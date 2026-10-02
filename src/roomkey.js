'use strict';

/**
 * 每台机器一份的房间号密钥（Ed25519）。
 *
 * 用途只有一个：把自动生成的房间号绑到本机身份上。
 * 房间号的构造是 sha256(时间戳 ‖ nonce ‖ 签名)，签名让这个号只有**持有私钥的这台机器**
 * 才造得出来 —— 将来要证明「某个房间号确实是我起的」，拿公钥验一下就行。
 *
 * ⚠️ 说清楚它**不是**什么：
 *   - 它**不增加随机性**。房间号够不够随机，只取决于里面那 32 字节 nonce；
 *     签名是确定性的，喂进去同样的输入永远产出同样的结果。
 *   - 它**不被任何人验证**。信令服务端不校验房间号，谁都可以起任意号。
 *     所以它保护不了房间、也挡不住冒名 —— 真正拦住外人的是房间号本身够不够难猜。
 * 密钥放在状态目录里、权限 0600，纯粹是因为「这是密钥」这个常识，
 * 而不是因为丢了它会造成什么损失（丢了就重新生成一把，房间号照常是随机的）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = 'room-key.pem';

/**
 * 读或创建房间号密钥。
 *
 * 返回 { privateKey, publicKey, path, created, fingerprint }。
 * 读失败/损坏一律当「没有」处理：隔离掉旧文件、生成新的、大声记日志 ——
 * 房间号是每次启动现生成的，换一把密钥不会让任何既有房间号失效，没有理由为此拒绝启动。
 */
function loadOrCreateRoomKey(stateDir, logger) {
    const log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    const keyPath = path.join(stateDir, KEY_FILE);

    const existing = readKey(keyPath, log);
    if (existing) return { ...existing, path: keyPath, created: false };

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    fs.mkdirSync(stateDir, { recursive: true });
    try {
        // 'wx'：已存在就失败。两个进程同时首次启动时，
        // 后到的那个不该把先到的密钥覆盖掉 —— 覆盖会让先启动的那个进程
        // 手里的密钥和磁盘上的对不上，之后拿公钥验签名就会莫名其妙失败。
        fs.writeFileSync(keyPath, pem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (e) {
        if (e.code === 'EEXIST') {
            // 有人抢先建好了，用他那把
            const raced = readKey(keyPath, log);
            if (raced) return { ...raced, path: keyPath, created: false };
        }
        throw e;
    }

    // Windows 上 mode 基本被忽略（ACL 说了算），只有 POSIX 需要也值得较这个真
    if (process.platform !== 'win32') {
        try { fs.chmodSync(keyPath, 0o600); }
        catch (e) { log.warn('房间号密钥权限设置失败（不影响使用）: ' + e.message); }
    }

    log.debug('已生成房间号密钥 ' + keyPath);
    return {
        privateKey, publicKey, path: keyPath, created: true,
        fingerprint: fingerprintOf(publicKey),
    };
}

function readKey(keyPath, log) {
    let pem;
    try {
        pem = fs.readFileSync(keyPath, 'utf8');
    } catch (e) {
        if (e.code !== 'ENOENT') {
            log.warn('房间号密钥读不出来，当作没有: ' + e.message);
        }
        return null;
    }

    let privateKey;
    try {
        privateKey = crypto.createPrivateKey(pem);
        // 光 createPrivateKey 成功还不够 —— 它可能只是块合法 PEM 但类型不对，
        // 那样要到真正签名的时候才炸。这里提前验一次，把失败挡在启动阶段。
        crypto.sign(null, Buffer.alloc(1), privateKey);
    } catch (e) {
        log.warn('房间号密钥损坏，已隔离 ' + keyPath + ': ' + e.message);
        try { fs.renameSync(keyPath, keyPath + '.corrupt-' + Date.now()); }
        catch (e2) { /* 尽力而为 */ }
        return null;
    }

    const publicKey = crypto.createPublicKey(privateKey);
    return { privateKey, publicKey, fingerprint: fingerprintOf(publicKey) };
}

/** 公钥指纹：给人看的一小段，用来在两边核对是不是同一把密钥 */
function fingerprintOf(publicKey) {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

module.exports = { loadOrCreateRoomKey, KEY_FILE };
