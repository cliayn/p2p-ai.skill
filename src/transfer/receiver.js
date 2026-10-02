'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const proto = require('./protocol');
const store = require('./store');
const { renameWithRetry } = require('../fsutil');

/**
 * 接收端引擎。
 *
 * 与浏览器端的差异只在「往哪儿写」：
 *   浏览器 = File System Access API 的随机写 / StreamSaver 的顺序流
 *   我们   = 本地文件的随机写（fs.write 带 position，就是 pwrite）
 *
 * 于是可以走随机写这条路：乱序到达也没关系，直接按 chunkIdx * chunkSize
 * 落到正确偏移。不必像 StreamSaver 那样做重排缓冲。
 *
 * 先写 <name>.p2p-part，全部收齐再 rename 成正式名字 —— 这样中途断了
 * 也不会在收件箱里留下一个看起来完好、其实残缺的文件。
 */

const MAX_CONCURRENT_WRITES = 32;

// 多久没收到新块就认为链路卡住了（丢包 / 对端掉了）
const STALL_TIMEOUT_MS = 3000;
const STALL_CHECK_MS = 1000;

class FileReceiver extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.peerId
     * @param {object} opts.header  transfer-header 消息
     */
    constructor({ peer, header, cfg, logger }) {
        super();
        this.peer = peer;
        this.peerId = peer.peerId;
        this.cfg = cfg;
        this.log = logger;
        this.header = header;

        this.name = String(header.name || 'unnamed');
        this.size = Number(header.size) || 0;
        this.chunkSize = Number(header.chunkSize) || proto.CHUNK_SIZE;
        this.totalChunks = Number(header.totalChunks) || 0;
        this.channelCount = Math.min(Number(header.channelCount) || proto.CHANNEL_COUNT, 8);
        this.channelIds = Array.isArray(header.channelIds) && header.channelIds.length
            ? header.channelIds
            : proto.TF_CHANNEL_IDS;

        this.mask = new Uint8Array(this.totalChunks);
        this.receivedCount = 0;
        this.writtenCount = 0;

        this.fh = null;              // 已打开的 .part 文件句柄
        this.paths = null;
        this.done = false;
        this.failed = null;
        this.startTime = Date.now();

        this._writing = 0;
        this._writeQueue = [];       // 背压队列 [{idx, data}]
        this._pending = 0;           // 已派发但未落盘的写操作数
        this._lastAckCount = 0;
        this._lastAckTime = 0;
        this._lastFrameTime = Date.now();
        this._lastResumeTime = 0;
        this._resumeAttempts = 0;
        this._stallTimer = null;
    }

    get progress() {
        return {
            name: this.name, size: this.size,
            received: this.receivedCount, total: this.totalChunks,
            bytes: Math.min(this.size, this.receivedCount * this.chunkSize),
        };
    }

    /** 校验 + 建沙箱路径 + 建通道 + 回 transfer-ready */
    async start() {
        if (!Number.isFinite(this.size) || this.size < 0 || !Number.isFinite(this.totalChunks)) {
            throw new Error('transfer-header 缺字段或数值非法');
        }
        // 空文件：没有数据块，但依然要走完 header/ready/complete 让对端收尾
        if (this.totalChunks === 0 && this.size > 0) {
            throw new Error('块数与大小矛盾（size=' + this.size + '，totalChunks=0）');
        }
        const expect = proto.chunkCountFor(this.size);
        if (this.totalChunks !== expect) {
            this.log.warn('声明的块数 ' + this.totalChunks + ' 与大小推算的 ' + expect + ' 不一致，按声明的走');
        }

        this.paths = store.resolveIncoming(this.cfg, this.peerId, this.name);
        this.name = path.basename(this.paths.finalPath);

        const cap = await store.checkCapacity(this.cfg, this.paths.dir, this.size);
        if (!cap.ok) {
            await this._reject(cap.reason);
            return false;
        }
        if (cap.note) this.log.warn(cap.note);
        if (cap.free !== null) {
            this.log.info('接收 ' + this.name + '（' + store.fmt(this.size) + '，剩余 ' +
                store.fmt(cap.free) + '）');
        }

        this.fh = await fs.promises.open(this.paths.partPath, 'w+');

        // 建 4 条协商通道（与发送端同 id、同 label，双方本地各建一次，无需信令）
        for (let i = 0; i < this.channelCount; i++) {
            try {
                this.peer.createBulkChannel(proto.channelLabel(i), this.channelIds[i]);
            } catch (e) {
                this.log.warn('创建接收通道 ' + i + ' 失败: ' + e.message);
            }
        }

        this.log.info('接收 ' + this.name + '：' + this.totalChunks + ' 块，' +
            this.channelCount + ' 路通道，已就绪');
        this.peer.sendJson({ type: 'transfer-ready' });
        if (this.totalChunks === 0) await this._finish();   // 空文件直接落地
        else this._startStallDetector();
        return true;
    }

    /** 收到一个二进制帧 */
    onFrame(buf) {
        if (this.done || this.failed) return;
        const f = proto.decodeFrame(buf);
        if (!f) return;

        if (f.chunkIdx >= this.totalChunks) {
            this.log.warn('块号越界 ' + f.chunkIdx + ' >= ' + this.totalChunks + '，丢弃');
            return;
        }
        // 去重：多通道 + 重传都会让同一块到达多次
        if (this.mask[f.chunkIdx]) return;
        this.mask[f.chunkIdx] = 1;
        this._lastFrameTime = Date.now();

        this._enqueueWrite(f.chunkIdx, f.payload, f.flags);
    }

    /**
     * 停顿检测：一段时间没有任何新块到达就主动要缺失的那部分。
     *
     * 没有这个机制，丢包会变成「永远卡住」—— 协议里接收方是唯一的
     * 进度权威，发送方只会闷头把已发过的块再发一遍，不会知道丢了哪些。
     */
    _startStallDetector() {
        if (this._stallTimer) return;
        this._stallTimer = setInterval(() => {
            if (this.done || this.failed) return;
            if (this.receivedCount >= this.totalChunks) return;

            const idle = Date.now() - this._lastFrameTime;
            if (idle < STALL_TIMEOUT_MS) return;

            // 别把对端刷爆：两次续传请求之间至少隔一个停顿周期
            if (Date.now() - this._lastResumeTime < STALL_TIMEOUT_MS) return;
            this._lastResumeTime = Date.now();
            this._resumeAttempts++;

            if (this._resumeAttempts > 20) {
                this._fail('反复请求续传仍无进展（卡在 ' +
                    this.receivedCount + '/' + this.totalChunks + '）');
                return;
            }

            this.log.warn('停顿 ' + Math.round(idle / 1000) + 's，请求续传（第 ' +
                this._resumeAttempts + ' 次）');
            this.resumeRequest();
        }, STALL_CHECK_MS);
        this._stallTimer.unref();
    }

    _stopStallDetector() {
        if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
    }

    /**
     * 解压是异步的，但只有压缩过的块才需要走这条路。
     * 未压缩的块（<512B 或压缩无收益）直接同步入队，省掉一次事件循环往返。
     */
    _enqueueWrite(idx, payload, flags) {
        if (flags & 1) {
            proto.maybeDecompress(payload, flags).then((data) => {
                this._write(idx, data);
            }).catch(() => {
                this._write(idx, payload);
            });
        } else {
            this._write(idx, payload);
        }
    }

    _write(idx, data) {
        if (this.done || this.failed) return;
        if (this._writing >= MAX_CONCURRENT_WRITES) {
            this._writeQueue.push({ idx, data });
            return;
        }
        this._executeWrite(idx, data);
    }

    _executeWrite(idx, data) {
        this._writing++;
        this._pending++;
        const position = idx * this.chunkSize;

        // pwrite：带 position 的 write 不依赖文件游标，天然支持乱序
        this.fh.write(data, 0, data.length, position).then(() => {
            this._writing--;
            this._onWritten(idx);
            this._drain();
        }).catch((e) => {
            this._writing--;
            this.log.error('写入失败 chunk=' + idx + ': ' + e.message);
            this._fail('写入失败: ' + e.message);
            this._drain();
        });
    }

    _drain() {
        while (this._writing < MAX_CONCURRENT_WRITES && this._writeQueue.length) {
            const it = this._writeQueue.shift();
            this._executeWrite(it.idx, it.data);
        }
    }

    _onWritten(idx) {
        this._pending--;
        this.writtenCount++;
        this.receivedCount++;

        // ACK 节流：每 32 块，或距上次 ACK 超过 80ms 且确实有新进展
        const now = Date.now();
        const sinceLast = this.receivedCount - this._lastAckCount;
        if (sinceLast >= proto.ACK_CHUNK_STEP ||
            (now - this._lastAckTime > proto.ACK_INTERVAL_MS && sinceLast > 0)) {
            this._lastAckTime = now;
            this._lastAckCount = this.receivedCount;
            this.peer.sendJson({ type: 'transfer-ack', receivedCount: this.receivedCount });
        }

        this.emit('progress', this.progress);

        if (this.receivedCount >= this.totalChunks) this._finish();
    }

    async _finish() {
        if (this.done || this.failed) return;
        this.done = true;
        this._stopStallDetector();

        // 等所有在途写入落盘再 rename —— 否则会改名成一份不完整的文件
        while (this._pending > 0 || this._writing > 0 || this._writeQueue.length > 0) {
            await new Promise((r) => setTimeout(r, 10));
        }

        try {
            await this.fh.close();
            this.fh = null;

            // 校验大小：协议层的块数算下来可能与声明大小不符（对端有问题）
            const st = await fs.promises.stat(this.paths.partPath);
            if (st.size !== this.size) {
                this.log.warn('落盘大小与声明不符（' + st.size + ' != ' + this.size + '），仍按实际大小保留');
            }

            await renameWithRetry(this.paths.partPath, this.paths.finalPath);
        } catch (e) {
            this._fail('收尾失败: ' + e.message);
            return;
        }

        const elapsed = (Date.now() - this.startTime) / 1000;
        this.log.info('接收完成 ' + this.name + '（' + store.fmt(this.size) + '，耗时 ' +
            elapsed.toFixed(1) + 's）');

        this.peer.sendJson({ type: 'transfer-complete' });
        this.emit('done', {
            name: this.name, size: this.size, path: this.paths.finalPath,
            elapsedMs: Date.now() - this.startTime,
        });
    }

    /** 断点续传：把缺的块号告诉对端，让它重发 */
    resumeRequest() {
        const missing = [];
        for (let i = 0; i < this.totalChunks; i++) if (!this.mask[i]) missing.push(i);
        if (!missing.length) return false;
        this.log.info('断点续传：已收 ' + this.receivedCount + '/' + this.totalChunks +
            '，缺 ' + missing.length + ' 块');
        this.peer.sendJson({
            type: 'transfer-resume',
            receivedCount: this.receivedCount,
            totalChunks: this.totalChunks,
            missingChunks: missing,
        });
        return true;
    }

    async _reject(reason) {
        this.failed = reason;
        this.log.warn('拒绝接收 ' + this.name + '：' + reason);
        this.peer.sendJson({ type: 'transfer-cancel' });
        this.emit('rejected', reason);
    }

    _fail(reason) {
        if (this.failed) return;
        this.failed = reason;
        this.done = true;
        this._stopStallDetector();
        if (this.fh) { this.fh.close().catch(() => {}); this.fh = null; }
        this.log.warn('接收中断 ' + this.name + '：' + reason);
        this.emit('failed', reason);
    }

    async abort(reason) {
        if (this.done) return;
        this.done = true;
        this.failed = reason || 'aborted';
        this._stopStallDetector();
        if (this.fh) { try { await this.fh.close(); } catch (e) { /* 忽略 */ } this.fh = null; }
        // 残缺的 .part 留在磁盘上，但不会伪装成正常文件；下次同名会拿到新的唯一名
    }
}

module.exports = { FileReceiver };
