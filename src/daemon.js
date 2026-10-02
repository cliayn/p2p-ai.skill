'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const { SignalingClient } = require('./signaling');
const { Peer } = require('./peer');
const { SessionStore, listClaudeSessions } = require('./session-store');
const { Conversation, ACK_TEXT } = require('./conversation');
const { ClaudeScheduler } = require('./scheduler');
const { createLogger } = require('./logger');
const { generateRoomId, validateRoomId } = require('./roomid');
const { loadOrCreateRoomKey } = require('./roomkey');
const { TransferManager } = require('./transfer/manager');
const { isTransferMessage } = require('./transfer/protocol');
const { fmt: fmtBytes } = require('./transfer/store');
const { ControlServer } = require('./control');

// 列给对端的会话条数上限。挑一条接着聊用不了几十条，
// 列得越长越像在把整台机器的历史摊开给对面看。
const SESSION_LIST_MAX = 10;

/**
 * 顶层编排：信令 <-> 对端 <-> 对话 <-> claude 调度。
 *
 * 两种模式：
 *   'listen'  —— 守在房间里，谁来连都自动同意
 *   'connect' —— 主动去连房间里的第一个可用对端
 */
class Daemon extends EventEmitter {
    constructor(config, opts) {
        super();
        opts = opts || {};
        this.cfg = config;
        this.mode = opts.mode || 'listen';
        this.log = createLogger('daemon');

        // 目录得先建好：自动生成房间号要用状态目录里的密钥文件。
        // （以前 _ensureDirs 在构造函数末尾，密钥写到一半会因为目录不存在而失败。）
        this._ensureDirs();

        this.roomKey = null;
        if (config.roomId) {
            this.roomId = config.roomId;
        } else {
            // 只有自动生成才要密钥。手填房间号时没有它的用武之地，
            // 不该让一个用不到的私钥白白出现在磁盘上。
            this.roomKey = loadOrCreateRoomKey(config.stateDir, this.log.child('roomkey'));
            this.roomId = generateRoomId({ key: this.roomKey });
        }

        this.peers = new Map();          // peerId -> Peer（当前活着的连接）
        this.conversations = new Map();  // peerId -> Conversation（跨重连保留）
        this.pendingRequests = new Set();// 已发出 connect_request 但还没回应的
        this.stopping = false;

        this.scheduler = new ClaudeScheduler({
            maxConcurrent: config.maxConcurrentClaude,
            logger: this.log.child('sched'),
        });
        this.store = new SessionStore({ dir: config.stateDir, logger: this.log.child('store') });
        this.transfers = new TransferManager({ cfg: config, logger: this.log.child('xfer') });
        this._wireTransfers();
        this.signaling = null;
    }

    /** 自己这一端的信令 id，由服务端在连接后分配；没连上时是 null */
    get myId() {
        return this.signaling ? this.signaling.myId : null;
    }

    _ensureDirs() {
        for (const d of [this.cfg.stateDir, this.cfg.inboxDir, this.cfg.outboxDir]) {
            fs.mkdirSync(d, { recursive: true });
        }
    }

    /** 传输结果转成给人看的一行 stdout + 给模型的一条上下文 */
    _wireTransfers() {
        const t = this.transfers;

        t.on('recv-start', ({ peerId, name, size }) => {
            process.stdout.write('  📥 ' + peerId + ' 正在发送 ' + name +
                '（' + fmtBytes(size) + '）\n');
        });
        t.on('send-start', ({ peerId, name }) => {
            process.stdout.write('  📤 正在发送 ' + name + ' 给 ' + peerId + '\n');
        });

        t.on('received', ({ peerId, info }) => {
            process.stdout.write('  📥 ' + peerId + ' 发送的文件已保存: ' + info.path + '\n');
            const conv = this.conversations.get(peerId);
            if (conv) {
                conv.onFileReceived({
                    name: info.name, size: info.size, path: info.path,
                }).catch((e) => this.log.warn('记录文件备注失败: ' + e.message));
            }
        });
        t.on('sent', ({ peerId, info }) => {
            process.stdout.write('  📤 ' + info.name + ' 已发送给 ' + peerId + '\n');
        });

        t.on('recv-failed', ({ peerId, error }) => {
            process.stdout.write('  ⚠️  ' + peerId + ' 的文件接收失败: ' + error + '\n');
        });
        t.on('recv-rejected', ({ peerId, error }) => {
            process.stdout.write('  ⚠️  已拒绝 ' + peerId + ' 的文件: ' + error + '\n');
        });
        t.on('send-failed', ({ peerId, path, error }) => {
            process.stdout.write('  ⚠️  发送 ' + path + ' 给 ' + peerId + ' 失败: ' + error + '\n');
        });
    }

    get stats() {
        return {
            roomId: this.roomId,
            myId: this.myId,
            signalingConnected: !!(this.signaling && this.signaling.connected),
            mode: this.mode,
            peers: Array.from(this.peers.keys()),
            conversations: Array.from(this.conversations.keys()),
            scheduler: this.scheduler.stats,
        };
    }

    // ————————————————————— 启动 / 停止 —————————————————————

    start() {
        this.log.info('启动，房间号 ' + this.roomId + '，模式 ' + this.mode);
        try {
            fs.writeFileSync(this.cfg.roomIdFile, this.roomId, 'utf8');
        } catch (e) {
            this.log.debug('写房间号文件失败: ' + e.message);
        }

        this.signaling = new SignalingClient({
            url: this.cfg.signalUrl,
            roomId: this.roomId,
            logger: this.log.child('sig'),
        });
        this._wireSignaling();

        this.signaling.connect();

        this.control = new ControlServer({
            daemon: this,
            sockPath: this.cfg.controlSock,
            logger: this.log.child('ctl'),
        });
        this.control.start();

        return this;
    }

    async stop(reason) {
        if (this.stopping) return;
        this.stopping = true;
        this.log.info('正在退出（' + (reason || '') + '）');

        for (const conv of this.conversations.values()) conv.stop();

        const closes = [];
        for (const peer of this.peers.values()) closes.push(peer.close('shutdown').catch(() => {}));
        await Promise.all(closes);

        if (this.control) this.control.stop();
        if (this.signaling) this.signaling.close();

        // 退出路径要同步落盘，异步的 await 可能来不及
        this.store.flushAllSync();
        this.log.info('已退出');
    }

    // ————————————————————— 信令事件 —————————————————————

    _wireSignaling() {
        const sig = this.signaling;

        sig.on('open', () => {
            this.log.info('信令就绪');
            this.emit('signaling-open');
        });

        sig.on('close', () => {
            // 注意：信令断了不代表 P2P 断了，这里什么都不做，只是日志
            this.log.warn('信令断开（P2P 链路不受影响）');
        });

        sig.on('connect_request', (m) => this._onConnectRequest(m));
        sig.on('connect_accept', (m) => this._onConnectAccept(m));
        sig.on('connect_reject', (m) => this._onConnectReject(m));
        sig.on('offer', (m) => this._onOffer(m));
        sig.on('answer', (m) => this._onAnswer(m));
        sig.on('ice', (m) => this._onIce(m));
        sig.on('same_network_clients', (m) => this._onClients(m));
        sig.on('new_peer', (m) => this._onNewPeer(m));
        sig.on('peer_left', (m) => this._onPeerLeft(m));
    }

    _allowed(peerId) {
        const list = this.cfg.allowedPeers;
        if (!list || !list.length) return true;
        return list.includes(peerId);
    }

    /** 有人请求连接：默认直接同意，不弹任何确认 */
    async _onConnectRequest(msg) {
        const from = msg.from;
        if (!from || from === this.signaling.myId) return;

        if (!this._allowed(from)) {
            this.log.warn('拒绝未在白名单内的对端 ' + from);
            this.signaling.send('connect_reject', from);
            return;
        }

        if (this.peers.has(from)) {
            this.log.info('已有与 ' + from + ' 的连接，忽略重复请求');
            return;
        }

        if (!this.cfg.autoAccept) {
            this.log.info('autoAccept 关闭，忽略 ' + from + ' 的连接请求');
            return;
        }

        this.log.info('自动同意 ' + from + ' 的连接请求');
        const peer = this._createPeer(from, 'answerer');
        this.signaling.send('connect_accept', from);
        this.emit('peer-connecting', from);
        // 接下来等对方的 offer
    }

    /** 我们主动发起的请求被接受了：我们当 offerer，出 offer */
    async _onConnectAccept(msg) {
        const from = msg.from;
        if (!from) return;
        this.pendingRequests.delete(from);

        if (this.peers.has(from)) {
            this.log.info('与 ' + from + ' 的连接已存在，忽略');
            return;
        }

        this.log.info(from + ' 接受了连接，作为发起方出 offer');
        const peer = this._createPeer(from, 'offerer');
        try {
            const offer = await peer.startAsOfferer();
            this.signaling.send('offer', from, offer);
        } catch (e) {
            this.log.error('生成 offer 失败: ' + e.message);
            await peer.close('offer-failed');
        }
    }

    _onConnectReject(msg) {
        const from = msg.from;
        this.pendingRequests.delete(from);
        this.log.info(from + ' 拒绝了连接');
        this.emit('peer-rejected', from);
    }

    async _onOffer(msg) {
        const from = msg.from;
        const peer = this.peers.get(from);
        if (!peer) {
            this.log.warn('收到来自未知对端 ' + from + ' 的 offer（可能是信令竞态），忽略');
            return;
        }
        if (peer.role !== 'answerer') {
            this.log.warn('收到 offer 但本端角色是 ' + peer.role + '，忽略');
            return;
        }
        try {
            const answer = await peer.acceptOffer(msg.payload);
            this.signaling.send('answer', from, answer);
        } catch (e) {
            this.log.error('处理 offer 失败: ' + e.message);
            await this._dropPeer(peer, 'offer-failed');
        }
    }

    async _onAnswer(msg) {
        const from = msg.from;
        const peer = this.peers.get(from);
        if (!peer) {
            this.log.warn('收到来自未知对端 ' + from + ' 的 answer，忽略');
            return;
        }
        if (peer.role !== 'offerer') {
            this.log.warn('收到 answer 但本端角色是 ' + peer.role + '，忽略');
            return;
        }
        try {
            await peer.applyAnswer(msg.payload);
        } catch (e) {
            this.log.error('应用 answer 失败: ' + e.message);
            await this._dropPeer(peer, 'answer-failed');
        }
    }

    /**
     * trickle ICE。
     *
     * 协议缺陷：入站的 ice 消息**不带 from**，无法判断是哪个对端发的。
     * 好在我们自己收集的候选已经内联在 offer/answer 里了，
     * 这里是兜底路径：所有还在协商中的对端都试一遍，
     * 候选与连接不匹配时 werift 会直接忽略，没有副作用。
     */
    async _onIce(msg) {
        const cand = msg.payload;
        if (typeof cand !== 'string' || !cand) return;
        for (const peer of this.peers.values()) {
            if (peer.closed) continue;
            await peer.addRemoteIce(cand);
        }
    }

    _onClients(msg) {
        const clients = (msg.clients || []).filter((id) => id !== this.signaling.myId);
        this.log.debug('同房间设备: ' + (clients.join(', ') || '无'));
        this.emit('clients', clients);
        if (this.mode === 'connect') this._tryConnectToAnyone(clients);
    }

    _onNewPeer(msg) {
        const id = msg.peer_id;
        if (!id || id === this.signaling.myId) return;
        this.log.info('新设备加入房间: ' + id);
        this.emit('new-peer', id);
        if (this.mode === 'connect') this._tryConnectToAnyone([id]);
    }

    /**
     * 关键：peer_left 不能当作断开信号。
     *
     * 浏览器端在 P2P 连接成功后就会主动关掉信令 WebSocket（js/main.js），
     * 所以服务端会为**数据通道还活着**的对端发 peer_left。
     * 真正的存活判定只看 DataChannel。
     */
    _onPeerLeft(msg) {
        const id = msg.peer_id;
        const alive = this.peers.get(id);
        if (alive) {
            this.log.info('信令显示 ' + id + ' 离开，但其 P2P 链路仍然存活，继续保留');
        } else {
            this.log.debug('信令显示 ' + id + ' 离开（本端无连接）');
        }
        this.emit('peer-left', id);
    }

    // ————————————————————— 主动连接 —————————————————————

    _tryConnectToAnyone(candidates) {
        if (this.stopping) return;

        // 指定了目标就只认它。房间号短/固定的时候房间里可能挤着好几个人，
        // 「连第一个」会连到谁全看服务端给的顺序 —— 那不是选择，是抽签。
        const target = this.cfg.targetPeer;
        if (target) {
            // 别把自己当目标。上游的 candidates 已经滤过一遍 myId，
            // 但这里的代价只有一行，而连自己会一直卡在 pendingRequests 上。
            if (target === this.signaling.myId) return;
            if (candidates.indexOf(target) < 0) {
                this.log.debug('目标 ' + target + ' 还没出现在房间里（当前 ' +
                    (candidates.join(', ') || '无') + '）');
                return;
            }
            if (this.peers.has(target) || this.pendingRequests.has(target)) return;
            this.connectTo(target);
            return;
        }

        for (const id of candidates) {
            if (!id || id === this.signaling.myId) continue;
            if (this.peers.has(id) || this.pendingRequests.has(id)) continue;
            // 只有真发出去了才收手。以前这里无条件 return，
            // 于是第一个候选被白名单挡掉时，后面的候选再也不会被试到 ——
            // 明明房间里有个能连的，却一直干等。
            if (this.connectTo(id)) return;   // 一次只发起一个，避免和多个对端同时协商
        }
    }

    connectTo(peerId) {
        if (!this._allowed(peerId)) {
            this.log.warn('目标 ' + peerId + ' 不在白名单内，不发起连接');
            return false;
        }
        if (!this.signaling || !this.signaling.connected) {
            this.log.warn('信令未连接，暂不能发起连接');
            return false;
        }
        this.pendingRequests.add(peerId);
        this.log.info('请求连接 ' + peerId);
        this.signaling.send('connect_request', peerId);
        return true;
    }

    // ————————————————————— 对端生命周期 —————————————————————

    _createPeer(peerId, role) {
        const peer = new Peer({
            peerId,
            role,
            config: this.cfg,
            logger: this.log.child('peer'),
        });
        this.peers.set(peerId, peer);
        this._wirePeer(peer);
        return peer;
    }

    /** 取（或创建）该对端的对话对象；同一对端重连时复用 */
    _conversationFor(peer) {
        let conv = this.conversations.get(peer.peerId);
        if (!conv) {
            conv = new Conversation({
                peer,
                store: this.store,
                scheduler: this.scheduler,
                config: this.cfg,
                logger: this.log.child('conv'),
            });
            this.conversations.set(peer.peerId, conv);
        } else {
            conv.attach(peer);
        }
        return conv;
    }

    /**
     * 给网页回一份「有哪些历史对话」的清单。
     *
     * 会话必须来自 cfg.workdir —— claude 的会话 JSONL 是按工作目录分目录存的，
     * 换个目录的 id 拿过来 --resume 也找不到。
     *
     * ⚠ 这是本项目里唯一一处把**工作目录以外的数据**交给对端的地方：
     * 列表里的 preview 就是运营方过去对话的开头几十个字。对话模型本身没有工具、
     * 读不到这些文件，所以这条通道确实是在默认姿态上新开的一个口子。
     * 房间号不好猜，威胁模型是「被请进房间的人」，但连陌生人时仍然应该关掉 ——
     * 用 --no-session-list / SESSION_LIST=0。
     */
    _sendSessionList(peer, error) {
        const conv = this.conversations.get(peer.peerId);
        const msg = {
            type: 'ai-sessions-list',
            current: (conv && conv.sessionId) || null,
            sessions: this.cfg.sessionList ? this._sessionBrief() : [],
        };
        // 关了列表也要回一条 —— 不回的话对面会一直卡在「正在获取…」
        if (!this.cfg.sessionList) {
            msg.error = '这台机器的运营方关掉了历史会话列表（--no-session-list）';
        } else if (error) {
            msg.error = error;
        }
        peer.sendJson(msg);
    }

    /**
     * 列表只给「挑哪一条」需要的元信息：id、时间、大小。
     *
     * 特意**不带 preview**。早先是把最多 30 条会话的开头几十个字一起塞过去的，
     * 结果是一次请求就把这台机器上所有历史对话的内容各漏一段 —— 既吵（网页上糊一大片），
     * 又是没必要的一次性暴露。现在要看某一条的内容得单独点名（见 _sendSessionPeek），
     * 一次只出去一条，对端不问就没有。
     */
    _sessionBrief() {
        if (!this.cfg.sessionList) return [];
        return listClaudeSessions(this.cfg.workdir).slice(0, SESSION_LIST_MAX).map((s) => ({
            sessionId: s.sessionId,
            mtime: s.mtime,
            size: s.size,
        }));
    }

    /**
     * 对端点名要看某一条会话的内容（网页上点「看内容」）。
     * 校验方式和 _applyAiMode 一样是白名单：只在当前列表里找，找不到就什么都不给，
     * 免得这个入口变成「随便拿个 id 就能读文件」。
     */
    _sendSessionPeek(peer, sessionId) {
        const reply = (extra) => peer.sendJson(Object.assign({
            type: 'ai-session-peek',
            sessionId: sessionId == null ? null : String(sessionId),
        }, extra || {}));

        if (!this.cfg.sessionList) {
            reply({ error: '这台机器的运营方关掉了历史会话列表（--no-session-list）' });
            return;
        }
        if (sessionId == null) { reply({ error: '没给 sessionId' }); return; }

        const want = String(sessionId);
        const hit = listClaudeSessions(this.cfg.workdir).find((s) => s.sessionId === want);
        if (!hit) { reply({ error: '找不到这个会话（可能已被删除）' }); return; }

        this.log.debug(peer.peerId + ' 查看会话内容 ' + want);
        reply({ preview: String(hit.preview || '').replace(/\s+/g, ' ').slice(0, 200) });
    }

    /** 网页请求把对话链切到某个历史会话（sessionId 为 null = 开新对话） */
    async _applyAiMode(peer, msg) {
        const conv = this.conversations.get(peer.peerId);
        if (!conv) {
            this._sendSessionList(peer, '对端还没有建立对话');
            return;
        }

        const want = msg.sessionId == null ? null : String(msg.sessionId);

        // 关掉列表之后只允许「开新对话」。切到某条历史会话本质上还是要先看到列表，
        // 拦在这里才是一致的行为 —— 否则知道 sessionId 的人照样能把它挖出来聊。
        if (want !== null && !this.cfg.sessionList) {
            this.log.warn(peer.peerId + ' 请求续接历史会话，但本机已关闭会话列表');
            this._sendSessionList(peer);
            return;
        }

        // 校验它真的存在。不校验的话 --resume 会白起一个 claude 进程再失败；
        // 顺带也挡住了对端塞任意字符串进来。
        if (want !== null && !this._sessionBrief().some((s) => s.sessionId === want)) {
            this.log.warn(peer.peerId + ' 请求续接一个不存在的会话: ' + want);
            this._sendSessionList(peer, '找不到这个会话（可能已被删除）');
            return;
        }

        await conv.setSession(want);
        this._sendSessionList(peer);
    }

    _wirePeer(peer) {
        const conv = this._conversationFor(peer);
        peer.__conv = conv;
        this.transfers.attach(peer);

        peer.on('open', () => {
            this.log.info(peer.peerId + ' 数据通道已打开');
        });

        peer.on('ready', async () => {
            this.log.info(peer.peerId + ' 双方就绪');
            this.emit('peer-ready', peer.peerId);

            // 连上后主动开场（AI 对 AI 时由发起方用 --say 触发）
            if (this.cfg.openingMessage && !peer.__opened) {
                peer.__opened = true;
                this.log.info('发出开场白');
                conv.sayOpening(this.cfg.openingMessage);
            }

            // 重放掉线期间积压的消息 / 补发未送达的回复
            await conv.onPeerBack();

            // 把 outbox 里排队的文件发过去（有就发，没有就是空操作）
            try {
                this.transfers.onPeerReady(peer);
            } catch (e) {
                this.log.error('启动文件发送失败: ' + e.message);
            }
        });

        // 文件传输的控制消息走主通道，数据帧走 4 条 tf-ch-* 通道
        peer.on('message', (m) => {
            if (!m || !isTransferMessage(m.type)) return;
            try {
                this.transfers.onControlMessage(peer, m);
            } catch (e) {
                this.log.error('处理传输消息失败: ' + e.message);
            }
        });

        peer.on('bulk-data', ({ data }) => {
            try {
                this.transfers.onBulkData(peer, data);
            } catch (e) {
                this.log.error('处理文件数据失败: ' + e.message);
            }
        });

        peer.on('ice', (raw) => {
            this.signaling.send('ice', peer.peerId, raw);
        });

        peer.on('chat', (m) => {
            if (typeof m.text !== 'string') return;
            // 打到 stdout，这样 AI 对 AI 时人也能看到整段对话
            if (m.text !== ACK_TEXT) {
                process.stdout.write('  💬 ' + peer.peerId + ': ' + m.text + '\n');
            }
            conv.onPeerMessage(m).catch((e) => {
                this.log.error('处理消息失败: ' + e.message);
            });
        });

        // 对端重连后会把断线期间缓存的消息一次性补发过来
        peer.on('messages-flush', (m) => {
            const list = (m.messages || []).filter((x) => x && x.type === 'chat' && typeof x.text === 'string');
            this.log.info('收到 ' + list.length + ' 条补发消息');
            for (const x of list) {
                conv.onPeerMessage(x).catch(() => {});
            }
        });

        // 对端正在打开文件选择器（安卓端会切后台），无需处理，仅记录
        peer.on('file-selecting', () => {});

        // —— 网页那边的「对话模式」面板：看历史会话、切对话链 ——
        peer.on('ai-sessions', () => {
            this._sendSessionList(peer);
        });

        peer.on('ai-mode', (m) => {
            this._applyAiMode(peer, m).catch((e) => {
                this.log.error('切换会话失败: ' + e.message);
                this._sendSessionList(peer, '切换失败: ' + e.message);
            });
        });

        // 列表里只有元信息，要看某一条讲了什么得单独点名 —— 一次只给一条
        peer.on('ai-session-peek', (m) => {
            try {
                this._sendSessionPeek(peer, m && m.sessionId);
            } catch (e) {
                this.log.error('读取会话内容失败: ' + e.message);
                peer.sendJson({
                    type: 'ai-session-peek',
                    sessionId: (m && m.sessionId) || null,
                    error: '读取失败: ' + e.message,
                });
            }
        });

        peer.on('disconnect', () => {
            this.log.info(peer.peerId + ' 主动断开');
            peer.close('peer disconnect');
        });

        peer.on('failed', (why) => {
            this.log.warn(peer.peerId + ' 连接失败: ' + why);
            this._dropPeer(peer, why).catch(() => {});
        });

        peer.on('closed', () => {
            this._dropPeer(peer, 'closed').catch(() => {});
        });
    }

    async _dropPeer(peer, reason) {
        // 收尾会触发多条事件链（pc.close() -> connectionState 'closed' -> failed，
        // 以及 close() 自身 emit 的 'closed'），不设闸会重入并重复上报断开
        if (peer.__dropped) return;
        peer.__dropped = true;

        const peerId = peer.peerId;
        if (this.peers.get(peerId) === peer) this.peers.delete(peerId);
        // 对话对象保留：会话链和积压队列都在 store 里，重连即续上
        if (peer.__conv) peer.__conv.onPeerGone();
        // 传输不能跨连接续：半截的收/发都中止掉
        this.transfers.detach(peerId, reason);
        this.emit('peer-gone', peerId, reason);
        try { await peer.close(reason); } catch (e) { /* 已关闭 */ }
    }
}

module.exports = { Daemon };
