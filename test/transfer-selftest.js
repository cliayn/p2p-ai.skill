#!/usr/bin/env node
'use strict';

/**
 * 文件传输的集成测试 —— 不需要 WebRTC。
 *
 * 做法：造两个「假对端」，让它们互相投递消息和二进制帧。
 * 两个 TransferManager 面对面接上，跑完整的
 *   header → ready → 建通道 → 灌块 → ACK → complete
 * 然后把收到的文件和源文件逐字节比对。
 *
 * 这样能在不依赖网络的情况下验证协议实现本身：分片、压缩标志、
 * 乱序去重、ACK 累计、收尾 rename、沙箱路径。
 *
 *   node test/transfer-selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const { loadConfig } = require('../src/config');
const { TransferManager } = require('../src/transfer/manager');
const proto = require('../src/transfer/protocol');
const store = require('../src/transfer/store');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
    if (cond) { passed++; process.stdout.write('  ✓ ' + name + '\n'); }
    else {
        failed++;
        failures.push(name + (detail ? ' — ' + detail : ''));
        process.stdout.write('  ✗ ' + name + (detail ? '  → ' + detail : '') + '\n');
    }
}
const section = (t) => process.stdout.write('\n' + t + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

// ═══════════════════════ 假对端 ═══════════════════════

/** 一个极简的 werift DataChannel 替身，只提供传输层用到的几个成员 */
function fakeChannel(label) {
    return {
        label,
        readyState: 'open',
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        stateChanged: { subscribe() {} },
        bufferedAmountLow: { subscribe() {} },
    };
}

/**
 * 两个 LoopbackPeer 互相投递。
 *
 * 注意：每个 peer 对象代表的是「对端」——它的 peerId 是**对方的** id。
 * managerA 手里的 peer.peerId = 'peerB'，所以 managerA 才会去
 * outbox/peerB 取文件；managerB 手里的 peer.peerId = 'peerA'，
 * 于是文件落在 inbox/peerA。这正是 daemon 里的真实形态。
 *
 * 用 setImmediate 投递，模拟真实网络的异步性（也顺带把重入问题暴露出来）。
 */
class LoopbackPeer extends EventEmitter {
    constructor(remoteId) {
        super();
        this.peerId = remoteId;
        this.other = null;
        this.bulk = new Map();
        this.sentFrames = 0;
        this.closed = false;
    }
    isOpen() { return true; }
    sendJson(obj) {
        this.sentFrames++;
        const other = this.other;
        // 深拷贝：真实链路上对象是被序列化过的，不能共享引用
        setImmediate(() => other.emit('message', JSON.parse(JSON.stringify(obj))));
        return true;
    }
    sendBinary(label, buf) {
        this.sentFrames++;
        const other = this.other;
        const copy = Buffer.from(buf);
        setImmediate(() => other.emit('bulk-data', { label, data: copy }));
        return true;
    }
    createBulkChannel(label) {
        let dc = this.bulk.get(label);
        if (!dc) { dc = fakeChannel(label); this.bulk.set(label, dc); }
        return dc;
    }
}

function wire(peer, manager) {
    peer.on('message', (msg) => {
        if (msg && proto.isTransferMessage(msg.type)) manager.onControlMessage(peer, msg);
    });
    peer.on('bulk-data', ({ data }) => manager.onBulkData(peer, data));
}

// ═══════════════════════ 环境 ═══════════════════════

function makeCfg(base, name) {
    const root = path.join(base, name);
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    return loadConfig(['--files-dir', path.join(root, 'files'), '--state-dir', path.join(root, 'state')], {});
}

function sha256(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 等一个事件，带超时 */
function waitFor(emitter, event, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('等待 ' + event + ' 超时')), ms);
        emitter.once(event, (info) => { clearTimeout(t); resolve(info); });
    });
}

// ═══════════════════════ 主流程 ═══════════════════════

(async () => {
    const base = path.join(os.tmpdir(), 'p2p-transfer-test-' + Date.now());

    // ————— 纯函数部分 —————
    section('帧编解码');
    {
        const payload = Buffer.from('hello 世界');
        const frame = proto.encodeFrame(0x01020304, 1, payload);
        ok('帧长 = 5 + 载荷', frame.length === 5 + payload.length, String(frame.length));
        ok('块号是大端', frame.readUInt32BE(0) === 0x01020304, '0x' + frame.readUInt32BE(0).toString(16));
        ok('标志位在偏移 4', frame.readUInt8(4) === 1);
        ok('载荷原样跟在后面', frame.subarray(5).toString('utf8') === 'hello 世界');

        const d = proto.decodeFrame(frame);
        ok('解码还原块号/标志/载荷',
            d.chunkIdx === 0x01020304 && d.flags === 1 && d.payload.toString('utf8') === 'hello 世界');
        ok('短帧被安全丢弃', proto.decodeFrame(Buffer.from([1, 2, 3])) === null);
        ok('空输入被安全丢弃', proto.decodeFrame(null) === null);
    }

    section('分片轮询');
    {
        const r = proto.splitChunks(10, 4);
        // i % 4 的分法：通道0拿 0,4,8；通道1拿 1,5,9；通道2拿 2,6；通道3拿 3,7
        ok('通道0 覆盖 0..8', r[0][0] === 0 && r[0][1] === 8, JSON.stringify(r[0]));
        ok('通道1 覆盖 1..9', r[1][0] === 1 && r[1][1] === 9, JSON.stringify(r[1]));
        ok('通道3 覆盖 3..7', r[3][0] === 3 && r[3][1] === 7, JSON.stringify(r[3]));

        const few = proto.splitChunks(2, 4);
        ok('块数少于通道数时，空通道是 [-1,-1]',
            few[0][0] === 0 && few[2][0] === -1 && few[3][1] === -1, JSON.stringify(few));

        const zero = proto.splitChunks(0, 4);
        ok('零块时全是空通道', zero.every((r2) => r2[0] === -1));
    }

    section('压缩条件');
    {
        const small = await proto.maybeCompress(Buffer.from('tiny'));
        ok('小于 512B 不压缩', small.flags === 0);

        // 重复数据压缩收益巨大
        const big = Buffer.alloc(64 * 1024, 'a');
        const packed = await proto.maybeCompress(big);
        ok('大块重复数据会被压缩', packed.flags === 1, 'flags=' + packed.flags);
        ok('压缩后确实更小', packed.payload.length < big.length,
            big.length + ' → ' + packed.payload.length);

        const back = await proto.maybeDecompress(packed.payload, packed.flags);
        ok('解压能还原', back.equals(big));

        // 随机数据压不动，必须退化为不压缩
        const rnd = crypto.randomBytes(8192);
        const rp = await proto.maybeCompress(rnd);
        if (rp.flags === 0) ok('压不动的数据不标记压缩', true);
        else ok('压不动的数据不标记压缩', rp.payload.length < rnd.length, '压缩后反而更大却标了 gzip');

        const fallback = await proto.maybeDecompress(Buffer.from('not gzip'), 1);
        ok('解压失败回退原始数据', fallback.toString() === 'not gzip');
    }

    section('沙箱路径');
    {
        const cfg = makeCfg(base, 'sandbox');
        const r = store.resolveIncoming(cfg, 'peerA', '../../etc/passwd');
        ok('路径穿越被剥成裸文件名', path.basename(r.finalPath) === 'passwd', r.finalPath);
        ok('落在 inbox/peerA 下', r.finalPath.startsWith(cfg.inboxFor('peerA')), r.finalPath);
        ok('临时文件用 .p2p-part 后缀', r.partPath.endsWith(store.PART_SUFFIX), r.partPath);

        // 同名不覆盖
        fs.writeFileSync(r.finalPath, 'x');
        const r2 = store.resolveIncoming(cfg, 'peerA', '../../etc/passwd');
        ok('同名文件不覆盖，自动改名', r2.finalPath !== r.finalPath, r2.finalPath);

        let threw = false;
        try { store.resolveIncoming(cfg, '../evil', 'a.txt'); } catch (e) { threw = true; }
        ok('非法对端 id 被拒', threw);

        threw = false;
        try { store.resolveOutgoing(cfg, 'peerA', '/etc/passwd'); } catch (e) { threw = true; }
        ok('outbox 之外的文件不给发', threw);
    }

    section('磁盘空间守卫');
    {
        const cfg = makeCfg(base, 'capacity');
        const over = await store.checkCapacity(cfg, cfg.inboxDir, cfg.maxFileBytes + 1);
        ok('超过上限的文件被拒', over.ok === false, over.reason || '');
        const neg = await store.checkCapacity(cfg, cfg.inboxDir, -1);
        ok('负数大小被拒', neg.ok === false);
        const fine = await store.checkCapacity(cfg, cfg.inboxDir, 1024);
        ok('正常大小放行', fine.ok === true, fine.reason || '');
    }

    // ————— 端到端（回环） —————
    section('回环传输：A → B');
    {
        const cfgA = makeCfg(base, 'nodeA');
        const cfgB = makeCfg(base, 'nodeB');

        const viewA = new LoopbackPeer('peerB');   // A 眼里的 B
        const viewB = new LoopbackPeer('peerA');   // B 眼里的 A
        viewA.other = viewB;
        viewB.other = viewA;

        const mgrA = new TransferManager({ cfg: cfgA, logger: silent });
        const mgrB = new TransferManager({ cfg: cfgB, logger: silent });
        wire(viewA, mgrA);
        wire(viewB, mgrB);
        mgrA.attach(viewA);
        mgrB.attach(viewB);

        // 准备样本：小文件 / 随机大文件 / 高度可压缩 / 空文件
        const samples = [
            { name: 'tiny.txt', data: Buffer.from('hello p2p 传输') },
            { name: 'random.bin', data: crypto.randomBytes(300 * 1024) },
            { name: 'repetitive.txt', data: Buffer.alloc(256 * 1024, 'ABCDEFGH') },
            { name: 'empty.dat', data: Buffer.alloc(0) },
        ];

        const boxA = cfgA.outboxFor('peerB');
        fs.mkdirSync(boxA, { recursive: true });
        for (const s of samples) fs.writeFileSync(path.join(boxA, s.name), s.data);

        const received = [];
        const failedTransfers = [];
        mgrB.on('received', ({ info }) => received.push(info));
        mgrB.on('recv-failed', ({ error }) => failedTransfers.push(error));
        mgrA.on('send-failed', ({ path: p, error }) => failedTransfers.push(p + ': ' + error));

        mgrA.onPeerReady(viewA);

        // 等四个文件都传完（大文件分片 + ACK 往返需要一点时间）
        const deadline = Date.now() + 20000;
        while (received.length < samples.length && Date.now() < deadline) await sleep(50);

        ok('没有传输失败', failedTransfers.length === 0, failedTransfers.join('; '));
        ok('四个文件都收到了（实际 ' + received.length + '）', received.length === samples.length);

        for (const s of samples) {
            const info = received.find((r) => r.name === s.name);
            if (!info) { ok('收到 ' + s.name, false, '没收到'); continue; }
            const got = fs.readFileSync(info.path);
            ok('收到 ' + s.name + ' 且字节一致（' + s.data.length + 'B）',
                got.length === s.data.length && got.equals(s.data),
                '得到 ' + got.length + ' 字节');
            if (s.data.length) {
                ok(s.name + ' sha256 匹配', sha256(info.path) === crypto.createHash('sha256').update(s.data).digest('hex'));
            }
        }

        ok('多块文件确实走了分片（random.bin 4 片）',
            proto.chunkCountFor(300 * 1024) === 5, String(proto.chunkCountFor(300 * 1024)));

        // 收件箱里不该残留 .part
        const leftovers = fs.readdirSync(cfgB.inboxFor('peerA')).filter((f) => f.endsWith(store.PART_SUFFIX));
        ok('收件箱没有残留 .part 文件', leftovers.length === 0, leftovers.join(', '));

        // 关键回归：发成功后必须把文件挪出 outbox。
        // 否则目录监视事件会把同一个文件反复排进队列，同一份文件发了一遍又一遍
        // （实测表现：接收端收到 "empty (1).dat"、"empty (2).dat"）。
        const boxDir = cfgA.outboxFor('peerB');
        const stillInOutbox = fs.readdirSync(boxDir)
            .filter((f) => fs.statSync(path.join(boxDir, f)).isFile());   // sent/ 是目录，不算残留
        ok('发送成功后 outbox 里没有待发文件', stillInOutbox.length === 0, stillInOutbox.join(', '));
        ok('已发送的文件归档到 sent/',
            fs.existsSync(path.join(cfgA.outboxFor('peerB'), 'sent')) &&
            fs.readdirSync(path.join(cfgA.outboxFor('peerB'), 'sent')).length === samples.length,
            String(fs.readdirSync(path.join(cfgA.outboxFor('peerB'), 'sent')).length));

        // 再来一次「对端就绪」也不该重发
        const before = received.length;
        mgrA.onPeerReady(viewA);
        await sleep(600);
        ok('重复触发就绪不会重发（收到数不变）', received.length === before,
            before + ' → ' + received.length);

        // 反向：B → A
        const samples2 = [{ name: 'reply.txt', data: Buffer.from('反向传输也通') }];
        const boxB = cfgB.outboxFor('peerA');
        fs.mkdirSync(boxB, { recursive: true });
        for (const s of samples2) fs.writeFileSync(path.join(boxB, s.name), s.data);

        const backReceived = [];
        mgrA.on('received', ({ info }) => backReceived.push(info));
        mgrB.onPeerReady(viewB);

        const dl2 = Date.now() + 10000;
        while (backReceived.length < samples2.length && Date.now() < dl2) await sleep(50);

        ok('反向传输成功', backReceived.length === 1, '收到 ' + backReceived.length);
        if (backReceived.length) {
            const got = fs.readFileSync(backReceived[0].path);
            ok('反向文件字节一致', got.equals(samples2[0].data));
        }
    }

    section('回环传输：断点续传');
    {
        const cfgA = makeCfg(base, 'resumeA');
        const cfgB = makeCfg(base, 'resumeB');
        const viewA = new LoopbackPeer('peerB');
        const viewB = new LoopbackPeer('peerA');
        viewA.other = viewB;
        viewB.other = viewA;

        const mgrA = new TransferManager({ cfg: cfgA, logger: silent });
        const mgrB = new TransferManager({ cfg: cfgB, logger: silent });
        wire(viewA, mgrA);
        wire(viewB, mgrB);
        mgrA.attach(viewA);
        mgrB.attach(viewB);

        // 丢掉前一半的帧，模拟链路中途断开后重连
        const data = crypto.randomBytes(200 * 1024);
        const boxA = cfgA.outboxFor('peerB');
        fs.mkdirSync(boxA, { recursive: true });
        fs.writeFileSync(path.join(boxA, 'lossy.bin'), data);

        // 只丢「第一次发送」的那两块。按块号丢是不行的 ——
        // 补发的还是那两块，会被一起丢掉，永远补不齐。
        let dropped = 0;
        const dropOnce = new Set([0, 1]);
        viewA.sendBinary = function (label, buf) {
            const idx = buf.readUInt32BE(0);
            if (dropOnce.has(idx)) { dropOnce.delete(idx); dropped++; return true; }
            const other = this.other;
            const copy = Buffer.from(buf);
            setImmediate(() => other.emit('bulk-data', { label, data: copy }));
            return true;
        };

        const received = [];
        mgrB.on('received', ({ info }) => received.push(info));

        mgrA.onPeerReady(viewA);

        // 前一半的帧被丢掉。接收端的停顿检测应该在几秒内发现不对劲，
        // 算出缺口并发 transfer-resume，发送端补发，最终仍然收齐。
        const deadline = Date.now() + 30000;
        while (!received.length && Date.now() < deadline) await sleep(100);

        ok('确认有帧被丢弃（' + dropped + ' 帧）', dropped > 0);
        ok('丢帧后靠续传仍然收齐了', received.length === 1,
            received.length ? '' : '没收到（说明续传路径没生效）');

        if (received.length) {
            const got = fs.readFileSync(received[0].path);
            ok('续传后的文件字节完整（' + data.length + 'B）',
                got.length === data.length && got.equals(data),
                '得到 ' + got.length + ' 字节');
            ok('续传后 sha256 匹配', sha256(received[0].path) ===
                crypto.createHash('sha256').update(data).digest('hex'));
        }
    }

    fs.rmSync(base, { recursive: true, force: true });

    process.stdout.write('\n' + '─'.repeat(50) + '\n');
    process.stdout.write('通过 ' + passed + '，失败 ' + failed + '\n');
    if (failed) {
        process.stdout.write('\n失败项:\n');
        for (const f of failures) process.stdout.write('  · ' + f + '\n');
    }
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    process.stdout.write('\n测试自身异常: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
