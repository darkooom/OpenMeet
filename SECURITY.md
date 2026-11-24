# Security

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the repository) instead of public issues. Include steps to reproduce and the affected version. We aim to respond within 7 days.

## Security model

| Area | Measure |
| --- | --- |
| Instance takeover | First-run wizard requires the `SETUP_TOKEN` secret (constant-time compare, sent in the body only, never logged, 10 attempts/15 min/IP). Completion is atomic (PK-protected insert in the same transaction as the admin account) and permanent. |
| Passwords | PBKDF2-SHA256 (100,000 iterations – the Workers runtime maximum), 128-bit salt, min. 10 chars with letters + digits. Login rate limits per IP and per account; identical errors for unknown accounts. |
| Sessions | 256-bit random tokens, only SHA-256 hashes stored, `HttpOnly; Secure; SameSite=Lax`, `__Host-` prefix on HTTPS, 30 days sliding, server-side revocation (logout, "sign out other sessions", password change/reset, account disable). |
| CSRF | Cookie-authenticated mutations require same-origin (`Origin` / `Sec-Fetch-Site`) **and** the custom header `X-OpenMeet-CSRF` (cannot be sent cross-site without a CORS preflight, which is never granted). |
| XSS | React escaping; e-mail templates escape all values; strict CSP (`script-src 'self'`, no inline scripts; `style-src 'unsafe-inline'` is needed for React style attributes). Dashboard pages send `frame-ancestors 'none'`; only public booking pages may be framed (embed). |
| SQL injection | Drizzle query builder / bound parameters only. The few dynamic table names in the admin area come from a fixed allow-list. |
| Tenant isolation / IDOR | All resource access goes through `services/permissions.ts`; foreign IDs return 404. Integration tests cover cross-tenant reads, writes and deletes. |
| API keys | `om_live_…` / `om_svc_…`, 192-bit random, SHA-256 hashed, scoped, expiring, revocable, `last_used_at`. Rate limit 600 req/min/key. |
| AI agents | Service tokens with the `agent` scope use the same permission checks as users; every agent call is audit-logged. |
| Secrets at rest | OAuth access/refresh tokens, CalDAV passwords, provider API keys, webhook secrets and manage-link tokens are AES-256-GCM encrypted with keys derived (HKDF, per purpose) from `ENCRYPTION_KEY`. |
| OAuth | Authorization code + PKCE (S256), single-use server-side state (10 min), minimal scopes, redirect URIs built from the configured public URL. Existing accounts are only auto-linked for Google-verified e-mail addresses. Connection callbacks must be completed by the same signed-in user. |
| SSRF | Webhooks, workflow HTTP/Slack/Teams steps, ICS feeds and CalDAV URLs: HTTPS only, default port, no credentials in URLs, private/reserved IPs and internal hostnames blocked, redirects never followed, 10 s timeout, response size bounded. |
| Webhook authenticity | `X-OpenMeet-Signature: t=<ts>,v1=<HMAC-SHA256(secret, "t.body")>`; receivers should reject timestamps older than 5 minutes. |
| Rate limiting | Fixed-window counters in D1 (atomic UPSERT) on login, registration, password reset, setup, OAuth start, public booking endpoints and API keys. IPs are hashed. |
| Host validation | Optional `ALLOWED_HOSTS` allow-list; links in e-mails use the configured public URL. |
| Logging | Errors are passed through a redactor (bearer tokens, API keys, sensitive JSON keys). Audit log for security-relevant actions; metadata is redacted. |
| Privacy | Data export (JSON) and account deletion for every user; configurable retention (attendee data anonymised after N days); analytics are aggregated counters without cookies or visitor IDs. |
| CSV export | Formula injection neutralised. |

## OWASP Top 10 (2021) review

| Risk | Status |
| --- | --- |
| A01 Broken access control | Centralised permission helpers, 404 on foreign IDs, role checks, tests for tenant isolation. |
| A02 Cryptographic failures | AES-GCM + HKDF, PBKDF2, hashed tokens/keys, HTTPS-only cookies. |
| A03 Injection | Parameterised SQL, escaped HTML, CSV injection guard. |
| A04 Insecure design | Atomic booking via DB triggers; setup token; idempotency; least-privilege scopes. |
| A05 Security misconfiguration | Secure headers on all API responses, CSP via `_headers`, weak secrets rejected. |
| A06 Vulnerable components | `npm audit` in CI (0 known production vulnerabilities at release). |
| A07 Identification & authentication failures | Rate limits, session revocation, no default credentials. **No 2FA yet** (see PROGRESS.md). |
| A08 Software & data integrity | Signed webhooks; lockfile; CI. |
| A09 Logging & monitoring failures | Audit, e-mail, webhook and job logs in the admin area; Workers observability enabled. |
| A10 SSRF | See SSRF row above; unit-tested. |

This review is an engineering self-assessment, not a third-party audit. OpenMeet provides features that support GDPR processes (export, deletion, retention, minimal tracking) but makes no claim of legal compliance – operators remain responsible for their deployment (e.g. data processing agreements with e-mail providers).
