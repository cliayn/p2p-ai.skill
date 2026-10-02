'use strict';

/**
 * 文件传输协议的常量与编解码 —— 逐字节对齐 js/transfer.js。
 *
 * 这些数字不是随手定的，改任何一个都会让浏览器那边收不了/发不出。
 * 对应关系：
 *   CHUNK_SIZE / CHANNEL_COUNT / TF_CHANNEL_IDS ... js/transfer.js:11-24
 *   帧头布局 ................................... js/transfer.js:726-731 / 948-952
 *   ACK 节流 ................................... js/transfer.js:1074-1087
 *   窗口与管道 ................................. js/transfer.js:15-19
 */

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const CHUNK_SIZE = 64 * 1024;            // 每片 64KB
const CHANNEL_COUNT = 4;                 // 4 路并发
const TF_CHANNEL_IDS = [1000, 1001, 1002, 1003];
const TF_LABEL_PREFIX = 'tf-ch-';

const ACK_INTERVAL_MS = 80;              // ACK 最小间隔
const ACK_CHUNK_STEP = 32;               // 或每 32 块一次
const INIT_WINDOW = 8;
const MAX_WINDOW = 32;
const MIN_WINDOW = 2;
const BUFFER_SOFT_CAP = 4 * 1024 * 1024;
const BUFFER_LOW_THRESHOLD = 256 * 1024;
const MAX_PIPELINE = 128;                // 全局在途上限（块）

const GZIP_MIN_BYTES = 512;              // 小于这个尺寸不值得压

const MAIN_DC_MAX_MESSAGE = 64 * 1024;   // 控制消息都很小，超过就是异常

/**
 * 组帧：[4B 大端 chunkIdx][1B flags(bit0=gzip)][payload]
 */
function encodeFrame(chunkIdx, flags, payload) {
    const frame = Buffer.allocUnsafe(5 + payload.length);
    frame.writeUInt32BE(chunkIdx >>> 0, 0);
    frame.writeUInt8(flags & 0xff, 4);
    Buffer.from(payload.buffer, payload.byteOffset, payload.length).copy(frame, 5);
    return frame;
}

/** 解帧；短于 5 字节的一律当噪声丢弃 */
function decodeFrame(buf) {
    if (!buf || buf.length < 5) return null;
    return {
        chunkIdx: buf.readUInt32BE(0),
        flags: buf.readUInt8(4),
        payload: buf.subarray(5),
    };
}

/**
 * 与浏览器同条件：原始 ≥512B 且压缩后**严格更小**才用压缩版本。
 * 压缩失败就发原始数据 —— 绝不能因为压缩器出问题就把传输卡死。
 */
async function maybeCompress(payload) {
    if (payload.length < GZIP_MIN_BYTES) return { payload, flags: 0 };
    try {
        const packed = await gzip(payload);
        if (packed.length < payload.length) return { payload: packed, flags: 1 };
    } catch (e) { /* 退化为不压缩 */ }
    return { payload, flags: 0 };
}

/** 解压失败时回退原始数据 —— 与浏览器 .catch 分支一致 */
async function maybeDecompress(payload, flags) {
    if (!(flags & 1)) return payload;
    try {
        return await gunzip(payload);
    } catch (e) {
        return payload;
    }
}

/**
 * 轮询切分：块 i 归通道 i % ways。
 * 返回每个通道的 [start, end]，没分到任务的通道是 [-1, -1]。
 */
function splitChunks(total, ways) {
    const ranges = [];
    for (let w = 0; w < ways; w++) ranges.push([-1, -1]);
    for (let i = 0; i < total; i++) {
        const w = i % ways;
        if (ranges[w][0] === -1) ranges[w][0] = i;
        ranges[w][1] = i;
    }
    return ranges;
}

function channelLabel(i) { return TF_LABEL_PREFIX + i; }

function chunkCountFor(size) { return Math.ceil(size / CHUNK_SIZE); }

function isTransferMessage(type) {
    return typeof type === 'string' && type.startsWith('transfer-');
}

module.exports = {
    CHUNK_SIZE, CHANNEL_COUNT, TF_CHANNEL_IDS, TF_LABEL_PREFIX,
    ACK_INTERVAL_MS, ACK_CHUNK_STEP,
    INIT_WINDOW, MAX_WINDOW, MIN_WINDOW,
    BUFFER_SOFT_CAP, BUFFER_LOW_THRESHOLD, MAX_PIPELINE,
    GZIP_MIN_BYTES, MAIN_DC_MAX_MESSAGE,
    encodeFrame, decodeFrame, maybeCompress, maybeDecompress,
    splitChunks, channelLabel, chunkCountFor, isTransferMessage,
};
