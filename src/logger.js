'use strict';

/**
 * 分级结构化日志。
 * 除了打到 stdout/stderr，最近 N 条还会留在环形缓冲里，
 * 供 p2p-ctl 通过控制 socket 拉取（运维时不用翻终端滚动）。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const RING_SIZE = 500;
const ring = [];
let ringSeq = 0;

// 全局级别，由 config 在启动时设置
let globalLevel = LEVELS.info;

function setLevel(name) {
    if (LEVELS[name] === undefined) throw new Error('未知日志级别: ' + name);
    globalLevel = LEVELS[name];
}

function ts() {
    const d = new Date();
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}

function pushRing(entry) {
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
}

function recent(n) {
    return ring.slice(Math.max(0, ring.length - (n || 100)));
}

function fmtExtra(extra) {
    if (extra === undefined || extra === null) return '';
    if (typeof extra === 'string') return ' ' + extra;
    if (extra instanceof Error) return ' ' + extra.message;
    try {
        const s = JSON.stringify(extra);
        return s === '{}' ? '' : ' ' + s;
    } catch (e) {
        return ' [unserializable]';
    }
}

function createLogger(scope) {
    const log = (level, msg, extra) => {
        if (LEVELS[level] < globalLevel) return;
        const line = '[' + ts() + '] ' + level.toUpperCase().padEnd(5) + ' [' + scope + '] ' + msg + fmtExtra(extra);
        // warn/error 走 stderr，其余走 stdout，方便 `p2p-listen > log` 时错误仍可见
        if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
        else process.stdout.write(line + '\n');
        pushRing({ seq: ++ringSeq, t: Date.now(), level, scope, msg, extra: extra instanceof Error ? extra.message : extra });
    };

    return {
        debug: (m, e) => log('debug', m, e),
        info: (m, e) => log('info', m, e),
        warn: (m, e) => log('warn', m, e),
        error: (m, e) => log('error', m, e),
        /** 子作用域，例如 createLogger('peer').child(peerId).info(...) */
        child: (sub) => createLogger(scope + ':' + sub),
    };
}

module.exports = { createLogger, setLevel, recent, LEVELS };
