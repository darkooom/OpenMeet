import { describe, expect, it } from "vitest";
import { assertSafeOutboundUrl } from "../../src/server/security/ssrf";
import { decryptString, encryptString, hashPassword, hmacSha256Hex, verifyPassword, timingSafeEqualStr } from "../../src/server/security/crypto";
import { redact, redactString } from "../../src/server/security/redact";
import { signPayload, verifySignature } from "../../src/server/services/webhooks";

const KEY = "k".repeat(64);

describe("SSRF guard", () => {
  it.each([
    "http://example.com/hook",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://[fd00::1]/x",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://intranet/x",
    "https://printer.local/x",
    "https://2130706433/",
    "ftp://example.com/",
  ])("rejects %s", (url) => {
    expect(() => assertSafeOutboundUrl(url)).toThrow();
  });
  it("accepts public https URLs", () => {
    expect(assertSafeOutboundUrl("https://hooks.slack.com/services/T000/B000/XXX").hostname).toBe("hooks.slack.com");
    expect(assertSafeOutboundUrl("https://example.com:443/a?b=c").pathname).toBe("/a");
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct-horse-42");
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword("correct-horse-42", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
  it("encrypts with AES-GCM and detects tampering", async () => {
    const ct = await encryptString(KEY, "refresh-token-value", "calendar");
    expect(ct).not.toContain("refresh-token-value");
    expect(await decryptString(KEY, ct, "calendar")).toBe("refresh-token-value");
    await expect(decryptString(KEY, ct, "other-purpose")).rejects.toThrow();
    const tampered = ct.slice(0, -2) + (ct.endsWith("A") ? "BB" : "AA");
    await expect(decryptString(KEY, tampered, "calendar")).rejects.toThrow();
  });
  it("refuses weak encryption keys", async () => {
    await expect(encryptString("short", "x")).rejects.toThrow(/ENCRYPTION_KEY/);
    await expect(encryptString("0".repeat(64), "x")).rejects.toThrow(/ENCRYPTION_KEY/);
  });
  it("compares in constant time", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
  it("produces stable HMACs", async () => {
    expect(await hmacSha256Hex("secret", "payload")).toBe("b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4");
  });
});

describe("webhook signatures", () => {
  it("verifies valid signatures and rejects tampered or stale ones", async () => {
    const body = JSON.stringify({ event: "booking.created" });
    const header = await signPayload("whsec_test", body);
    expect(await verifySignature("whsec_test", body, header)).toBe(true);
    expect(await verifySignature("whsec_test", body + " ", header)).toBe(false);
    expect(await verifySignature("whsec_other", body, header)).toBe(false);
    const old = await signPayload("whsec_test", body, Math.floor(Date.now() / 1000) - 3600);
    expect(await verifySignature("whsec_test", body, old)).toBe(false);
  });
});

describe("secret redaction", () => {
  it("redacts sensitive keys and inline tokens", () => {
    expect(redact({ email: "a@b.c", password: "x", nested: { apiKey: "y", ok: 1 } })).toEqual({ email: "a@b.c", password: "[redacted]", nested: { apiKey: "[redacted]", ok: 1 } });
    expect(redactString("failed: Bearer abc.def.ghi with om_live_ABCDEFGHIJKLMNOPQRSTUV")).toBe("failed: Bearer [redacted] with om_live_[redacted]");
  });
});
