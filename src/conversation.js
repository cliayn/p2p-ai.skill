'use strict';

const fs = require('fs');
const { runClaude } = require('./claude-runner');
const { TokenBucket } = require('./security');
const { PERSONA_OPEN, PERSONA_CLOSE } = require('./session-store');

/**
 * 一个对端的对话状态机。
 *
 * 会话链的核心规则（这条决定了中断行为是否正确）：
 *
 *   —— 新的 session_id 只在**整轮成功之后**才提交。
 *
 *   claude 的 system/init 事件在生成一开始就带 session_id 了，
 *   看起来很适合立刻落盘。但那样一旦中途被取消（对端掉线/超时），
 *   我们就把续接点推进到了一个只含用户提问、没有回答的残缺会话。
 *   所以：init 的 id 只放内存，成功后才 promote 成正式的续接点。
 *
 *   失败时一律把消息留在队列里，重连后对着**旧**会话重放，
 *   残缺会话直接丢弃（只是留下一个用不到的 JSONL 文件）。
 *   这样既不会丢消息，也不会答两遍。
 */

// 生成开始前先回一句，避免对端长时间毫无反应。
// 注意：协议里没有「正在输入」这种消息类型，只能真的发一条 chat。
const ACK_TEXT = '收到，让我想一下 ~';

const DEFAULT_PERSONA = [
    '你是通过 WebRTC P2P 直连与对方通信的 Claude Code 实例。',
    '对方可能是浏览器用户，也可能是另一个 AI 实例。',
    '',
    '通信须知：',
    '- 回复会以「段」为单位实时发送，请用自然、简洁的口语化中文（除非对方使用其他语言）。',
    '- 这是点对点聊天通道，不是文档，回答长度控制在几段以内。',
    '',
    '对方的聊天窗口能渲染下面这些。要展示数据就用起来，别把一串数字堆成一段话：',
    '- Markdown：加粗、斜体、行内代码、标题、有序/无序列表、引用、分割线、表格、链接、代码块。',
    '- ```chart 代码块：画图。里面写 JSON，type 支持 line（折线）/ bar（柱状）/ pie（饼图）/ candlestick（K线）。',
    '- ```mermaid 代码块：流程图。',
    '各类型的字段写法见 p2p-chat 技能的「客户端渲染能力」一节（K 线的数据顺序是 [open, close, low, high]）。',
].join('\n');

class Conversation {
    constructor({ peer, store, scheduler, config, logger, runner }) {
        this.peer = peer;
        this.peerId = peer.peerId;
        this.store = store;
        this.scheduler = scheduler;
        this.cfg = config;
        this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
        this.runner = runner || runClaude;

        this.generating = false;
        this._pendingSessionId = null;
        this._runningBase = null;        // 当前这一轮是从哪条会话起跑的
        this._ackPending = false;
        this._submitted = new Set();     // 已提交给调度器的 seq，避免重放时重复提交
        this._stopped = false;
        // 跨重连累计，不随 attach 重置 —— 否则反复重连可以绕过回复上限
        this._replyCount = 0;

        this.bucket = new TokenBucket({
            rate: config.rateMsgsPerSec,
            burst: Math.max(3, config.rateMsgsPerSec * 2),
            bytesRate: config.rateBytesPerSec,
            bytesBurst: config.rateBytesPerSec * 4,
        });

        // 给 claude 的人格
        this.persona = DEFAULT_PERSONA;
        if (config.persona) {
            try {
                this.persona = fs.readFileSync(config.persona, 'utf8');
            } catch (e) {
                this.log.warn('读取人格文件失败，改用内置人格: ' + e.message);
            }
        }
    }

    get sessionId() {
        return this.store.get(this.peerId).sessionId;
    }

    /**
     * 把这条对话链切到某个历史会话上（null = 开新对话）。
     *
     * 只改存储就够了：下一次 _exec 会自然 --resume 它。
     * 但如果此刻正好有一轮在跑，那一轮结束后会把会话推进到它自己产生的新 id，
     * 把用户刚选的会话覆盖掉 —— 所以 _exec 起跑时要记下当时用的是哪条，
     * _onDone 推进前先比对（见 _runningBase）。
     */
    async setSession(sessionId) {
        const next = sessionId || null;
        if (this.sessionId === next) return;
        await this.store.advanceSession(this.peerId, next);
        this.log.info('会话已切换 -> ' + (next || '(新对话)'));
    }

    /**
     * 把一个新建立的连接挂到这个对话上。
     *
     * 同一对端重连时复用同一个 Conversation 对象，而不是新建：
     * 这样内存里的状态不会和持久化状态打架，会话链天然延续。
     * 此刻该对端在调度器里的旧任务已被 cancelPeer 清空，
     * 所以清掉 _submitted 再重放持久化队列是安全的。
     */
    attach(peer) {
        this.peer = peer;
        this.peerId = peer.peerId;
        this._stopped = false;
        this.generating = false;
        this._pendingSessionId = null;
        this._runningBase = null;
        this._ackPending = false;
        this._submitted.clear();
    }

    /**
     * 对端发来一条聊天消息。
     * @param {{text:string, seq?:number, ts?:number, ack?:boolean}} msg
     */
    async onPeerMessage(msg) {
        if (this._stopped) return;
        const text = String(msg && msg.text != null ? msg.text : '');
        const seq = msg && msg.seq;
        const ts = msg && msg.ts;
        const s = this.store.get(this.peerId);

        // 去重 / 丢弃乱序的旧消息
        if (typeof seq === 'number') {
            if (seq <= s.lastInboundSeq) {
                this.log.debug('忽略重复或乱序消息 seq=' + seq + '（已见 ' + s.lastInboundSeq + '）');
                return;
            }
            s.lastInboundSeq = seq;
        }

        // 对方的"稍等"回执。协议里没有独立的 typing 消息类型，它就是一条真的 chat：
        // 对人只是提示，对 AI 却会被当成一个问题、白跑一整轮 claude。
        if (msg && msg.ack === true) {
            this.log.debug('收到对端的回执，跳过');
            this.store.save(this.peerId);
            return;
        }

        // 只收不发：两个都开着自动回复的 AI 会无限互相回下去
        if (!this.cfg.autoReply) {
            this.log.info('收到（autoReply 已关闭，不回复）: ' + text.slice(0, 80));
            this.store.save(this.peerId);
            return;
        }

        if (this._replyCount >= this.cfg.maxRepliesPerPeer) {
            this.log.warn('对端 ' + this.peerId + ' 已达回复上限 ' + this.cfg.maxRepliesPerPeer + '，本条不再回复');
            return;
        }

        // 限流：对端可以疯狂刷
        if (!this.bucket.take(Buffer.byteLength(text, 'utf8'))) {
            this.log.warn('对端 ' + this.peerId + ' 触发限流，丢弃消息');
            return;
        }

        if (s.queue.length >= this.cfg.maxQueuePerPeer) {
            this.log.warn('对端 ' + this.peerId + ' 队列已满（' + s.queue.length + '），丢弃消息');
            return;
        }

        // 入队条目（参数名已经占用 msg，这里另取一个名字）
        const entry = {
            seq: typeof seq === 'number' ? seq : (++s.lastInboundSeq),
            text,
            ts: ts || Date.now(),
            attempts: 0,
        };

        // 先落盘再调 claude —— 顺序反了的话崩溃会丢用户消息
        await this.store.enqueue(this.peerId, entry);
        this.log.info('收到消息 seq=' + entry.seq + ' 长度=' + text.length);

        if (!this.generating) this._ackPending = true;
        this._dispatch(entry);
    }

    /** 收到文件后记一条上下文，等下一次提问时告知模型 */
    async onFileReceived(note) {
        await this.store.addNote(this.peerId, Object.assign({ kind: 'file', announced: false }, note));
    }

    /** 对端掉线 */
    onPeerGone() {
        this.scheduler.cancelPeer(this.peerId, 'peer disconnected');
        this.generating = false;
        this._pendingSessionId = null;
        this._ackPending = false;
        // 注意：不提交 pendingSessionId，队列里的消息原样保留待重放
    }

    /** 对端回来了（同一 peerId 重连，或重启后加载旧状态） */
    async onPeerBack() {
        this._stopped = false;

        const und = await this.store.takeUndelivered(this.peerId);
        for (const m of und) {
            this.log.info('补发掉线期间的回复 seq=' + m.seq);
            this._sendChat(m.text);
        }

        // 重放没处理完的消息
        const s = this.store.get(this.peerId);
        for (const msg of s.queue.slice()) this._dispatch(msg);
    }

    stop() {
        this._stopped = true;
        this.scheduler.cancelPeer(this.peerId, 'conversation stopped');
    }

    // ————————————————————————— 内部 —————————————————————————

    _dispatch(msg) {
        if (this._submitted.has(msg.seq)) return;
        this._submitted.add(msg.seq);

        this.scheduler.submit({
            peerId: this.peerId,
            exec: (ctx) => this._exec(msg, ctx),
            onDone: (result, err) => this._onDone(msg, result, err),
        });
    }

    /** 连上后主动开场（AI 对 AI 时由发起方调用） */
    sayOpening(text) {
        this._ackPending = false;
        this._sendChat(text);
    }

    /** 运营方从外部注入一条消息（p2p-ctl say），同样不触发 claude */
    say(text) {
        this._sendChat(text);
    }

    async _exec(msg, ctx) {
        this.generating = true;
        this._pendingSessionId = null;
        this._replyCount++;

        if (this._ackPending && this.cfg.ackMode === 'once') {
            // 带 ack 标记：浏览器只是显示它，AI 对端则会跳过而不为它跑一轮 claude
            this._sendChat(ACK_TEXT, { ack: true });
        }

        // 记下这一轮是从哪条会话起跑的。_onDone 推进会话前要拿它比对：
        // 中途被 setSession 换过的话，用户的选择优先，不能被这一轮覆盖。
        // 每对端严格串行，所以一个字段就够，不需要按 seq 存。
        this._runningBase = this.sessionId;
        const resumeFrom = this._runningBase;
        const runOpts = this._runOptions(resumeFrom, msg, ctx);

        let result;
        try {
            result = await this.runner(runOpts);
        } catch (e) {
            result = { ok: false, error: e.message, aborted: false, timedOut: false, chunks: [] };
        }
        return result;
    }

    _runOptions(resumeFrom, msg, ctx) {
        const cfg = this.cfg;

        // 人格只在**新建会话**时注入；续接时历史里已经有了，重复注入会污染。
        // 包上一对围栏：这段会成为会话 JSONL 的第一条用户消息，而对端「看内容」
        // 拿的就是会话开头，不围起来的话每条会话的预览都是同一段模板。
        const fresh = !resumeFrom;
        const promptParts = [];
        if (fresh) promptParts.push(PERSONA_OPEN + '\n' + this.persona + '\n' + PERSONA_CLOSE, '');

        const s = this.store.get(this.peerId);
        const unannounced = s.notes.filter((n) => !n.announced);
        if (unannounced.length) {
            for (const n of unannounced) {
                n.announced = true;
                promptParts.push('[收到文件] ' + n.name + '（' + formatBytes(n.size) + '，已保存到 ' + n.path + '）');
            }
            promptParts.push('');
        }

        promptParts.push(msg.text);

        const useTools = cfg.allowedTools.length > 0;

        return {
            bin: cfg.claudeBin,
            model: cfg.model,
            fallbackModel: cfg.fallbackModel,
            prompt: promptParts.join('\n'),
            sessionId: resumeFrom,
            cwd: cfg.workdir,
            timeoutMs: cfg.timeoutMs,
            signal: ctx.signal,
            extraArgs: cfg.extraArgs,
            allowedTools: cfg.allowedTools,
            disallowedTools: cfg.disallowedTools,
            // 开了工具就必须跳过权限确认，否则 -p 模式下会卡住直到超时
            skipPermissions: useTools,
            addDirs: useTools ? [cfg.inboxDir, cfg.outboxDir] : [],
            logger: this.log,
            onSessionId: (sid) => { this._pendingSessionId = sid; },
            onAssistantText: (t) => this._emit(t),
        };
    }

    /** 流式输出：每个 assistant 文本块作为一条消息发出 */
    _emit(text) {
        if (this._stopped) return;
        this._ackPending = false;
        this._sendChat(text);
    }

    _sendChat(text, extra) {
        const s = this.store.get(this.peerId);
        const msg = Object.assign(
            { type: 'chat', text, seq: ++s.lastSeq, ts: Date.now() },
            extra || {}
        );

        if (this.peer.isOpen()) {
            const ok = this.peer.sendJson(msg);
            if (!ok) {
                this.store.addUndelivered(this.peerId, msg);
                this.log.warn('发送失败，转入待补发 seq=' + msg.seq);
            } else {
                this.store.save(this.peerId);
            }
        } else {
            this.store.addUndelivered(this.peerId, msg);
            this.log.info('对端不在线，回复记为待补发 seq=' + msg.seq);
        }
    }

    async _onDone(msg, result, err) {
        this.generating = false;
        const s = this.store.get(this.peerId);

        if (err) {
            // 被取消（对端掉线 / 主动 stop）：保留队列，下次重放
            this.log.info('任务取消 seq=' + msg.seq + '：' + err.message);
            this._pendingSessionId = null;
            this._submitted.delete(msg.seq);
            this._ackPending = false;
            return;
        }

        const failed = !result || !result.ok;

        if (failed) {
            const why = result ? (result.timedOut ? '超时' : result.aborted ? '中止' : (result.error || '未知错误')) : '无结果';
            this.log.warn('第 ' + (msg.attempts || 0) + ' 次尝试失败 seq=' + msg.seq + '：' + why);

            msg.attempts = (msg.attempts || 0) + 1;

            // 超时且允许重试：再给它一次机会
            if (result && result.timedOut && this.cfg.retryOnTimeout && msg.attempts < 2) {
                this._submitted.delete(msg.seq);
                this._pendingSessionId = null;
                this.log.info('超时重试 seq=' + msg.seq);
                this._dispatch(msg);
                return;
            }

            // 放弃这条：告诉对端，并出队避免死循环
            this._pendingSessionId = null;
            this._ackPending = false;
            this.store.saveSync(this.peerId);
            await this.store.dequeue(this.peerId, msg.seq);
            this._submitted.delete(msg.seq);

            // 会话续接失败（JSONL 被删等）：丢掉坏掉的会话 id，下次开新会话。
            // 同样只在会话没被切走时清理 —— 切走之后报的是旧会话的错，
            // 没道理把用户新选的那条也一起清掉。
            if (result && /session|resume|not found/i.test(String(result.error || '')) &&
                this.sessionId && this.sessionId === this._runningBase) {
                this.log.warn('会话续接疑似失效，清空 sessionId 以便下次开新会话');
                await this.store.advanceSession(this.peerId, null);
            }

            this._sendChat('（抱歉，这一轮没跑成功：' + why + '）');
            return;
        }

        // —— 成功 ——
        // 现在才把会话推进到新的 id。
        // 但只有会话还停在起跑时那条才推进：中途被 setSession 换过，
        // 说明用户主动选了别的对话，这一轮的结果不该把它顶掉。
        if (this._pendingSessionId) {
            if (this.sessionId !== this._runningBase) {
                this.log.info('会话已被切走（' + (this._runningBase || '新对话') + ' -> ' +
                    (this.sessionId || '新对话') + '），本轮不推进会话链');
            } else {
                await this.store.advanceSession(this.peerId, this._pendingSessionId);
                this.log.debug('会话推进 seq=' + msg.seq + ' -> ' + this._pendingSessionId);
            }
        }
        this._pendingSessionId = null;
        this._ackPending = false;

        await this.store.dequeue(this.peerId, msg.seq);
        this._submitted.delete(msg.seq);
        this.log.info('完成 seq=' + msg.seq + ' 输出段数=' + ((result.chunks && result.chunks.length) || 0));
    }
}

function formatBytes(n) {
    if (!n && n !== 0) return '未知大小';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + u[i];
}

module.exports = { Conversation, DEFAULT_PERSONA, ACK_TEXT };
