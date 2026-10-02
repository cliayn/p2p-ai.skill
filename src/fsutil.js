'use strict';

/**
 * 跨平台的 fs 小工具。
 *
 * 存在的唯一理由：rename 在两个平台上的语义不一样。
 *   POSIX   —— 原子替换，目标文件开着也照样成功
 *   Windows —— 实质是搬运，目标只要被任何句柄占着就 EPERM/EACCES/EBUSY
 *
 * 代码里到处用「写临时文件再 rename 就位」，在 Linux 上跑得好好的，
 * 到 Windows 上会随机失败。占用通常是瞬时的（杀毒扫描、索引器、编辑器），
 * 所以退让几次重试就能过去；实在过不去才把错误抛出去。
 */

const fs = require('fs');
const fsp = require('fs/promises');

const ATTEMPTS = 5;
const BACKOFF_MS = 20;

function isTransient(e) {
    return !!e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
}

async function renameWithRetry(from, to) {
    for (let i = 0; ; i++) {
        try {
            return await fsp.rename(from, to);
        } catch (e) {
            if (!isTransient(e) || i >= ATTEMPTS - 1) throw e;
            await new Promise((r) => setTimeout(r, BACKOFF_MS * (i + 1)));
        }
    }
}

/** 同步版没有 await 可用，用 Atomics 睡——比忙等省 CPU */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameSyncWithRetry(from, to) {
    for (let i = 0; ; i++) {
        try {
            return fs.renameSync(from, to);
        } catch (e) {
            if (!isTransient(e) || i >= ATTEMPTS - 1) throw e;
            sleepSync(BACKOFF_MS * (i + 1));
        }
    }
}

module.exports = { renameWithRetry, renameSyncWithRetry, sleepSync, isTransient };
