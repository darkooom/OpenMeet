const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|refresh|access|private|signature|credential)/i;

/** Deep-copies a value replacing values of sensitive-looking keys. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return "[depth]" as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out as T;
  }
  if (typeof value === "string") return redactString(value) as unknown as T;
  return value;
}

/** Removes bearer tokens and API keys that might appear inside free text (e.g. upstream errors). */
export function redactString(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/om_(live|svc)_[A-Za-z0-9_-]+/g, "om_$1_[redacted]")
    .replace(/(re_|xkeysib-)[A-Za-z0-9_-]{8,}/g, "$1[redacted]")
    .slice(0, 2000);
}
