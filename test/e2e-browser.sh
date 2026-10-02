#!/bin/bash
# 浏览器 ↔ AI 端到端：用 test/fake-browser.js 冒充浏览器走完整流程。
#
# 验证：
#   - 自动同意（AI 不弹任何确认）
#   - 双向 chat-ready 握手
#   - claude 的 --resume 会话续接（第 1 轮记一个数字，第 2 轮问它）
#
# 用法: test/e2e-browser.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STATE=/tmp/e2e-browser-state
FILES=/tmp/e2e-browser-files
LOG=/tmp/e2e-browser-listen.log

cleanup() {
    [ -n "${LISTEN_PID:-}" ] && kill "$LISTEN_PID" 2>/dev/null
    pkill -f 'p2p-listen.js' 2>/dev/null
    return 0
}
trap cleanup EXIT

cleanup; sleep 1
rm -rf "$STATE" "$FILES" "$LOG"

node bin/p2p-listen.js --quiet --state-dir "$STATE" --files-dir "$FILES" > "$LOG" 2>&1 &
LISTEN_PID=$!

# 等信令连上。房间号同步就能拿到，但「我的id」要等服务端分配，得轮询。
ROOM=""
for _ in $(seq 1 20); do
    sleep 1
    ROOM=$(cat "$STATE/room-id" 2>/dev/null)
    [ -n "$ROOM" ] && [ -n "$(grep -m1 '^我的id: ' "$LOG" 2>/dev/null)" ] && break
done

echo "房间号: $ROOM"
if [ -z "$ROOM" ]; then echo "❌ 没拿到房间号"; cat "$LOG"; exit 1; fi

# 自动生成的号必须顶满 24 格（12 格前缀 + 12 格 hash），
# 短了就说明生成路径退化回了旧的「随机查表」
if [ "${#ROOM}" -ne 24 ]; then echo "❌ 房间号长度 ${#ROOM}，期望 24: $ROOM"; exit 1; fi

# 起监听要报出自己的 id，否则房间里人多时对面不知道该连谁
MY_ID=$(grep -m1 '^我的id: ' "$LOG" 2>/dev/null | sed 's/^我的id: //' | tr -d '\r')
echo "自己的 id: ${MY_ID:-（没等到）}"
if [ -z "$MY_ID" ]; then echo "❌ 没打出「我的id: 」"; tail -20 "$LOG"; exit 1; fi

echo "--- 浏览器 ↔ AI ---"
node test/fake-browser.js "$ROOM" > /tmp/e2e-browser-client.log 2>&1
RC=$?
tail -20 /tmp/e2e-browser-client.log

echo ""
if [ "$RC" -eq 0 ]; then echo "✅ 浏览器 ↔ AI 通过"; else echo "❌ 浏览器 ↔ AI 失败"; fi
exit $RC
