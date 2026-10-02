'use strict';

const os = require('os');
const path = require('path');
const { validateRoomId } = require('./roomid');

/**
 * 配置来源优先级：命令行 flag > 环境变量 > 默认值。
 * 加载后深冻结，避免运行期被别处悄悄改掉。
 */

const HOME = os.homedir();

// Unix 域套接字在 Windows 上不可用，那边得用命名管道
const DEFAULT_SOCK = process.platform === 'win32'
    ? '\\\\.\\pipe\\p2p-ai-control-' + (process.env.USERNAME || 'default')
    : path.join(HOME, '.p2p-ai', 'control.sock');

const DEFAULTS = {
    // —— 信令 ——
    signalUrl: 'wss://my-party.cliayn.partykit.dev/party/default',
    stunUrl: 'stun:stun.l.google.com:19302',
    roomId: null,                 // null = 自动生成
    targetPeer: null,             // 只连这个对端 id；null = 连房间里第一个能连的

    // —— claude ——
    claudeBin: 'claude',
    // null = 不传 --model，用 claude 自己的默认模型。
    // 写死 'sonnet' 在只配了别的模型的机器上会直接失败。
    model: null,
    fallbackModel: null,
    timeoutMs: 120000,
    maxConcurrentClaude: 4,
    maxQueuePerPeer: 10,
    workdir: process.cwd(),
    extraArgs: [],
    allowedTools: [],             // 空 = 不给任何工具（纯对话）
    disallowedTools: [],
    persona: null,                // 系统提示词文件路径

    // —— 目录（沙箱）——
    filesRoot: path.join(HOME, 'p2p-files'),
    stateDir: path.join(HOME, '.p2p-ai', 'state'),
    controlSock: DEFAULT_SOCK,

    // —— 传输 ——
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    minFreeBytes: 512 * 1024 * 1024,

    // —— 行为 ——
    deviceName: 'ai-peer',
    allowedPeers: [],             // 空 = 允许任何人
    rateMsgsPerSec: 5,
    rateBytesPerSec: 1024 * 1024,
    ackMode: 'once',              // 'once' | 'none'
    replayOnDisconnect: true,
    retryOnTimeout: true,
    autoAccept: true,
    logLevel: 'info',

    // 要不要让对端看到这台机器上的历史会话（网页端「续接历史」）。
    // 默认开着 —— 这是用户要的功能。但它是本项目里唯一一处
    // 把**工作目录以外的数据**（过去的对话摘要）交给对端的地方，
    // 所以留一个一关就干净的口子，见 daemon._sendSessionList。
    sessionList: true,

    // —— AI 对 AI 的防跑飞 ——
    // 两个都开着自动回复的 daemon 会无限互相回下去，必须有闸。
    autoReply: true,              // false = 只记录和显示，不触发 claude
    maxRepliesPerPeer: 100,       // 每对端最多触发多少次 claude
    openingMessage: null,         // 连上后主动说的第一句话（AI 对 AI 时的开场）
};

function parseFlags(argv) {
    const out = { extraArgs: [], allowedTools: [], disallowedTools: [], allowedPeers: [] };
    const takesValue = {
        '--signal': 'signalUrl',
        '--room': 'roomId',
        '--peer': 'targetPeer',
        '--target': 'targetPeer',
        '--model': 'model',
        '--timeout': 'timeoutMs',
        '--concurrency': 'maxConcurrentClaude',
        '--workdir': 'workdir',
        '--files-dir': 'filesRoot',
        '--state-dir': 'stateDir',
        '--control-sock': 'controlSock',
        '--sock': 'controlSock',
        '--max-file': 'maxFileBytes',
        '--persona': 'persona',
        '--allow-tools': 'allowedTools',
        '--deny-tools': 'disallowedTools',
        '--allow-peers': 'allowedPeers',
        '--ack-mode': 'ackMode',
        '--device': 'deviceName',
        '--claude-bin': 'claudeBin',
        '--claude-args': 'extraArgs',
        '--log-level': 'logLevel',
        '--say': 'openingMessage',
        '--max-replies': 'maxRepliesPerPeer',
    };
    const listFields = new Set(['allowedTools', 'disallowedTools', 'allowedPeers', 'extraArgs']);

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--verbose') { out.logLevel = 'debug'; continue; }
        if (a === '--quiet') { out.logLevel = 'warn'; continue; }
        if (a === '--no-auto-reply') { out.autoReply = false; continue; }
        if (a === '--no-session-list') { out.sessionList = false; continue; }
        if (a === '--help' || a === '-h') { out.help = true; continue; }

        const eq = a.indexOf('=');
        const key = eq >= 0 ? a.slice(0, eq) : a;
        const field = takesValue[key];
        if (!field) continue;

        let val;
        if (eq >= 0) val = a.slice(eq + 1);
        else {
            val = argv[++i];
            if (val === undefined) throw new Error(key + ' 需要一个值');
        }

        if (listFields.has(field)) {
            out[field] = out[field].concat(String(val).split(',').map((s) => s.trim()).filter(Boolean));
        } else if (typeof DEFAULTS[field] === 'number') {
            const n = Number(val);
            if (!Number.isFinite(n) || n <= 0) throw new Error(key + ' 需要一个正数，收到: ' + val);
            out[field] = n;
        } else {
            out[field] = val;
        }
    }
    return out;
}

function parseEnv(env) {
    const map = {
        SIGNAL_URL: ['signalUrl', 'str'],
        STUN_URL: ['stunUrl', 'str'],
        ROOM_ID: ['roomId', 'str'],
        TARGET_PEER: ['targetPeer', 'str'],
        CLAUDE_BIN: ['claudeBin', 'str'],
        CLAUDE_MODEL: ['model', 'str'],
        CLAUDE_TIMEOUT_MS: ['timeoutMs', 'num'],
        CLAUDE_EXTRA_ARGS: ['extraArgs', 'csv'],
        CLAUDE_ALLOWED_TOOLS: ['allowedTools', 'csv'],
        CLAUDE_DISALLOWED_TOOLS: ['disallowedTools', 'csv'],
        MAX_CONCURRENT_CLAUDE: ['maxConcurrentClaude', 'num'],
        MAX_QUEUE_PER_PEER: ['maxQueuePerPeer', 'num'],
        WORKDIR: ['workdir', 'str'],
        FILES_ROOT: ['filesRoot', 'str'],
        STATE_DIR: ['stateDir', 'str'],
        CONTROL_SOCK: ['controlSock', 'str'],
        MAX_FILE_BYTES: ['maxFileBytes', 'num'],
        MIN_FREE_BYTES: ['minFreeBytes', 'num'],
        DEVICE_NAME: ['deviceName', 'str'],
        ALLOWED_PEERS: ['allowedPeers', 'csv'],
        RATE_MSGS_PER_SEC: ['rateMsgsPerSec', 'num'],
        RATE_BYTES_PER_SEC: ['rateBytesPerSec', 'num'],
        ACK_MODE: ['ackMode', 'str'],
        REPLAY_ON_DISCONNECT: ['replayOnDisconnect', 'bool'],
        RETRY_ON_TIMEOUT: ['retryOnTimeout', 'bool'],
        AUTO_ACCEPT: ['autoAccept', 'bool'],
        SESSION_LIST: ['sessionList', 'bool'],
        PERSONA_FILE: ['persona', 'str'],
        LOG_LEVEL: ['logLevel', 'str'],
        AUTO_REPLY: ['autoReply', 'bool'],
        MAX_REPLIES_PER_PEER: ['maxRepliesPerPeer', 'num'],
        OPENING_MESSAGE: ['openingMessage', 'str'],
    };
    const out = {};
    for (const key of Object.keys(map)) {
        if (env[key] === undefined || env[key] === '') continue;
        const [field, kind] = map[key];
        const raw = env[key];
        if (kind === 'num') {
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) throw new Error('环境变量 ' + key + ' 需要一个正数，收到: ' + raw);
            out[field] = n;
        } else if (kind === 'bool') {
            out[field] = !/^(0|false|no|off)$/i.test(String(raw).trim());
        } else if (kind === 'csv') {
            out[field] = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
        } else {
            out[field] = String(raw);
        }
    }
    return out;
}

function loadConfig(argv, env) {
    argv = argv || process.argv.slice(2);
    env = env || process.env;

    const cfg = Object.assign({}, DEFAULTS, parseEnv(env), parseFlags(argv));

    // 房间号：给了就严格校验，没给就留 null 给 bin 那边生成。
    // 注意**不要求** p2p-ai-room- 前缀 —— --room 1 这种短号是合法的：
    // 房间里人多的时候靠「对方的 id」区分，不靠房间号本身。
    if (cfg.roomId) cfg.roomId = validateRoomId(cfg.roomId);

    // 只连指定对端。格式先挡一道：id 是照抄来的，抄错了要在启动时就发现，
    // 而不是连着信令等一个永远不会出现的 id。
    if (cfg.targetPeer) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cfg.targetPeer)) {
            const e = new Error('--peer 的对端 id 不合法（只允许字母数字和 _-）: ' + cfg.targetPeer);
            e.expected = true;
            throw e;
        }
    }

    if (!cfg.signalUrl) throw new Error('signalUrl 不能为空');
    if (!/^wss?:\/\//.test(cfg.signalUrl)) throw new Error('signalUrl 必须以 ws:// 或 wss:// 开头: ' + cfg.signalUrl);

    cfg.workdir = path.resolve(cfg.workdir);
    cfg.filesRoot = path.resolve(cfg.filesRoot);
    cfg.stateDir = path.resolve(cfg.stateDir);

    // 派生目录
    cfg.inboxDir = path.join(cfg.filesRoot, 'inbox');
    cfg.outboxDir = path.join(cfg.filesRoot, 'outbox');
    cfg.roomIdFile = path.join(cfg.stateDir, 'room-id');

    cfg.inboxFor = (peerId) => path.join(cfg.inboxDir, peerId);
    cfg.outboxFor = (peerId) => path.join(cfg.outboxDir, peerId);

    if (!['once', 'none'].includes(cfg.ackMode)) {
        throw new Error("ackMode 只能是 'once' 或 'none'，收到: " + cfg.ackMode);
    }

    // 对端 id 由服务器分配（4 位字母数字），但我们要拼进路径，仍做一次白名单校验
    cfg.safePeerId = (peerId) => {
        if (typeof peerId !== 'string' || !peerId) return null;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(peerId)) return null;
        return peerId;
    };

    return Object.freeze(cfg);
}

const HELP = `
p2p-ai —— 把 Claude Code 变成 P2P 对端

  p2p-listen  [选项]              起监听，打印房间号等待别人连接
  p2p-connect <房间号> [选项]      主动加入别人的房间
  p2p-ctl     <命令>              查看/操作正在运行的 listen 进程

选项:
  --signal <url>       信令服务器 (默认 ${DEFAULTS.signalUrl})
  --room <id>          指定固定房间号（默认自动生成一个随机号）。
                       可以不带前缀，比如 --room 1。短号/固定号谁都能进，
                       房间里人多时用 --peer 指定连哪一个
  --peer <id>          只连这个对端 id（起监听时屏幕上会打出「我的id」）。
                       默认连房间里第一个能连上的
  --model <name>       claude 模型 (默认 ${DEFAULTS.model})
  --timeout <ms>       单次 claude 调用超时 (默认 ${DEFAULTS.timeoutMs})
  --concurrency <n>    全局同时运行的 claude 进程上限 (默认 ${DEFAULTS.maxConcurrentClaude})
  --workdir <dir>      claude 工作目录，必须是固定值否则 --resume 会失效
  --files-dir <dir>    文件沙箱根目录 (默认 ${DEFAULTS.filesRoot})
  --allow-tools <列表> 给 claude 开工具，逗号分隔，例如 Read,Bash（默认无工具）
  --allow-peers <列表> 只接受这些对端 id，逗号分隔（默认不限）
  --ack-mode <once|none>  是否在生成前先回一个"稍等"
  --persona <文件>     系统提示词文件
  --say <文本>         连上后主动说的第一句话（AI 对 AI 时用来开场）
  --no-auto-reply      只接收和显示，不触发 claude（防止两个 AI 无限互相回复）
  --max-replies <n>    每对端最多触发多少次 claude（默认 ${DEFAULTS.maxRepliesPerPeer}）
  --no-session-list    不让对端看到本机的历史会话（关掉网页端的「续接历史」）。
                       默认开着；连陌生人时建议关掉 —— 对端点名就能读到过去对话的开头
  --verbose / --quiet  日志级别

环境变量：把上面的选项名换成大写下划线形式即可（如 CLAUDE_MODEL、MAX_REPLIES_PER_PEER），
         SESSION_LIST=0 等价于 --no-session-list。
`;

module.exports = { loadConfig, DEFAULTS, HELP };
