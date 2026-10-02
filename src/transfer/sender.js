'use strict';

const fs = require('fs');
const EventEmitter = require('events');

const proto = require('./protocol');
const store = require('./store');

/**
 * 发送端引擎。
 *
 * 流程（与浏览器完全一致）：
 *   transfer-header  → 等待 transfer-ready → 建 4 条协商通道
 *   → 按 i % 4 把块分给各通道 → 每通道带窗口灌数据 → 收 ACK 调窗口 → 全部确认后收 complete
 *
 * 与浏览器的关键差异：浏览器用 FileReader 读切片（一次一片的回调地狱），
 * 我们用 fs 的带 position 读（pread），所以「读一片 → 压缩 → 发一片」可以写成
 * 一个直白的 async while 循环，每个通道一个循环，天然并发。
 *
 * 推进有三个来源，缺一不可：
 *   1. ACK 到达（主路径）
 *   2. 通道 bufferedAmountLow（背压解除）
 *   3. 25ms 的兜底定时器 —— werift 的 bufferedAmountLow 不保证触发，
 *      没有这个兜底，一旦撞上背压就永远停在那儿了
 */

const PUMP_INTERVAL_MS = 25;

class FileSender extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.filePath  outbox 沙箱内的绝对路径
     */
    constructor({ peer, filePath, cfg, logger }) {
        super();
        this.peer = peer;
        this.peerId = peer.peerId;
        this.cfg = cfg;
        this.log = logger;

        const meta = store.resolveOutgoing(cfg, this.peerId, filePath);
        this.path = meta.path;
        this.name = meta.name;
        this.size = meta.size;

        this.chunkSize = proto.CHUNK_SIZE;
        this.totalChunks = proto.chunkCountFor(this.size);
        this.channelCount = proto.CHANNEL_COUNT;

        this.sentCount = 0;
        this.ackedCount = 0;
        this.channels = [];          // [{dc, window, inFlight, nextChunk, endChunk, _pumping, _missing}]
        this.ready = false;
        this.done = false;
        this.failed = null;

        this.startTime = Date.now();
        this._fh = null;
        this._timer = null;
        this._lastAckTime = 0;
    }

    get progress() {
        return {
            name: this.name, size: this.size,
            sent: this.ackedCount, total: this.totalChunks,
            bytes: Math.min(this.size, this.ackedCount * this.chunkSize),
        };
    }

    /** 发 transfer-header，然后等对端回 transfer-ready */
    async start() {
        if (this.size === 0) {
            // 空文件：没有块可发，直接走一趟 header/ready/complete 让对端建出空文件
            this.log.info('发送空文件 ' + this.name);
        }
        this._fh = await fs.promises.open(this.path, 'r');

        this.log.info('准备发送 ' + this.name + '（' + store.fmt(this.size) + '，' +
            this.totalChunks + ' 块）');

        this.peer.sendJson({
            type: 'transfer-header',
            name: this.name,
            size: this.size,
            totalChunks: this.totalChunks,
            chunkSize: this.chunkSize,
            channelCount: this.channelCount,
            channelIds: proto.TF_CHANNEL_IDS,
        });
        return true;
    }

    /** 对端确认可以接收了 */
    onReady() {
        if (this.done || this.failed || this.ready) return;
        this.ready = true;

        const ranges = proto.splitChunks(this.totalChunks, this.channelCount);

        for (let i = 0; i < this.channelCount; i++) {
            const label = proto.channelLabel(i);
            let dc;
            try {
                dc = this.peer.createBulkChannel(label, proto.TF_CHANNEL_IDS[i]);
            } catch (e) {
                this.log.warn('创建发送通道 ' + label + ' 失败: ' + e.message);
                continue;
            }

            const ci = {
                dc, label,
                window: proto.INIT_WINDOW,
                inFlight: 0,
                nextChunk: ranges[i][0],
                endChunk: ranges[i][1],
                _pumping: false,
                _missing: null,
            };
            this.channels.push(ci);

            if (dc.stateChanged) {
                dc.stateChanged.subscribe((s) => {
                    if (s === 'open') this.log.debug('发送通道 ' + label + ' 已打开');
                });
            }
            if (dc.bufferedAmountLow) {
                dc.bufferedAmountLow.subscribe(() => {
                    if (this.sentCount - this.ackedCount < proto.MAX_PIPELINE) this._pump(i);
                });
            }
        }

        // 等通道就绪（协商通道在 SCTP 建好后即 open，这里给一小段宽限）
        setTimeout(() => {
            const open = this.channels.filter((c) => c.dc.readyState === 'open').length;
            this.log.info(this.channels.length + ' 路发送通道，已打开 ' + open + ' 路');
            this._startTimer();
            for (let i = 0; i < this.channels.length; i++) this._pump(i);
        }, 200);
    }

    _startTimer() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            if (this.done || this.failed) return;
            if (this.sentCount - this.ackedCount >= proto.MAX_PIPELINE) return;
            for (let i = 0; i < this.channels.length; i++) this._pump(i);
        }, PUMP_INTERVAL_MS);
        this._timer.unref();
    }

    /** 单通道泵送。_pumping 闸门防止 ACK 与定时器同时进来把 inFlight 灌爆 */
    async _pump(i) {
        const ci = this.channels[i];
        if (!ci || ci._pumping || this.done || this.failed) return;
        if (!ci._missing && (ci.nextChunk === -1 || ci.nextChunk > ci.endChunk)) return;
        if (ci.dc.readyState !== 'open') return;

        ci._pumping = true;
        try {
            for (;;) {
                if (this.done || this.failed) break;
                if (this.sentCount - this.ackedCount >= proto.MAX_PIPELINE) break;
                if (ci.dc.readyState !== 'open') break;

                if (typeof ci.dc.bufferedAmount === 'number' &&
                    ci.dc.bufferedAmount > proto.BUFFER_SOFT_CAP) {
                    ci.window = Math.max(proto.MIN_WINDOW, ci.window - 1);
                    break;
                }

                let idx;
                if (ci._missing) {
                    if (!ci._missing.length) break;
                    idx = ci._missing.shift();
                } else {
                    if (ci.nextChunk > ci.endChunk) break;
                    if (ci.inFlight >= ci.window) break;
                    idx = ci.nextChunk;
                    ci.nextChunk += proto.CHANNEL_COUNT;   // 轮询步长
                }

                if (!ci._missing) ci.inFlight++;
                const ok = await this._sendOne(ci, idx);
                if (!ok) {
                    if (!ci._missing) { ci.inFlight--; ci.nextChunk -= proto.CHANNEL_COUNT; }
                    break;
                }
            }
        } finally {
            ci._pumping = false;
        }
    }

    async _sendOne(ci, idx) {
        const offset = idx * this.chunkSize;
        const len = Math.min(this.chunkSize, this.size - offset);
        if (len <= 0) return true;

        const buf = Buffer.allocUnsafe(len);
        let read;
        try {
            read = await this._fh.read(buf, 0, len, offset);
        } catch (e) {
            this._fail('读文件失败: ' + e.message);
            return false;
        }
        if (read.bytesRead !== len) {
            this._fail('读到的字节数不对（期望 ' + len + '，实际 ' + read.bytesRead + '）');
            return false;
        }

        const raw = buf.subarray(0, read.bytesRead);
        const packed = await proto.maybeCompress(raw);
        const frame = proto.encodeFrame(idx, packed.flags, packed.payload);

        const sent = this.peer.sendBinary(ci.label, frame);
        if (!sent) {
            this.log.debug('通道 ' + ci.label + ' 发送失败，稍后重试 chunk=' + idx);
            return false;
        }

        this.sentCount++;
        this.emit('progress', this.progress);
        return true;
    }

    onAck(msg) {
        if (this.done || this.failed) return;
        const acked = Number(msg.receivedCount);
        if (!Number.isFinite(acked)) return;

        const delta = acked - this.ackedCount;
        if (delta <= 0) return;              // ACK 是累计值，回退/重复一律忽略
        this.ackedCount = acked;
        this._lastAckTime = Date.now();
        this.emit('progress', this.progress);

        const pipeline = this.sentCount - this.ackedCount;

        // 按各通道窗口占比重新分配 inFlight（与浏览器 _onTransferAck 同算法）
        let totalWindow = 0;
        for (const ci of this.channels) totalWindow += ci.window;
        for (const ci of this.channels) {
            const share = totalWindow > 0 ? ci.window / totalWindow : 1 / this.channels.length;
            ci.inFlight = Math.max(0, Math.ceil(pipeline * share));

            if (pipeline < proto.MAX_PIPELINE / 3) {
                ci.window = Math.min(proto.MAX_WINDOW, ci.window + 1);
            } else if (pipeline > proto.MAX_PIPELINE * 0.7) {
                ci.window = Math.max(proto.MIN_WINDOW, ci.window - 1);
            }
        }

        if (pipeline < proto.MAX_PIPELINE) {
            for (let i = 0; i < this.channels.length; i++) this._pump(i);
        }
    }

    /** 对端要求补发缺失的块（断点续传） */
    onResume(msg) {
        if (this.done || this.failed) return;
        const missing = Array.isArray(msg.missingChunks) ? msg.missingChunks.slice() : null;
        if (!missing || !missing.length) {
            // 对端其实已经收齐了，只是我们没收到它的 complete
            if (Number(msg.receivedCount) >= this.totalChunks) this._finish();
            return;
        }

        this.log.info('对端要求补发 ' + missing.length + ' 块');

        // 按通道切成几份，各通道独立重发
        const buckets = [];
        for (let i = 0; i < this.channelCount; i++) buckets.push([]);
        missing.forEach((idx, n) => buckets[n % this.channelCount].push(idx));

        this.sentCount = Number(msg.receivedCount) || this.ackedCount;
        this.ackedCount = this.sentCount;

        this.channels.forEach((ci, i) => {
            ci._missing = buckets[i];
            ci.inFlight = 0;
            ci.window = proto.INIT_WINDOW;
        });

        for (let i = 0; i < this.channels.length; i++) this._pump(i);
    }

    onComplete() { this._finish(); }

    _finish() {
        if (this.done) return;
        this.done = true;
        this._cleanup();
        const elapsed = (Date.now() - this.startTime) / 1000;
        this.log.info('发送完成 ' + this.name + '（' + store.fmt(this.size) + '，耗时 ' +
            elapsed.toFixed(1) + 's）');
        this.emit('done', {
            name: this.name, size: this.size,
            elapsedMs: Date.now() - this.startTime,
        });
    }

    _fail(reason) {
        if (this.failed) return;
        this.failed = reason;
        this.done = true;
        this._cleanup();
        this.log.warn('发送中断 ' + this.name + '：' + reason);
        this.emit('failed', reason);
    }

    _cleanup() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._fh) { this._fh.close().catch(() => {}); this._fh = null; }
    }

    cancel(reason) {
        if (this.done) return;
        this.failed = reason || 'cancelled';
        this.done = true;
        this._cleanup();
        this.emit('failed', this.failed);
    }
}

module.exports = { FileSender };
