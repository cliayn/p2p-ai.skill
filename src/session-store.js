'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { renameWithRetry, renameSyncWithRetry } = require('./fsutil');

/**
 * 每个对端一个 JSON 文件，持久化会话链与待处理消息。
 *
 * 为什么一对端一文件：一个文件损坏只毁掉那一个对话，扫描时隔离掉即可，
 * 不会让整台机器上所有历史一起不可读。
 *
 * 写入一律 temp + rename，保证崩溃时不会读到半个 JSON。
 *
 * 但 rename 的语义两个平台不一样：POSIX 上是「原子替换」，目标开着也照样成功；
 * Windows 上是「搬运」，目标被任何句柄占着就 EPERM/EBUSY。所以这里两件事都要做 ——
 * 同一对端的写串行化（消除进程内竞争），以及 rename 的短暂重试（挡住杀毒/索引器
 * 那种外部占用）。
 */

const EMPTY = (peerId) => ({
    peerId,
    sessionId: null,
    lastSeq: 0,          // 我方已发出的最大 seq
    lastInboundSeq: 0,   // 对端发来的最大 seq（用于去重/排序）
    device: null,
    queue: [],           // 尚未成功处理的对端消息
    undelivered: [],     // 已生成但因对端掉线没发出去的回复
    notes: [],           // 收到的文件等上下文补充
    createdAt: 0,
    updatedAt: 0,
});

class SessionStore {
    constructor({ dir, logger }) {
        this.dir = dir;
        this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
        this.cache = new Map();
        this._tmpSeq = 0;
        this._chains = new Map();   // peerId -> Promise，同一对端的状态文件一次只写一个
        fs.mkdirSync(dir, { recursive: true });
    }

    /**
     * 把同一对端的写排成一条链。
     *
     * 光有唯一临时文件名不够：两个并发 save 会同时 rename 到同一个目标，
     * POSIX 上可能 ENOENT，Windows 上必定 EPERM。
     * 状态对象是就地改的、序列化发生在真正写的那一刻，所以串行化不会丢更新。
     */
    _enqueueWrite(peerId, task) {
        const prev = this._chains.get(peerId) || Promise.resolve();
        // 前一次失败也不能把后面卡死，所以 onRejected 也接上 task
        const next = prev.then(task, task);
        this._chains.set(peerId, next.then(() => {}, () => {}));
        return next;
    }

    /**
     * 每次写用**唯一**的临时文件名。
     *
     * 曾经用固定的 `<peerId>.json.tmp`，结果同一对端的两个并发 save 会互相踩：
     * 先完成的那次把 tmp rename 走了，后一次再 rename 就 ENOENT。
     * （enqueue 之后紧接着 _sendChat 就会触发这种并发。）
     */
    _tmpFile(file) {
        return file + '.' + process.pid + '.' + (++this._tmpSeq) + '.tmp';
    }

    _file(peerId) {
        return path.join(this.dir, peerId + '.json');
    }

    /** 读一个对端的状态；不存在则返回全新的空状态 */
    load(peerId) {
        if (this.cache.has(peerId)) return this.cache.get(peerId);

        let state = null;
        const file = this._file(peerId);
        try {
            const raw = fs.readFileSync(file, 'utf8');
            state = JSON.parse(raw);
            // 补上后续版本新增的字段
            state = Object.assign(EMPTY(peerId), state);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                // 损坏文件：改名隔离，不要让它拖垮启动
                this.log.warn('状态文件损坏，已隔离 ' + file + ': ' + e.message);
                try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (e2) { /* 尽力而为 */ }
            }
            state = EMPTY(peerId);
            state.createdAt = Date.now();
        }
        this.cache.set(peerId, state);
        return state;
    }

    get(peerId) {
        return this.load(peerId);
    }

    /** 原子落盘。所有写操作最终都走这里。 */
    async save(peerId) {
        return this._enqueueWrite(peerId, () => this._saveNow(peerId));
    }

    async _saveNow(peerId) {
        const state = this.cache.get(peerId);
        if (!state) return;
        state.updatedAt = Date.now();
        const file = this._file(peerId);
        const tmp = this._tmpFile(file);
        try {
            await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
            await renameWithRetry(tmp, file);
        } catch (e) {
            this.log.error('写状态文件失败 ' + file + ': ' + e.message);
            try { fs.unlinkSync(tmp); } catch (e2) { /* 已经没了 */ }
        }
    }

    /** 同步落盘，用于进程退出路径（异步还来不及 flush 就退出了） */
    saveSync(peerId) {
        const state = this.cache.get(peerId);
        if (!state) return;
        state.updatedAt = Date.now();
        const file = this._file(peerId);
        const tmp = this._tmpFile(file);
        try {
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
            renameSyncWithRetry(tmp, file);
        } catch (e) {
            this.log.error('同步写状态文件失败 ' + file + ': ' + e.message);
            try { fs.unlinkSync(tmp); } catch (e2) { /* 已经没了 */ }
        }
    }

    /** 列出所有已知对端 */
    list() {
        const out = [];
        try {
            for (const f of fs.readdirSync(this.dir)) {
                if (!f.endsWith('.json') || f.includes('.corrupt-')) continue;
                out.push(f.slice(0, -5));
            }
        } catch (e) { /* 目录不存在 */ }
        return out;
    }

    // —— 队列操作 ——

    /**
     * 入队一条待处理消息。
     * 必须在调用 claude 之前落盘，否则崩溃会丢用户消息。
     */
    async enqueue(peerId, msg) {
        const s = this.load(peerId);
        s.queue.push(msg);
        await this.save(peerId);
    }

    /** 处理成功后出队 */
    async dequeue(peerId, seq) {
        const s = this.load(peerId);
        const i = s.queue.findIndex((m) => m.seq === seq);
        if (i >= 0) s.queue.splice(i, 1);
        await this.save(peerId);
    }

    /** 失败时把消息退回队首，重连后优先重放 */
    async requeueFront(peerId, msg) {
        const s = this.load(peerId);
        if (s.queue.some((m) => m.seq === msg.seq)) return;   // 已在队列里
        s.queue.unshift(msg);
        await this.save(peerId);
    }

    /** 推进会话链。只保留最新 id —— 旧的一旦 resume 过就作废了。 */
    async advanceSession(peerId, sessionId) {
        const s = this.load(peerId);
        if (s.sessionId === sessionId) return;
        s.sessionId = sessionId;
        await this.save(peerId);
    }

    /** 生成成功但没能送达的回复 */
    async addUndelivered(peerId, msg) {
        const s = this.load(peerId);
        s.undelivered.push(msg);
        if (s.undelivered.length > 200) s.undelivered.splice(0, s.undelivered.length - 200);
        await this.save(peerId);
    }

    async takeUndelivered(peerId) {
        const s = this.load(peerId);
        const out = s.undelivered.slice();
        s.undelivered = [];
        await this.save(peerId);
        return out;
    }

    async addNote(peerId, note) {
        const s = this.load(peerId);
        s.notes.push(note);
        if (s.notes.length > 50) s.notes.splice(0, s.notes.length - 50);
        await this.save(peerId);
    }

    flushAllSync() {
        for (const peerId of this.cache.keys()) this.saveSync(peerId);
    }
}

/**
 * 列出某个工作目录下 claude 的历史会话（供后续网页端做「续接历史对话」）。
 * claude 把会话存在 ~/.claude/projects/<把 workdir 里的非字母数字换成 - 的 slug>/
 */
function listClaudeSessions(workdir) {
    const slug = path.resolve(workdir).replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', slug);
    const out = [];
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch (e) {
        return out;
    }
    for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }

        // JSONL 第一行通常是 summary / 首条用户消息，用它当预览
        let preview = '';
        let cwd = null;
        try {
            const fd = fs.openSync(full, 'r');
            const buf = Buffer.alloc(8192);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            const head = buf.slice(0, n).toString('utf8').split('\n');
            for (const line of head) {
                if (!line.trim()) continue;
                let o;
                try { o = JSON.parse(line); } catch (e) { continue; }
                if (o.cwd) cwd = o.cwd;
                const t = stripLeadingPersona(extractText(o)).trim();
                if (t) { preview = t.slice(0, 160); break; }
            }
        } catch (e) { /* 读不了就留空 */ }

        out.push({
            sessionId: f.slice(0, -6),
            path: full,
            mtime: st.mtimeMs,
            size: st.size,
            preview,
            cwd,
        });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

/**
 * 人格块在会话 JSONL 里的围栏。
 *
 * 新建会话时人格是拼在**第一条用户消息最前面**的（见 conversation.js 的 _runOptions）。
 * 于是「会话开头」永远是同一段模板 —— 而网页端「看内容」拿的正是会话开头，
 * 不剥掉的话每条会话预览长得一模一样，这功能等于没有。
 * 用一对标记围起来，剥的时候按标记找，不去猜人格文件里写了什么。
 * 旧会话没有这对标记，剥不掉也不影响正确性，只是预览还是那段模板。
 */
const PERSONA_OPEN = '[p2p-persona]';
const PERSONA_CLOSE = '[/p2p-persona]';

/** 只剥**开头**那一块：对面的消息正文里出现同样的字眼不该被当成标记 */
function stripLeadingPersona(text) {
    const s = String(text == null ? '' : text);
    const head = s.replace(/^\s+/, '');
    if (!head.startsWith(PERSONA_OPEN)) return s;
    const j = head.indexOf(PERSONA_CLOSE, PERSONA_OPEN.length);
    if (j < 0) return s;   // 标记不完整（截断/手改过），原样返回
    return head.slice(j + PERSONA_CLOSE.length);
}

function extractText(o) {
    if (!o) return '';
    if (typeof o.summary === 'string') return o.summary;
    if (typeof o.content === 'string') return o.content;
    if (o.message && typeof o.message.content === 'string') return o.message.content;
    if (o.message && Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
            if (b && b.type === 'text' && b.text) return b.text;
        }
    }
    return '';
}

module.exports = {
    SessionStore, listClaudeSessions, EMPTY,
    PERSONA_OPEN, PERSONA_CLOSE, stripLeadingPersona,
};
