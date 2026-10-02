#!/usr/bin/env node
'use strict';

/**
 * 把 p2p-chat 技能安装到 ~/.claude/skills/p2p-chat/。
 *
 *   node install.js [目标目录]
 *
 * 技能目录里只放 SKILL.md 和一份安装信息 —— 源代码留在原地，
 * 免得同一份代码在两处各改一遍、然后不一致。
 *
 * 关键一步是把 SKILL.md 里的 `node bin/xxx.js` 换成绝对路径：
 * 技能被读取时，AI 的工作目录不是这个仓库，相对路径会解析错地方。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveClaudeBin } = require('./src/claude-bin');

const ROOT = path.resolve(__dirname);
const dest = path.resolve(process.argv[2] || path.join(os.homedir(), '.claude', 'skills', 'p2p-chat'));

function log(msg) { process.stdout.write(msg + '\n'); }

// ————— 1. 依赖自检 —————

const problems = [];

const major = Number(process.versions.node.split('.')[0]);
log('node      ' + process.version + (major >= 18 ? '  ✓' : '  ✗ 需要 18 以上（fs.statfs 用在磁盘空间检查上）'));
if (major < 18) problems.push('node 版本过低（需要 ≥18，当前 ' + process.version + '）');

// 注意：不能 require('werift/package.json') —— 它的 exports 映射不放行这个子路径，
// 会误报「未安装」。改成解析主入口，再往上找最近的 package.json 读版本号。
let werift = null;
try {
    let d = path.dirname(require.resolve('werift'));
    while (d !== path.dirname(d)) {
        const pj = path.join(d, 'package.json');
        if (fs.existsSync(pj)) {
            const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
            if (meta.name === 'werift') { werift = meta.version; break; }
        }
        d = path.dirname(d);
    }
    if (!werift) werift = '(已安装，版本未知)';
} catch (e) { /* 没装 */ }

if (werift) {
    log('werift    ' + werift + '  ✓');
} else {
    log('werift    未安装  ✗');
    problems.push('缺少依赖，请先在 ' + ROOT + ' 下执行 npm install');
}

// 不能只看 PATH：claude 常装在 ~/.local/bin 之类没进 PATH 的地方
// （这台 Windows 上就是 %USERPROFILE%\.local\bin\claude.exe）。
// 用运行时同一个解析器，装的时候报「找不到」而跑起来又能找到，那种不一致最难查。
const found = resolveClaudeBin('claude');
const claude = spawnSync(found.bin, ['--version'], {
    encoding: 'utf8', shell: process.platform === 'win32',
});
if (claude.status === 0) {
    log('claude    ' + String(claude.stdout || '').trim() + '  ✓' +
        (found.bin !== 'claude' ? '  (' + found.bin + ')' : ''));
} else {
    log('claude    找不到  ✗');
    problems.push('找不到 claude，对端起来了也没法对话（找过 ' + found.tried.length +
        ' 个目录，可用 CLAUDE_BIN 指定绝对路径）');
}

// ————— 2. 写技能文件 —————

fs.mkdirSync(dest, { recursive: true });

const src = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
// 相对路径 → 绝对路径
const md = src.replace(/node bin\//g, 'node ' + ROOT + '/bin/');
fs.writeFileSync(path.join(dest, 'SKILL.md'), md, 'utf8');
log('\nSKILL.md  → ' + path.join(dest, 'SKILL.md'));

fs.writeFileSync(path.join(dest, 'install.json'), JSON.stringify({
    root: ROOT,
    installedAt: new Date().toISOString(),
    node: process.version,
    werift,
}, null, 2) + '\n', 'utf8');
log('install.json → ' + path.join(dest, 'install.json'));

// ————— 3. 结果 —————

log('\n源码位置  ' + ROOT);
log('沙箱目录  ' + path.join(os.homedir(), 'p2p-files'));

if (problems.length) {
    log('\n⚠️  有 ' + problems.length + ' 个问题需要先解决:');
    for (const p of problems) log('  · ' + p);
    process.exit(1);
}

log('\n✅ 技能已安装。让它「起一个 P2P 监听」试试。');
