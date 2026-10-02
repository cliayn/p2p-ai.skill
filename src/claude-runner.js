'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { resolveClaudeBin } = require('./claude-bin');

/**
 * 跑一次 claude -p，把流式事件回调出去。
 *
 * 几个必须做对的点：
 *  1. prompt 走 stdin，不走 argv —— 长 prompt + 文件上下文会超过 ARG_MAX。
 *  2. detached:true 让子进程自成进程组，取消时能整组杀掉；
 *     只杀直接 pid 会留下 claude 派生的子进程。
 *  3. stream-json 的第一个 system/init 事件就带 session_id，
 *     可以在模型还没答完时就把会话落盘（这是中断/续接能安全的前提）。
 *  4. cwd 必须固定，否则会话 JSONL 落到别的 project 目录，--resume 会找不到。
 */

const KILL_GRACE_MS = 5000;

/**
 * @param {object} opts
 * @param {string} opts.prompt           用户输入（写 stdin）
 * @param {string} [opts.sessionId]      续接某个会话
 * @param {function} [opts.onSessionId]  拿到 session_id 就回调（init 事件，很早）
 * @param {function} [opts.onAssistantText] 每个 assistant 文本块完成时回调（增量）
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok, sessionId, text, chunks, exitCode, aborted, timedOut, error, stderr, usage}>}
 */
function runClaude(opts) {
    const {
        bin = 'claude',
        model,
        fallbackModel,
        prompt = '',
        sessionId,
        cwd,
        timeoutMs = 120000,
        signal,
        extraArgs = [],
        allowedTools = [],
        disallowedTools = [],
        skipPermissions = false,
        addDirs = [],
        onSessionId,
        onAssistantText,
        logger,
    } = opts;

    return new Promise((resolve) => {
        const args = ['-p', '--output-format', 'stream-json', '--verbose'];

        if (model) args.push('--model', model);
        if (fallbackModel) args.push('--fallback-model', fallbackModel);
        if (sessionId) args.push('--resume', sessionId);

        // 工具白名单放在最后：--allowedTools 是变参，放前面会吞掉后面的参数
        if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
        if (disallowedTools.length) args.push('--disallowedTools', disallowedTools.join(','));
        if (addDirs.length) args.push('--add-dir', ...addDirs);
        if (skipPermissions) args.push('--dangerously-skip-permissions');
        if (extraArgs.length) args.push(...extraArgs);

        // 裸名字先解析成真实路径：claude 常常不在 PATH 里（尤其 Windows）
        const resolved = resolveClaudeBin(bin);
        const binPath = resolved.bin;

        // Windows 上 .cmd/.bat（npm 装的 claude 就是 claude.cmd）不能用
        // shell:false 直接 spawn —— Node 从 18.20 起会直接抛 EINVAL。
        // 这种脚本本来就得靠 cmd.exe 解释，包一层是最稳的。
        let spawnBin = binPath;
        let spawnArgs = args;
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath)) {
            spawnBin = process.env.ComSpec || 'cmd.exe';
            // 不要加 /s —— 它会剥掉命令串首尾的引号，把参数搅乱
            spawnArgs = ['/d', '/c', binPath, ...args];
        }

        let child;
        try {
            child = spawn(spawnBin, spawnArgs, {
                cwd: cwd || process.cwd(),
                // detached 只为拿到 POSIX 进程组（kill(-pid) 要靠它）。
                // Windows 没这回事，整组杀走的是 taskkill /T；
                // 而且那边 detached 会给子进程开新控制台，cmd.exe 会直接挂住。
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            });
        } catch (e) {
            return resolve({ ok: false, sessionId: null, text: '', chunks: [], exitCode: -1, error: e.message, stderr: '' });
        }

        let settled = false;
        let aborted = false;
        let timedOut = false;
        let killTimer = null;
        let timeoutTimer = null;
        let stderrBuf = '';
        let sawInit = false;
        let finalSessionId = sessionId || null;
        let resultText = null;
        let isError = false;
        let chunks = [];
        let usage = null;
        let spawnErrored = null;

        const log = (logger || { debug() {}, warn() {}, error() {} });

        /**
         * 整组杀掉。
         *
         * Windows 没有进程组和信号这回事：process.kill(-pid) 必然抛错，
         * child.kill() 也只杀得掉直接子进程，claude 派生的 bash/node 会变孤儿。
         * 只有 taskkill /T 才会连子孙一起收，所以两边走不同路径。
         */
        function killGroup(why) {
            if (!child.pid || child.killed) return;
            log.debug('kill 进程组 ' + child.pid + '（' + why + '）');

            if (process.platform === 'win32') {
                // /T 连子孙，/F 强杀 —— Windows 上没有「先礼后兵」的等价物
                try {
                    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                        stdio: 'ignore', windowsHide: true,
                    });
                } catch (e) { /* 进程可能已经退了 */ }
                return;
            }

            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch (e) {
                try { child.kill('SIGTERM'); } catch (e2) { /* 已退出 */ }
            }
            killTimer = setTimeout(() => {
                try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* 已退出 */ }
            }, KILL_GRACE_MS);
            killTimer.unref();
        }

        function finish(exitCode) {
            if (settled) return;
            settled = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (killTimer) clearTimeout(killTimer);

            // 没拿到任何文本时，退回 result 事件里的整段文本
            if (chunks.length === 0 && typeof resultText === 'string' && resultText) {
                chunks = [resultText];
                if (onAssistantText) {
                    try { onAssistantText(resultText); } catch (e) { log.warn('onAssistantText 回调抛错: ' + e.message); }
                }
            }

            resolve({
                ok: !spawnErrored && !aborted && !timedOut && exitCode === 0 && !isError,
                sessionId: finalSessionId,
                text: chunks.join('\n\n'),
                chunks,
                exitCode,
                aborted,
                timedOut,
                error: spawnErrored || (isError ? (resultText || 'claude 返回错误') : null),
                stderr: stderrBuf.slice(0, 4000),
                usage,
            });
        }

        child.on('error', (e) => {
            spawnErrored = e.code === 'ENOENT'
                ? '找不到 claude 可执行文件：' + bin + '（请确认 PATH，或用 CLAUDE_BIN 指定绝对路径）'
                    + (resolved.tried.length ? '；已找过 ' + resolved.tried.length + ' 个目录：'
                        + resolved.tried.slice(0, 6).join('、') + (resolved.tried.length > 6 ? ' …' : '') : '')
                : e.message;
            log.error(spawnErrored);
            finish(-1);
        });

        // —— 超时 ——
        if (timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                timedOut = true;
                log.warn('claude 超过 ' + timeoutMs + 'ms 未完成，终止');
                killGroup('timeout');
            }, timeoutMs);
        }

        // —— 外部取消（对端掉线）——
        if (signal) {
            if (signal.aborted) {
                aborted = true;
                killGroup('already aborted');
            } else {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    killGroup('abort');
                }, { once: true });
            }
        }

        // —— stdout：逐行 JSONL ——
        const rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => {
            const s = line.trim();
            if (!s) return;
            let ev;
            try { ev = JSON.parse(s); } catch (e) { return; }   // 非 JSON 行直接忽略

            if (ev.type === 'system' && ev.subtype === 'init') {
                sawInit = true;
                if (ev.session_id) {
                    finalSessionId = ev.session_id;
                    // 这里是关键：会话 id 在生成开始前就拿到了
                    if (onSessionId) {
                        try { onSessionId(ev.session_id); } catch (e) { log.warn('onSessionId 回调抛错: ' + e.message); }
                    }
                }
                return;
            }

            if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
                for (const block of ev.message.content) {
                    // 只取 text，thinking/tool_use 不外发
                    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                        chunks.push(block.text);
                        if (onAssistantText) {
                            try { onAssistantText(block.text); } catch (e) { log.warn('onAssistantText 回调抛错: ' + e.message); }
                        }
                    }
                }
                if (ev.message.usage) usage = ev.message.usage;
                return;
            }

            if (ev.type === 'result') {
                if (ev.session_id) finalSessionId = ev.session_id;
                if (typeof ev.result === 'string') resultText = ev.result;
                isError = !!ev.is_error;
                if (ev.usage) usage = ev.usage;
                return;
            }
        });

        child.stderr.on('data', (d) => {
            stderrBuf += d.toString();
            if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
        });

        child.on('close', (code) => {
            const wasAborted = aborted;
            const wasTimedOut = timedOut;
            // close 可能在 finish 之前/之后，标记状态保证 finish 里判断正确
            aborted = wasAborted || aborted;
            timedOut = wasTimedOut || timedOut;
            if (!sawInit && !spawnErrored && !aborted && !timedOut && code !== 0) {
                log.warn('claude 未输出 init 事件就退出，code=' + code + ' stderr=' + stderrBuf.slice(0, 300));
            }
            finish(code === null ? -1 : code);
        });

        // 写 prompt 并关闭 stdin
        child.stdin.on('error', () => { /* 子进程提前退出时 EPIPE，忽略 */ });
        child.stdin.end(prompt, 'utf8');
    });
}

module.exports = { runClaude };
