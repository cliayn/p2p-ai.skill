'use strict';

/**
 * claude 进程调度。
 *
 * 要同时保证三个性质：
 *
 *   1. 对话顺序 —— 同一对端的第 N+1 轮必须建立在其第 N 轮之上。
 *   2. 会话单写者 —— 两个并发 --resume 同一个 session 会把历史写乱。
 *      1 和 2 共同推出「每对端并发恒为 1」这条硬约束。
 *   3. 公平 —— 一个刷屏的对端不能把安静的对端饿死。
 *
 * 关于第 3 点：一开始用的是「FIFO 里最老的、且其 peer 没在跑的任务」，
 * 但那个策略挡不住饥饿 —— A 先排队 10 条、B 后来 1 条，
 * A 的队列永远更靠前，B 要等 A 全部跑完。改成在**对端之间**轮转：
 * 每次挑「轮转顺序里下一个有待办、且当前没在跑的对端」，取它队首的一条。
 * 这样 B 那一条最迟下一轮就能上。
 */

class ClaudeScheduler {
    /**
     * @param {object} opts
     * @param {number} opts.maxConcurrent  全局并发上限
     * @param {object} [opts.logger]
     */
    constructor({ maxConcurrent = 4, logger }) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };

        this.queues = new Map();       // peerId -> 待执行任务数组（保持插入顺序）
        this.running = new Map();      // peerId -> 正在执行的任务
        this.runningCount = 0;
        this.queuedCount = 0;
        this._rr = 0;                  // 轮转游标
    }

    get stats() {
        return {
            running: this.runningCount,
            queued: this.queuedCount,
            runningPeers: Array.from(this.running.keys()),
            maxConcurrent: this.maxConcurrent,
        };
    }

    /**
     * 提交任务。
     * @param {object} job
     * @param {string} job.peerId
     * @param {function} job.exec   (ctx) => Promise<any>，ctx 含 signal / peerId
     * @param {function} [job.onDone] (result, err) => void
     * @returns {object} 原 job 对象，附带 promise / cancel
     */
    submit(job) {
        const entry = {
            peerId: job.peerId,
            exec: job.exec,
            onDone: job.onDone,
            controller: new AbortController(),
            started: false,
            settled: false,
        };

        entry.promise = new Promise((resolve) => { entry._resolve = resolve; });
        job.promise = entry.promise;
        job.cancel = (reason) => this._cancelEntry(entry, reason || 'caller');

        let q = this.queues.get(job.peerId);
        if (!q) { q = []; this.queues.set(job.peerId, q); }
        q.push(entry);
        this.queuedCount++;

        this.log.debug('入队 ' + entry.peerId + '，待办 ' + this.queuedCount);
        this._pump();
        return job;
    }

    /**
     * 取消某对端的一切：正在跑的 abort，排队的丢弃。
     * 对端掉线时调用。消息本身留在持久化队列里，重连后重放。
     */
    cancelPeer(peerId, reason) {
        const running = this.running.get(peerId);
        if (running) {
            this.log.info('中止 ' + peerId + ' 正在运行的任务（' + (reason || 'peer gone') + '）');
            running.controller.abort();
        }

        const q = this.queues.get(peerId);
        if (q && q.length) {
            const dropped = q.splice(0);
            this.queuedCount -= dropped.length;
            for (const e of dropped) this._settle(e, null, new Error('cancelled: ' + (reason || 'peer gone')));
            this.log.info('丢弃 ' + peerId + ' 的 ' + dropped.length + ' 个排队任务');
        }
        // 空队列留在 Map 里没有意义，清掉以免轮转时白扫
        if (q && !q.length && !this.running.has(peerId)) this.queues.delete(peerId);
    }

    _cancelEntry(entry, reason) {
        if (entry.settled) return;
        if (!entry.started) {
            const q = this.queues.get(entry.peerId);
            if (q) {
                const i = q.indexOf(entry);
                if (i >= 0) { q.splice(i, 1); this.queuedCount--; }
                if (!q.length && !this.running.has(entry.peerId)) this.queues.delete(entry.peerId);
            }
            this._settle(entry, null, new Error('cancelled before start: ' + reason));
        } else {
            entry.controller.abort();
        }
    }

    _settle(entry, result, err) {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.onDone) {
            try { entry.onDone(result, err); } catch (e) { this.log.warn('onDone 抛错: ' + e.message); }
        }
        entry._resolve({ result, error: err });
    }

    /** 轮转挑一个「有待办且当前没在跑」的对端 */
    _nextEligiblePeer() {
        const ids = Array.from(this.queues.keys());
        const n = ids.length;
        if (!n) return null;
        for (let i = 0; i < n; i++) {
            const idx = (this._rr + i) % n;
            const peerId = ids[idx];
            if (this.running.has(peerId)) continue;
            if (!this.queues.get(peerId).length) continue;
            this._rr = (idx + 1) % n;   // 下次从这个对端的下一位开始
            return peerId;
        }
        return null;
    }

    _pump() {
        while (this.runningCount < this.maxConcurrent) {
            const peerId = this._nextEligiblePeer();
            if (!peerId) return;

            const q = this.queues.get(peerId);
            const entry = q.shift();
            this.queuedCount--;
            if (!q.length) this.queues.delete(peerId);

            entry.started = true;
            this.running.set(peerId, entry);
            this.runningCount++;

            // 故意不 await：让循环继续把剩余槽位填满
            this._run(entry);
        }
    }

    async _run(entry) {
        const ctx = { signal: entry.controller.signal, peerId: entry.peerId };
        try {
            const result = await entry.exec(ctx);
            this._settle(entry, result, null);
        } catch (err) {
            this._settle(entry, null, err);
        } finally {
            this.running.delete(entry.peerId);
            this.runningCount--;
            this._pump();
        }
    }
}

module.exports = { ClaudeScheduler };
