#!/usr/bin/env node
'use strict';

const { loadConfig, HELP } = require('../src/config');
const { Daemon } = require('../src/daemon');
const { setLevel } = require('../src/logger');
const { validateRoomId } = require('../src/roomid');

// 这些 flag 后面跟一个值，找位置参数时要跳过它们的值
const FLAGS_WITH_VALUE = new Set([
    '--signal', '--room', '--peer', '--target', '--model', '--timeout', '--concurrency', '--workdir',
    '--files-dir', '--state-dir', '--control-sock', '--max-file', '--persona',
    '--allow-tools', '--deny-tools', '--allow-peers', '--ack-mode', '--device',
    '--claude-bin', '--claude-args', '--log-level',
]);

/**
 * 取位置参数：第一个是房间号，第二个（可选）是要连的对端 id。
 *
 * 支持 `p2p-connect <房间号> <对方id>` 这种写法，是因为房间号能填成 `1` 这种短号，
 * 一个房间里常有好几个人，光报房间号对面不知道该连谁 ——
 * 起监听那边打出来的就是「房间号以及 id 为 X 和 Y」，两个值正好按顺序填进来。
 */
function positionals(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            if (a.includes('=')) continue;
            if (FLAGS_WITH_VALUE.has(a)) i++;
            continue;
        }
        out.push(a);
    }
    return out;
}

/**
 * 主动加入别人的房间。
 *   p2p-connect p2p-ai-room-xxxxxxxxxx
 */
async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(HELP + '\n');
        return 0;
    }

    const args = positionals(argv);
    const roomArg = args[0];
    const peerArg = args[1];

    if (!roomArg) {
        process.stderr.write('用法: p2p-connect <房间号> [对方id]\n' +
            '例如: p2p-connect p2p-ai-room-ab12cd34ef zt9t\n');
        return 1;
    }

    const roomId = validateRoomId(roomArg);
    const cfg = loadConfig(argv, Object.assign({}, process.env, { ROOM_ID: roomId, TARGET_PEER: peerArg || '' }));
    setLevel(cfg.logLevel);

    process.stdout.write('\n  正在加入房间 ' + roomId + ' …\n');
    if (cfg.targetPeer) process.stdout.write('  只连对端 ' + cfg.targetPeer + '\n');

    const daemon = new Daemon(cfg, { mode: 'connect' });
    daemon.start();

    daemon.on('clients', (clients) => {
        if (!clients.length) process.stdout.write('  房间里暂时没有其他设备，等待中…\n');
        else if (cfg.targetPeer) process.stdout.write('  房间里现有: ' + clients.join(', ') + '\n');
    });

    // 加入房间后先报出自己的 id —— 对面也一样需要知道「来的是谁」，
    // 尤其是房间里不止两个人的时候
    daemon.on('signaling-open', () => {
        const myId = daemon.myId;
        if (!myId) return;
        process.stdout.write('\n我的id: ' + myId + '\n' +
            '  已用「' + roomId + ' / ' + myId + '」加入房间；' +
            '对面要定向连过来，需要的是这个 id\n\n');
    });
    daemon.on('peer-ready', (peerId) => {
        process.stdout.write('\n  ✅ 已连接到 ' + peerId + '，开始对话\n\n');
    });
    daemon.on('peer-rejected', (peerId) => {
        process.stderr.write('  ❌ ' + peerId + ' 拒绝了连接\n');
    });
    daemon.on('peer-gone', (peerId, reason) => {
        process.stdout.write('\n  ⏹  ' + peerId + ' 已断开（' + (reason || '') + '）\n\n');
    });

    let shuttingDown = false;
    const shutdown = async (sig) => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stdout.write('\n  收到 ' + sig + '，正在退出…\n');
        try { await daemon.stop(sig); } catch (e) { /* 忽略 */ }
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (e) => {
        process.stderr.write('[未处理的 Promise 拒绝] ' + (e && e.stack ? e.stack : e) + '\n');
    });

    return 0;
}

main().then((code) => {
    if (code) process.exit(code);
}).catch((e) => {
    // 房间号填错是常见失败，不是崩溃：只打一行人话就让位。
    // 堆栈会把真正的原因淹掉，而房间号大多是照抄过来的。
    if (e && e.expected) {
        process.stderr.write('❌ ' + e.message + '\n');
        process.exit(2);
    }
    process.stderr.write('启动失败: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
