# p2p-ai

把本机的 Claude Code 变成一个 **P2P 对端**：别人（网页用户，或另一个 Claude Code）通过
WebRTC 点对点连进来，和这个 AI 对话、互传文件。

链路是真正的 P2P（WebRTC DataChannel 直连），中间那台信令服务器只负责牵线——
连上之后消息不经过它。

这个仓库同时也是 [Claude Code 技能](https://docs.claude.com/en/docs/claude-code/skills)
`p2p-chat` 的源码：装到 `~/.claude/skills/` 之后，你直接跟 Claude 说
「起一个 P2P 监听」，它就会自己去跑。

---

## 它解决什么

网页端（浏览器）和本地 AI 之间想通个话，通常得挂个服务器、开个端口、过一遍公网。
这个项目不要那些：

- **不要公网 IP、不要端口映射** —— WebRTC 自己打洞，打不通就走 STUN 反射。
- **不要部署后端** —— 信令用现成的 WebSocket 服务，只传 SDP/ICE，不碰消息内容。
- **消息不过中间人** —— 连上之后是两端直连。

## 前置要求

| | 要求 |
|---|---|
| Node | **≥ 18**（开发用 18.19 / 20.15 验证过）|
| Claude Code | 命令行 `claude` 能跑。装在 PATH 之外也行，见下面的 `CLAUDE_BIN` |
| 网络 | 能访问信令服务器和 STUN（默认都是公网的）|

依赖是纯 JS（`werift` 是自己实现的 WebRTC，不是原生库），所以 **macOS / Linux / Windows
都不需要编译工具链**，`npm install` 不会卡在 node-gyp。

## 安装

```bash
git clone <本仓库>
cd p2p-ai
npm install          # 必做：install.js 只检查依赖，不会替你装
node install.js      # 把技能写进 ~/.claude/skills/p2p-chat/
```

`install.js` 会打一份自检表，三行都得是 ✓：

```
node      v20.15.0  ✓
werift    0.24.4  ✓
claude    2.1.137  ✓  (/Users/you/.local/bin/claude)
```

> **装完之后，这个目录不要删、不要挪。**
> 技能目录里只放 `SKILL.md` 和 `install.json`，源码留在原地——
> `install.js` 把命令写成了**这个目录的绝对路径**，挪走技能就指向空气了。
> （这样设计是为了避免同一份代码在两个地方各改一遍。）

想装到别处：`node install.js <目标目录>`。

## 快速开始

### 起监听（等别人连过来）

```bash
node bin/p2p-listen.js
```

输出里会有房间号和你自己的 id：

```
房间号: p2p-ai-room-4tcy83n77a
我的id: zt9t
房间号以及 id 为 p2p-ai-room-4tcy83n77a 和 zt9t
```

**这两样都要对方拿到**：房间号用来进房间，id 用来在房间里认出是你
（房间号可以很短，一个房间里可能挤着好几个人）。

进程会一直挂着等连接，所以放后台跑。房间号也落在 `~/.p2p-ai/state/room-id`。

### 加入别人的房间

```bash
node bin/p2p-connect.js p2p-ai-room-4tcy83n77a        # 谁在房间里就连谁
node bin/p2p-connect.js p2p-ai-room-4tcy83n77a zt9t   # 只连 zt9t
node bin/p2p-connect.js 1 zt9t                        # 短号房间也一样
```

房间里暂时没人不会退出，会一直等对方上线。

### 用固定房间号

默认每次启动都生成一个新随机号（`sha256(时间戳 ‖ 随机 nonce ‖ 本机私钥签名)` 取前 12 位，
所以同一毫秒起一百个也各不相同）。想固定：

```bash
node bin/p2p-listen.js --room myroom    # 带前缀的号
node bin/p2p-listen.js --room 1         # 短号也行，不强求前缀
```

⚠️ **短号 / 固定号等于弱口令**——猜得到就能进房间。要私密就用默认的随机号，
并在连陌生人时加 `--no-session-list`。

## 观察和操作一个正在跑的监听

```bash
node bin/p2p-ctl.js status                  # 房间号、对端、传输、claude 队列
node bin/p2p-ctl.js peers                   # 当前连着的对端 id
node bin/p2p-ctl.js say <对端id> 文本…        # 以本端身份发一条消息
node bin/p2p-ctl.js send <对端id> <文件路径>
node bin/p2p-ctl.js quit                    # 让那个进程退出
```

它通过本机的一个控制套接字通信（Unix domain socket / Windows 命名管道，
权限 0600），**拿到它就等于能替这个 AI 发消息发文件**，别往网络上暴露。

## 和网页端配合

对端是浏览器时，网页检测到 `device=ai-peer` 会多出一个「对话模式」按钮：

- **即时对话**——普通聊天，AI 记着上文
- **开始新对话**——丢掉上下文重开一条
- **续接历史**——列出本机该工作目录下的历史会话，挑一条接上

> 浏览器那一端是**另一个项目**，不在本仓库里。
> 这个仓库只管 Node 侧的 AI 对端。

## 发消息时能用格式和图表

网页端的聊天窗口会渲染富文本。所以给数据的时候**别堆一串数字，直接发图**：

````
```chart
{"type":"candlestick","title":"贵州茅台","x":["1/2","1/3"],
 "series":[{"data":[[1680,1702,1675,1710],[1702,1690,1688,1705]]}]}
```
````

支持 Markdown（加粗/标题/列表/表格/代码块）、四种图表
（`line` / `bar` / `pie` / `candlestick`）和 `mermaid` 流程图。
完整语法见 [SKILL.md](SKILL.md) 的「客户端渲染能力」一节。

图表全部画成 SVG（没有 canvas），解析失败会**原样显示代码块**——
所以宁可先给个简单的图，也别拼复杂结构。

## 文件互传

沙箱固定两个目录，不会往别处写：

```
~/p2p-files/outbox/<对端id>/    放这里的东西自动发给该对端
~/p2p-files/inbox/<对端id>/     收到该对端的文件落在这里
```

把文件丢进 outbox 就会发；发完的会挪到同目录下的 `sent/`。
对端 id 用 `p2p-ctl peers` 查。

## 安全

**房间号是唯一的门槛。** 没有密码、没有审批，进得来房间就连得上，
连上是自动同意的、不弹确认。几条默认值就是照这个前提设的：

- **默认不给 AI 任何工具。** 对端是任意人时，这个 AI 只是纯对话——
  读不了文件、执行不了命令。要用工具得显式 `--allow-tools Read,Bash`。
- **文件只能落在沙箱里。** 对端给的文件名会被消毒（只取 basename），
  `../../etc/passwd` 这种会被剥成裸文件名，落盘前再断言一次没跑出沙箱。
- **发只能发 outbox 里的文件。**
- **历史会话列表**是唯一一处把工作目录以外的数据送出去的地方，
  默认开着，分两步取（先元信息、再按 id 点名取开头 200 字）。
  **连陌生人或房间号要贴到公开地方时，加 `--no-session-list`。**

完整的安全模型和威胁分析见 [SKILL.md](SKILL.md) 的「安全」一节，建议读一遍再决定怎么用。

## 常用参数

```bash
node bin/p2p-listen.js --help     # 完整列表
```

几个最常动的：

| 参数 | 作用 |
|---|---|
| `--room <号>` | 固定房间号 |
| `--peer <id>` | 只连这个对端，不乱连房间里其他人 |
| `--model <名字>` | 指定模型；不写就用本机默认 |
| `--workdir <目录>` | claude 的工作目录。**必须是固定值**，变了 `--resume` 就失效 |
| `--allow-tools Read,Bash` | 给 AI 开工具，默认**不开** |
| `--no-session-list` | 不让对端看到本机历史会话 |
| `--no-auto-reply` | 只收不发，不触发 claude（防两个 AI 无限互刷） |
| `--max-replies <n>` | 每对端最多触发多少次 claude（默认 100） |

所有参数都有对应的环境变量：名字换成大写下划线即可
（`--model` → `CLAUDE_MODEL`，`--no-session-list` → `SESSION_LIST=0`）。
`CLAUDE_BIN` 用来指定 `claude` 的绝对路径，适合它不在 PATH 里的情况。

## 目录结构

```
bin/          命令行入口（p2p-listen / p2p-connect / p2p-ctl）
src/          daemon、信令、会话、调度、安全、房间号生成
src/transfer/ 分块收发、断点续传、落盘
test/         单元测试 + 4 个真机 e2e 脚本
install.js    把技能写进 ~/.claude/skills/
SKILL.md      给 AI 读的说明书（安装后复制到技能目录）
```

运行期数据都在家目录，不在仓库里：
`~/.p2p-ai/state/`（房间号、私钥、会话链）、`~/.p2p-ai/control.sock`、`~/p2p-files/`。

## 开发与测试

```bash
npm install          # 会装上 jsdom（网页端测试要用）
npm test             # 三个套件：单元 + 传输 + 网页端
```

`npm test` 里第三个套件会用 jsdom 真的加载网页端的 `index.html`，
所以它需要**网页端项目在同一层**（`../update/`）；找不到就自动跳过。

真机 e2e 需要真的 `claude` 和真的网络，分四个：

```bash
npm run test:e2e:browser      # 假浏览器 ↔ 真 AI
npm run test:e2e:ai           # 真 AI ↔ 真 AI
npm run test:e2e:file         # 文件传输
npm run test:e2e:fixed-room   # 固定房间号
```

它们是 `#!/bin/bash` 脚本，macOS 自带的 bash 3.2 也能跑。

## 常见问题

**连不上**——两边得用同一个信令服务器。房间号必须一字不差（前缀不强制，
但多一个字少一个字母就是另一个房间）。还没连上时不报错、一直等，
先看两边日志里的房间号是不是同一个。

**两个 AI 互相刷屏**——都开着自动回复就会一直聊下去。
用 `--max-replies` 设上限，或给一边加 `--no-auto-reply`。

**收不到文件**——文件必须放在 `<files目录>/outbox/<对端id>/`，
id 别写错（`p2p-ctl peers` 确认）。目录监视是自动的，丢进去等一两秒。

**会话断了**——会话链存在 `~/.p2p-ai/state/<对端id>.json`，
同一对端重连会自动续上，断线期间的消息会补发。

**换了个 `--workdir`，历史会话就不一样了**——claude 的会话 JSONL 是按工作目录
分目录存的，别的目录的 id 拿过来 `--resume` 也找不到。这是正常的。

## 许可

本项目 `package.json` 里写的是 ISC，但**仓库里还没有 LICENSE 文件**。
开源前请补一个（用 [choosealicense.com](https://choosealicense.com/) 选，
注意填上版权人）。
