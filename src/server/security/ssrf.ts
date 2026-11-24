/**
 * Outbound request guard for user-configured URLs (webhooks, workflow HTTP
 * actions, Slack/Teams webhooks, ICS feeds). Workers cannot reach the private
 * network of a host, but we still refuse internal-looking targets, non-HTTPS
 * URLs, credentials in URLs and non-default ports, and we never follow
 * redirects automatically (a redirect could point to an internal target).
 */
const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.home\.arpa$/i, /\.lan$/i];

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:") || h.startsWith("64:ff9b");
}

export function assertSafeOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  if (url.port && url.port !== "443") throw new Error("Only the default HTTPS port is allowed");
  const host = url.hostname;
  if (BLOCKED_HOSTNAMES.some((r) => r.test(host))) throw new Error("Internal hostnames are not allowed");
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) throw new Error("Private or reserved IP addresses are not allowed");
  if (/^\d+$/.test(host) || /^0x/i.test(host)) throw new Error("Numeric hostnames are not allowed");
  if (!host.includes(".") && !host.includes(":")) throw new Error("Hostname must be fully qualified");
  return url;
}

export interface SafeFetchResult {
  status: number;
  body: string;
  durationMs: number;
}

/** fetch() for user-provided URLs: guarded, no redirects, timeout, bounded response. */
export async function safeFetch(raw: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<SafeFetchResult> {
  const url = assertSafeOutboundUrl(raw);
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url.toString(), { ...init, redirect: "manual", signal: controller.signal });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 2000), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
