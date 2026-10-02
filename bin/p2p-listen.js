#!/usr/bin/env node
'use strict';

const { loadConfig, HELP } = require('../src/config');
const { Daemon } = require('../src/daemon');
const { setLevel } = require('../src/logger');

const RULE = '─'.repeat(58);

/**
 * 第一行就是房间号，而且是能直接抓的 `key: value` 形式。
 *
 * 为什么单拎出来：这个进程通常被后台拉起，横幅会混在一堆日志里；
 * 而「起完监听必须把房间号报给用户」是硬要求，不能靠人从横幅里肉眼找。
 * 现在 `head -1`、或者从日志里 grep 一下 `房间号:` 就能拿到，一个字都不用解析。
 */
function roomLine(roomId) {
    return '房间号: ' + roomId;
}

/**
 * 信令连上之后才拿得到自己的 id，所以这段必须挂在 signaling-open 上，不能进横幅。
 *
 * 为什么非要报 id：房间号可以手填成 `1` 这种短号，一个房间里可能挤着好几个人，
 * 光有房间号对面不知道该连谁。给房间号配上一个「我是谁」，对面才能定向连过来
 * （浏览器那边是在雷达列表里点选，AI 那边是 p2p-connect 带 --peer）。
 *
 * 第一行是能 grep 的 `我的id: xxx`，和横幅里那行 `房间号: xxx` 一个路数；
 * 后面两行是给人直接整段复制的。
 */
function idLines(roomId, myId) {
    return [
        '我的id: ' + myId,
        '房间号以及 id 为 ' + roomId + ' 和 ' + myId,
        '请把这一行复制给另一个 AI（或填进浏览器）来选择连接',
    ].join('\n') + '\n';
}

function banner(cfg, roomId) {
    const tools = cfg.allowedTools.length ? cfg.allowedTools.join(', ') : '未启用（纯对话）';
    const lines = [
        roomLine(roomId),
        '',
        RULE,
        '  AI 对端已上线',
        RULE,
        '  把下面这个房间号填进网页的「房间号」输入框:',
        '',
        '      ' + roomId,
        '',
        // 固定号是用户自己给的，说清楚省得他以为是随机出来的、下次还去猜
        cfg.roomId ? '  （固定房间号，来自 --room）'
                   : '  （随机房间号，每次启动都不一样）',
        '',
        '  信令    ' + cfg.signalUrl,
        '  模型    ' + (cfg.model || 'claude 默认') + (cfg.fallbackModel ? '（备选 ' + cfg.fallbackModel + '）' : ''),
        '  工具    ' + tools,
        '  文件    ' + cfg.inboxDir + '/<对端id>/',
        '  并发    ' + cfg.maxConcurrentClaude + ' 个 claude 进程',
        // 后台拉起时横幅可能拿不到，房间号也一直躺在这个文件里
        '  房间号也在这个文件里  ' + cfg.roomIdFile,
        RULE,
        '  等待连接中…  Ctrl+C 退出',
        // 房间里人多时，光有房间号对面不知道该连谁，得配上一个 id
        '  信令连上后会再打出你自己的一行「我的id: xxxx」，',
        '  把它连同房间号一起给对面，对面才能定向连过来',
        RULE,
        '',
    ];
    process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(HELP + '\n');
        return 0;
    }

    const cfg = loadConfig(argv, process.env);
    setLevel(cfg.logLevel);

    const daemon = new Daemon(cfg, { mode: 'listen' });
    daemon.start();

    banner(cfg, daemon.roomId);

    daemon.on('peer-ready', (peerId) => {
        process.stdout.write('\n  ✅ ' + peerId + ' 已连接，开始对话\n\n');
    });
    daemon.on('peer-gone', (peerId, reason) => {
        process.stdout.write('\n  ⏹  ' + peerId + ' 已断开（' + (reason || '') + '）\n\n');
    });
    daemon.on('peer-connecting', (peerId) => {
        process.stdout.write('  ⏳ ' + peerId + ' 正在接入…\n');
    });
    daemon.on('signaling-open', () => {
        process.stdout.write('  🔗 信令已连接\n');
        const myId = daemon.myId;
        if (myId) {
            process.stdout.write('\n' + idLines(daemon.roomId, myId) + '\n');
        } else {
            // 服务端没给 id 是反常的，但不能让人对着没有 id 的界面干等
            process.stdout.write('  ⚠ 信令已连接但没拿到自己的 id，对面无法定向连过来\n');
        }
    });

    let shuttingDown = false;
    const shutdown = async (sig) => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stdout.write('\n  收到 ' + sig + '，正在退出…\n');
        try {
            await daemon.stop(sig);
        } catch (e) {
            process.stderr.write('退出时出错: ' + e.message + '\n');
        }
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 未捕获异常不能让常驻进程静默死掉
    process.on('unhandledRejection', (e) => {
        process.stderr.write('[未处理的 Promise 拒绝] ' + (e && e.stack ? e.stack : e) + '\n');
    });
    process.on('uncaughtException', (e) => {
        process.stderr.write('[未捕获异常] ' + (e && e.stack ? e.stack : e) + '\n');
    });

    return 0;
}

// 只在被当脚本跑的时候才启动。这样测试可以直接 require 进来验报号格式，
// 而不用为了测三行字符串去起一个真的监听进程。
if (require.main === module) {
    main().then((code) => {
        if (code) process.exit(code);
    }).catch((e) => {
        // 同 p2p-connect：房间号填错只打一行人话，别拿堆栈盖住原因
        if (e && e.expected) {
            process.stderr.write('❌ ' + e.message + '\n');
            process.exit(2);
        }
        process.stderr.write('启动失败: ' + (e && e.stack ? e.stack : e) + '\n');
        process.exit(1);
    });
}

module.exports = { roomLine, idLines };
