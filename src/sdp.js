'use strict';

/**
 * 浏览器手写 SDP <-> 紧凑载荷 的互转。
 *
 * 浏览器端（js/main.js buildSDP）不是标准 WebRTC 实现：它手写 SDP 模板，
 * 只把 {u,p,f,ice,stunIp} 塞进信令，另一头再重新拼出完整 SDP。
 * 这里必须逐字节对齐，否则对端解析不了。
 */

/** 与 js/main.js:buildICECandidate 完全一致 */
function buildICECandidate(ip, port, type, ufrag) {
    let priority;
    if (type === 'host') priority = ip.includes(':') ? 2113939711 : 2113937151;
    else if (type === 'srflx') priority = 1694498815;
    else if (type === 'prflx') priority = 100;
    else priority = 0;

    const foundation = Math.floor(Math.random() * 2e9);
    return 'candidate:' + foundation + ' 1 udp ' + priority + ' ' + ip + ' ' + port +
        ' typ ' + type + ' generation 0 ufrag ' + ufrag + ' network-cost 999';
}

/** 与 js/main.js:buildSDP 完全一致（含 \r\n 行尾与随机 session-id） */
function buildSDP(type, ufrag, pwd, fingerprint, candidates) {
    const sessionId = Math.floor(Math.random() * 1e18);
    let sdp = 'v=0\r\n' +
        'o=- ' + sessionId + ' 2 IN IP4 127.0.0.1\r\n' +
        's=-\r\n' +
        't=0 0\r\n' +
        'a=group:BUNDLE 0\r\n' +
        'a=extmap-allow-mixed\r\n' +
        'a=msid-semantic: WMS\r\n' +
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
        'c=IN IP4 0.0.0.0\r\n' +
        'a=ice-ufrag:' + ufrag + '\r\n' +
        'a=ice-pwd:' + pwd + '\r\n' +
        'a=ice-options:trickle\r\n' +
        'a=fingerprint:sha-256 ' + fingerprint + '\r\n' +
        'a=setup:' + (type === 'offer' ? 'actpass' : 'active') + '\r\n' +
        'a=mid:0\r\n' +
        'a=sctp-port:5000\r\n' +
        'a=max-message-size:262144\r\n';

    if (candidates && candidates.length > 0) {
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            sdp += 'a=' + buildICECandidate(c.ip, c.port, c.type, ufrag) + '\r\n';
        }
    }
    return sdp;
}

function grab(sdp, re) {
    const m = sdp.match(re);
    return m ? m[1].trim() : null;
}

/** 解析一行 candidate:... 字符串 */
function parseCandidate(str) {
    const p = String(str).split(' ');
    const i = p.indexOf('typ');
    if (i < 2) return null;
    const port = parseInt(p[i - 1], 10);
    if (!Number.isFinite(port)) return null;
    const type = p[i + 1];
    if (!type) return null;
    const ip = p[i - 2];
    // 浏览器做法：丢掉 TCP 候选和 1024 以下端口
    if (String(str).includes('tcptype')) return null;
    if (port < 1024) return null;
    return { ip, port, type, raw: String(str) };
}

/**
 * 从 werift 的 localDescription 里取候选。
 *
 * 注意：werift 在 setLocalDescription 返回之前就已经收集完 ICE，
 * 所以 onIceCandidate 事件早就发完了 —— 只能直接从 SDP 里抠。
 */
function candidatesFromPC(pc) {
    const sdp = (pc.localDescription && pc.localDescription.sdp) || '';
    const lines = sdp.match(/^a=candidate:.*$/gm) || [];
    return lines
        .map((l) => l.replace(/^a=/, ''))
        .map(parseCandidate)
        .filter(Boolean);
}

/** 本机收集到的完整候选（含 raw，用于 trickle） */
function localCandidates(pc) {
    return candidatesFromPC(pc);
}

/** 组装发给对端的紧凑载荷 */
function toCompact(pc, stunIp) {
    const sdp = (pc.localDescription && pc.localDescription.sdp) || '';
    return {
        u: grab(sdp, /a=ice-ufrag:(.+)/),
        p: grab(sdp, /a=ice-pwd:(.+)/),
        f: grab(sdp, /a=fingerprint:sha-256 (.+)/),
        ice: candidatesFromPC(pc).map((c) => ({ ip: c.ip, port: c.port, type: c.type })),
        stunIp: stunIp || null,
    };
}

/** 把收到的紧凑载荷还原成完整 SDP 字符串 */
function fromCompact(type, payload) {
    if (!payload || !payload.u || !payload.p || !payload.f) {
        throw new Error('紧凑 SDP 载荷字段缺失: ' + JSON.stringify(payload));
    }
    return buildSDP(type, payload.u, payload.p, payload.f, payload.ice || []);
}

/** 校验一个紧凑载荷看起来是否合理（快速失败，别把垃圾塞进 setRemoteDescription） */
function validateCompact(payload) {
    if (!payload || typeof payload !== 'object') return 'not an object';
    if (typeof payload.u !== 'string' || !payload.u) return 'missing u';
    if (typeof payload.p !== 'string' || !payload.p) return 'missing p';
    if (typeof payload.f !== 'string' || !payload.f) return 'missing f';
    if (payload.ice !== undefined && !Array.isArray(payload.ice)) return 'ice not array';
    return null;
}

module.exports = {
    buildSDP,
    buildICECandidate,
    parseCandidate,
    candidatesFromPC,
    localCandidates,
    toCompact,
    fromCompact,
    validateCompact,
};
