'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 本地控制面：让 p2p-ctl 能查询/操作一个已经在跑的 daemon。
 *
 * 走的是本地套接字（Windows 上是命名管道），不走网络 —— 不给别人留后门。
 * 协议：一行一个 JSON 请求，一行一个 JSON 响应，连接可复用。
 *
 *   → {"cmd":"status"}
 *   ← {"ok":true,"data":{...}}
 *
 * 安全：套接字文件权限收到 0600，同机器上的其他用户连不上。
 * 拿到这个套接字就等于能替这个 AI 发消息/发文件，别往外暴露。
 */

/** 平台对应的默认套接字路径 */
function defaultSockPath() {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\p2p-ai-control-' + (process.env.USERNAME || 'default');
    }
    return path.join(os.homedir(), '.p2p-ai', 'control.sock');
}

const MAX_LINE = 64 * 1024;

class ControlServer {
    /**
     * @param {object} opts
     * @param {import('./daemon').Daemon} opts.daemon
     */
    constructor({ daemon, sockPath, logger }) {
        this.daemon = daemon;
        this.sockPath = sockPath || defaultSockPath();
        this.log = logger;
        this.server = null;
        this.conns = new Set();
    }

    start() {
        // 上次没退干净留下的陈旧套接字会让 listen 报 EADDRINUSE
        if (process.platform !== 'win32') {
            try {
                if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath);
            } catch (e) { /* 忽略 */ }
        }

        try {
            fs.mkdirSync(path.dirname(this.sockPath), { recursive: true });
        } catch (e) { /* Windows 管道不需要目录 */ }

        this.server = net.createServer((conn) => this._onConn(conn));

        this.server.on('error', (e) => {
            // 控制面起不来不该拖垮整个 daemon，只是少了个运维入口
            this.log.warn('控制套接字不可用（' + e.code + '）: ' + e.message);
        });

        this.server.listen(this.sockPath, () => {
            if (process.platform !== 'win32') {
                try { fs.chmodSync(this.sockPath, 0o600); } catch (e) { /* 忽略 */ }
            }
            this.log.info('控制套接字: ' + this.sockPath);
        });

        return this;
    }

    _onConn(conn) {
        this.conns.add(conn);
        conn.on('error', () => { try { conn.destroy(); } catch (e) { /* 忽略 */ } });
        conn.on('close', () => this.conns.delete(conn));

        let buf = '';
        conn.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            if (buf.length > MAX_LINE * 8) { buf = ''; conn.destroy(); return; }

            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                this._handle(conn, line);
            }
        });
    }

    _reply(conn, obj) {
        try { conn.write(JSON.stringify(obj) + '\n'); } catch (e) { /* 对端已断 */ }
    }

    async _handle(conn, line) {
        let req;
        try {
            req = JSON.parse(line);
        } catch (e) {
            return this._reply(conn, { ok: false, error: '请求不是合法 JSON' });
        }

        const d = this.daemon;
        const cmd = String(req.cmd || '');

        try {
            switch (cmd) {
                case 'status': {
                    const t = d.transfers.busy;
                    return this._reply(conn, {
                        ok: true,
                        data: {
                            roomId: d.roomId,
                            myId: d.signaling ? d.signaling.myId : null,
                            mode: d.mode,
                            signalingConnected: !!(d.signaling && d.signaling.connected),
                            peers: Array.from(d.peers.keys()),
                            transfers: t,
                            scheduler: d.scheduler.stats,
                            dirs: { inbox: d.cfg.inboxDir, outbox: d.cfg.outboxDir },
                        },
                    });
                }

                case 'peers': {
                    const list = [];
                    for (const [id, p] of d.peers) {
                        list.push({ peerId: id, role: p.role, open: p.isOpen(), device: p.device || null });
                    }
                    return this._reply(conn, { ok: true, data: list });
                }

                case 'say': {
                    const conv = d.conversations.get(req.peerId);
                    if (!conv) return this._reply(conn, { ok: false, error: '没有与 ' + req.peerId + ' 的对话' });
                    if (typeof req.text !== 'string' || !req.text) {
                        return this._reply(conn, { ok: false, error: 'text 不能为空' });
                    }
                    conv.say(req.text);
                    return this._reply(conn, { ok: true });
                }

                case 'send': {
                    const peer = d.peers.get(req.peerId);
                    if (!peer) return this._reply(conn, { ok: false, error: '对端 ' + req.peerId + ' 不在线' });
                    await d.transfers.sendFile(peer, req.path);
                    return this._reply(conn, { ok: true });
                }

                case 'sessions': {
                    const { listClaudeSessions } = require('./session-store');
                    const list = listClaudeSessions(req.workdir || d.cfg.workdir);
                    return this._reply(conn, { ok: true, data: list });
                }

                case 'quit': {
                    this._reply(conn, { ok: true });
                    setTimeout(() => d.stop('p2p-ctl quit').catch(() => {}), 50);
                    return;
                }

                default:
                    return this._reply(conn, { ok: false, error: '未知命令: ' + cmd });
            }
        } catch (e) {
            this._reply(conn, { ok: false, error: e.message });
        }
    }

    stop() {
        for (const c of this.conns) { try { c.destroy(); } catch (e) { /* 忽略 */ } }
        this.conns.clear();
        if (this.server) {
            try { this.server.close(); } catch (e) { /* 忽略 */ }
            this.server = null;
        }
        if (process.platform !== 'win32') {
            try { if (fs.existsSync(this.sockPath)) fs.unlinkSync(this.sockPath); } catch (e) { /* 忽略 */ }
        }
    }
}

/** 客户端：发一条请求，拿回响应。p2p-ctl 用 */
function controlRequest(sockPath, req, timeoutMs) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(sockPath);
        let buf = '';
        let done = false;

        const finish = (err, val) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) { /* 忽略 */ }
            err ? reject(err) : resolve(val);
        };

        const timer = setTimeout(() => finish(new Error('控制套接字无响应（' + (timeoutMs || 5000) + 'ms）')), timeoutMs || 5000);

        sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
        sock.on('data', (c) => {
            buf += c.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            clearTimeout(timer);
            try { finish(null, JSON.parse(buf.slice(0, nl))); }
            catch (e) { finish(new Error('响应不是合法 JSON')); }
        });
        sock.on('error', (e) => {
            clearTimeout(timer);
            if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
                finish(new Error('连不上控制套接字（没有正在运行的 p2p-listen？）'));
            } else {
                finish(e);
            }
        });
    });
}

module.exports = { ControlServer, controlRequest, defaultSockPath };
