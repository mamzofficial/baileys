/**
 * lib/Utils/curve25519-js.js — pure-JavaScript Curve25519 key exchange +
 * XEdDSA-style signing, with zero external/native/git dependencies.
 *
 * Why this exists: the primary `Curve` implementation in crypto.js depends
 * on the `libsignal` package, which is currently a `github:` dependency
 * (see package.json and vendor-libsignal.sh) — meaning it needs `git` to
 * install and, once installed, relies on that package's own native/JS
 * curve implementation. This file is a self-contained fallback that only
 * needs Node's built-in `crypto` module, so it keeps working even in
 * environments where `libsignal` fails to install or load.
 *
 * `generateKeyPairJS`/`sharedKeyJS` delegate to Node's own built-in,
 * standard X25519 support (`crypto.generateKeyPairSync('x25519')` /
 * `crypto.diffieHellman`) — not custom math, low risk. `signJS`/`verifyJS`
 * implement the XEdDSA scheme (sign/verify with a Curve25519 key, the same
 * scheme Signal/WhatsApp use for signed prekeys) using standard Edwards
 * curve arithmetic — publicly documented, not something invented here.
 *
 * This is NOT wired in as the default — see crypto.js's `CurveJS` export
 * and README.md → "Pure-JS Curve25519 fallback" for how to opt into it.
 * Verified via round-trip tests (sign→verify, and ECDH agreement matching
 * between two independently generated keypairs) in the test suite.
 */
import crypto from 'crypto';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function mod(a, m = P) {
    const r = a % m;
    return r >= 0n ? r : r + m;
}
function powmod(b, e, m) {
    b = mod(b, m);
    let r = 1n;
    while (e > 0n) {
        if (e & 1n)
            r = mod(r * b, m);
        b = mod(b * b, m);
        e >>= 1n;
    }
    return r;
}
function invert(a, m = P) {
    return powmod(a, m - 2n, m);
}
const D = mod(-121665n * invert(121666n));
const I = powmod(2n, (P - 1n) / 4n, P);
function pointAdd(p1, p2) {
    const [X1, Y1, Z1, T1] = p1;
    const [X2, Y2, Z2, T2] = p2;
    const A = mod((Y1 - X1) * (Y2 - X2));
    const Bb = mod((Y1 + X1) * (Y2 + X2));
    const C = mod(T1 * 2n * D * T2);
    const Dd = mod(Z1 * 2n * Z2);
    const E = Bb - A;
    const F = Dd - C;
    const G = Dd + C;
    const H = Bb + A;
    return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function pointDouble(p) {
    const [X1, Y1, Z1] = p;
    const A = mod(X1 * X1);
    const Bb = mod(Y1 * Y1);
    const C = mod(2n * Z1 * Z1);
    const H = A + Bb;
    const E = H - mod((X1 + Y1) * (X1 + Y1));
    const G = A - Bb;
    const F = C + G;
    return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function scalarMul(s, p) {
    let result = [0n, 1n, 1n, 0n];
    let addend = p;
    s = mod(s, L * 8n);
    if (s < 0n)
        s += L * 8n;
    while (s > 0n) {
        if (s & 1n)
            result = pointAdd(result, addend);
        addend = pointDouble(addend);
        s >>= 1n;
    }
    return result;
}
function negatePoint(p) {
    const [X, Y, Z, T] = p;
    return [mod(-X), Y, Z, mod(-T)];
}
function recoverX(y, sign) {
    const y2 = y * y;
    const u = mod(y2 - 1n);
    const v = mod(D * y2 + 1n);
    let x = mod(u * invert(v));
    x = powmod(x, (P + 3n) / 8n, P);
    if (mod(x * x - u * invert(v)) !== 0n) {
        x = mod(x * I);
    }
    if (mod(x * x - u * invert(v)) !== 0n) {
        throw new Error('invalid Edwards point (not on curve)');
    }
    if ((x & 1n) !== BigInt(sign)) {
        x = P - x;
    }
    return x;
}
const By = mod(4n * invert(5n));
const Bx = recoverX(By, 0n);
const BASE = [mod(Bx), mod(By), 1n, mod(mod(Bx) * mod(By))];
function bigIntToBytesLE(n, len) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}
function bytesToBigIntLE(buf) {
    let n = 0n;
    for (let i = buf.length - 1; i >= 0; i--) {
        n = (n << 8n) | BigInt(buf[i]);
    }
    return n;
}
function encodePoint(p) {
    const [X, Y, Z] = p;
    const zinv = invert(Z);
    const x = mod(X * zinv);
    const y = mod(Y * zinv);
    const bytes = bigIntToBytesLE(y, 32);
    if (x & 1n)
        bytes[31] |= 0x80;
    return bytes;
}
function decodePoint(buf) {
    const sign = buf[31] & 0x80 ? 1 : 0;
    const y = bytesToBigIntLE(buf) & ((1n << 255n) - 1n);
    const x = recoverX(y, BigInt(sign));
    return [x, y, 1n, mod(x * y)];
}
function sha512(...bufs) {
    const h = crypto.createHash('sha512');
    for (const b of bufs)
        h.update(b);
    return h.digest();
}
function hashI(i, ...bufs) {
    const padding = Buffer.alloc(32, 0xff);
    padding[0] = 0xff - i;
    const h = crypto.createHash('sha512');
    h.update(padding);
    for (const b of bufs)
        h.update(b);
    return h.digest();
}
function signBit(pointBytes) {
    return pointBytes[31] & 0x80 ? 1 : 0;
}
function montgomeryUToEdwardsY(uBuf) {
    const u = mod(bytesToBigIntLE(uBuf), P);
    return mod((u - 1n) * invert(mod(u + 1n, P)), P);
}
function encodeYWithSign(y, sign) {
    const yBytes = bigIntToBytesLE(y, 32);
    if (sign)
        yBytes[31] |= 0x80;
    return encodePoint(decodePoint(yBytes));
}
function stripKeyTypePrefix(buf) {
    return buf.length === 33 ? buf.subarray(1) : buf;
}
function calculateKeyPair(kBuf) {
    const k = bytesToBigIntLE(kBuf);
    const rawPoint = scalarMul(k, BASE);
    const rawEnc = encodePoint(rawPoint);
    let a;
    let A;
    if (signBit(rawEnc) === 1) {
        a = mod(-k, L);
        A = encodePoint(negatePoint(rawPoint));
    }
    else {
        a = mod(k, L);
        A = rawEnc;
    }
    return { a, A };
}

export function signJS(privateKey, message) {
    const Z = crypto.randomBytes(64);
    const { a, A } = calculateKeyPair(privateKey);
    const aBytes = bigIntToBytesLE(a, 32);
    const r = mod(bytesToBigIntLE(hashI(1, aBytes, message, Z)), L);
    const R = scalarMul(r, BASE);
    const REnc = encodePoint(R);
    const h = mod(bytesToBigIntLE(sha512(REnc, A, message)), L);
    const s = mod(r + h * a, L);
    return Buffer.concat([REnc, bigIntToBytesLE(s, 32)]);
}

export function verifyJS(pubKey, message, signature) {
    try {
        const u = stripKeyTypePrefix(pubKey);
        if (u.length !== 32 || signature.length !== 64)
            return false;
        const REnc = signature.subarray(0, 32);
        const s = bytesToBigIntLE(signature.subarray(32, 64));
        if (s >= L)
            return false;
        const A = encodeYWithSign(montgomeryUToEdwardsY(u), 0);
        const APoint = decodePoint(A);
        const h = mod(bytesToBigIntLE(sha512(REnc, A, message)), L);
        const sB = scalarMul(s, BASE);
        const hA = scalarMul(h, APoint);
        const RCheck = pointAdd(sB, negatePoint(hA));
        return encodePoint(RCheck).equals(REnc);
    }
    catch {
        return false;
    }
}

function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4)
        str += '=';
    return Buffer.from(str, 'base64');
}

export function generateKeyPairJS() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const priv = fromB64url(privateKey.export({ format: 'jwk' }).d);
    const pub = fromB64url(publicKey.export({ format: 'jwk' }).x);
    return { private: priv, public: pub };
}

function generateKeyPairJS_publicFrom(privateKeyRaw) {
    const k = bytesToBigIntLE(privateKeyRaw);
    const point = scalarMul(k, BASE);
    const [, Y, Z] = point;
    const y = mod(Y * invert(Z));
    const u = mod((1n + y) * invert(mod(1n - y)));
    return bigIntToBytesLE(u, 32);
}

export function sharedKeyJS(privateKey, publicKey) {
    const pub = stripKeyTypePrefix(publicKey);
    const privKey = crypto.createPrivateKey({
        key: { kty: 'OKP', crv: 'X25519', d: b64url(privateKey), x: b64url(generateKeyPairJS_publicFrom(privateKey)) },
        format: 'jwk'
    });
    const pubKey = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: b64url(pub) },
        format: 'jwk'
    });
    return crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
}
