'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

/**
 * PartyKit 信令客户端。
 *
 * 协议（与浏览器端 js/main.js 完全一致）：
 *   出站 { type, target, payload }
 *   入站 { type, from, payload }
 *   连上后什么都不发，等服务端推 'ok'，收到 'ok' 才发 join_room。
 *
 * 与浏览器的关键差异：浏览器一旦 P2P 连通就主动关掉信令（它只需要一个对端），
 * 我们必须**保持信令连接**，因为随时可能有新对端要连进来。
 * 这也意味着浏览器关闭信令时我们会收到针对**仍然活着**的对端的 peer_left —— 不能当断开处理。
 */

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

class SignalingClient extends EventEmitter {
    constructor({ url, roomId, logger }) {
        super();
        this.url = url;
        this.roomId = roomId;
        this.log = logger;
        this.ws = null;
        this.myId = null;
        this.connected = false;
        this.closed = false;
        this._backoff = BACKOFF_MIN_MS;
        this._reconnectTimer = null;
        this._joining = false;
    }

    connect() {
        this.closed = false;
        this._open();
    }

    _open() {
        if (this.closed) return;
        this.log.info('连接信令 ' + this.url);

        let ws;
        try {
            ws = new WebSocket(this.url);
        } catch (e) {
            this.log.error('创建 WebSocket 失败: ' + e.message);
            return this._scheduleReconnect();
        }
        this.ws = ws;

        ws.on('open', () => {
            // 协议要求：什么都不发，等 'ok'
            this.log.info('信令已连接，等待 ok');
        });

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch (e) {
                this.log.debug('信令收到非 JSON 帧，忽略');
                return;
            }
            if (!msg || !msg.type) return;

            if (msg.type === 'ok') {
                this.myId = msg.id;
                this.connected = true;
                this._backoff = BACKOFF_MIN_MS;
                this.log.info('已分配 id=' + this.myId + '，加入房间 ' + this.roomId);
                this._joinRoom();
                this.emit('open', msg);
                return;
            }

            this.emit(msg.type, msg);
            this.emit('message', msg);
        });

        ws.on('close', () => {
            this.connected = false;
            if (this.closed) return;
            this.log.warn('信令断开，将重连');
            this.emit('close');
            this._scheduleReconnect();
        });

        ws.on('error', (e) => {
            this.log.warn('信令错误: ' + e.message);
        });
    }

    _joinRoom() {
        this._joining = false;
        this.send('join_room', null, { room_id: this.roomId });
    }

    _scheduleReconnect() {
        if (this.closed || this._reconnectTimer) return;
        // 退避 + 抖动：多个实例同时重连时不要撞在一起
        const jitter = Math.random() * 0.3 + 0.85;
        const delay = Math.min(BACKOFF_MAX_MS, this._backoff * jitter);
        this._backoff = Math.min(BACKOFF_MAX_MS, this._backoff * 2);
        this.log.info('将在 ' + Math.round(delay) + 'ms 后重连信令');
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._open();
        }, delay);
        this._reconnectTimer.unref();
    }

    /**
     * 发一条信令消息。
     * 注意：P2P 链路不依赖信令，所以信令断开时这里只是放弃发送，不要抛错。
     */
    send(type, target, payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.log.debug('信令未连接，丢弃 ' + type);
            return false;
        }
        const msg = { type };
        if (target) msg.target = target;
        if (payload !== undefined && payload !== null) msg.payload = payload;
        try {
            this.ws.send(JSON.stringify(msg));
            return true;
        } catch (e) {
            this.log.warn('信令发送失败 ' + type + ': ' + e.message);
            return false;
        }
    }

    close() {
        this.closed = true;
        this.connected = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* 已关闭 */ }
            this.ws = null;
        }
    }
}

module.exports = { SignalingClient };
