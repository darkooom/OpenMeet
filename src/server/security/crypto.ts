/**
 * Cryptographic helpers based exclusively on WebCrypto (available in Workers).
 */
import { base64url, base64urlDecode } from "../lib/ids";

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(new Uint8Array(digest));
}

export function toHex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// The Workers runtime caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so that user enumeration via timing is harder.
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    return false;
  }
  const [scheme, iter, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !iter || !saltB64 || !hashB64) return false;
  const computed = await pbkdf2(password, base64urlDecode(saltB64), Number(iter));
  return timingSafeEqualStr(base64url(computed), hashB64);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function deriveAesKey(secret: string, purpose: string): Promise<CryptoKey> {
  const cacheKey = `${purpose}:${secret}`;
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("openmeet/v1"), info: enc.encode(purpose) },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(cacheKey, p);
  }
  return p;
}

export function isStrongSecret(secret: string | undefined): secret is string {
  return !!secret && secret.length >= 32 && !/^0+$/.test(secret) && !secret.startsWith("change-me");
}

export function assertEncryptionKey(secret: string | undefined): string {
  if (!isStrongSecret(secret)) throw new Error("ENCRYPTION_KEY is missing or too weak (min. 32 characters).");
  return secret;
}

/** AES-256-GCM encryption. Output: v1.<iv>.<ciphertext> (base64url). */
export async function encryptString(secret: string | undefined, plaintext: string, purpose = "data"): Promise<string> {
  const key = await deriveAesKey(assertEncryptionKey(secret), purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ct))}`;
}

export async function decryptString(secret: string | undefined, payload: string, purpose = "data"): Promise<string> {
  const [v, ivB64, ctB64] = payload.split(".");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("Unsupported ciphertext");
  const key = await deriveAesKey(assertEncryptionKey(secret), purpose);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64urlDecode(ivB64) }, key, base64urlDecode(ctB64));
  return dec.decode(pt);
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(new Uint8Array(sig));
}

/** PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return base64url(new Uint8Array(digest));
}
