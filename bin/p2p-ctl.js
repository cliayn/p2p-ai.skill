#!/usr/bin/env node
'use strict';

/**
 * p2p-ctl —— 操作一个正在运行的 p2p-listen。
 *
 *   p2p-ctl status                     看整体状态
 *   p2p-ctl peers                      列出当前连着的对端
 *   p2p-ctl say <对端id> <文本…>        以本端身份发一条消息（不触发 claude）
 *   p2p-ctl send <对端id> <文件路径>     发一个文件（必须在该对端的 outbox 里）
 *   p2p-ctl sessions [工作目录]         列出可续接的历史 claude 会话
 *   p2p-ctl quit                       让那个进程退出
 */

const path = require('path');
const { loadConfig, HELP } = require('../src/config');
const { controlRequest } = require('../src/control');

// 下游提前关掉管道时（`p2p-ctl status | head`），Node 会把 EPIPE 抛成
// 未捕获异常、糊一屏堆栈。这种情况安静退出就行，别的错误照旧抛。
process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
});

const USAGE = `
p2p-ctl —— 操作正在运行的 p2p-listen

  p2p-ctl status                     整体状态（房间号、对端、队列、传输）
  p2p-ctl peers                      列出当前连着的对端
  p2p-ctl say <对端id> <文本…>        以本端身份发一条消息（不触发 claude）
  p2p-ctl send <对端id> <文件路径>     发一个文件
  p2p-ctl sessions [工作目录]         列出可续接的历史 claude 会话
  p2p-ctl quit                       让那个进程退出

  --sock <路径>   控制套接字（默认与 p2p-listen 一致）

  flag 放命令前后都行。正文里要以 -- 开头时，用 -- 隔开：
    p2p-ctl say ab12 你好 -- --sock 是正文
`;

function fail(msg) {
    process.stderr.write('✗ ' + msg + '\n');
    process.exit(1);
}

/** mtime 是毫秒时间戳，直接打出来是一串 13 位数字，没法看 */
function fmtTime(ms) {
    if (!ms) return '（时间未知）   ';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtSize(n) {
    if (typeof n !== 'number') return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return ((i === 0 ? v : v.toFixed(1)) + u[i]).padEnd(7);
}

/** 会吃掉下一个参数的 flag（与 config.js 的 parseFlags 保持一致） */
const VALUE_FLAGS = new Set([
    '--sock', '--control-sock', '--signal', '--room', '--peer', '--target', '--model', '--timeout',
    '--concurrency', '--workdir', '--files-dir', '--state-dir', '--max-file',
    '--persona', '--allow-tools', '--deny-tools', '--allow-peers', '--ack-mode',
    '--device', '--claude-bin', '--claude-args', '--log-level', '--say', '--max-replies',
]);

/**
 * flag 可以出现在命令前后任意位置：`p2p-ctl status --sock x` 和
 * `p2p-ctl --sock x status` 都得能用。
 *
 * 代价是 `say` 的正文跟 flag 会打架 —— `say ab12 你好 --sock /tmp/x`
 * 到底是「正文里带 --sock」还是「指定套接字」？没法两全，所以约定：
 * 认得的 flag 一律当 flag；正文真要写 `--` 开头的东西，用 `--` 隔开，
 * 它后面的所有词一律原样进 args。
 *
 *   p2p-ctl say ab12 你好 -- --sock 是正文      → 正文 "你好 --sock 是正文"
 */
function splitArgs(argv) {
    const flags = [];
    const positional = [];
    let verbatim = null;   // 出现过 `--` 之后，剩下的词原样收着

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (verbatim) { verbatim.push(a); continue; }
        if (a === '--') { verbatim = []; continue; }
        if (a === '--help' || a === '-h') return { flags, command: null, args: [] };
        if (a.startsWith('--')) {
            flags.push(a);
            if (!a.includes('=') && VALUE_FLAGS.has(a) && argv[i + 1] !== undefined) {
                flags.push(argv[++i]);
            }
            continue;
        }
        positional.push(a);
    }

    const command = positional.length ? positional[0] : null;
    const args = positional.slice(1).concat(verbatim || []);
    return { flags, command, args };
}

async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length) { process.stdout.write(HELP); return; }

    const { flags, command: cmd, args } = splitArgs(argv);
    if (!cmd) { process.stdout.write(USAGE); return; }

    const cfg = loadConfig(flags, process.env);
    let req;

    switch (cmd) {
        case 'status':
            req = { cmd: 'status' };
            break;
        case 'peers':
            req = { cmd: 'peers' };
            break;
        case 'say': {
            const peerId = args[0];
            const text = args.slice(1).join(' ');
            if (!peerId || !text) fail('用法: p2p-ctl say <对端id> <文本…>');
            req = { cmd: 'say', peerId, text };
            break;
        }
        case 'send': {
            const peerId = args[0];
            const file = args[1];
            if (!peerId || !file) fail('用法: p2p-ctl send <对端id> <文件路径>');
            req = { cmd: 'send', peerId, path: path.resolve(file) };
            break;
        }
        case 'sessions':
            req = { cmd: 'sessions', workdir: args[0] ? path.resolve(args[0]) : cfg.workdir };
            break;
        case 'quit':
            req = { cmd: 'quit' };
            break;
        default:
            fail('未知命令: ' + cmd + '\n' + USAGE);
    }

    let res;
    try {
        res = await controlRequest(cfg.controlSock, req);
    } catch (e) {
        fail(e.message);
    }

    if (!res.ok) fail(res.error || '操作失败');

    if (cmd === 'peers') {
        if (!res.data.length) { process.stdout.write('（当前没有已连接的对端）\n'); return; }
        for (const p of res.data) {
            process.stdout.write(`  ${p.peerId}  ${p.role}  ${p.open ? '已连接' : '已断开'}` +
                (p.device ? '  设备=' + p.device : '') + '\n');
        }
        return;
    }

    if (cmd === 'sessions') {
        if (!res.data.length) { process.stdout.write('（没有找到历史会话）\n'); return; }
        for (const s of res.data) {
            // 字段名是 listClaudeSessions 返回的那套：preview / mtime / size。
            // 曾经写成 firstMessage —— 两边对不上，这一列就永远是空的。
            process.stdout.write('  ' + s.sessionId +
                '  ' + fmtTime(s.mtime) +
                '  ' + fmtSize(s.size) +
                (s.preview ? '  ' + s.preview.replace(/\s+/g, ' ').slice(0, 60) : '') + '\n');
        }
        return;
    }

    if (cmd === 'status') {
        const d = res.data;
        process.stdout.write(
            '房间号    ' + d.roomId + '\n' +
            '本端 id   ' + (d.myId || '（信令未分配）') + '\n' +
            '模式      ' + d.mode + '\n' +
            '信令      ' + (d.signalingConnected ? '已连接' : '断开') + '\n' +
            '对端      ' + (d.peers.length ? d.peers.join(', ') : '（无）') + '\n' +
            '收件箱    ' + d.dirs.inbox + '\n' +
            '发件箱    ' + d.dirs.outbox + '\n'
        );
        const t = Object.keys(d.transfers);
        process.stdout.write('进行中传输 ' + (t.length ? t.map((k) => k + '(' + d.transfers[k].direction + ')').join(', ') : '（无）') + '\n');
        process.stdout.write('claude    ' + JSON.stringify(d.scheduler) + '\n');
        return;
    }

    process.stdout.write('✓ 完成\n');
}

if (require.main === module) main().catch((e) => fail(e.stack || e.message));

module.exports = { splitArgs, VALUE_FLAGS };
