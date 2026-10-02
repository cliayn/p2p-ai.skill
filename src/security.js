'use strict';

/**
 * 对端是不可信的：文件名、消息频率、文件大小都必须当作攻击输入处理。
 */

const path = require('path');

// Windows 保留名（即使跑在 Linux 也一并挡掉，因为文件可能被同步到 Windows）
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// 收到文件名时只允许这些字符，其余一律替换掉
// 故意不含 / \ : * ? " < > | 以及控制字符
const UNSAFE_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

const MAX_NAME_LEN = 180;

/**
 * 把对端给的文件名洗成一个安全的、单层的文件名。
 * 返回 null 表示这个文件名不可接受（调用方应当拒绝整个传输）。
 */
function sanitizeFilename(raw) {
    if (typeof raw !== 'string') return null;

    // 只取最后一段：挡掉 "../../etc/passwd" 和 "C:\\Windows\\x" 以及 "a/b"
    let name = raw.replace(/\\/g, '/').split('/').pop() || '';

    name = name.replace(UNSAFE_CHARS, '_').trim();

    // 去掉开头的点：挡掉 ".."、".bashrc"、以及 Windows 会截断的尾部点
    name = name.replace(/^\.+/, '');
    name = name.replace(/[. ]+$/, '');

    if (!name) return null;
    if (name === '.' || name === '..') return null;

    // 长度按字节截断（UTF-8 下中文一字 3 字节），保留扩展名
    if (Buffer.byteLength(name) > MAX_NAME_LEN) {
        const ext = path.extname(name).slice(0, 20);
        const base = name.slice(0, name.length - path.extname(name).length);
        let cut = base;
        while (Buffer.byteLength(cut + ext) > MAX_NAME_LEN && cut.length > 1) cut = cut.slice(0, -1);
        name = cut + ext;
    }

    if (WIN_RESERVED.test(name)) name = '_' + name;

    return name || null;
}

/**
 * 断言 child 确实落在 parent 目录内（防路径逃逸的第二道防线）。
 * resolve 之后再比，能挡住符号链接以外的所有 ".." 花样。
 */
function isWithin(parent, child) {
    const p = path.resolve(parent);
    const c = path.resolve(child);
    if (c === p) return true;
    return c.startsWith(p + path.sep);
}

/**
 * 文件名冲突时找一个不覆盖已有文件的路径： report.pdf -> report (1).pdf
 */
function uniquePath(dir, filename, existsFn) {
    const ext = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let candidate = path.join(dir, filename);
    let n = 1;
    while (existsFn(candidate)) {
        candidate = path.join(dir, base + ' (' + n + ')' + ext);
        n++;
        if (n > 9999) throw new Error('无法为 ' + filename + ' 找到空闲文件名');
    }
    return candidate;
}

/**
 * 令牌桶。对端可以疯狂刷消息，必须限流。
 * 同时限「条/秒」和「字节/秒」两个维度。
 */
class TokenBucket {
    constructor({ rate, burst, bytesRate, bytesBurst }) {
        this.rate = rate;                       // 每秒补充多少 token
        this.capacity = burst !== undefined ? burst : rate;
        this.tokens = this.capacity;
        this.bytesRate = bytesRate || 0;        // 0 = 不限
        this.bytesCapacity = bytesBurst !== undefined ? bytesBurst : (bytesRate || 0);
        this.bytesTokens = this.bytesCapacity;
        this.last = Date.now();
    }

    _refill(now) {
        const dt = (now - this.last) / 1000;
        if (dt <= 0) return;
        this.tokens = Math.min(this.capacity, this.tokens + dt * this.rate);
        if (this.bytesRate > 0) {
            this.bytesTokens = Math.min(this.bytesCapacity, this.bytesTokens + dt * this.bytesRate);
        }
        this.last = now;
    }

    /**
     * 消耗一次配额。返回 true 表示放行。
     * 任一维度不足则整体拒绝，且不消耗另一维度（避免半扣）。
     */
    take(bytes) {
        const now = Date.now();
        this._refill(now);
        const need = bytes || 0;
        if (this.tokens < 1) return false;
        if (this.bytesRate > 0 && this.bytesTokens < need) return false;
        this.tokens -= 1;
        if (this.bytesRate > 0) this.bytesTokens -= need;
        return true;
    }
}

module.exports = { sanitizeFilename, isWithin, uniquePath, TokenBucket, WIN_RESERVED };
