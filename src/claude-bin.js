'use strict';

/**
 * 把 'claude' 这类裸名字解析成真实路径。
 *
 * 为什么需要：claude 经常装在 PATH 之外。官方安装脚本把它落在
 * ~/.local/bin/claude，而不少环境的 PATH 里并没有 ~/.local/bin
 * （Windows 上尤其明显）。这时 spawn('claude') 直接 ENOENT，
 * 报「找不到 claude」——对使用者来说很难排查。
 *
 * 所以按「PATH → 几个已知安装目录」的顺序找一遍，并把找过哪些目录
 * 带回给调用方，好让报错信息说得出话。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

/** Windows 上可执行文件带后缀，按 PATHEXT 的习惯试 */
function candidates(name) {
    if (!IS_WIN) return [name];
    if (/\.[a-z0-9]+$/i.test(name)) return [name];      // 已经带后缀了
    const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';').map((e) => e.trim()).filter(Boolean);
    const out = [name];
    for (const e of pathext) out.push(name + e.toLowerCase());
    for (const e of pathext) out.push(name + e.toUpperCase());
    return out;
}

function findIn(dir, name) {
    if (!dir) return null;
    for (const cand of candidates(name)) {
        const full = path.join(dir, cand);
        try {
            if (fs.statSync(full).isFile()) return full;
        } catch (e) { /* 不在这儿 */ }
    }
    return null;
}

/** 按顺序找的那些目录（PATH 在前，然后是各家的默认安装位置） */
function searchDirs() {
    return [
        ...(process.env.PATH || '').split(IS_WIN ? ';' : ':'),
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.claude', 'local'),
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'claude') : null,
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
    ].filter(Boolean);
}

/**
 * @returns {{bin: string, found: boolean, tried: string[]}}
 *          找不到时 bin 原样返回，让报错里能显示用户本来要的是什么。
 */
function resolveClaudeBin(bin) {
    const name = bin || 'claude';

    // 显式给了路径 / 带后缀的名字，就别自作聪明去猜
    if (name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
        return { bin: name, found: true, tried: [] };
    }

    const tried = [];
    const seen = new Set();

    for (const d of searchDirs()) {
        const key = IS_WIN ? d.toLowerCase() : d;
        if (seen.has(key)) continue;
        seen.add(key);
        tried.push(d);
        const hit = findIn(d, name);
        if (hit) return { bin: hit, found: true, tried };
    }

    return { bin: name, found: false, tried };
}

module.exports = { resolveClaudeBin, findIn, candidates, searchDirs, IS_WIN };
