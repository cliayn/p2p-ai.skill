'use strict';

/**
 * 用 jsdom 把**真正的** index.html 跑起来，验证网页端「对话模式」面板。
 *
 * 关键点：这里不重写一份 UI 逻辑来对着测 —— 那样只能证明测试和它自己自洽。
 * 载入的是仓库里那份 index.html 和 js/*.js，走的也是它们真实的调用路径：
 *
 *   建容器 -> 收到 chat-ready(device=ai-peer) -> 标题栏按钮露出来
 *        -> 点开面板 -> 发出 ai-sessions -> 收到 ai-sessions-list
 *        -> 列表渲染 -> 点「续接」/「开始新对话」-> 发回 ai-mode
 *
 * 顺带把两种到达顺序都跑一遍（先 onopen 还是先 chat-ready）。真机走的是其中一种，
 * 另一种过不去真实的 DataChannel，留着是为了守住「建容器的人自己负责刷按钮」这条。
 *
 * 网页工程里没有 package.json（故意的，它没有构建步骤），所以这个套件放在技能这边，
 * 指向 ../update/。找不到那个目录就跳过，不影响技能单独安装。
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

// ————— 先看清楚有没有东西可测，再决定要不要 jsdom —————
// 网页工程和技能是分开的两份东西：技能单独安装到别的机器上时，
// ../update/ 根本不在，这时候安静跳过就行，别把整条 npm test 拖挂。
const WEB_DIR = path.resolve(__dirname, '..', '..', 'update');

if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
    console.log('⚠ 找不到 ' + WEB_DIR + '/index.html，跳过网页端测试。');
    process.exit(0);
}

let JSDOM, ResourceLoader, VirtualConsole;
try {
    ({ JSDOM, ResourceLoader, VirtualConsole } = require('jsdom'));
} catch (e) {
    console.log('⚠ 没装 jsdom（npm i -D jsdom），跳过网页端测试。');
    process.exit(0);
}

// ————— 迷你断言 —————
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else {
        fail++;
        failures.push(name);
        console.log('  ✗ ' + name + (detail ? '  —— ' + detail : ''));
    }
}

function eq(actual, expected, name) {
    ok(actual === expected, name, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

// ————— 载入页面 —————

/**
 * 页面 head 里有三个 CDN 脚本（qrcode / jsQR / pako）。测试用不到它们，
 * 但让 jsdom 真去抓就会把整个套件挂在网络上 —— 直接挡掉。
 */
class LocalOnly extends ResourceLoader {
    fetch(url, options) {
        if (/^https?:/i.test(url)) return null;
        return super.fetch(url, options);
    }
}

/**
 * jsdom 的 window 里没有 fetch，而 predict-internal.js 一进来就要抓
 * assets/carrier-nat-patterns.json。缺了这个的话它一开始就抛，
 * 而 main.js 整个包在 IIFE 里 —— 它那些全局是靠文件末尾的 window.xxx = xxx
 * 挂上去的，脚本中途断掉就什么都导不出来，后面全跟着报 not defined。
 * 所以这里补一个只认本地文件的 fetch：文件在就真读，其余的拒绝。
 */
function makeFetchStub() {
    return function fetch(input) {
        const raw = String(input && input.url ? input.url : input);
        try {
            const p = raw.startsWith('file:') ? fileURLToPath(raw) : path.resolve(WEB_DIR, raw);
            if (p.startsWith(WEB_DIR) && fs.existsSync(p)) {
                return Promise.resolve(new Response(fs.readFileSync(p), { status: 200 }));
            }
        } catch (e) { /* 落到下面的拒绝 */ }
        return Promise.reject(new Error('测试环境不联网: ' + raw));
    };
}

const scriptErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => scriptErrors.push(e));

const indexUrl = pathToFileURL(path.join(WEB_DIR, 'index.html'));
const dom = new JSDOM(fs.readFileSync(indexUrl, 'utf8'), {
    url: indexUrl.href,
    runScripts: 'dangerously',
    resources: new LocalOnly(),
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) { win.fetch = makeFetchStub(); },
});

const w = dom.window;

/** 等页面里的外链脚本都跑完 */
function waitLoad(timeoutMs) {
    return new Promise((resolve) => {
        if (w.document.readyState === 'complete') return resolve(true);
        const t = setTimeout(() => resolve(false), timeoutMs);
        w.addEventListener('load', () => { clearTimeout(t); resolve(true); });
    });
}

// ————— 假的数据通道 —————
/**
 * 注意 readyState 得从 'connecting' 起。
 * 一开始就是 'open' 的话，setupDataChannelForPeer 结尾那段
 * 「已经打开就立刻宣布就绪」会马上跑掉，两个就绪标志当场齐全 ——
 * 于是不管下面按哪种顺序喂，容器都是在 _onChatReady 里建的，
 * 「先 chat-ready 后 onopen」那条路根本走不到，测了等于没测。
 */
function makeFakeChannel(peerId) {
    const sent = [];
    const ch = {
        sent,
        readyState: 'connecting',
        binaryType: 'arraybuffer',
        onopen: null, onclose: null, onmessage: null,
        send(text) { sent.push(typeof text === 'string' ? JSON.parse(text) : text); },
        // 模拟对端发来一条
        deliver(obj) { if (ch.onmessage) ch.onmessage({ data: JSON.stringify(obj) }); },
        open() { ch.readyState = 'open'; if (ch.onopen) ch.onopen(); },
    };
    return ch;
}

/** 按真实顺序接上一个对端：注册通道 -> （可选）打开 -> 收 chat-ready */
function attachPeer(peerId, device, order) {
    const conn = w.connections[peerId] || (w.connections[peerId] = {});
    const ch = makeFakeChannel(peerId);
    conn.dc = ch;
    conn.targetId = peerId;
    w.setupDataChannelForPeer(peerId, ch);

    const open = () => ch.open();
    const ready = () => ch.deliver({ type: 'chat-ready', device });

    if (order === 'ready-first') { ready(); open(); } else { open(); ready(); }
    return { conn, ch };
}

function btn(peerId) {
    return w.document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"] .ai-mode-btn');
}

function panel() { return w.document.getElementById('aiPanel'); }
function rows() { return w.document.querySelectorAll('#aiSessionList .ai-session-row'); }

const SID_A = '38a716a7-2951-4faa-b9a1-b1775b949337';
const SID_B = 'af473eb9-6370-4d26-8128-174a7790d6d8';

// 用本地时间构造，这样断言不受跑测试的机器时区影响
const MTIME_A = new Date(2026, 9, 2, 13, 20).getTime();    // 10月2日 13:20
const MTIME_B = new Date(2026, 8, 30, 9, 5).getTime();     // 9月30日 09:05

// 列表里**没有 preview** —— 这是刻意的：一次请求换不回一屏对话摘要
function listMsg(current, error) {
    const m = {
        type: 'ai-sessions-list',
        current: current,
        sessions: [
            // 和真 daemon 一样按 mtime 倒序
            { sessionId: SID_A, mtime: MTIME_A, size: 20480 },
            { sessionId: SID_B, mtime: MTIME_B, size: 1024 },
        ],
    };
    if (error) m.error = error;
    return m;
}

const PREVIEW_A = '请记住这个数字：7391';
const PREVIEW_B = '早点睡';

function peekMsg(sessionId, preview) {
    return { type: 'ai-session-peek', sessionId, preview };
}

(async function main() {
    console.log('\n网页端：对话模式面板（jsdom 载入真实 index.html）');
    console.log('  页面目录: ' + WEB_DIR);

    const loaded = await waitLoad(30000);
    ok(loaded, 'index.html 与外链脚本加载完成');
    if (!loaded) { report(); return; }

    // 载入期间的脚本异常要暴露出来（外链 CDN 被挡掉是预期的，不算）
    const real = scriptErrors.filter((e) => !/Could not load|https?:/i.test(String(e && e.message)));
    ok(real.length === 0, '载入期间没有脚本异常',
        real.map((e) => String(e && e.message)).join(' | '));

    ok(typeof w.setupDataChannelForPeer === 'function', 'transfer.js 已执行（导出函数在）');
    ok(!!w.connections, 'config.js 的 connections 全局在');

    // ————————————— 两种到达顺序 —————————————
    // open-first 是真机上实际会走的路（本地 DC 先 open，对方的 chat-ready 随后到）。
    // ready-first 过不去真实的 DataChannel —— 本地没开就收不到消息 ——
    // 它守的是另一件事：createPeerChatContainer 必须自己把按钮刷对，
    // 不能指望调用方在它返回之后补一次。将来多一个调用方，这条就是活的。
    for (const order of ['open-first', 'ready-first']) {
        const real = (order === 'open-first');
        console.log('\n  —— 到达顺序：' + order + (real ? '（真机路径）' : '（合成：守调用方顺序）') + ' ——');
        const pid = 'peer-' + order;
        attachPeer(pid, 'ai-peer', order);

        eq(w.connections[pid]._isAiPeer, true, '认出了 device=ai-peer');

        const b = btn(pid);
        ok(!!b, '标题栏里有对话模式按钮');
        if (!b) continue;
        ok(!b.classList.contains('hidden'), 'AI 对端：按钮露出来了');
        eq(b.querySelector('.ai-mode-label').textContent, '即时对话', '默认标签是「即时对话」');
    }

    // ————————————— 非 AI 对端不该露按钮 —————————————
    console.log('\n  —— 普通浏览器对端 ——');
    attachPeer('peer-human', 'desktop', 'open-first');
    const hb = btn('peer-human');
    ok(!!hb && hb.classList.contains('hidden'), '非 AI 对端：按钮保持隐藏');

    // ————————————— 打开面板 & 列会话 —————————————
    console.log('\n  —— 打开面板 ——');
    const PID = 'peer-open-first';
    const ch = w.connections[PID].dc;

    ok(!panel().classList.contains('show'), '面板初始是收起的');
    btn(PID).onclick();
    ok(panel().classList.contains('show'), '点按钮后面板打开');
    eq(w.document.getElementById('aiSessionList').textContent.trim(), '正在获取…', '打开时显示「正在获取…」');

    // ai-sessions 必须真的发出去了
    const asked = ch.sent.filter((m) => m.type === 'ai-sessions');
    eq(asked.length, 1, '向 AI 发出了 ai-sessions');

    // ————————————— 渲染会话列表 —————————————
    console.log('\n  —— 收到会话列表 ——');
    ch.deliver(listMsg(SID_A));
    eq(rows().length, 2, '渲染出 2 条会话');
    ok(w.document.getElementById('aiCurrent').textContent.indexOf(SID_A.slice(0, 8)) >= 0,
        '顶部显示当前会话（截断的 id）');
    ok(w.document.getElementById('aiPanelMsg').classList.contains('hidden'), '没有错误时提示是隐藏的');
    eq(btn(PID).querySelector('.ai-mode-label').textContent, '续接历史',
        '挂着历史会话时按钮标签变成「续接历史」');

    const first = rows()[0];
    eq(first.querySelector('.ai-session-meta').textContent, '10月2日 13:20 · 20.0KB', '第一条的「时间 · 大小」');
    eq(rows()[1].querySelector('.ai-session-meta').textContent, '9月30日 09:05 · 1.0KB',
        '第二条的「时间 · 大小」（月/日不补零，时分补零）');
    ok(first.classList.contains('is-current'), '当前会话那一行被标出来');
    eq(first.querySelector('.ai-session-pick').disabled, true, '当前那条的按钮是禁用的');
    eq(rows()[1].querySelector('.ai-session-pick').disabled, false, '另一条可以点');

    // ————————————— 内容要单独点名才给 —————————————
    // 这是「别把整台机器的历史一次摊开」的核心：列表只给时间和大小，
    // 想知道一条讲了什么，得为它单独发一次请求。
    console.log('\n  —— 内容按需展开 ——');
    eq(first.querySelector('.ai-session-preview').textContent, '内容未展开',
        '当前那条也先不给内容（时间/大小之外什么都没有）');
    eq(rows()[1].querySelector('.ai-session-preview').textContent, '内容未展开',
        '没点过的会话一律不显示内容');

    const peeks = ch.sent.filter((m) => m.type === 'ai-session-peek');
    eq(peeks.length, 1, '只自动点了当前那一条的名字');
    eq(peeks[0].sessionId, SID_A, '点名的是当前会话');

    ch.deliver(peekMsg(SID_A, PREVIEW_A));
    eq(rows()[0].querySelector('.ai-session-preview').textContent, PREVIEW_A, '当前那条的内容显示出来了');
    ok(rows()[0].querySelector('.ai-session-peek').classList.contains('hidden'),
        '拿到内容后「看内容」按钮收起来');
    eq(rows()[1].querySelector('.ai-session-preview').textContent, '内容未展开',
        '另一条依旧不给内容 —— 没点名就不出去');

    // 手动点名看另一条
    ch.sent.length = 0;
    rows()[1].querySelector('.ai-session-peek').onclick();
    eq(ch.sent.length, 1, '点「看内容」发出了请求');
    eq(ch.sent[0].type, 'ai-session-peek', '消息类型是 ai-session-peek');
    eq(ch.sent[0].sessionId, SID_B, '点名的是被点那条');
    eq(rows()[1].querySelector('.ai-session-peek').textContent, '读取中…', '等待期间按钮变成「读取中…」');
    ch.deliver(peekMsg(SID_B, PREVIEW_B));
    eq(rows()[1].querySelector('.ai-session-preview').textContent, PREVIEW_B, '第二条的内容也出来了');

    // 对面不认这条消息时不能一直转
    ch.sent.length = 0;
    ch.deliver(listMsg(SID_A));
    ch.deliver({ type: 'ai-session-peek', sessionId: SID_A, error: '找不到这个会话（可能已被删除）' });
    eq(rows()[0].querySelector('.ai-session-peek').classList.contains('hidden'), true,
        '读失败也要收掉按钮，不能卡在「读取中…」');

    // ————————————— 点「续接」 —————————————
    console.log('\n  —— 点「续接」 ——');
    ch.sent.length = 0;
    rows()[1].querySelector('.ai-session-pick').onclick();
    eq(ch.sent.length, 1, '发出了 1 条消息');
    eq(ch.sent[0].type, 'ai-mode', '消息类型是 ai-mode');
    eq(ch.sent[0].sessionId, SID_B, '带的是被点那条的 sessionId');

    // 对面确认切换
    ch.deliver(listMsg(SID_B));
    ok(rows()[1].classList.contains('is-current'), '切换后当前行跟着变');
    eq(rows()[0].querySelector('.ai-session-pick').disabled, false, '原来那条现在可以点了');

    // ————————————— 开始新对话 —————————————
    console.log('\n  —— 开始新对话 ——');
    ch.sent.length = 0;
    w.document.getElementById('aiNewChatBtn').onclick();
    eq(ch.sent.length, 1, '发出了 1 条消息');
    eq(ch.sent[0].type, 'ai-mode', '消息类型是 ai-mode');
    ok(ch.sent[0].sessionId === null, 'sessionId 是 null（开新对话）');

    ch.deliver(listMsg(null));
    eq(w.document.getElementById('aiCurrent').textContent.indexOf('新对话') >= 0, true,
        '顶部显示「新对话」');
    eq(btn(PID).querySelector('.ai-mode-label').textContent, '即时对话',
        '没有历史会话时按钮标签回到「即时对话」');

    // ————————————— 错误提示 —————————————
    console.log('\n  —— 对面报错 ——');
    ch.deliver(listMsg(null, '找不到这个会话（可能已被删除）'));
    const msgEl = w.document.getElementById('aiPanelMsg');
    ok(!msgEl.classList.contains('hidden'), '报错时提示条露出来');
    ok(msgEl.textContent.indexOf('找不到这个会话') >= 0, '提示内容就是对面给的那句');

    // ————————————— 对面用 --no-session-list 跑 —————————————
    console.log('\n  —— 对面关掉了历史会话列表 ——');
    ch.deliver({
        type: 'ai-sessions-list', current: null, sessions: [],
        error: '这台机器的运营方关掉了历史会话列表（--no-session-list）',
    });
    ok(rows().length === 0, '没有会话行');
    ok(w.document.getElementById('aiSessionList').textContent.indexOf('没有可续接') >= 0,
        '列表位置显示「没有可续接的历史会话」而不是一直转圈');
    ok(w.document.getElementById('aiPanelMsg').textContent.indexOf('--no-session-list') >= 0,
        '把对面的原话透出来，让人知道是为什么');

    // ————————————— 连接断了要收起面板 —————————————
    console.log('\n  —— 连接断开 ——');
    ok(panel().classList.contains('show'), '此刻面板还开着');
    try { w.cleanupConnection(PID); } catch (e) { /* 假连接缺零件是正常的 */ }
    ok(!panel().classList.contains('show'), '断开后面板自动收起');
    ok(!btn(PID), '断开后聊天容器被移除');

    // ————————————— 消息富文本渲染 —————————————
    // 这是全套测试里唯一走 {type:'chat'} 的地方 —— 在此之前聊天气泡的渲染
    // 完全没有覆盖。改动 js/render.js 之后跑这一节就知道有没有砸坏。
    console.log('\n  —— 消息富文本渲染 ——');

    const RPID = 'render-peer';
    const { ch: rch } = attachPeer(RPID, 'ai-peer', 'open-first');

    function wrappers() {
        return w.document.querySelectorAll(
            '#peerTabs .peer-chat-container[data-peerid="' + RPID + '"] .transfer-messages .message-wrapper.peer-msg');
    }
    /**
     * 投递一条消息，返回它自己的那个气泡。
     *
     * 不能取「最后一个」：模板里那条「✨ 连接已建立」没有 data-ts，
     * 而 addPeerMessage 按 ts 插入时会跳过它，最后走
     * insertBefore(wrapper, children[0]) —— 新消息落在它**前面**。
     * 所以这里按「多了哪个节点」取，跟插入位置无关。
     */
    function send(text) {
        const before = new Set(Array.prototype.slice.call(wrappers()));
        rch.deliver({ type: 'chat', text: text, ts: Date.now() });
        const after = Array.prototype.slice.call(wrappers());
        for (const wr of after) if (!before.has(wr)) return wr.querySelector('.message');
        return null;
    }

    ok(typeof w.P2PRender === 'object', 'render.js 已执行（window.P2PRender 在）');

    // —— Markdown ——
    let b = send('**粗体** 和 `行内代码`\n\n第二段');
    eq(b.querySelectorAll('p').length, 2, '空行切出两个段落');
    eq(b.querySelector('strong').textContent, '粗体', '**加粗** 变成 <strong>');
    ok(!!b.querySelector('code.md-code'), '`行内代码` 变成 <code>');

    b = send('# 大标题\n\n- 甲\n- 乙');
    eq(b.querySelector('h1').textContent, '大标题', '# 变成 <h1>');
    eq(b.querySelectorAll('li').length, 2, '列表两项');

    b = send('| 项目 | 值 |\n|---|---|\n| A | 1 |');
    ok(!!b.querySelector('table.md-table'), '表格渲染出来了');
    eq(b.querySelectorAll('tbody td').length, 2, '表格两个单元格');

    b = send('```js\nconst a = 1 < 2 && 3 > 2;\n```');
    ok(!!b.querySelector('pre.md-pre'), '代码块变成 <pre>');
    eq(b.querySelector('pre code').textContent, 'const a = 1 < 2 && 3 > 2;',
        '代码内容原样保留（< > 没有被吃掉）');

    // —— 图表 ——
    const candleBubble = send('```chart\n{"type":"candlestick","x":["1","2"],' +
        '"series":[{"data":[[10,12,9,13],[12,11,10,14]]}]}\n```');
    ok(!!candleBubble.querySelector('svg'), 'K 线画成 SVG');
    eq(candleBubble.querySelectorAll('svg rect').length, 2, '两个数据点画两根 K 线实体');
    ok(candleBubble.classList.contains('has-rich'), '含图的消息会放宽气泡宽度');

    b = send('```chart\n{"type":"line","x":["a","b","c"],"series":[{"data":[1,3,2]}]}\n```');
    ok(!!b.querySelector('svg polyline'), '折线画成 <polyline>');

    b = send('```chart\n{"type":"bar","x":["a","b"],"series":[{"data":[3,5]}]}\n```');
    eq(b.querySelectorAll('svg rect').length, 2, '柱状图两根柱子');

    b = send('```chart\n{"type":"pie","data":[{"name":"甲","value":3},{"name":"乙","value":1}]}\n```');
    eq(b.querySelectorAll('svg path').length, 2, '饼图两瓣扇形');
    ok(b.textContent.indexOf('甲') >= 0, '饼图图例带上了名字');

    // —— 流程图 ——
    b = send('```mermaid\nflowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n```');
    const mtexts = Array.prototype.map.call(b.querySelectorAll('svg text'), (t) => t.textContent);
    ok(!!b.querySelector('svg'), '流程图画成 SVG');
    ok(mtexts.indexOf('开始') >= 0 && mtexts.indexOf('结束') >= 0, '三个节点标签都在');
    ok(mtexts.indexOf('是') >= 0, '连线上的标签也画了');

    // —— 降级：畸形输入是常态，不能抛异常、不能丢消息 ——
    console.log('\n  —— 畸形输入降级 ——');

    b = send('```chart\n{这不是合法 JSON\n```');
    ok(!b.querySelector('svg'), '坏 JSON 不画图');
    ok(b.textContent.indexOf('这不是合法 JSON') >= 0, '原样显示出来，内容没丢');

    b = send('```chart\n{"type":"radar","series":[{"data":[1]}]}\n```');
    ok(!b.querySelector('svg'), '不认识的 type 不画图');
    ok(b.textContent.indexOf('radar') >= 0, '照样把 JSON 露出来');

    b = send('```chart\n{"type":"candlestick","series":[{"data":[[1,2,3]]}]}\n```');
    ok(!b.querySelector('svg'), 'K 线数据缺字段（只有 3 个数）不画图');

    b = send('```chart\n{"type":"pie","data":[]}\n```');
    ok(!b.querySelector('svg'), '空饼图不画图');

    b = send('```mermaid\nsequenceDiagram\n  A->>B: hi\n```');
    ok(!b.querySelector('svg'), '序列图不支持，降级成代码块');
    ok(b.textContent.indexOf('sequenceDiagram') >= 0, '把原始源码显示出来');

    // 注意别拿一串中文当「看不懂」的例子 —— 裸节点 id 本来就允许中文，
    // 那种输入是**合法**的，会画出一个单独的节点。这里要的是真解析不了的。
    b = send('```mermaid\nflowchart TD\n  A[括号没闭合\n```');
    ok(!b.querySelector('svg'), '括号没闭合的流程图不画');

    // —— 注入防护（这一节是重点）——
    // render.js 整条路径上不该有任何一处把字符串当 HTML 解析。
    // 这几条断言就是钉住这个性质的：一旦有人图省事改成 innerHTML，这里立刻红。
    console.log('\n  —— 注入防护 ——');

    const EVIL = '<img src=x onerror="window.__pwned=1">' +
                 '<script>window.__pwned=2<\/script>' +
                 '[点我](javascript:window.__pwned=3)' +
                 '<iframe src="https://evil.example"></iframe>';
    b = send(EVIL);
    eq(b.querySelectorAll('img').length, 0, '没有生成 <img> 元素');
    eq(b.querySelectorAll('script').length, 0, '没有生成 <script> 元素');
    eq(b.querySelectorAll('iframe').length, 0, '没有生成 <iframe> 元素');
    eq(b.querySelectorAll('a').length, 0, 'javascript: 链接不会变成可点的 <a>');
    ok(b.textContent.indexOf('<img src=x') >= 0, '整段原样可见（没被吃掉）');
    ok(!w.__pwned, '注入的代码一次都没执行');

    // 代码块里的 HTML 同样只是文本
    b = send('```html\n<script>window.__pwned=4<\/script>\n```');
    eq(b.querySelectorAll('script').length, 0, '代码块里的 <script> 也是纯文本');
    ok(b.textContent.indexOf('window.__pwned=4') >= 0, '代码块内容完整');
    ok(!w.__pwned, '到这里仍然没有被执行');

    // 正常链接要能用
    b = send('[官网](https://example.com)');
    const link = b.querySelector('a');
    ok(!!link && link.getAttribute('href') === 'https://example.com', 'https 链接可以点');
    ok((link.getAttribute('rel') || '').indexOf('noopener') >= 0, '外链带上 noopener');

    // —— 系统消息保持纯文本 ——
    console.log('\n  —— 系统消息 ——');
    w.addPeerMessage(RPID, 'system', '**不该变粗**');
    const sysBubble = w.document.querySelector(
        '#peerTabs .peer-chat-container[data-peerid="' + RPID + '"] .system-msg .message');
    ok(!!sysBubble && !sysBubble.querySelector('strong'), '系统提示不走 Markdown');
    eq(sysBubble.textContent, '**不该变粗**', '系统提示原样显示');

    // 渲染全程不该冒出脚本异常（getBBox / canvas 之类 jsdom 没实现的东西）
    const renderErrs = scriptErrors.filter((e) => !/Could not load|https?:/i.test(String(e && e.message)));
    ok(renderErrs.length === 0, '渲染期间没有脚本异常',
        renderErrs.map((e) => String(e && e.message)).join(' | '));

    report();
})().catch((e) => {
    console.log('❌ 套件自身出错: ' + (e && e.stack || e));
    process.exit(1);
});

function report() {
    console.log('\n' + '─'.repeat(50));
    console.log('网页端通过 ' + pass + '，失败 ' + fail);
    if (fail) {
        console.log('失败项：');
        for (const f of failures) console.log('  - ' + f);
    }
    // jsdom 会留着定时器不放，直接退
    process.exit(fail ? 1 : 0);
}
