/* =========================================================================
 * Ed25519 密钥与签名（WebCrypto）
 * 职责：生成密钥对、原始密钥与 base64 互转、签名、验签、能力检测。
 * 仅使用浏览器/Node 提供的 WebCrypto（不支持时导出流程会提示升级浏览器）。
 * ======================================================================= */

export const KEY_ALG = 'Ed25519';

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 异步能力检测：能否生成 Ed25519 密钥。 */
export async function isEd25519Supported() {
  try {
    if (!(globalThis.crypto && globalThis.crypto.subtle)) return false;
    await globalThis.crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
    return true;
  } catch (_) {
    return false;
  }
}

/** 生成 Ed25519 密钥对，返回可 JSON 序列化的 { private, public }（均为标准 base64）。
 *  private 为 PKCS#8 DER（浏览器 WebCrypto 不保证 Ed25519 私钥可 raw 导出），
 *  public 为 raw 32 字节。 */
export async function generateKeyPair() {
  const pair = await globalThis.crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
  const priv = await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const pub = await globalThis.crypto.subtle.exportKey('raw', pair.publicKey);
  return { private: bytesToBase64(new Uint8Array(priv)), public: bytesToBase64(new Uint8Array(pub)) };
}

export async function importPrivateKey(privateB64) {
  const raw = base64ToBytes(privateB64);
  return globalThis.crypto.subtle.importKey('pkcs8', raw, KEY_ALG, false, ['sign']);
}

export async function importPublicKey(publicB64) {
  const raw = base64ToBytes(publicB64);
  return globalThis.crypto.subtle.importKey('raw', raw, KEY_ALG, false, ['verify']);
}

/** 用 base64 私钥对 data（BufferSource）签名，返回 64 字节 Uint8Array。 */
export async function signData(privateB64, data) {
  const key = await importPrivateKey(privateB64);
  const sig = await globalThis.crypto.subtle.sign(KEY_ALG, key, data);
  return new Uint8Array(sig);
}

/** 用 base64 公钥验证签名，返回 boolean。 */
export async function verifyData(publicB64, data, signature) {
  try {
    const key = await importPublicKey(publicB64);
    return await globalThis.crypto.subtle.verify(KEY_ALG, key, signature, data);
  } catch (_) {
    return false;
  }
}