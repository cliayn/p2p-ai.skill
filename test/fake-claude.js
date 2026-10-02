#!/usr/bin/env node
'use strict';

/**
 * 一个假的 claude CLI，用来在**不花钱、不联网**的前提下测 claude-runner 的解析逻辑。
 * 它复刻真实 claude 1.0.44 在 --output-format stream-json 下的输出形状：
 *   system/init  -> assistant  -> result
 * 并把收到的 argv 塞进 result 里，方便断言 --resume 之类的参数确实传对了。
 */

const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d.toString(); });
process.stdin.on('end', () => {
    const prompt = input.trim();

    // 模拟 --resume 失败的情况，用于测试回退逻辑
    if (process.env.FAKE_CLAUDE_FAIL_RESUME === '1' && args.includes('--resume')) {
        process.stderr.write('No conversation found with session ID\n');
        process.stdout.write(JSON.stringify({
            type: 'result', subtype: 'error_during_execution', is_error: true,
            result: 'No conversation found with session ID', session_id: null,
        }) + '\n');
        process.exit(1);
    }

    // 模拟超时
    if (process.env.FAKE_CLAUDE_HANG === '1') {
        setTimeout(() => process.exit(0), 600000);
        return;
    }

    const ri = args.indexOf('--resume');
    const resumed = ri >= 0 ? args[ri + 1] : null;
    const sid = resumed ? 'fake-resumed-' + Date.now() : 'fake-init-' + Date.now();

    const text = 'ECHO[' + prompt.slice(0, 120) + ']';

    const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

    emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'text', text: '第二段' }] } });
    emit({
        type: 'result', subtype: 'success', is_error: false, result: text,
        session_id: sid, num_turns: 2,
        // 真实 claude 没有这个字段，纯粹给测试断言用
        __argv: args,
    });
    process.exit(0);
});
