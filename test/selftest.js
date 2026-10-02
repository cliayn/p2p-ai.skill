#!/usr/bin/env node
'use strict';

/**
 * 不碰网络的单元测试：调度器不变量、安全工具、SDP 往返、claude 输出解析。
 *   node test/selftest.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { ClaudeScheduler } = require('../src/scheduler');
const { runClaude } = require('../src/claude-runner');
const security = require('../src/security');
const roomid = require('../src/roomid');
const sdp = require('../src/sdp');

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

function section(t) { process.stdout.write('\n' + t + '\n'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 造一个「可执行」的假 claude。
 *
 * POSIX 上 .js 靠 shebang 就能直接 exec，Windows 上不行 —— 得给个真入口。
 * 用 .cmd 顺带把「npm 装的 claude 是 claude.cmd」那条路也覆盖了
 * （runClaude 会自动包一层 cmd.exe）。
 */
function makeFakeClaude() {
    const script = path.join(__dirname, 'fake-claude.js');
    const dir = path.join(os.tmpdir(), 'p2p-fake-claude');
    fs.mkdirSync(dir, { recursive: true });

    if (process.platform === 'win32') {
        const shim = path.join(dir, 'fake-claude.cmd');
        fs.writeFileSync(shim,
            '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n', 'utf8');
        return shim;
    }
    const shim = path.join(dir, 'fake-claude');
    fs.writeFileSync(shim,
        '#!/bin/sh\nexec "' + process.execPath + '" "' + script + '" "$@"\n', 'utf8');
    fs.chmodSync(shim, 0o755);
    return shim;
}

/** 按 runClaude 的方式启动假 claude（Windows 上 .cmd 要经 cmd.exe） */
function spawnShim(shim, args) {
    const { spawn } = require('child_process');
    if (process.platform === 'win32') {
        return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', shim, ...args],
            { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return spawn(shim, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

// ═══════════════════════ 房间号 ═══════════════════════
section('房间号');
{
    const id = roomid.generateRoomId();
    ok('带 p2p-ai-room- 前缀', id.startsWith('p2p-ai-room-'), id);
    ok('长度不超过 24', id.length <= 24, id + ' 长度=' + id.length);
    ok('能被 isServerRoomId 识别', roomid.isServerRoomId(id));
    ok('随机性（两次不同）', roomid.generateRoomId() !== roomid.generateRoomId());

    // 前缀是技能描述里的触发词，得足够长、足够不像日常说的话，
    // 否则用户随口提到某个词就会误命中。这条挡的是「谁手滑把前缀改短了」。
    ok('前缀够独特（≥10 字符，多词连字符）',
        roomid.PREFIX.length >= 10 && roomid.PREFIX.split('-').filter(Boolean).length >= 3,
        roomid.PREFIX + ' 长度=' + roomid.PREFIX.length);

    // 升级前发出去的房间号还得认，不然旧号会被当成普通房间号
    ok('老房间号仍被识别', roomid.isServerRoomId('p2p-serverab12cd34ef'));
    ok('随便一个房间号不会被误认', !roomid.isServerRoomId('my-room-123'));

    let threw = false;
    try { roomid.validateRoomId('x'.repeat(25)); } catch (e) { threw = true; }
    ok('超长房间号被拒绝而不是截断', threw);

    // 房间号填错是最常见的失败。入口见到 expected 就只打一行人话 ——
    // 没这个标记的话用户/AI 看到的是十几行堆栈，真正的原因被淹在中间。
    let expected = false;
    try { roomid.validateRoomId('x'.repeat(25)); } catch (e) { expected = e.expected === true; }
    ok('房间号错误带 expected 标记（入口据此少打堆栈）', expected);

    let emptyExpected = false;
    try { roomid.validateRoomId('   '); } catch (e) { emptyExpected = e.expected === true; }
    ok('空房间号也带 expected 标记', emptyExpected);

    ok('正常房间号通过校验', roomid.validateRoomId('  p2p-ai-room-abc  ') === 'p2p-ai-room-abc');

    // 手填一个超长房间号时必须报错，否则网页那边会静默截断成别的房间。
    // 自动生成的长度正好顶在 24 上，所以这条线现在是真的贴边。
    let onPrefix = false;
    try { roomid.validateRoomId(roomid.PREFIX + 'x'.repeat(13)); } catch (e) { onPrefix = true; }
    ok('刚好越过 24 的号被拒绝', onPrefix);

    // 手填的房间号**不要求**前缀：房间里人多时靠「对方的 id」区分，不靠房间号。
    // `--room 1` 是明确要支持的用法。
    ok('短号（--room 1）可用', roomid.validateRoomId('1') === '1');
    ok('不带前缀的普通号可用', roomid.validateRoomId('my-room-123') === 'my-room-123');
    ok('短号不会被当成技能房间号', !roomid.isServerRoomId('1'));
}

// ═══════════════════════ 房间号的随机性 ═══════════════════════
section('随机房间号：同刻也必须不同');
{
    // 这条是本轮的核心需求。构造里混了时间戳，但**时间戳不提供唯一性** ——
    // 同一毫秒里起一百个监听也是常态（脚本批量拉起、容器同时启动）。
    // 真正扛住这件事的是 32 字节 nonce，下面把它钉死。
    const sameNow = 1760000000000;
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(roomid.generateRoomId({ now: sameNow }));
    ok('同一个时间戳下生成 500 个，两两不同', seen.size === 500, '实际只出了 ' + seen.size + ' 个');

    // 2000 个连号生成，确认没有系统性重复（也顺带看 base31 取模没搞出偏斜）
    const bulk = new Set();
    for (let i = 0; i < 2000; i++) bulk.add(roomid.generateRoomId());
    ok('连续生成 2000 个没有重复', bulk.size === 2000, '实际 ' + bulk.size + ' 个');

    // 字符合法：网页输入框和人对抄都只认这套字母表
    const id = roomid.generateRoomId();
    const body = id.slice(roomid.PREFIX.length);
    ok('随机部分是允许的字符集', /^[23456789abcdefghjkmnpqrstuvwxyz]+$/.test(body), body);
    ok('随机部分长度是 RAND_LEN', body.length === roomid.RAND_LEN, body.length + ' vs ' + roomid.RAND_LEN);
    ok('自动生成的长度正好顶到 24', id.length === 24, String(id.length));

    // 构造是纯函数：喂同样的时间戳和 nonce 必须出同样的号。
    // 这条挡的是「谁往里面塞了模块级可变状态」，那样就复现不了了。
    const nonce = Buffer.alloc(32, 7);
    ok('同样的输入产出同样的号',
        roomid.generateRoomId({ now: sameNow, nonce }) === roomid.generateRoomId({ now: sameNow, nonce }));
    ok('只换时间戳就换号',
        roomid.generateRoomId({ now: sameNow, nonce }) !== roomid.generateRoomId({ now: sameNow + 1, nonce }));
    ok('只换 nonce 就换号',
        roomid.generateRoomId({ now: sameNow, nonce }) !==
        roomid.generateRoomId({ now: sameNow, nonce: Buffer.alloc(32, 8) }));
}

// ═══════════════════════ 房间号密钥 ═══════════════════════
section('房间号密钥（Ed25519）');
{
    const { loadOrCreateRoomKey } = require('../src/roomkey');
    const crypto = require('crypto');
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const dir = path.join(os.tmpdir(), 'p2p-key-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });

    const a = loadOrCreateRoomKey(dir, silent);
    ok('首次调用会生成密钥文件', a.created === true && fs.existsSync(a.path), a.path);
    ok('返回了公私钥和指纹', !!a.privateKey && !!a.publicKey && /^[0-9a-f]{16}$/.test(a.fingerprint), a.fingerprint);

    if (process.platform !== 'win32') {
        const mode = fs.statSync(a.path).mode & 0o777;
        ok('密钥文件权限是 0600', mode === 0o600, '0' + mode.toString(8));
    }

    // 第二次必须复用同一把。生成新的不会有报错、只会让指纹悄悄变掉，
    // 所以这条得盯着指纹比，不能只看「文件还在」。
    const b = loadOrCreateRoomKey(dir, silent);
    ok('第二次复用同一把密钥', b.created === false && b.fingerprint === a.fingerprint);

    // 签名能被自己的公钥验过 —— 证明这确实是一对可用的 Ed25519 密钥
    const msg = Buffer.from('hello');
    const sig = crypto.sign(null, msg, a.privateKey);
    ok('私钥签的东西公钥能验', crypto.verify(null, msg, a.publicKey, sig));
    ok('签名长度是 64 字节（Ed25519）', sig.length === 64, String(sig.length));

    // 混了签名的房间号和没混的是两个值：证明签名确实进了 preimage，
    // 而不是写了参数却忘了用。
    const nonce = Buffer.alloc(32, 1);
    ok('密钥确实参与了房间号构造',
        roomid.generateRoomId({ now: 1, nonce }) !== roomid.generateRoomId({ now: 1, nonce, key: a }));

    // 损坏的密钥不能让启动挂掉：隔离旧文件、生成新的、继续跑
    fs.writeFileSync(a.path, '这不是一个 PEM\n');
    const c = loadOrCreateRoomKey(dir, silent);
    ok('密钥损坏后能自愈并生成新的一把', c.created === true && c.fingerprint !== a.fingerprint);
    const left = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    ok('损坏的旧密钥被隔离而不是删掉', left.length === 1, left.join(', '));

    fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════ 文件名消毒 ═══════════════════════
section('文件名消毒');
{
    const s = security.sanitizeFilename;
    // 只取 basename 就等于把穿越部分整个丢掉：../../etc/passwd 落到沙箱里叫 passwd
    ok('路径穿越被剥掉', s('../../etc/passwd') === 'passwd', String(s('../../etc/passwd')));
    ok('深层穿越只剩文件名', s('../../../../root/.ssh/id_rsa') === 'id_rsa', String(s('../../../../root/.ssh/id_rsa')));
    ok('Windows 反斜杠路径被剥掉', s('C:\\Windows\\system32\\evil.exe') === 'evil.exe', String(s('C:\\Windows\\system32\\evil.exe')));
    ok('正斜杠路径取最后一段', s('a/b/c.txt') === 'c.txt', String(s('a/b/c.txt')));
    ok('空字节被清掉', s('a\u0000b.txt') === 'a_b.txt', String(s('a\u0000b.txt')));
    ok('前导点被去掉（挡 .bashrc）', s('.bashrc') === 'bashrc', String(s('.bashrc')));
    ok('纯 .. 被拒绝', s('..') === null);
    ok('纯 . 被拒绝', s('.') === null);
    ok('空字符串被拒绝', s('') === null);
    ok('非字符串被拒绝', s(null) === null);
    ok('保留名被加前缀', String(s('CON')).startsWith('_'), String(s('CON')));
    ok('冒号等非法字符被替换', !s('a:b*c?d.txt').includes(':'), String(s('a:b*c?d.txt')));
    ok('超长名被截断到 180 字节内', Buffer.byteLength(s('好'.repeat(200) + '.txt')) <= 180,
        String(Buffer.byteLength(s('好'.repeat(200) + '.txt'))));
}

section('路径包含判定');
{
    const base = path.join(os.tmpdir(), 'p2p-sandbox');
    ok('子路径通过', security.isWithin(base, path.join(base, 'a', 'b.txt')));
    ok('自身通过', security.isWithin(base, base));
    ok('父目录被拒', !security.isWithin(base, path.join(base, '..', 'evil')));
    ok('同前缀的兄弟目录被拒', !security.isWithin(base, base + '-evil/x'));
    ok('绝对逃逸被拒', !security.isWithin(base, '/etc/passwd'));
}

section('限流令牌桶');
{
    const b = new security.TokenBucket({ rate: 5, burst: 5 });
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (b.take(10)) allowed++;
    ok('突发上限生效（5）', allowed === 5, '放行 ' + allowed);

    const bb = new security.TokenBucket({ rate: 100, burst: 100, bytesRate: 1000, bytesBurst: 1000 });
    ok('字节维度生效', bb.take(5000) === false);
    ok('字节维度放行正常大小', bb.take(100) === true);
}

// ═══════════════════════ SDP ═══════════════════════
section('SDP 往返');
{
    const compact = { u: 'ufrag123', p: 'pwd456', f: 'AB:CD:EF', ice: [{ ip: '1.2.3.4', port: 5000, type: 'host' }], stunIp: null };
    const offer = sdp.fromCompact('offer', compact);
    ok('offer 用 a=setup:actpass', offer.includes('a=setup:actpass'));
    ok('含 ufrag/pwd/fingerprint', offer.includes('a=ice-ufrag:ufrag123') && offer.includes('a=ice-pwd:pwd456') && offer.includes('AB:CD:EF'));
    ok('内联了 ICE 候选', /^a=candidate:.*1\.2\.3\.4 5000 typ host/m.test(offer));
    ok('用 CRLF 行尾（没有裸 \\n）', offer.includes('\r\n') && !/[^\r]\n/.test(offer));

    const answer = sdp.fromCompact('answer', compact);
    ok('answer 用 a=setup:active', answer.includes('a=setup:active'));
    ok('answer 不含 actpass', !answer.includes('actpass'));

    ok('缺字段时抛错', (() => { try { sdp.fromCompact('offer', { u: 'x' }); return false; } catch (e) { return true; } })());
    ok('validateCompact 能挑出问题', sdp.validateCompact({ u: 'a' }) === 'missing p');

    const c = sdp.parseCandidate('candidate:1 1 udp 2113937151 10.0.0.5 54321 typ host generation 0 ufrag xy network-cost 999');
    ok('候选解析出 ip/port/type', c && c.ip === '10.0.0.5' && c.port === 54321 && c.type === 'host');
    ok('TCP 候选被过滤', sdp.parseCandidate('candidate:1 1 tcp 211 1.2.3.4 5000 typ host tcptype active') === null);
    ok('低端口候选被过滤', sdp.parseCandidate('candidate:1 1 udp 211 1.2.3.4 80 typ host') === null);
}

// ═══════════════════════ 调度器 ═══════════════════════
section('调度器：每对端串行 + 全局上限');
(async () => {
    // ═══════════════════════ 模块加载 ═══════════════════════
    // 放在最前面：任何语法错误 / 顶层引用错误在这里就炸成一条测试失败，
    // 而不是拖到套件跑到一半时把整个进程带崩（那样后面的用例根本没机会跑）
    section('模块加载');
    {
        const srcDir = path.join(__dirname, '..', 'src');
        const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
        for (const f of files) {
            let err = null;
            try { require(path.join(srcDir, f)); } catch (e) { err = e; }
            ok('加载 ' + f, !err, err ? err.message : '');
        }
    }

    // ═══════════════════════ 命令行参数 ═══════════════════════
    // p2p-ctl 的 flag 前后位置都能写，代价是 say 的正文可能跟 flag 撞车。
    // 这些用例把「怎么算 flag、怎么算正文」钉死，免得以后改动悄悄改了语义。
    section('p2p-ctl 参数解析');
    {
        const { splitArgs } = require('../bin/p2p-ctl');

        let r = splitArgs(['status', '--sock', '/tmp/a.sock']);
        ok('flag 在命令后', r.command === 'status' && r.flags.join(' ') === '--sock /tmp/a.sock',
            JSON.stringify(r));

        r = splitArgs(['--sock', '/tmp/a.sock', 'status']);
        ok('flag 在命令前', r.command === 'status' && r.flags.join(' ') === '--sock /tmp/a.sock',
            JSON.stringify(r));

        r = splitArgs(['--sock=/tmp/a.sock', 'peers']);
        ok('--flag=值 形式', r.command === 'peers' && r.flags.join(' ') === '--sock=/tmp/a.sock',
            JSON.stringify(r));

        r = splitArgs(['say', 'ab12', '你好', '世界']);
        ok('say 多词正文拼回一句', r.command === 'say' && r.args.join(' ') === 'ab12 你好 世界',
            JSON.stringify(r.args));

        // 认得的 flag 一律当 flag —— 这是上面注释里写明的取舍
        r = splitArgs(['--sock', '/tmp/a.sock', 'say', 'ab12', '你好', '--sock', '/tmp/b.sock']);
        ok('正文里的 --sock 会被当成 flag', r.flags.join(' ') === '--sock /tmp/a.sock --sock /tmp/b.sock'
            && r.args.join(' ') === 'ab12 你好', JSON.stringify(r));

        // `--` 之后一律原样，是说要写 -- 开头的正文时的唯一出路
        r = splitArgs(['--sock', '/tmp/a.sock', 'say', 'ab12', '你好', '--', '--sock', '是正文']);
        ok('-- 之后原样进正文', r.args.join(' ') === 'ab12 你好 --sock 是正文'
            && r.flags.join(' ') === '--sock /tmp/a.sock', JSON.stringify(r));

        r = splitArgs(['--sock', '/tmp/a.sock', 'send', 'ab12', '/tmp/x.bin', '--', '--weird']);
        ok('send 的文件名不受 -- 影响', r.args[0] === 'ab12' && r.args[1] === '/tmp/x.bin'
            && r.args[2] === '--weird', JSON.stringify(r.args));

        // 不以 -- 开头的单横线/中文破折号不是 flag
        r = splitArgs(['say', 'ab12', '-3 度', '注意--这里']);
        ok('正文里的单个 - 不算 flag', r.args.join(' ') === 'ab12 -3 度 注意--这里', JSON.stringify(r.args));

        r = splitArgs(['--help']);
        ok('--help 不产生命令', r.command === null, JSON.stringify(r));
        r = splitArgs(['-h']);
        ok('-h 不产生命令', r.command === null, JSON.stringify(r));
        r = splitArgs([]);
        ok('空参数不产生命令', r.command === null, JSON.stringify(r));

        // 会吃值的 flag 后面必须跟一个值，否则会把命令吞掉
        r = splitArgs(['--workdir', '/tmp/wd', 'sessions']);
        ok('带值 flag 不吃掉命令', r.command === 'sessions' && r.args.length === 0, JSON.stringify(r));
    }

    {
        const sched = new ClaudeScheduler({ maxConcurrent: 2, logger: silent });
        const perPeer = new Map();
        let globalNow = 0;
        let globalMax = 0;
        const violations = [];
        const done = [];

        const mk = (peerId, ms) => sched.submit({
            peerId,
            exec: async () => {
                const n = (perPeer.get(peerId) || 0) + 1;
                perPeer.set(peerId, n);
                if (n > 1) violations.push(peerId + ' 并发=' + n);
                globalNow++;
                globalMax = Math.max(globalMax, globalNow);
                await sleep(ms);
                globalNow--;
                perPeer.set(peerId, perPeer.get(peerId) - 1);
                done.push(peerId);
            },
        });

        const jobs = [];
        for (const p of ['A', 'B', 'C']) for (let i = 0; i < 4; i++) jobs.push(mk(p, 15));
        await Promise.all(jobs.map((j) => j.promise));

        ok('同一对端任何时刻只有一个任务在跑', violations.length === 0, violations.join('; '));
        ok('全局并发不超过上限 2', globalMax <= 2, '观测到峰值 ' + globalMax);
        ok('全部 12 个任务都完成', done.length === 12, '完成 ' + done.length);
    }

    section('调度器：公平性（不饿死安静对端）');
    {
        const sched = new ClaudeScheduler({ maxConcurrent: 2, logger: silent });
        const order = [];
        const mk = (peerId, ms) => sched.submit({
            peerId,
            exec: async () => { await sleep(ms); order.push(peerId); },
        });

        const aJobs = [];
        for (let i = 0; i < 10; i++) aJobs.push(mk('A', 10));   // A 先排 10 条
        const bJob = mk('B', 10);                                // B 后到 1 条

        await Promise.all([...aJobs, bJob].map((j) => j.promise));
        const bPos = order.indexOf('B');
        ok('B 没有被 A 的积压饿死', bPos < 4, 'B 在第 ' + (bPos + 1) + ' 位完成，顺序=' + order.join(''));
    }

    section('调度器：取消');
    {
        const sched = new ClaudeScheduler({ maxConcurrent: 1, logger: silent });
        let aborted = false;
        let runningStarted = false;

        const long = sched.submit({
            peerId: 'A',
            exec: async (ctx) => {
                runningStarted = true;
                await new Promise((res) => {
                    ctx.signal.addEventListener('abort', () => { aborted = true; res(); }, { once: true });
                    setTimeout(res, 5000);
                });
            },
        });
        const q1 = sched.submit({ peerId: 'A', exec: async () => {} });
        const q2 = sched.submit({ peerId: 'A', exec: async () => {} });

        await sleep(30);
        sched.cancelPeer('A', 'test');

        const r1 = await q1.promise;
        const r2 = await q2.promise;
        ok('排队中的任务被取消并带错误', !!r1.error && !!r2.error);
        ok('正在运行的任务收到 abort', aborted);
        ok('取消后队列清空', sched.stats.queued === 0, '剩余 ' + sched.stats.queued);
        ok('取消后没有任务仍在跑', sched.stats.running === 0, '剩余 ' + sched.stats.running);
        await long.promise.catch(() => {});
    }

    // ═══════════════════════ claude-runner ═══════════════════════
    section('claude-runner（用假 claude 验证解析）');
    {
        const fakeBin = makeFakeClaude();
        if (!fs.existsSync(fakeBin)) {
            ok('假 claude 存在', false, fakeBin + ' 不存在');
        } else {
            // 事件顺序：session_id 必须在第一段文本之前拿到（早回执的前提）
            const events = [];
            const r = await runClaude({
                bin: fakeBin,
                prompt: '你好世界',
                cwd: __dirname,
                timeoutMs: 15000,
                logger: silent,
                onSessionId: (sid) => events.push('session:' + sid),
                onAssistantText: (t) => events.push('text:' + t),
            });

            ok('执行成功', r.ok === true, r.error || '');
            ok('拿到 session_id', typeof r.sessionId === 'string' && r.sessionId.startsWith('fake-init-'), String(r.sessionId));
            ok('onSessionId 早于 onAssistantText', events.length >= 2 && events[0].startsWith('session:'), events.join(' | '));
            ok('两段文本都收到了', r.chunks.length === 2, JSON.stringify(r.chunks));
            ok('文本内容正确（prompt 经 stdin 传入）', r.text.includes('你好世界'), r.text);
            ok('没有把 prompt 放进 argv', !r.stderr.includes('你好世界'));

            // --resume 传参
            let argvSeen = null;
            const r2 = await runClaude({
                bin: fakeBin,
                prompt: '继续',
                sessionId: 'prev-session-id',
                cwd: __dirname,
                timeoutMs: 15000,
                logger: silent,
            });
            ok('续接时返回新的 session_id', typeof r2.sessionId === 'string' && r2.sessionId.startsWith('fake-resumed-'), String(r2.sessionId));
            ok('续接没有把旧 id 原样返回', r2.sessionId !== 'prev-session-id');

            // 超时
            const t0 = Date.now();
            const r3 = await runClaude({
                bin: fakeBin, prompt: '卡住', cwd: __dirname, timeoutMs: 400, logger: silent,
                extraArgs: [],
            });
            ok('超时能收敛（不会挂住）', Date.now() - t0 < 5000, '耗时 ' + (Date.now() - t0) + 'ms');

            // 找不到可执行文件
            const r4 = await runClaude({ bin: '/nonexistent/claude-xyz', prompt: 'x', cwd: __dirname, timeoutMs: 5000, logger: silent });
            ok('可执行文件缺失时给出明确错误', r4.ok === false && /找不到 claude/.test(r4.error || ''), String(r4.error));
        }
    }

    section('claude-runner：参数构造');
    {
        const fakeBin = makeFakeClaude();
        // 通过假 claude 回传的 __argv 检查我们拼的命令行
        const captured = await new Promise((resolve) => {
            const c = spawnShim(fakeBin, ['-p', '--output-format', 'stream-json', '--verbose', '--resume', 'abc', '--allowedTools', 'Read,Bash']);
            let out = '';
            c.stdout.on('data', (d) => { out += d.toString(); });
            c.on('close', () => {
                const line = out.trim().split('\n').find((l) => l.includes('__argv'));
                resolve(line ? JSON.parse(line).__argv : null);
            });
            c.stdin.end('x');
        });
        ok('假 claude 能回传 argv（测试自检）', Array.isArray(captured), JSON.stringify(captured));
    }

    // ═══════════════════════ 对话：回执不该触发一轮 claude ═══════════════════════
    section('对话：回执处理');
    {
        const { Conversation } = require('../src/conversation');
        const { SessionStore } = require('../src/session-store');
        const { loadConfig } = require('../src/config');

        const dir = path.join(os.tmpdir(), 'p2p-conv-test-' + Date.now());
        const store = new SessionStore({ dir, logger: silent });
        const cfg = loadConfig([], {});

        let runs = 0;
        const fakePeer = { peerId: 'p1', isOpen: () => true, sendJson: () => true };
        const sched = new ClaudeScheduler({ maxConcurrent: 1, logger: silent });
        const conv = new Conversation({
            peer: fakePeer, store, scheduler: sched, config: cfg, logger: silent,
            runner: async () => { runs++; return { ok: true, chunks: ['回复'], sessionId: 's' }; },
        });

        // 协议里没有 typing 消息类型，回执只能是一条真的 chat，必须被识别出来
        await conv.onPeerMessage({ text: '收到，让我想一下 ~', seq: 1, ts: 1, ack: true });
        await sleep(50);
        ok('回执不会触发 claude', runs === 0, '触发 ' + runs + ' 次');

        await conv.onPeerMessage({ text: '真正的问题', seq: 2, ts: 2 });
        await sleep(50);
        ok('正常消息会触发 claude', runs === 1, '触发 ' + runs + ' 次');

        // 重复 seq 去重
        await conv.onPeerMessage({ text: '真正的问题', seq: 2, ts: 3 });
        await sleep(50);
        ok('重复 seq 被去重', runs === 1, '触发 ' + runs + ' 次');

        // autoReply 关闭
        const conv2 = new Conversation({
            peer: fakePeer, store: new SessionStore({ dir, logger: silent }), scheduler: sched,
            config: Object.assign({}, cfg, { autoReply: false }), logger: silent,
            runner: async () => { runs++; return { ok: true, chunks: ['x'], sessionId: 's' }; },
        });
        await conv2.onPeerMessage({ text: '不该回的消息', seq: 1, ts: 1 });
        await sleep(50);
        ok('autoReply 关闭时不触发 claude', runs === 1, '触发 ' + runs + ' 次');

        conv.stop(); conv2.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ═══════════════════════ 切换历史会话 ═══════════════════════
    // 网页上「续接历史」就是改这条对话链。最阴的地方是：用户切走之后，
    // 正在跑的那一轮结束时会把它自己产生的新 id 写回去，把用户的选择顶掉。
    // 下面两个用例一个钉住「切走了就不许覆盖」，一个钉住「没切走照常推进」。
    section('对话：切换历史会话');
    {
        const { Conversation } = require('../src/conversation');
        const { SessionStore } = require('../src/session-store');
        const { loadConfig } = require('../src/config');

        const dir = path.join(os.tmpdir(), 'p2p-switch-test-' + Date.now());
        const cfg = loadConfig([], {});
        const fakePeer = { peerId: 'p1', isOpen: () => true, sendJson: () => true };

        /** 造一个能被卡住的 runner，好在"生成中"这个窗口里做切换 */
        function makeConv(store) {
            let release = null;
            const gate = new Promise((r) => { release = r; });
            const conv = new Conversation({
                peer: fakePeer, store, scheduler: new ClaudeScheduler({ maxConcurrent: 1, logger: silent }),
                config: cfg, logger: silent,
                runner: async (opts) => {
                    await gate;                                  // 卡在这儿，模拟 claude 正在生成
                    if (opts.onSessionId) opts.onSessionId(conv._newId);   // 真 runner 也是这么回调的
                    return { ok: true, chunks: ['回复'], sessionId: conv._newId };
                },
            });
            return { conv, release };
        }

        // —— 场景 1：生成中途被切走，用户的选择优先 ——
        {
            const store = new SessionStore({ dir: dir + '-a', logger: silent });
            await store.advanceSession('p1', 'old-session');
            const { conv, release } = makeConv(store);
            conv._newId = 'new-from-old';

            await conv.onPeerMessage({ text: '在吗', seq: 1, ts: 1 });
            await sleep(30);
            ok('起跑时用的是旧会话', conv._runningBase === 'old-session', String(conv._runningBase));

            await conv.setSession('picked-from-history');   // 用户点了「续接历史」
            ok('setSession 立即生效', conv.sessionId === 'picked-from-history', String(conv.sessionId));

            release();
            await sleep(60);
            ok('生成结束后不覆盖用户选的会话',
                store.get('p1').sessionId === 'picked-from-history', String(store.get('p1').sessionId));

            conv.stop();
        }

        // —— 场景 2：没被切走，会话链照常往前走 ——
        {
            const store = new SessionStore({ dir: dir + '-b', logger: silent });
            await store.advanceSession('p1', 'old-session');
            const { conv, release } = makeConv(store);
            conv._newId = 'new-from-old';

            await conv.onPeerMessage({ text: '在吗', seq: 1, ts: 1 });
            await sleep(30);
            release();
            await sleep(60);
            ok('没切换时正常推进到新会话',
                store.get('p1').sessionId === 'new-from-old', String(store.get('p1').sessionId));

            conv.stop();
        }

        // —— 场景 3：setSession(null) 就是开新对话 ——
        {
            const store = new SessionStore({ dir: dir + '-c', logger: silent });
            await store.advanceSession('p1', 'old-session');
            const { conv, release } = makeConv(store);
            conv._newId = 'unused';

            await conv.setSession(null);
            ok('传 null 清空会话（= 开新对话）', store.get('p1').sessionId === null, String(store.get('p1').sessionId));

            release();
            conv.stop();
        }

        fs.rmSync(dir + '-a', { recursive: true, force: true });
        fs.rmSync(dir + '-b', { recursive: true, force: true });
        fs.rmSync(dir + '-c', { recursive: true, force: true });
    }

    // ═══════════════════════ 关掉历史会话列表 ═══════════════════════
    // 会话列表是整个项目里唯一一处把「工作目录以外的数据」交给对端的地方：
    // 列表里的 preview 就是运营方过去对话的开头。要有能一关就干净的口子。
    section('配置：--no-session-list');
    {
        const { loadConfig } = require('../src/config');
        const { Daemon } = require('../src/daemon');

        ok('默认开着', loadConfig([], {}).sessionList === true);
        ok('--no-session-list 关掉', loadConfig(['--no-session-list'], {}).sessionList === false);

        // 上面那几条只证明 flag 解析对了。真正要的是它一路传到 daemon 手上 ——
        // 中间少接一环的话，前面全绿也白搭。
        {
            const scratch = path.join(os.tmpdir(), 'p2p-cfg-wire-' + Date.now());
            const d = new Daemon(loadConfig(['--no-session-list'], {
                STATE_DIR: scratch, FILES_ROOT: scratch,
            }));
            ok('flag 一路传到了 daemon.cfg', d.cfg.sessionList === false, String(d.cfg.sessionList));
            fs.rmSync(scratch, { recursive: true, force: true });
        }

        ok('SESSION_LIST=0 关掉', loadConfig([], { SESSION_LIST: '0' }).sessionList === false);
        ok('SESSION_LIST=1 开着', loadConfig([], { SESSION_LIST: '1' }).sessionList === true);

        /**
         * 只需要这几个字段，不必真起一个 daemon。
         * 但得挂在 Daemon.prototype 上 —— _applyAiMode 内部会调 this._sendSessionList，
         * 拿个裸对象去 call 会直接炸。
         */
        function fakeDaemon(sessionList) {
            const sent = [];
            const calls = [];
            const self = Object.assign(Object.create(Daemon.prototype), {
                cfg: { sessionList, workdir: path.join(os.tmpdir(), 'p2p-nope-' + Date.now()) },
                log: silent,
                conversations: new Map([['p1', {
                    sessionId: 'live-session',
                    setSession: async (sid) => { calls.push(sid); },
                }]]),
            });
            const peer = { peerId: 'p1', sendJson: (m) => sent.push(m) };
            return { self, peer, sent, calls };
        }

        // —— 关掉之后：列表是空的，而且要说清楚为什么 ——
        {
            const { self, peer, sent } = fakeDaemon(false);
            self._sendSessionList(peer);
            ok('关掉后 sessions 是空数组', Array.isArray(sent[0].sessions) && sent[0].sessions.length === 0,
                JSON.stringify(sent[0].sessions));
            ok('关掉后给出说明（不然网页一直卡在"正在获取…"）',
                /no-session-list/.test(String(sent[0].error)), String(sent[0].error));
        }

        // —— 关掉之后仍然允许「开新对话」，只是不许挑历史 ——
        {
            const { self, peer, sent, calls } = fakeDaemon(false);
            await self._applyAiMode(peer, { sessionId: null });
            ok('关掉后仍能开新对话', calls.length === 1 && calls[0] === null, JSON.stringify(calls));

            sent.length = 0;
            await self._applyAiMode(peer, { sessionId: 'live-session' });
            ok('关掉后不能续接历史会话（哪怕 id 是真的）', calls.length === 1, JSON.stringify(calls));
            ok('关掉后这条请求也会得到回复', sent.length === 1, JSON.stringify(sent));
        }

        // —— 开着的时候：开新对话不受影响（挑历史要走真会话目录，e2e 里覆盖） ——
        {
            const { self, peer, calls } = fakeDaemon(true);
            await self._applyAiMode(peer, { sessionId: null });
            ok('开着时会话列表不影响开新对话', calls.length === 1 && calls[0] === null, JSON.stringify(calls));
        }

        // —— 点名看内容：这是内容出去的第二条路，闸门要和列表一样严 ——
        {
            const { self, peer, sent } = fakeDaemon(false);
            self._sendSessionPeek(peer, 'whatever');
            ok('关掉列表时也看不了内容',
                sent[0].preview === undefined && /no-session-list/.test(String(sent[0].error)),
                JSON.stringify(sent[0]));

            const on = fakeDaemon(true).self;
            const p2 = { peerId: 'p1', sendJson: (m) => sent.push(m) };

            sent.length = 0;
            on._sendSessionPeek(p2, null);
            ok('没给 sessionId 就什么都不给', sent[0].preview === undefined && !!sent[0].error,
                JSON.stringify(sent[0]));

            // workdir 指向一个不存在的目录 → 列表为空 → 任何 id 都找不到。
            // 重点是：拿不到的 id 不会变成「那就直接去读那个文件」。
            sent.length = 0;
            on._sendSessionPeek(p2, '../../etc/passwd');
            ok('白名单外的 id 一律拒绝（含路径穿越写法）',
                sent[0].preview === undefined && /找不到这个会话/.test(String(sent[0].error)),
                JSON.stringify(sent[0]));
        }
    }

    // ═══════════════════════ 会话存储 ═══════════════════════
    section('会话存储：并发写不互相踩');
    {
        const { SessionStore } = require('../src/session-store');
        const errs = [];
        const capture = { debug() {}, info() {}, warn() {}, error: (m) => errs.push(m) };
        const dir = path.join(os.tmpdir(), 'p2p-store-test-' + Date.now());

        const store = new SessionStore({ dir, logger: capture });
        const peer = 'testpeer';

        // 同一对端的多个写入并发触发，正是 enqueue + _sendChat 的真实形态
        await Promise.all([
            store.enqueue(peer, { seq: 1, text: 'a', ts: 1 }),
            store.save(peer),
            store.addUndelivered(peer, { seq: 1, text: 'b', ts: 2 }),
            store.save(peer),
            store.advanceSession(peer, 'sess-x'),
        ]);

        ok('并发写入没有报错（临时文件名唯一）', errs.length === 0, errs.join('; '));

        const s = store.get(peer);
        ok('队列保住了', s.queue.length === 1, '长度 ' + s.queue.length);
        ok('待补发保住了', s.undelivered.length === 1, '长度 ' + s.undelivered.length);
        ok('会话 id 保住了', s.sessionId === 'sess-x', String(s.sessionId));

        // 从磁盘重新加载，确认真的落盘了
        const reopened = new SessionStore({ dir, logger: capture });
        const s2 = reopened.get(peer);
        ok('重新加载后状态一致', s2.queue.length === 1 && s2.sessionId === 'sess-x');

        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ═══════════════════════ 定向连接 ═══════════════════════
    section('定向连接：--peer');
    {
        const { Daemon } = require('../src/daemon');

        // 只搭出 _tryConnectToAnyone 真正会碰到的那几个字段，不跑真信令。
        // connectTo 换成一个只记账的假实现（除非用例特意要测真 connectTo）。
        function mk(cfg, opts) {
            opts = opts || {};
            const attempts = [];
            const sent = [];
            const self = Object.assign(Object.create(Daemon.prototype), {
                cfg: Object.assign({ targetPeer: null, allowedPeers: [] }, cfg || {}),
                log: silent,
                stopping: false,
                peers: new Map(),
                pendingRequests: new Set(),
                signaling: { myId: 'me', connected: true, send: (t, to) => sent.push(t + ':' + to) },
                connectTo: opts.realConnect
                    ? Daemon.prototype.connectTo
                    : (id) => { attempts.push(id); return true; },
            });
            return { self, attempts, sent };
        }

        let { self, attempts } = mk();
        self._tryConnectToAnyone(['a', 'b', 'c']);
        ok('没指定目标时连第一个', attempts.join(',') === 'a', attempts.join(',') || '（没连）');

        ({ self, attempts } = mk({ targetPeer: 'c' }));
        self._tryConnectToAnyone(['a', 'b', 'c']);
        ok('指定目标时只连目标', attempts.join(',') === 'c', attempts.join(',') || '（没连）');

        // 目标还没进房间：不能退而求其次连别人，那正是「连错人」的场景
        ({ self, attempts } = mk({ targetPeer: 'z' }));
        self._tryConnectToAnyone(['a', 'b']);
        ok('目标不在房间里时谁也不连', attempts.length === 0, attempts.join(','));

        ({ self, attempts } = mk({ targetPeer: 'me' }));
        self._tryConnectToAnyone(['me']);
        ok('目标是自己的 id 时不自连', attempts.length === 0);

        // 已经连上/正在连的就不再重复发起
        ({ self, attempts } = mk({ targetPeer: 'c' }));
        self.peers.set('c', {});
        self._tryConnectToAnyone(['c']);
        ok('目标已经在连/已连上时不重复发起', attempts.length === 0);

        // 这条是回归：以前 `this.connectTo(id); return;` 无条件返回，
        // 第一个候选被白名单挡掉之后，后面的候选再也不会被试到 ——
        // 房间里明明坐着个能连的，这边却一直干等。
        const r = mk({ allowedPeers: ['b'] }, { realConnect: true });
        r.self._tryConnectToAnyone(['a', 'b']);
        ok('第一个候选被白名单挡掉后会继续试下一个',
            r.sent.join(',') === 'connect_request:b', r.sent.join(',') || '（一条都没发）');
    }

    // ═══════════════════════ 报出自己的 id ═══════════════════════
    section('报号：房间号 + 我的id');
    {
        const { roomLine, idLines } = require('../bin/p2p-listen');

        ok('房间号那行是能 grep 的 key: value',
            roomLine('p2p-ai-room-abc') === '房间号: p2p-ai-room-abc');

        const out = idLines('p2p-ai-room-abc', 'zt9t');
        ok('有一行能 grep 的「我的id: 」', out.indexOf('我的id: zt9t\n') === 0, JSON.stringify(out.slice(0, 40)));
        // 用户要的整段复制格式：房间号和 id 都在同一行里，念出来就是一句话
        ok('给对面复制的那行同时含房间号和 id',
            out.indexOf('房间号以及 id 为 p2p-ai-room-abc 和 zt9t') >= 0, JSON.stringify(out.slice(0, 80)));
        ok('说明这行是干什么用的', out.indexOf('选择连接') > 0);
    }

    // ═══════════════════════ 会话开头 ═══════════════════════
    // 对端「看内容」看到的就是这里算出来的 preview。人格是拼在第一条用户消息
    // 最前面的，不剥掉的话每条会话都返回同一段模板 —— 那这个功能就没意义了。
    section('会话预览：剥掉注入的人格');
    {
        const store = require('../src/session-store');
        const { PERSONA_OPEN: O, PERSONA_CLOSE: C } = store;

        ok('剥掉开头的完整人格块',
            store.stripLeadingPersona(O + '\n你是 P2P 实例。\n' + C + '\n\n请记住这个数字：7391')
                .trim() === '请记住这个数字：7391');

        ok('前导空白不影响识别',
            store.stripLeadingPersona('  \n' + O + 'x' + C + '真问题').trim() === '真问题');

        ok('没有标记就原样返回（旧会话）',
            store.stripLeadingPersona('请记住这个数字：7391') === '请记住这个数字：7391');

        // 标记不完整时不能把后面的正文也一起吃掉
        ok('标记不完整就原样返回',
            store.stripLeadingPersona(O + '\n没闭合') === O + '\n没闭合');

        // 只在开头认标记：对面往正文里塞同样的字眼，不能把消息截断
        ok('正文中间的同名字眼不算标记',
            store.stripLeadingPersona('前面的话 ' + O + '坏人' + C)
                === '前面的话 ' + O + '坏人' + C);

        // ————— 走一遍真的 JSONL —————
        const home = path.join(os.tmpdir(), 'p2p-home-' + Date.now());
        const workdir = path.join(os.tmpdir(), 'p2p-wd-' + Date.now());
        const slug = path.resolve(workdir).replace(/[^a-zA-Z0-9]/g, '-');
        const projDir = path.join(home, '.claude', 'projects', slug);
        fs.mkdirSync(projDir, { recursive: true });

        const jl = (o) => JSON.stringify(o) + '\n';
        const write = (sid, body) => fs.writeFileSync(path.join(projDir, sid + '.jsonl'), body);

        // 新格式：人格包在围栏里，后面跟着用户真正说的话
        write('new-session', jl({
            cwd: workdir, type: 'user',
            message: { role: 'user', content: O + '\n你是 P2P 实例。\n' + C + '\n\n请记住这个数字：7391' },
        }));
        // 旧格式：没有围栏，第一条就是人格原文
        write('old-session', jl({
            cwd: workdir, type: 'user',
            message: { role: 'user', content: '你是通过 WebRTC P2P 直连与对方通信的 Claude Code 实例。' },
        }));
        // 首行是 summary 的：summary 就是给人和检索看的，优先用它
        write('sum-session', jl({ type: 'summary', summary: '聊了一下部署' }));

        const realHomedir = os.homedir;
        os.homedir = () => home;
        let listed;
        try {
            listed = store.listClaudeSessions(workdir);
        } finally {
            os.homedir = realHomedir;
        }

        const byId = {};
        for (const s of listed) byId[s.sessionId] = s;
        ok('列出了三个会话', listed.length === 3, '实际 ' + listed.length);

        ok('新会话的预览是真问题，不是人格',
            byId['new-session'] && byId['new-session'].preview === '请记住这个数字：7391',
            JSON.stringify(byId['new-session'] && byId['new-session'].preview));
        ok('预览里不再带围栏标记',
            byId['new-session'] && byId['new-session'].preview.indexOf(O) < 0
            && byId['new-session'].preview.indexOf(C) < 0);
        // 旧会话剥不掉 —— 这是已知且可接受的，写下来免得以后误以为是 bug
        ok('旧会话预览仍是人格原文（无标记可剥）',
            byId['old-session'] && byId['old-session'].preview.indexOf('Claude Code 实例') >= 0);
        ok('有 summary 的用 summary', byId['sum-session'].preview === '聊了一下部署');

        // 预览长度得有上限，不然对端点一次名就能要走一整段
        ok('预览不超过 160 字',
            listed.every((s) => s.preview.length <= 160));

        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(workdir, { recursive: true, force: true });
    }

    // ═══════════════════════ 结果 ═══════════════════════
    process.stdout.write('\n' + '─'.repeat(50) + '\n');
    process.stdout.write('通过 ' + passed + '，失败 ' + failed + '\n');
    if (failed) {
        process.stdout.write('\n失败项:\n');
        for (const f of failures) process.stdout.write('  · ' + f + '\n');
    }
    process.exit(failed ? 1 : 0);
})();
