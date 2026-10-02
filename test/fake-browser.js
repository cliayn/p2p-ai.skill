#!/usr/bin/env node
'use strict';

/**
 * 一个「假装成浏览器」的对端，用来在无人值守的情况下端到端验证 AI 对端。
 *
 * 它严格按 js/main.js 的流程走：
 *   join_room -> connect_request -> (对方 connect_accept) -> offer
 *   -> answer -> trickle ice -> DataChannel -> chat-ready 握手 -> chat
 *
 * 默认脚本验证两件事：
 *
 *   1. **会话续接**：第一轮让 AI 记住一个数字，第二轮问它那个数字是多少。
 *      第二轮能答对，说明 --resume 链路真的通了。
 *
 *   2. **对话模式面板**（阶段 4）：ai-sessions 能列出历史会话，
 *      ai-mode 能在「新对话 / 某条历史会话」之间切，切到不存在的 id 会被拒
 *      且不影响当前对话链。
 *
 * 用法: node test/fake-browser.js <房间号> [信令地址]
 */

const WebSocket = require('ws');
const { RTCPeerConnection } = require('werift');
const sdpBridge = require('../src/sdp');
const { toBuf } = require('../src/peer');

const room = process.argv[2];
const signalUrl = process.argv[3] || 'wss://my-party.cliayn.partykit.dev/party/default';

if (!room) {
    console.error('用法: node test/fake-browser.js <房间号> [信令地址]');
    process.exit(2);
}

const REPLY_TIMEOUT_MS = Number(process.env.E2E_REPLY_TIMEOUT_MS || 90000);
const QUIET_MS = Number(process.env.E2E_QUIET_MS || 2500);

function log(...a) { process.stdout.write('[浏览器] ' + a.join(' ') + '\n'); }

// ————— 极简的「等待某条消息到达」机制 —————
const inbox = [];
let waiters = [];

function deliver(text) {
    inbox.push(text);
    const still = [];
    for (const w of waiters) {
        if (w.want(text)) w.resolve(text);
        else still.push(w);
    }
    waiters = still;
}

function waitChat(timeoutMs) {
    return new Promise((resolve, reject) => {
        const w = { want: () => true, resolve };
        waiters.push(w);
        setTimeout(() => {
            waiters = waiters.filter((x) => x !== w);
            reject(new Error('等待消息超时（' + timeoutMs + 'ms）'));
        }, timeoutMs);
    });
}

// ————— 阶段 4：会话模式（ai-sessions / ai-mode / ai-session-peek）的收发 —————
// 一次只发一个请求，所以每种回复各留一个槽位就够，不用排成队列。
const replyWaiters = { 'ai-sessions-list': null, 'ai-session-peek': null };

function waitReply(type, timeoutMs) {
    return new Promise((resolve, reject) => {
        const w = { resolve };
        w.timer = setTimeout(() => {
            if (replyWaiters[type] === w) replyWaiters[type] = null;
            reject(new Error('等待 ' + type + ' 超时（' + timeoutMs + 'ms）'));
        }, timeoutMs);
        replyWaiters[type] = w;
    });
}

function onReply(type, m) {
    if (type === 'ai-sessions-list') {
        log('收到会话列表: ' + ((m.sessions || []).length) + ' 条, current=' +
            (m.current || '(新对话)') + (m.error ? ', error=' + m.error : ''));
    } else {
        log('收到内容预览: ' + (m.error ? 'error=' + m.error
            : JSON.stringify(String(m.preview || '').slice(0, 60))));
    }
    const w = replyWaiters[type];
    if (!w) { log('（这一条没人等着，忽略）'); return; }
    replyWaiters[type] = null;
    clearTimeout(w.timer);
    w.resolve(m);
}

function requestSessions() {
    const p = waitReply('ai-sessions-list', REPLY_TIMEOUT_MS);
    log('发送: ai-sessions');
    dc.send(JSON.stringify({ type: 'ai-sessions' }));
    return p;
}

function sendAiMode(sessionId) {
    const p = waitReply('ai-sessions-list', REPLY_TIMEOUT_MS);
    log('发送: ai-mode sessionId=' + (sessionId || '(新对话)'));
    dc.send(JSON.stringify({ type: 'ai-mode', sessionId }));
    return p;
}

function sendPeek(sessionId) {
    const p = waitReply('ai-session-peek', REPLY_TIMEOUT_MS);
    log('发送: ai-session-peek sessionId=' + sessionId);
    dc.send(JSON.stringify({ type: 'ai-session-peek', sessionId }));
    return p;
}

/** 收一条回复：等第一段，然后等安静下来，把流式的多段拼起来 */
async function collectReply() {
    let parts = [];
    try {
        const first = await waitChat(REPLY_TIMEOUT_MS);
        parts.push(first);
    } catch (e) {
        return { text: '', error: e.message };
    }
    for (;;) {
        try {
            const more = await waitChat(QUIET_MS);
            parts.push(more);
        } catch (e) {
            break;   // 安静了
        }
    }
    return { text: parts.join('\n') };
}

// ————— 信令 —————
const ws = new WebSocket(signalUrl);
let myId = null;
let pc = null;
let dc = null;
let requested = false;
let targetId = null;
let remoteReady = false;
let localReady = false;
const pendingIce = [];
const inlinedKeys = new Set();

function send(type, target, payload) {
    const o = { type };
    if (target) o.target = target;
    if (payload !== undefined && payload !== null) o.payload = payload;
    ws.send(JSON.stringify(o));
    log('→ ' + type + (target ? ' target=' + target : ''));
}

function onReady() {
    log('✅ 双方就绪（chat-ready 握手完成）');
    runScenario().then((ok) => {
        process.exit(ok ? 0 : 1);
    }).catch((e) => {
        log('❌ 场景执行出错: ' + e.message);
        process.exit(1);
    });
}

function maybeReady() {
    if (localReady && remoteReady) onReady();
}

function sendChat(text) {
    const msg = { type: 'chat', text, seq: ++seq, ts: Date.now() };
    log('发送: ' + text);
    dc.send(JSON.stringify(msg));
}
let seq = 0;

async function startOffer(peerId) {
    targetId = peerId;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onIceCandidate.subscribe((c) => {
        const raw = c && typeof c.candidate === 'string' ? c.candidate : null;
        if (!raw) return;
        const p = sdpBridge.parseCandidate(raw);
        if (!p) return;
        if (inlinedKeys.has(p.ip + ':' + p.port)) return;
        send('ice', peerId, raw);
    });

    // 浏览器是发起方，由它创建 'fileTransfer' 通道
    dc = pc.createDataChannel('fileTransfer');
    dc.stateChanged.subscribe((s) => {
        if (s !== 'open') return;
        log('数据通道已打开');
        localReady = true;
        dc.send(JSON.stringify({ type: 'chat-ready', device: 'desktop' }));
        maybeReady();
    });
    dc.onMessage.subscribe((d) => {
        let m;
        try { m = JSON.parse(toBuf(d).toString('utf8')); } catch (e) { return; }
        if (m.type === 'chat-ready') {
            remoteReady = true;
            log('对端就绪（device=' + m.device + '）');
            maybeReady();
            return;
        }
        if (m.type === 'ai-sessions-list' || m.type === 'ai-session-peek') {
            onReply(m.type, m);
            return;
        }
        if (m.type === 'chat') {
            // 回执（ack）只是给人看的提示，不该被当成一轮对话
            if (m.ack === true) log('收到回执: ' + m.text);
            else { log('收到: ' + m.text); deliver(m.text); }
        }
    });

    await pc.setLocalDescription(await pc.createOffer());
    const compact = sdpBridge.toCompact(pc, null);
    for (const c of compact.ice) inlinedKeys.add(c.ip + ':' + c.port);
    log('发送 offer（候选 ' + compact.ice.length + ' 个）');
    send('offer', peerId, compact);
}

ws.on('open', () => log('信令已连接'));
ws.on('error', (e) => log('信令错误: ' + e.message));

ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (m.type) {
        case 'ok':
            myId = m.id;
            send('join_room', null, { room_id: room });
            break;

        case 'same_network_clients':
            if (!requested && m.clients.length) {
                requested = true;
                send('connect_request', m.clients[0]);
            }
            break;

        case 'new_peer':
            if (!requested && m.peer_id !== myId) {
                requested = true;
                send('connect_request', m.peer_id);
            }
            break;

        case 'connect_accept':
            await startOffer(m.from);
            break;

        case 'answer':
            await pc.setRemoteDescription({ type: 'answer', sdp: sdpBridge.fromCompact('answer', m.payload) });
            for (const c of pendingIce.splice(0)) {
                pc.addIceCandidate({ candidate: c, sdpMid: '0', sdpMLineIndex: 0 }).catch(() => {});
            }
            log('已应用 answer');
            break;

        case 'ice':
            if (pc && pc.remoteDescription) {
                pc.addIceCandidate({ candidate: m.payload, sdpMid: '0', sdpMLineIndex: 0 }).catch(() => {});
            } else {
                pendingIce.push(m.payload);
            }
            break;

        case 'error':
            log('信令错误消息: ' + JSON.stringify(m));
            break;

        default:
            break;
    }
});

// ————— 场景 —————
const SECRET = '7391';

async function runScenario() {
    log('开始对话脚本');

    sendChat('请记住这个数字：' + SECRET + '。收到请只回复"好的"两个字，不要多说。');
    const r1 = await collectReply();
    log('第 1 轮回复: ' + JSON.stringify(r1.text.slice(0, 200)));
    if (r1.error) { log('❌ 第 1 轮没收到回复: ' + r1.error); return false; }

    await new Promise((r) => setTimeout(r, 500));

    sendChat('我刚才让你记住的数字是多少？只回答那个数字，不要解释。');
    const r2 = await collectReply();
    log('第 2 轮回复: ' + JSON.stringify(r2.text.slice(0, 200)));
    if (r2.error) { log('❌ 第 2 轮没收到回复: ' + r2.error); return false; }

    const remembered = r2.text.includes(SECRET);
    if (!remembered) {
        log('❌ 会话续接失败：第 2 轮没有答出 ' + SECRET + '，实际回复: ' + r2.text);
        return false;
    }
    log('✅✅ 会话续接成功：第 2 轮正确答出了第 1 轮的数字 ' + SECRET);

    const aiOk = await runAiModeScenario();
    log('');
    if (aiOk) log('✅✅ 阶段 4（对话模式面板）全部通过');
    else log('❌ 阶段 4（对话模式面板）失败');
    return aiOk;
}

/**
 * 阶段 4：网页的「即时对话 / 续接历史」面板靠这两个消息。
 * 全程不跑 claude，所以这一步很快。
 */
async function runAiModeScenario() {
    log('');
    log('开始阶段 4 脚本：ai-sessions / ai-mode');

    // 1) 拉历史会话清单
    const l1 = await requestSessions();
    if (l1.error) { log('❌ 拉列表返回错误: ' + l1.error); return false; }
    if (!Array.isArray(l1.sessions)) { log('❌ sessions 不是数组'); return false; }
    if (l1.sessions.length === 0) {
        log('❌ 历史会话列表是空的 —— 刚跑过两轮 claude，至少该有一条');
        return false;
    }
    for (const s of l1.sessions) {
        if (typeof s.sessionId !== 'string' || !s.sessionId) {
            log('❌ 会话条目缺 sessionId: ' + JSON.stringify(s)); return false;
        }
        if (typeof s.mtime !== 'number' || !(s.mtime > 0)) {
            log('❌ 会话条目 mtime 不是时间戳: ' + JSON.stringify(s)); return false;
        }
        if (typeof s.size !== 'number') { log('❌ 会话条目缺 size: ' + JSON.stringify(s)); return false; }
        // 列表里绝不能带内容。带了的话一次请求就把这台机器上所有历史对话
        // 各漏一段出去 —— 那正是这一版要修掉的行为。
        if ('preview' in s || 'content' in s || 'text' in s) {
            log('❌ 会话列表里带了内容字段: ' + JSON.stringify(s)); return false;
        }
    }
    // 条数也要收着点，别把整台机器的历史摊开
    if (l1.sessions.length > 10) {
        log('❌ 一次列了 ' + l1.sessions.length + ' 条（上限 10）'); return false;
    }
    // 列表要按 mtime 倒序，否则网页上「最近的在最前面」是假的
    for (let i = 1; i < l1.sessions.length; i++) {
        if (l1.sessions[i - 1].mtime < l1.sessions[i].mtime) {
            log('❌ 会话列表没有按 mtime 倒序'); return false;
        }
    }
    // 当前链上的会话必须能在列表里找到。找不到说明 workdir 和 claude 存会话的目录对不上，
    // 那样网页点「续接」出来的每一轮都会失败。
    if (!l1.current) {
        log('❌ current 为空 —— 刚跑过两轮对话，当前链上该有会话'); return false;
    }
    if (!l1.sessions.some((s) => s.sessionId === l1.current)) {
        log('❌ current=' + l1.current + ' 不在列表里（workdir 可能对不上）'); return false;
    }
    const realSid = l1.current;
    log('✅ 会话列表正常：' + l1.sessions.length + ' 条，current=' + realSid);

    // 2) 切到「新对话」
    const l2 = await sendAiMode(null);
    if (l2.error) { log('❌ 切新对话返回错误: ' + l2.error); return false; }
    if (l2.current !== null) {
        log('❌ 切新对话后 current 应为 null，实际 ' + JSON.stringify(l2.current)); return false;
    }
    log('✅ 切到新对话');

    // 3) 续接一个不存在的 id：必须被拒，而且不能把当前对话链搞坏。
    //    这条是防护性的 —— 校验一旦漏掉，--resume 会白起一个 claude 进程再失败，
    //    而且对端能塞任意字符串进来。
    const l3 = await sendAiMode('00000000-0000-4000-8000-000000000000');
    if (!l3.error) { log('❌ 续接不存在的会话居然成功了'); return false; }
    if (l3.current !== null) {
        log('❌ 失败的切换改动了 current: ' + JSON.stringify(l3.current)); return false;
    }
    log('✅ 不存在的会话被拒: ' + l3.error);

    // 4) 切到一条真实的历史会话
    const l4 = await sendAiMode(realSid);
    if (l4.error) { log('❌ 续接真实会话返回错误: ' + l4.error); return false; }
    if (l4.current !== realSid) {
        log('❌ 续接后 current 应为 ' + realSid + '，实际 ' + JSON.stringify(l4.current)); return false;
    }
    log('✅ 已续接到历史会话 ' + realSid);

    // 4.5) 内容要单独点名才给：列表里没有，点名之后才有。
    //      这一对断言合起来才说明「不是换个地方藏，而是真的要一次给一次」。
    const pk = await sendPeek(realSid);
    if (pk.error) { log('❌ 点名看内容报错: ' + pk.error); return false; }
    if (typeof pk.preview !== 'string' || !pk.preview) {
        log('❌ 点名看内容没回 preview: ' + JSON.stringify(pk)); return false;
    }
    // 预览得是「人话」，不能是注入进去的那段人格模板 ——
    // 每条会话都返回同一段模板的话，这个功能等于没做。
    if (pk.preview.indexOf('Claude Code 实例') >= 0 || pk.preview.indexOf('[p2p-persona]') >= 0) {
        log('❌ 预览是注入的人格模板而不是对话内容: ' + JSON.stringify(pk.preview.slice(0, 80)));
        return false;
    }
    if (pk.preview.indexOf(SECRET) < 0) {
        log('❌ 预览里没有第 1 轮说过的话（' + SECRET + '）: ' + JSON.stringify(pk.preview.slice(0, 80)));
        return false;
    }
    log('✅ 点名拿到了内容预览（' + pk.preview.length + ' 字）: ' + JSON.stringify(pk.preview.slice(0, 60)));

    const pk2 = await sendPeek('00000000-0000-4000-8000-000000000000');
    if (!pk2.error || pk2.preview !== undefined) {
        log('❌ 点名一个不存在的会话居然给了内容: ' + JSON.stringify(pk2)); return false;
    }
    log('✅ 点名不存在的会话被拒: ' + pk2.error);

    // 5) 光把 current 回显过来不算数 —— 真发一轮，看它有没有真的续上那段历史。
    //    那段历史里有第 1 轮藏的数字，能答对才说明 ai-mode 真的驱动了 --resume，
    //    而不是悄悄起了一个新会话。
    sendChat('我刚才让你记住的数字是多少？只回答那个数字，不要解释。');
    const r3 = await collectReply();
    log('第 3 轮回复（续接历史后）: ' + JSON.stringify(r3.text.slice(0, 200)));
    if (r3.error) { log('❌ 续接历史后没收到回复: ' + r3.error); return false; }
    if (!r3.text.includes(SECRET)) {
        log('❌ 切到历史会话后答不出 ' + SECRET + '，说明 --resume 没真的续上');
        return false;
    }
    log('✅ 续接历史后仍记得 ' + SECRET + '：ai-mode 确实驱动了 --resume');

    return true;
}

setTimeout(() => {
    log('❌ 整体超时退出');
    process.exit(1);
}, REPLY_TIMEOUT_MS * 4 + 30000).unref();
