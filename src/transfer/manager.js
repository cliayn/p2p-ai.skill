'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const proto = require('./protocol');
const store = require('./store');
const { uniquePath } = require('../security');
const { renameSyncWithRetry } = require('../fsutil');
const { FileSender } = require('./sender');
const { FileReceiver } = require('./receiver');

// 发成功后把文件挪进 outbox/<对端>/sent/ 子目录。
// 不删：那是用户自己的文件，删掉太粗暴；但必须挪走，
// 否则它一直留在 outbox 里，每次目录变动都会被重新排进队列、再发一遍。
const SENT_DIRNAME = 'sent';

/**
 * 传输编排：按对端管理收发引擎，并把主通道上的 transfer-* 控制消息路由过去。
 *
 * 硬约束：**同一对端同时只允许一个传输**。
 * 这不是偷懒 —— 协议里的 transfer-ack 只有 receivedCount 一个累计值，
 * 没有传输 id，两个传输并行会让 ACK 张冠李戴。浏览器端也是这么限的
 * （"已有传输进行中，忽略"，js/transfer.js:536）。
 *
 * 出站走 outbox 自动发送：对端一连上，就把 ~/p2p-files/outbox/<peerId>/
 * 里的文件挨个发过去；会话期间新放进去的也会被 fs.watch 捡起来。
 * 收到的文件统一落在 ~/p2p-files/inbox/<peerId>/。
 */
class TransferManager extends EventEmitter {
    constructor({ cfg, logger }) {
        super();
        this.cfg = cfg;
        this.log = logger;
        this.peers = new Map();   // peerId -> { peer, incoming, outgoing, queue, watcher }
    }

    // ————————————————————— 对端生命周期 —————————————————————

    attach(peer) {
        const peerId = peer.peerId;
        let st = this.peers.get(peerId);
        if (!st) {
            st = {
                peer, incoming: null, outgoing: null,
                queue: [], sending: false, watcher: null,
                sentDir: path.join(this.cfg.outboxFor(peerId), SENT_DIRNAME),
                failed: new Set(),
            };
            this.peers.set(peerId, st);
        } else {
            st.peer = peer;      // 重连后指向新的 Peer 对象
        }
        this._syncOutbox(peerId);
        return st;
    }

    detach(peerId, reason) {
        const st = this.peers.get(peerId);
        if (!st) return;
        if (st.incoming && !st.incoming.done) st.incoming.abort(reason || 'peer gone');
        if (st.outgoing && !st.outgoing.done) st.outgoing.cancel(reason || 'peer gone');
        if (st.watcher) { try { st.watcher.close(); } catch (e) { /* 忽略 */ } st.watcher = null; }
        st.incoming = null;
        st.outgoing = null;
        st.queue = [];
        this.peers.delete(peerId);
    }

    get busy() {
        const out = {};
        for (const [id, st] of this.peers) {
            if (st.incoming || st.outgoing) {
                out[id] = {
                    direction: st.incoming ? 'receive' : 'send',
                    progress: st.incoming ? st.incoming.progress : st.outgoing.progress,
                };
            }
        }
        return out;
    }

    // ————————————————————— 出站：outbox 自动发送 —————————————————————

    /** 对端就绪：把 outbox 里排队的文件发过去 */
    onPeerReady(peer) {
        const st = this.peers.get(peer.peerId) || this.attach(peer);
        // 重连是一次新的机会，之前失败的可以再试一次
        st.failed.clear();
        this._syncOutbox(peer.peerId);
        this._drain(peer.peerId);
        return st;
    }

    /** 把 outbox 目录里的文件排进发送队列（可重复调用，已排过的不会重复） */
    _syncOutbox(peerId) {
        const st = this.peers.get(peerId);
        if (!st) return;
        // 先把目录建出来：fs.watch 在目录不存在时建不起来，
        // 那样「会话期间往 outbox 丢文件」就永远不会被发现
        const dir = store.ensureDir(this.cfg.outboxFor(peerId));

        let names;
        try { names = fs.readdirSync(dir); } catch (e) { return; }

        for (const name of names) {
            if (name.endsWith(store.PART_SUFFIX) || name.startsWith('.')) continue;
            const full = path.join(dir, name);
            let stat;
            try { stat = fs.statSync(full); } catch (e) { continue; }
            if (!stat.isFile()) continue;            // sent/ 子目录会在这里被跳过
            if (st.queue.includes(full)) continue;
            if (st.failed.has(full)) continue;       // 失败过的不自动重试，避免死循环
            st.queue.push(full);
        }
        if (st.queue.length) this.log.info('outbox 待发 ' + st.queue.length + ' 个文件');

        // 会话期间往 outbox 里丢文件也能自动发出去
        if (!st.watcher) {
            try {
                st.watcher = fs.watch(dir, () => {
                    setTimeout(() => { this._syncOutbox(peerId); this._drain(peerId); }, 200);
                });
                st.watcher.unref && st.watcher.unref();
            } catch (e) {
                this.log.debug('监视 outbox 失败（不影响手动发送）: ' + e.message);
            }
        }
    }

    /** 顺序发送队列里的文件（同一时刻只发一个） */
    async _drain(peerId) {
        const st = this.peers.get(peerId);
        if (!st || st.sending) return;
        if (st.incoming || st.outgoing) return;   // 同一对端同时只跑一个传输
        if (!st.queue.length) return;
        if (!st.peer.isOpen()) return;

        const file = st.queue.shift();

        // 目录监视事件会重复触发，同一个文件可能被重复排队；
        // 前一次发完已经把它挪进 sent/ 了，这里就什么也不做
        if (!fs.existsSync(file)) return this._drain(peerId);

        st.sending = true;
        try {
            await this._sendOne(st, file);
        } catch (e) {
            st.failed.add(file);
            this.log.error('发送 ' + path.basename(file) + ' 失败: ' + e.message);
            this.emit('send-failed', { peerId, path: file, error: e.message });
        } finally {
            st.sending = false;
        }
    }

    /**
     * 发成功后把文件挪进 sent/。
     * 挪不动也不能算传输失败 —— 文件已经完整送达对端了。
     */
    _archiveSent(st, filePath) {
        try {
            store.ensureDir(st.sentDir);
            const dest = uniquePath(st.sentDir, path.basename(filePath), fs.existsSync);
            renameSyncWithRetry(filePath, dest);
        } catch (e) {
            this.log.warn('发送成功但归档失败（文件仍在 outbox，可能被重发）: ' + e.message);
        }
    }

    async _sendOne(st, filePath) {
        const peerId = st.peer.peerId;
        const sender = new FileSender({
            peer: st.peer, filePath, cfg: this.cfg,
            logger: this.log.child ? this.log.child('send') : this.log,
        });
        st.outgoing = sender;

        sender.on('progress', (p) => this.emit('send-progress', { peerId, progress: p }));
        sender.on('done', (info) => {
            if (st.outgoing === sender) st.outgoing = null;
            this._archiveSent(st, filePath);
            this.log.info('已发出 ' + info.name);
            this.emit('sent', { peerId, info });
            setTimeout(() => this._drain(peerId), 100);
        });
        sender.on('failed', (why) => {
            if (st.outgoing === sender) st.outgoing = null;
            this.emit('send-failed', { peerId, path: filePath, error: why });
        });

        this.emit('send-start', { peerId, name: path.basename(filePath) });
        await sender.start();
    }

    /** 手动发送一个具体文件（p2p-ctl 用） */
    async sendFile(peer, filePath) {
        const st = this.peers.get(peer.peerId) || this.attach(peer);
        st.queue.push(filePath);
        await this._drain(peer.peerId);
    }

    // ————————————————————— 入站：控制消息与数据帧 —————————————————————

    /** 主通道上的 transfer-* 消息 */
    onControlMessage(peer, msg) {
        const peerId = peer.peerId;
        let st = this.peers.get(peerId);
        if (!st) st = this.attach(peer);

        switch (msg.type) {
            case 'transfer-header':
                return this._onHeader(st, msg);

            case 'transfer-ready':
                if (st.outgoing) st.outgoing.onReady();
                else this.log.debug('收到 transfer-ready 但没有在发的传输，忽略');
                return;

            case 'transfer-ack':
                if (st.outgoing) st.outgoing.onAck(msg);
                return;

            case 'transfer-resume':
                if (st.outgoing) st.outgoing.onResume(msg);
                return;

            case 'transfer-complete':
                if (st.outgoing) st.outgoing.onComplete();
                return;

            case 'transfer-cancel':
                this.log.warn('对端取消了传输');
                if (st.outgoing && !st.outgoing.done) st.outgoing.cancel('对端取消');
                if (st.incoming && !st.incoming.done) st.incoming.abort('对端取消');
                this.emit('cancelled', { peerId });
                return;

            default:
                this.log.debug('未知的传输控制消息: ' + msg.type);
        }
    }

    async _onHeader(st, msg) {
        const peerId = st.peer.peerId;

        if (st.incoming || st.outgoing) {
            this.log.warn('已有传输进行中，拒绝新的 transfer-header');
            st.peer.sendJson({ type: 'transfer-cancel' });
            return;
        }

        const receiver = new FileReceiver({
            peer: st.peer, header: msg, cfg: this.cfg,
            logger: this.log.child ? this.log.child('recv') : this.log,
        });
        st.incoming = receiver;

        receiver.on('progress', (p) => this.emit('recv-progress', { peerId, progress: p }));
        receiver.on('done', (info) => {
            if (st.incoming === receiver) st.incoming = null;
            this.emit('received', { peerId, info });
            setTimeout(() => this._drain(peerId), 100);
        });
        receiver.on('failed', (why) => {
            if (st.incoming === receiver) st.incoming = null;
            this.emit('recv-failed', { peerId, error: why });
        });
        receiver.on('rejected', (why) => {
            if (st.incoming === receiver) st.incoming = null;
            this.emit('recv-rejected', { peerId, error: why });
        });

        this.emit('recv-start', { peerId, name: msg.name, size: msg.size });
        try {
            await receiver.start();
        } catch (e) {
            if (st.incoming === receiver) st.incoming = null;
            this.log.error('接收初始化失败: ' + e.message);
            st.peer.sendJson({ type: 'transfer-cancel' });
            this.emit('recv-failed', { peerId, error: e.message });
        }
    }

    /** 4 条文件通道上的二进制帧 */
    onBulkData(peer, buf) {
        const st = this.peers.get(peer.peerId);
        if (!st || !st.incoming || st.incoming.done) return;
        st.incoming.onFrame(buf);
    }
}

module.exports = { TransferManager };
