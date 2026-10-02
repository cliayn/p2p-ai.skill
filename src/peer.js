'use strict';

const EventEmitter = require('events');
const { RTCPeerConnection } = require('werift');
const sdpBridge = require('./sdp');

/**
 * 一个远端对端的连接。
 *
 * 角色映射（与浏览器端一致，很容易搞反）：
 *   - 主动发起 connect_request 的一方 = offerer，由它创建 'fileTransfer' 通道
 *   - 接受连接的一方            = answerer，经 pc.onDataChannel 收到该通道
 *
 * werift 的两个坑（都已实测）：
 *   1. ICE 收集在 setLocalDescription resolve 之前就完成了，
 *      所以 onIceCandidate 事件早就发完了 —— 候选只能从 localDescription.sdp 里抠。
 *   2. onMessage 直接把 payload 抛出来，不像浏览器那样包一层 { data }。
 */

const DC_OPEN_TIMEOUT_MS = 15000;
// 'disconnected' 可能只是网络抖动，持续这么久才判定为真的断了
const DISCONNECT_GRACE_MS = 10000;
const MAIN_DC_LABEL = 'fileTransfer';
const TF_LABEL_RE = /^tf-ch-\d+$/;

function toBuf(d) {
    if (Buffer.isBuffer(d)) return d;
    if (typeof d === 'string') return Buffer.from(d, 'utf8');
    if (d instanceof ArrayBuffer) return Buffer.from(d);
    if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    if (d && d.data !== undefined) return toBuf(d.data);
    return Buffer.from(String(d), 'utf8');
}

/** werift 的 candidate 事件对象形态不固定，尽量兼容 */
function candToString(c) {
    if (!c) return null;
    if (typeof c === 'string') return c;
    if (typeof c.candidate === 'string') return c.candidate;
    if (typeof c.toJSON === 'function') {
        const j = c.toJSON();
        if (j && typeof j.candidate === 'string') return j.candidate;
    }
    return null;
}

class Peer extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.peerId
     * @param {'offerer'|'answerer'} opts.role
     */
    constructor({ peerId, role, config, logger }) {
        super();
        this.peerId = peerId;
        this.role = role;
        this.cfg = config;
        this.log = (logger || { debug() {}, info() {}, warn() {}, error() {} }).child
            ? logger.child(peerId)
            : (logger || { debug() {}, info() {}, warn() {}, error() {} });

        this.pc = null;
        this.dc = null;               // 主通道（JSON 控制 + 聊天）
        this.channels = new Map();    // label -> RTCDataChannel，阶段 2 的文件通道
        this.closed = false;

        this._localDcReady = false;
        this._remoteDcReady = false;
        this._readyEmitted = false;
        this._inlinedKeys = new Set();
        this._seenCandKeys = new Set();
        this._dcOpenTimer = null;
        this._disconnectTimer = null;
        this._pendingRemoteIce = [];  // setRemoteDescription 之前到达的候选先攒着
    }

    // ————————————————————— 生命周期 —————————————————————

    _newPc() {
        const iceServers = this.cfg.stunUrl ? [{ urls: this.cfg.stunUrl }] : [];
        const pc = new RTCPeerConnection({ iceServers });
        this.pc = pc;

        if (pc.onIceCandidate) {
            pc.onIceCandidate.subscribe((c) => this._onLocalIce(c));
        }
        if (pc.onDataChannel) {
            pc.onDataChannel.subscribe((ch) => this._adoptChannel(ch));
        }
        if (pc.connectionStateChange) {
            pc.connectionStateChange.subscribe((s) => {
                this.log.debug('connectionState = ' + s);
                this.emit('state', s);

                if (s === 'connected') {
                    this._armDcTimeout();
                    // 恢复后取消待定的断线判定
                    if (this._disconnectTimer) {
                        clearTimeout(this._disconnectTimer);
                        this._disconnectTimer = null;
                    }
                    return;
                }

                if (s === 'failed') {
                    this.emit('failed', s);
                    return;
                }

                // 'disconnected' 可能只是抖动，给一段宽限期再判定
                if (s === 'disconnected' && !this._disconnectTimer) {
                    this._disconnectTimer = setTimeout(() => {
                        this._disconnectTimer = null;
                        if (!this.closed && this.pc && this.pc.connectionState === 'disconnected') {
                            this.log.warn('连接持续 disconnected，判定为断开');
                            this.emit('failed', 'disconnected');
                        }
                    }, DISCONNECT_GRACE_MS);
                    this._disconnectTimer.unref();
                }
                // 'closed' 不在这里上报：正常关闭由 close() 自己走 'closed' 事件，
                // 否则关闭路径会同时触发 failed 和 closed 两条链
            });
        }
        return pc;
    }

    /** offerer 路径：建 PC + 建主通道 + 出 offer */
    async startAsOfferer() {
        const pc = this._newPc();

        // offerer 负责创建 'fileTransfer' 主通道
        const dc = pc.createDataChannel(MAIN_DC_LABEL);
        this._setupMainChannel(dc);

        await pc.setLocalDescription(await pc.createOffer());
        const compact = this._finishLocalDescription();
        this.log.info('已生成 offer，候选 ' + compact.ice.length + ' 个');
        this._armDcTimeout();
        return compact;
    }

    /** answerer 路径：应用对方的 offer 并出 answer */
    async acceptOffer(compact) {
        const pc = this._newPc();

        const err = sdpBridge.validateCompact(compact);
        if (err) throw new Error('收到的 offer 载荷无效: ' + err);

        await pc.setRemoteDescription({ type: 'offer', sdp: sdpBridge.fromCompact('offer', compact) });
        await this._flushPendingIce();

        await pc.setLocalDescription(await pc.createAnswer());
        const answer = this._finishLocalDescription();
        this.log.info('已生成 answer，候选 ' + answer.ice.length + ' 个');
        this._armDcTimeout();
        return answer;
    }

    /** offerer 路径：应用对方的 answer */
    async applyAnswer(compact) {
        if (!this.pc) throw new Error('applyAnswer 调用时 PC 尚未创建');
        const err = sdpBridge.validateCompact(compact);
        if (err) throw new Error('收到的 answer 载荷无效: ' + err);

        await this.pc.setRemoteDescription({ type: 'answer', sdp: sdpBridge.fromCompact('answer', compact) });
        await this._flushPendingIce();
        this.log.info('已应用 answer，连接建立中');
    }

    /** setLocalDescription 之后：取候选、记录已内联的、返回紧凑载荷 */
    _finishLocalDescription() {
        const compact = sdpBridge.toCompact(this.pc, null);
        for (const c of compact.ice) this._inlinedKeys.add(c.ip + ':' + c.port);
        return compact;
    }

    async addRemoteIce(candidateStr) {
        if (this.closed) return;
        const parsed = sdpBridge.parseCandidate(candidateStr);
        if (!parsed) return;   // 过滤掉 TCP / 低端口

        const key = parsed.ip + ':' + parsed.port;
        if (this._seenCandKeys.has(key)) return;
        this._seenCandKeys.add(key);

        if (!this.pc || !this.pc.remoteDescription) {
            this._pendingRemoteIce.push(candidateStr);
            return;
        }
        try {
            await this.pc.addIceCandidate({ candidate: candidateStr, sdpMid: '0', sdpMLineIndex: 0 });
        } catch (e) {
            this.log.debug('addIceCandidate 失败（忽略）: ' + e.message);
        }
    }

    async _flushPendingIce() {
        if (!this._pendingRemoteIce.length) return;
        const pending = this._pendingRemoteIce.splice(0);
        for (const c of pending) {
            try {
                await this.pc.addIceCandidate({ candidate: c, sdpMid: '0', sdpMLineIndex: 0 });
            } catch (e) {
                this.log.debug('补加候选失败（忽略）: ' + e.message);
            }
        }
    }

    /** 晚到的本地候选（正常情况都在 SDP 里，这里是兜底） */
    _onLocalIce(c) {
        const raw = candToString(c);
        if (!raw) return;
        const parsed = sdpBridge.parseCandidate(raw);
        if (!parsed) return;
        const key = parsed.ip + ':' + parsed.port;
        if (this._inlinedKeys.has(key) || this._seenCandKeys.has(key)) return;
        this.emit('ice', raw);
    }

    // ————————————————————— DataChannel —————————————————————

    _adoptChannel(ch) {
        const label = ch.label;
        if (label === MAIN_DC_LABEL || !this.dc) {
            this._setupMainChannel(ch);
        } else if (TF_LABEL_RE.test(label)) {
            // 协商通道其实不会走到这里（双方本地各建一次），保留作为兜底
            this.channels.set(label, ch);
            this._wireBulkChannel(ch, label);
            this.emit('bulk-channel', ch);
        } else {
            this.log.debug('忽略未知 DataChannel: ' + label);
        }
    }

    _setupMainChannel(dc) {
        this.dc = dc;
        this.log.debug('主通道已建立，label=' + dc.label);

        const onOpen = () => {
            this.log.info('主通道 open');
            this.emit('open');
            this._announceReady();
        };

        // werift 用 stateChanged 而不是 onopen
        if (dc.stateChanged) {
            dc.stateChanged.subscribe((s) => { if (s === 'open') onOpen(); });
        }
        if (dc.readyState === 'open') onOpen();

        dc.onMessage.subscribe((d) => this._onDcMessage(d));

        dc.error && dc.error.subscribe && dc.error.subscribe((e) => {
            this.log.warn('主通道错误: ' + (e && e.message));
        });
    }

    _onDcMessage(d) {
        const buf = toBuf(d);
        let msg;
        try {
            msg = JSON.parse(buf.toString('utf8'));
        } catch (e) {
            // 主通道只跑 JSON；解析不了就当噪声丢掉
            this.log.debug('主通道收到非 JSON 数据，丢弃 ' + buf.length + ' 字节');
            return;
        }
        if (!msg || !msg.type) return;

        if (msg.type === 'chat-ready') {
            this._remoteDcReady = true;
            if (msg.device) this.device = msg.device;
            this.log.info('对端就绪（device=' + (msg.device || '未知') + '）');
            this._tryReady();
            return;
        }

        this.emit('message', msg);
        this.emit(msg.type, msg);
    }

    /** 两侧都在 DC open 时各发一次 chat-ready —— 与浏览器端一致 */
    _announceReady() {
        this._localDcReady = true;
        if (this.dc && this.dc.readyState === 'open') {
            this._sendRaw({ type: 'chat-ready', device: this.cfg.deviceName });
        }
        this._tryReady();
    }

    _tryReady() {
        if (this._readyEmitted) return;
        if (this._localDcReady && this._remoteDcReady) {
            this._readyEmitted = true;
            this.log.info('双方就绪，可以对话');
            this.emit('ready');
        }
    }

    _armDcTimeout() {
        if (this._dcOpenTimer) return;
        this._dcOpenTimer = setTimeout(() => {
            if (!this.dc || this.dc.readyState !== 'open') {
                this.log.warn('DataChannel 超时未打开（' + DC_OPEN_TIMEOUT_MS + 'ms）');
                this.emit('failed', 'dc-timeout');
                this.close('dc-timeout');
            }
        }, DC_OPEN_TIMEOUT_MS);
        this._dcOpenTimer.unref();
    }

    // ————————————————————— 发送 —————————————————————

    isOpen() {
        return !!(this.dc && this.dc.readyState === 'open' && !this.closed);
    }

    _sendRaw(obj) {
        if (!this.isOpen()) return false;
        try {
            this.dc.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            this.log.warn('发送失败: ' + e.message);
            return false;
        }
    }

    sendJson(obj) {
        return this._sendRaw(obj);
    }

    /**
     * 建一条协商（negotiated）文件通道。
     *
     * 协商通道双方各自用**相同的 id 和 label** 本地创建，不会走 DCEP 握手，
     * 所以对端不会触发 onDataChannel —— 这是设计如此，不是漏了处理。
     * 4 条通道的 id 固定在 TF_CHANNEL_IDS，和浏览器端一致。
     */
    createBulkChannel(label, id) {
        if (this.closed || !this.pc) throw new Error('连接已关闭，无法建通道');
        const existing = this.channels.get(label);
        if (existing) return existing;

        const dc = this.pc.createDataChannel(label, { negotiated: true, id, ordered: true });
        this.channels.set(label, dc);
        this._wireBulkChannel(dc, label);
        return dc;
    }

    _wireBulkChannel(dc, label) {
        dc.onMessage.subscribe((d) => {
            this.emit('bulk-data', { label, data: toBuf(d) });
        });
        if (dc.error && dc.error.subscribe) {
            dc.error.subscribe((e) => {
                this.log.warn('文件通道 ' + label + ' 错误: ' + (e && e.message));
            });
        }
    }

    /** 发一个二进制帧到某条文件通道（阶段 2 用） */
    sendBinary(label, buffer) {
        const ch = this.channels.get(label);
        if (!ch || ch.readyState !== 'open') return false;
        try {
            ch.send(buffer);
            return true;
        } catch (e) {
            this.log.warn('二进制发送失败 ' + label + ': ' + e.message);
            return false;
        }
    }

    // ————————————————————— 关闭 —————————————————————

    async close(reason) {
        if (this.closed) return;
        this.closed = true;
        if (this._dcOpenTimer) {
            clearTimeout(this._dcOpenTimer);
            this._dcOpenTimer = null;
        }
        if (this._disconnectTimer) {
            clearTimeout(this._disconnectTimer);
            this._disconnectTimer = null;
        }
        this.log.info('关闭连接（' + (reason || '') + '）');

        // 尽量通知对端，让浏览器那边能立刻收起会话
        try { this._sendRaw({ type: 'disconnect' }); } catch (e) { /* 已断 */ }

        for (const ch of this.channels.values()) {
            try { ch.close(); } catch (e) { /* 忽略 */ }
        }
        this.channels.clear();

        if (this.dc) {
            try { this.dc.close(); } catch (e) { /* 忽略 */ }
        }
        if (this.pc) {
            try { await this.pc.close(); } catch (e) { /* 忽略 */ }
        }
        this.emit('closed', reason);
        this.removeAllListeners();
    }
}

module.exports = { Peer, toBuf, MAIN_DC_LABEL, TF_LABEL_RE, DC_OPEN_TIMEOUT_MS };
