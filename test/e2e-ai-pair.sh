#!/bin/bash
# 两个 AI 对端互相连接、对话，验证：
#   1. 双向 P2P 建立（listener 自动同意）
#   2. --resume 上下文续接在双方都成立
#   3. 回执（ack）不会被对端当问题白跑一轮 claude
#   4. 到达 --max-replies 后双方都能干净停下，不会互相刷爆
#
# 用法: test/e2e-ai-pair.sh [每端最大回复数] [最长等待秒数]
set -u

MAX_REPLIES="${1:-2}"
WAIT_SECS="${2:-240}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

A_STATE=/tmp/e2e-a-state; A_FILES=/tmp/e2e-a-files
B_STATE=/tmp/e2e-b-state; B_FILES=/tmp/e2e-b-files
A_LOG=/tmp/e2e-ai-a.log;  B_LOG=/tmp/e2e-ai-b.log

# grep -c 在没有匹配时自己会打印 0 并以 1 退出；文件不存在时什么都不打印。
# 这里统一收敛成一个整数，避免 [ "" -ge 1 ] 这种报错。
count() {
    local n
    n=$(grep -c -- "$1" "$2" 2>/dev/null)
    echo "${n:-0}"
}

cleanup() {
    [ -n "${A_PID:-}" ] && kill "$A_PID" 2>/dev/null
    [ -n "${B_PID:-}" ] && kill "$B_PID" 2>/dev/null
    pkill -f 'p2p-listen.js' 2>/dev/null
    pkill -f 'p2p-connect.js' 2>/dev/null
    return 0
}
trap cleanup EXIT

cleanup; sleep 1
rm -rf "$A_STATE" "$B_STATE" "$A_FILES" "$B_FILES" "$A_LOG" "$B_LOG"

# A 起监听，连上后主动开场出一道题
node bin/p2p-listen.js --verbose \
    --state-dir "$A_STATE" --files-dir "$A_FILES" --device ai-A \
    --say '在吗？我问你一道题：3 乘以 7 等于几？只回答那个数字，不要解释。' \
    --max-replies "$MAX_REPLIES" > "$A_LOG" 2>&1 &
A_PID=$!
sleep 3

ROOM=$(cat "$A_STATE/room-id" 2>/dev/null)
echo "房间号: $ROOM"
if [ -z "$ROOM" ]; then echo "❌ 没拿到房间号"; cat "$A_LOG"; exit 1; fi

# A 自己的 id 要等信令连上才打得出来，轮询一会儿。
# 这正是「起监听必须把 id 报出来」那条需求：对面没有它就不知道该连谁。
A_ID=""
for _ in $(seq 1 15); do
    A_ID=$(grep -m1 '^我的id: ' "$A_LOG" 2>/dev/null | sed 's/^我的id: //' | tr -d '\r')
    [ -n "$A_ID" ] && break
    sleep 1
done
echo "A 的 id: ${A_ID:-（没等到）}"
if [ -z "$A_ID" ]; then
    # 拿不到 id 就没法验定向连接，而且这本身就说明「报号」那条需求挂了。
    # 直接判失败，别退化成「连房间里第一个人」把问题盖过去。
    echo "❌ 监听端没打出「我的id: 」"
    tail -30 "$A_LOG"
    exit 1
fi

# B 主动加入，并且**定向**连 A —— 不指定的话就是连「房间里第一个」，
# 房间号短/固定时那等于抽签
node bin/p2p-connect.js "$ROOM" --peer "$A_ID" --verbose \
    --state-dir "$B_STATE" --files-dir "$B_FILES" --device ai-B \
    --max-replies "$MAX_REPLIES" > "$B_LOG" 2>&1 &
B_PID=$!

# 轮询等待两边都撞到回复上限（或超时）
echo "--- 等待对话跑到上限（最多 ${WAIT_SECS}s）---"
for i in $(seq 1 "$WAIT_SECS"); do
    sleep 1
    if [ "$(count '已达回复上限' "$A_LOG")" -gt 0 ] && \
       [ "$(count '已达回复上限' "$B_LOG")" -gt 0 ]; then
        echo "双方都已到达上限（用了 ${i}s）"
        break
    fi
done
# 让最后几条回复的日志刷完
sleep 2

echo ""
echo "════════ A 端（监听方） ════════"
grep -E '💬|收到消息 seq|完成 seq|会话推进|已达回复上限|收到对端的回执' "$A_LOG" | head -40
echo ""
echo "════════ B 端（连接方） ════════"
grep -E '💬|收到消息 seq|完成 seq|会话推进|已达回复上限|收到对端的回执' "$B_LOG" | head -40

echo ""
echo "════════ 断言 ════════"
FAIL=0
chk() { if [ "$2" = "1" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; FAIL=1; fi; }

a_runs=$(count '完成 seq=' "$A_LOG")
b_runs=$(count '完成 seq=' "$B_LOG")
a_recv=$(count '收到消息 seq=' "$A_LOG")
b_recv=$(count '收到消息 seq=' "$B_LOG")
a_acks=$(count '收到对端的回执' "$A_LOG")
b_acks=$(count '收到对端的回执' "$B_LOG")

chk "双方建立了 P2P 连接" \
    "$(grep -q '数据通道已打开' "$A_LOG" && grep -q '数据通道已打开' "$B_LOG" && echo 1 || echo 0)"

# 报号：监听端要同时给出房间号和自己的 id，格式都是能 grep 的 `key: value`
chk "监听端打了「房间号: 」" "$(grep -q '^房间号: ' "$A_LOG" && echo 1 || echo 0)"
chk "监听端打了「我的id: $A_ID」" "$(grep -q "^我的id: $A_ID\$" "$A_LOG" && echo 1 || echo 0)"
# 定向连接：B 说了「只连 A_ID」，就必须真的把 connect_request 发给那个 id
chk "B 认下了 --peer $A_ID" "$(grep -q "只连对端 $A_ID" "$B_LOG" && echo 1 || echo 0)"
chk "B 把连接请求发给了 $A_ID" "$(grep -q "请求连接 $A_ID" "$B_LOG" && echo 1 || echo 0)"
chk "A 跑过 claude（${a_runs} 轮）" "$([ "$a_runs" -ge 1 ] && echo 1 || echo 0)"
chk "B 跑过 claude（${b_runs} 轮）" "$([ "$b_runs" -ge 1 ] && echo 1 || echo 0)"
chk "A 没有超过回复上限（上限 ${MAX_REPLIES}，实际 ${a_runs}）" \
    "$([ "$a_runs" -le "$MAX_REPLIES" ] && echo 1 || echo 0)"
chk "B 没有超过回复上限（上限 ${MAX_REPLIES}，实际 ${b_runs}）" \
    "$([ "$b_runs" -le "$MAX_REPLIES" ] && echo 1 || echo 0)"

# 回执在线上就是一条真的 chat，必须被两侧都识别出来
chk "回执被识别（A ${a_acks} 条 / B ${b_acks} 条）" \
    "$([ $((a_acks + b_acks)) -ge 1 ] && echo 1 || echo 0)"

# 关键回归：claude 只该为真正的消息跑。
# 回执走的是「收到对端的回执 -> return」这条早退路径，根本到不了「收到消息 seq=」那一行；
# 所以只要每一轮 claude 都能配上一个「收到消息 seq=」，就说明没有为回执白跑。
chk "每一轮 claude 都对应一条真实消息（A：${a_runs} 轮 / ${a_recv} 条）" \
    "$([ "$a_runs" -eq "$a_recv" ] && echo 1 || echo 0)"
chk "每一轮 claude 都对应一条真实消息（B：${b_runs} 轮 / ${b_recv} 条）" \
    "$([ "$b_runs" -eq "$b_recv" ] && echo 1 || echo 0)"

# 内容正确性：B 应该真的读到了题并算出 21
chk "B 答对了 3×7=21" "$(grep -q '21' "$B_LOG" && echo 1 || echo 0)"

# 会话续接：每一轮之后 session id 都应该被推进（新的 UUID 链）
chk "A 的会话链在推进" "$([ "$(count '会话推进 seq=' "$A_LOG")" -ge 1 ] && echo 1 || echo 0)"
chk "B 的会话链在推进" "$([ "$(count '会话推进 seq=' "$B_LOG")" -ge 1 ] && echo 1 || echo 0)"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "✅ AI ↔ AI 通过"; else echo "❌ AI ↔ AI 有失败项"; fi
exit $FAIL
