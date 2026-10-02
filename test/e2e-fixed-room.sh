#!/bin/bash
# 固定房间号 + 定向连接。
#
# 验证：
#   1. --room 1    这种**短号、不带前缀**的房间号能真的组网
#   2. 起监听会自动生成密钥（随机号），而 --room 手填时**不生成**密钥
#   3. 两边都把「我的id」报出来
#   4. p2p-connect 的位置参数形式 `p2p-connect <房间号> <对方id>` 能定向连上
#
# 全程 --no-auto-reply，不跑 claude，所以很快也很便宜。
#
# 用法: test/e2e-fixed-room.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

A_STATE=/tmp/e2e-fx-a; A_FILES=/tmp/e2e-fx-af; A_LOG=/tmp/e2e-fx-a.log
B_STATE=/tmp/e2e-fx-b; B_FILES=/tmp/e2e-fx-bf; B_LOG=/tmp/e2e-fx-b.log
ROOM_ID='1'

cleanup() {
    [ -n "${A_PID:-}" ] && kill "$A_PID" 2>/dev/null
    [ -n "${B_PID:-}" ] && kill "$B_PID" 2>/dev/null
    pkill -f 'p2p-listen.js' 2>/dev/null
    pkill -f 'p2p-connect.js' 2>/dev/null
    return 0
}
trap cleanup EXIT

FAIL=0
chk() { if [ "$2" = "1" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; FAIL=1; fi; }

# 等某个文件里出现某行，最多 N 秒
wait_for() {
    local pattern="$1" file="$2" secs="${3:-20}" i
    for ((i = 0; i < secs; i++)); do
        grep -q -- "$pattern" "$file" 2>/dev/null && return 0
        sleep 1
    done
    return 1
}

cleanup; sleep 1
rm -rf "$A_STATE" "$B_STATE" "$A_FILES" "$B_FILES" "$A_LOG" "$B_LOG"

echo "--- 起监听：--room $ROOM_ID（短号，不带前缀）---"
node bin/p2p-listen.js --room "$ROOM_ID" --no-auto-reply \
    --state-dir "$A_STATE" --files-dir "$A_FILES" > "$A_LOG" 2>&1 &
A_PID=$!

if ! wait_for '^我的id: ' "$A_LOG" 20; then
    echo "❌ 监听端没打出「我的id: 」"; tail -20 "$A_LOG"; exit 1
fi
A_ID=$(grep -m1 '^我的id: ' "$A_LOG" | sed 's/^我的id: //' | tr -d '\r')
echo "A 的 id: $A_ID"

echo "--- B 用位置参数定向连过去：p2p-connect $ROOM_ID $A_ID ---"
node bin/p2p-connect.js "$ROOM_ID" "$A_ID" --no-auto-reply \
    --state-dir "$B_STATE" --files-dir "$B_FILES" > "$B_LOG" 2>&1 &
B_PID=$!

wait_for '数据通道已打开' "$B_LOG" 25 || true
wait_for '数据通道已打开' "$A_LOG" 25 || true

B_ID=$(grep -m1 '^我的id: ' "$B_LOG" 2>/dev/null | sed 's/^我的id: //' | tr -d '\r')

echo ""
echo "════════ 断言 ════════"
chk "监听端用的是固定房间号 $ROOM_ID" "$(grep -q "^房间号: $ROOM_ID\$" "$A_LOG" && echo 1 || echo 0)"
chk "横幅说清了这是固定号" "$(grep -q '固定房间号，来自 --room' "$A_LOG" && echo 1 || echo 0)"
chk "短号原样进了信令（没被加前缀）" "$(grep -q "房间号 $ROOM_ID，" "$A_LOG" && echo 1 || echo 0)"

# 手填房间号时不该凭空多出一个私钥文件 —— 那东西只有随机生成时才用得上
chk "手填房间号不生成密钥" "$([ ! -f "$A_STATE/room-key.pem" ] && echo 1 || echo 0)"

chk "B 认下的是位置参数里的 id" "$(grep -q "只连对端 $A_ID" "$B_LOG" && echo 1 || echo 0)"
chk "B 把连接请求发给了 $A_ID" "$(grep -q "请求连接 $A_ID" "$B_LOG" && echo 1 || echo 0)"
chk "双方建立了 P2P 连接" \
    "$(grep -q '数据通道已打开' "$A_LOG" && grep -q '数据通道已打开' "$B_LOG" && echo 1 || echo 0)"
chk "连接方也报出了自己的 id（${B_ID:-无}）" "$([ -n "$B_ID" ] && echo 1 || echo 0)"
chk "两端的 id 不是同一个" "$([ -n "$B_ID" ] && [ "$B_ID" != "$A_ID" ] && echo 1 || echo 0)"

echo ""
if [ "$A_ID" = "${B_ID:-x}" ]; then
    echo "（两端 id 相同，说明上面的断言有问题，贴日志）"; tail -20 "$A_LOG"; tail -20 "$B_LOG"
fi

if [ "$FAIL" -eq 0 ]; then echo "✅ 固定房间号 + 定向连接 通过"; else echo "❌ 固定房间号 + 定向连接 失败"; fi
exit $FAIL
