#!/bin/bash
# 真链路上的文件传输：两个完整的 daemon 通过真实 WebRTC 互传文件。
#
# 这一步验证的是回环测试验证不了的东西：
#   - werift 的**协商数据通道**（createDataChannel(label, {negotiated, id})）
#     在真实 SCTP 上能不能开起来、双方能不能配对
#   - daemon → peer → transfer manager 整条链路的接线
#   - outbox 监视器能不能自动把文件发出去
#   - 文件最终落在对方的 inbox/<本端看到的对端id>/ 里且字节一致
#
# 目录约定很容易搞反，这里写清楚：
#   要发给 X  → 放本端 outbox/<X 的 id>/
#   收到 X 的 → 落在本端 inbox/<X 的 id>/
# 每个 daemon 的**自己**的 id 从它日志里的「已分配 id=」取。
#
# 用法: test/e2e-file.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

A_FILES=/tmp/e2e-file-a-files; A_STATE=/tmp/e2e-file-a-state
B_FILES=/tmp/e2e-file-b-files; B_STATE=/tmp/e2e-file-b-state
A_LOG=/tmp/e2e-file-a.log; B_LOG=/tmp/e2e-file-b.log
SAMPLES=/tmp/e2e-samples

cleanup() {
    [ -n "${A_PID:-}" ] && kill "$A_PID" 2>/dev/null
    [ -n "${B_PID:-}" ] && kill "$B_PID" 2>/dev/null
    pkill -f 'p2p-listen.js' 2>/dev/null
    pkill -f 'p2p-connect.js' 2>/dev/null
    return 0
}
trap cleanup EXIT

# grep -c 无匹配时会打印 0 并退出 1，`|| echo 0` 会变成两行 "0\n0"
count_files() {
    local n
    n=$(ls "$1" 2>/dev/null | grep -vc '\.p2p-part$')
    echo "${n:-0}"
}

cleanup; sleep 1
rm -rf "$A_FILES" "$B_FILES" "$A_STATE" "$B_STATE" "$A_LOG" "$B_LOG" "$SAMPLES"

echo "--- 启动两个 daemon ---"
node bin/p2p-listen.js --files-dir "$A_FILES" --state-dir "$A_STATE" \
    --device ai-A > "$A_LOG" 2>&1 &
A_PID=$!
sleep 3

ROOM=$(cat "$A_STATE/room-id" 2>/dev/null)
echo "房间号: $ROOM"
if [ -z "$ROOM" ]; then echo "❌ 没拿到房间号"; cat "$A_LOG"; exit 1; fi

node bin/p2p-connect.js "$ROOM" --files-dir "$B_FILES" --state-dir "$B_STATE" \
    --device ai-B > "$B_LOG" 2>&1 &
B_PID=$!

echo "--- 等待 P2P 建立 ---"
for i in $(seq 1 60); do
    sleep 1
    grep -q '双方就绪' "$A_LOG" 2>/dev/null && grep -q '双方就绪' "$B_LOG" 2>/dev/null && break
done
if ! grep -q '双方就绪' "$A_LOG" 2>/dev/null; then
    echo "❌ 连接没建立"; tail -20 "$A_LOG"; exit 1
fi
echo "连接建立（用了 ${i}s）"

A_ID=$(grep -oE '已分配 id=[a-zA-Z0-9_-]+' "$A_LOG" | head -1 | cut -d= -f2)
B_ID=$(grep -oE '已分配 id=[a-zA-Z0-9_-]+' "$B_LOG" | head -1 | cut -d= -f2)
echo "A 的 id = $A_ID ；B 的 id = $B_ID"
if [ -z "$A_ID" ] || [ -z "$B_ID" ]; then echo "❌ 没解析出 id"; exit 1; fi

# ————— 样本 —————
mkdir -p "$SAMPLES"
head -c 300000 /dev/urandom > "$SAMPLES/random.bin"
python3 -c "open('$SAMPLES/text.txt','w').write('p2p 文件传输测试\n'*8000)" 2>/dev/null \
    || yes 'p2p 文件传输测试' 2>/dev/null | head -8000 > "$SAMPLES/text.txt"
: > "$SAMPLES/empty.dat"

FAIL=0
chk() { if [ "$2" = "1" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; FAIL=1; fi; }

# ————— B → A —————
echo ""
echo "--- B 发给 A：丢进 B 的 outbox/$A_ID/，等监视器自动发 ---"
mkdir -p "$B_FILES/outbox/$A_ID"
for s in random.bin text.txt empty.dat; do cp "$SAMPLES/$s" "$B_FILES/outbox/$A_ID/$s"; done

echo "--- 等待 A 收件箱出现 3 个文件 ---"
for i in $(seq 1 60); do
    sleep 1
    [ "$(count_files "$A_FILES/inbox/$B_ID")" -ge 3 ] && break
done
# 多等一会儿：如果有重发，第二个副本会在这段时间里冒出来
sleep 3
echo "等待 ${i}s"
ls -la "$A_FILES/inbox/$B_ID" 2>/dev/null || echo "(收件箱不存在)"

echo ""
for s in random.bin text.txt empty.dat; do
    src="$SAMPLES/$s"; got="$A_FILES/inbox/$B_ID/$s"
    if [ -f "$got" ]; then
        chk "B→A $s 字节一致（$(stat -c%s "$src")B）" \
            "$([ "$(sha256sum "$src" | cut -d' ' -f1)" = "$(sha256sum "$got" | cut -d' ' -f1)" ] && echo 1 || echo 0)"
    else
        chk "B→A $s 已收到" "0"
    fi
done

# 重发会在收件箱里留下 "名字 (1).ext" 这样的第二个副本
n=$(count_files "$A_FILES/inbox/$B_ID")
chk "收件箱恰好 3 个文件，没有重发副本（实际 $n）" "$([ "$n" -eq 3 ] && echo 1 || echo 0)"

# 发送端每个文件只该发起一次
resend=$(grep -c '正在发送 random.bin' "$B_LOG" 2>/dev/null)
chk "random.bin 只发送了一次（实际 $resend 次）" "$([ "${resend:-0}" -eq 1 ] && echo 1 || echo 0)"

# ————— A → B —————
echo ""
echo "--- A 发给 B：丢进 A 的 outbox/$B_ID/ ---"
mkdir -p "$A_FILES/outbox/$B_ID"
cp "$SAMPLES/text.txt" "$A_FILES/outbox/$B_ID/reply.txt"

for i in $(seq 1 60); do
    sleep 1
    [ -f "$B_FILES/inbox/$A_ID/reply.txt" ] && break
done

if [ -f "$B_FILES/inbox/$A_ID/reply.txt" ]; then
    chk "A→B reply.txt 字节一致" \
        "$([ "$(sha256sum "$SAMPLES/text.txt" | cut -d' ' -f1)" = "$(sha256sum "$B_FILES/inbox/$A_ID/reply.txt" | cut -d' ' -f1)" ] && echo 1 || echo 0)"
else
    chk "A→B reply.txt 已收到" "0"
fi

leftover=$(find "$A_FILES" "$B_FILES" -name '*.p2p-part' 2>/dev/null | wc -l)
chk "两端都没有残留 .part 文件" "$([ "$leftover" -eq 0 ] && echo 1 || echo 0)"

echo ""
echo "--- 传输相关日志 ---"
grep -hE '📥|📤|发送完成|接收完成|通道|传输|拒绝|失败' "$A_LOG" "$B_LOG" 2>/dev/null | head -30

if [ "$FAIL" -ne 0 ]; then
    echo ""
    echo "--- A 日志尾部 ---"; tail -20 "$A_LOG"
    echo "--- B 日志尾部 ---"; tail -20 "$B_LOG"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then echo "✅ 真链路文件传输通过"; else echo "❌ 真链路文件传输有失败项"; fi
exit $FAIL
