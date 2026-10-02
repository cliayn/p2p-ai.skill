'use strict';

/**
 * 房间号生成。
 *
 * 自动生成的格式：p2p-ai-room-<12 格 base31>，例如 p2p-ai-room-7f3k9qpz2mr9
 * 手填的房间号则**不强求前缀** —— `--room 1` 这种短号是允许的（见 validateRoomId），
 * 房间里挤进多人时的区分靠「房间里每个人的 id」来做，不靠房间号本身。
 *
 * 前缀是有意的，而且刻意选得长：
 *   - 对方在网页里一看就知道这是个「能调 p2p-chat 技能的 AI」的房间；
 *   - 它同时是技能描述里的触发词 —— 用户在对话里贴出一个房间号，
 *     技能要能被自动选中。前缀太短太普通（比如早先的 `p2p-server`）就会有歧义：
 *     用户随口提到 "p2p"、"server" 都可能误命中，反过来真给了房间号又未必认得出。
 *     三个连字符词连在一起，日常说话基本不可能碰巧凑出来。
 *
 * 网页端 index.html 的房间号输入框 maxlength=24，超了会被截断成别的房间，
 * 所以这里生成时必须留在预算内，并且对运维手填的房间号做硬校验。
 */

const crypto = require('crypto');

const PREFIX = 'p2p-ai-room-';

// 早期版本用的是这个。既不生成的也不推荐的，但老房间号还得认出来，
// 否则升级之后对面发来一个旧号，这边会当成普通房间号连过去（连得上，只是不再被识别成本技能）。
const LEGACY_PREFIXES = ['p2p-server'];

const ROOM_ID_MAX = 24;

// base36 里去掉容易看错的 0/O/1/I —— 房间号要靠人念、靠人抄
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const BASE = ALPHABET.length;
const RAND_LEN = 12;

/**
 * 生成一个新房间号。
 *
 * 构造是：base31( sha256( 时间戳(8B 大端) ‖ nonce(32B) ‖ 签名 ) )，取前 12 格。
 * 各部分各司其职：
 *
 *   - **nonce** 是唯一真正的随机性来源。32 字节的 CSPRNG 输出。
 *   - **时间戳**把房间号钉在生成的那一刻上，同一台机器不同时间起的号不会落进同一条轨道。
 *   - **签名**（拿本机 Ed25519 私钥签「时间戳‖nonce」）让这个号只有持有该私钥的机器造得出，
 *     将来可以证明出处。
 *
 * ⚠️ 别被构造唬住：**保证「同一时刻也不同」的是那 32 字节 nonce，不是签名**。
 * 签名是确定性的，喂同样的输入永远出同样的结果；它既不增加熵，也没有人验证
 * （信令服务端不校验房间号）。真正决定房间号难不难猜的，只有 nonce。
 *
 * 长度：前缀 12 + 12 = 24，正好顶到网页输入框 maxlength 的上限（不能再多了）。
 * 12 格 base31 ≈ 2^59.5，即便同一毫秒起一百万个也撞不上。下面的断言守着这条线，
 * 前缀一旦再变长就会当场炸出来，而不是生成一个会被网页截断、静默进错房间的号。
 *
 * opts 全是测试接缝：{ now, nonce, key }。不传就用真值。
 * 传了 key 才混签名 —— 手填房间号时压根不需要密钥，也就没有理由让它在磁盘上多躺一份。
 */
function generateRoomId(opts) {
    opts = opts || {};
    const ts = opts.now === undefined ? Date.now() : opts.now;
    const nonce = opts.nonce || crypto.randomBytes(32);

    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigUInt64BE(BigInt(Math.floor(ts)));

    const parts = [tsBuf, nonce];
    if (opts.key) {
        // Ed25519 的算法参数必须是 null
        parts.push(sign(opts.key, Buffer.concat([tsBuf, nonce])));
    }

    const digest = crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
    const id = PREFIX + encodeBase(digest, RAND_LEN);
    if (id.length > ROOM_ID_MAX) {
        throw new Error('房间号超长（' + id.length + ' > ' + ROOM_ID_MAX + '）: ' + id);
    }
    return id;
}

function sign(key, data) {
    const priv = key.privateKey || key;
    return crypto.sign(null, data, priv);
}

/** digest 的字节按 base31 取模铺开 —— digest 是均匀的，取模不引入可见偏差 */
function encodeBase(digest, n) {
    let out = '';
    for (let i = 0; i < n; i++) out += ALPHABET[digest[i] % BASE];
    return out;
}

function isServerRoomId(roomId) {
    if (typeof roomId !== 'string') return false;
    if (roomId.startsWith(PREFIX)) return true;
    return LEGACY_PREFIXES.some((p) => roomId.startsWith(p));
}

/**
 * 校验运维传入的房间号。超长直接抛错——绝不静默截断，
 * 截断会悄悄地进到另一个房间，是那种最难查的 bug。
 *
 * 这几个错误标记为 expected：房间号填错是最常见的失败，不是崩溃。
 * 入口那边看到标记就只打一行人话，不拿堆栈把真正的原因埋掉 ——
 * 房间号大多是照抄过来的，抄错一两个字符时，第一眼要能看见到底哪里不对。
 */
function fail(message) {
    const e = new Error(message);
    e.expected = true;
    return e;
}

function validateRoomId(roomId) {
    if (typeof roomId !== 'string' || !roomId.trim()) {
        throw fail('房间号不能为空');
    }
    const id = roomId.trim();
    if (id.length > ROOM_ID_MAX) {
        throw fail('房间号超过 ' + ROOM_ID_MAX + ' 字符（当前 ' + id.length + '），网页端会截断，拒绝使用: ' + id);
    }
    return id;
}

module.exports = {
    generateRoomId, validateRoomId, isServerRoomId,
    PREFIX, LEGACY_PREFIXES, ROOM_ID_MAX, RAND_LEN,
};
