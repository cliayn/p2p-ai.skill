'use strict';

/**
 * 传输落盘：沙箱路径解析 + 磁盘空间守卫。
 *
 * 沙箱约定（用户确认过的固定目录）：
 *   收进来的文件 → ~/p2p-files/inbox/<peerId>/
 *   要发出去的文件 → ~/p2p-files/outbox/<peerId>/
 *
 * 对端给的文件名是不可信输入，必须先消毒再拼路径，拼完还要断言没跑出沙箱。
 * sanitizeFilename 只取 basename，所以 "../../etc/passwd" 会变成 "passwd"。
 */

const fs = require('fs');
const path = require('path');
const { sanitizeFilename, isWithin, uniquePath } = require('../security');

const PART_SUFFIX = '.p2p-part';

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * 解析一个「对端想发给我们的文件」的落地路径。
 * @returns {{dir:string, finalPath:string, partPath:string}}
 */
function resolveIncoming(cfg, peerId, rawName) {
    const safePeer = cfg.safePeerId(peerId);
    if (!safePeer) throw new Error('非法的对端 id: ' + String(peerId));

    const name = sanitizeFilename(rawName);
    if (!name) throw new Error('非法的文件名: ' + String(rawName));

    const dir = ensureDir(cfg.inboxFor(safePeer));
    // 同名文件不覆盖，改成 "名字 (1).ext"。注意这里只避开最终名，
    // 同一对端同时只允许一个传输（manager 保证），所以不会有两个 .part 撞在一起。
    const finalPath = uniquePath(dir, name, fs.existsSync);

    if (!isWithin(dir, finalPath)) throw new Error('路径逃逸: ' + finalPath);

    return { dir, finalPath, partPath: finalPath + PART_SUFFIX };
}

/**
 * 解析一个「我们要发出去的文件」。与收件箱不同，这里不消毒也不重命名：
 * 路径是我们自己给的，只需要确认它确实在 outbox 沙箱里。
 */
function resolveOutgoing(cfg, peerId, filePath) {
    const safePeer = cfg.safePeerId(peerId);
    if (!safePeer) throw new Error('非法的对端 id: ' + String(peerId));

    const box = ensureDir(cfg.outboxFor(safePeer));
    const full = path.resolve(filePath);
    if (!isWithin(box, full)) throw new Error('只能发送 outbox 目录内的文件: ' + full);
    if (!fs.existsSync(full)) throw new Error('文件不存在: ' + full);

    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error('不是普通文件: ' + full);

    return { path: full, name: path.basename(full), size: st.size };
}

/** 剩余磁盘空间；拿不到就返回 null（调用方当作「未知」，不阻止传输） */
async function freeBytes(dir) {
    try {
        if (typeof fs.promises.statfs !== 'function') return null;
        const st = await fs.promises.statfs(dir);
        return Number(st.bavail) * Number(st.bsize);
    } catch (e) {
        return null;
    }
}

/**
 * 传输开始前的空间检查。
 * 声明大小本身就超过上限，或者剩余空间放不下（留出 minFree 余量）就拒绝。
 */
async function checkCapacity(cfg, dir, declaredSize) {
    if (!Number.isFinite(declaredSize) || declaredSize < 0) {
        return { ok: false, reason: '声明的大小无效' };
    }
    if (declaredSize > cfg.maxFileBytes) {
        return {
            ok: false,
            reason: '文件超过上限（' + fmt(declaredSize) + ' > ' + fmt(cfg.maxFileBytes) + '）',
        };
    }

    const free = await freeBytes(dir);
    if (free === null) return { ok: true, free: null, note: '无法读取磁盘剩余空间，跳过检查' };

    if (free - declaredSize < cfg.minFreeBytes) {
        return {
            ok: false,
            reason: '磁盘空间不足（剩余 ' + fmt(free) + '，需要 ' + fmt(declaredSize) +
                ' + 保留 ' + fmt(cfg.minFreeBytes) + '）',
            free,
        };
    }
    return { ok: true, free };
}

function fmt(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + u[i];
}

module.exports = {
    PART_SUFFIX, ensureDir, resolveIncoming, resolveOutgoing,
    freeBytes, checkCapacity, fmt,
};
