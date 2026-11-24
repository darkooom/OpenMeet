# Deploying OpenMeet

## Requirements

- A Cloudflare account (the free plan is enough for small teams: Workers, D1, Cron Triggers)
- A GitHub or GitLab account (for the Deploy button / Workers Builds)
- Two secrets you generate yourself:

| Secret | How to generate | Purpose |
| --- | --- | --- |
| `SETUP_TOKEN` | `openssl rand -hex 24` | Proves you own the instance in the first-run wizard. Not needed after setup (you may delete it). |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | AES-256-GCM root key for OAuth tokens, provider API keys and manage-link tokens. **Do not change or lose it.** |

Optional variables (`wrangler.jsonc → vars`): `PUBLIC_BASE_URL` (normally set in the wizard instead), `ALLOWED_HOSTS` (comma separated hostnames – enables strict Host validation), `APP_VERSION`.

## Option A – Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/darkooom/OpenMeet)

What happens (per Cloudflare's [Deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)):

1. The repository is cloned into your Git account.
2. You choose names for the Worker and the D1 database (defaults: `openmeet`).
3. Cloudflare reads `wrangler.jsonc`, **provisions the D1 database** and binds it as `DB`. No database ID is committed in this repository – the provisioned ID is written into your copy.
4. You are prompted for the secrets listed in `.dev.vars.example` (`SETUP_TOKEN`, `ENCRYPTION_KEY`); their descriptions come from `package.json → cloudflare.bindings`.
5. Workers Builds runs `npm ci`, `npm run build` (Vite → `dist/client`) and `npm run deploy` (`scripts/deploy.mjs`: `wrangler d1 migrations apply DB --remote` + `wrangler deploy`).
6. You get a `https://openmeet.<your-subdomain>.workers.dev` URL. Open it – the setup wizard starts.

Because the button creates a Workers Builds project connected to your repository copy, **every push to `main` deploys automatically**.

## Option B – Wrangler CLI

```bash
npm ci
npx wrangler login
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put ENCRYPTION_KEY
npm run build
npm run deploy
```

On a first manual deploy the database does not exist yet; `wrangler deploy` provisions it (automatic resource provisioning) and the deploy script then applies the migrations. If that step is skipped for any reason, the Worker's runtime migrator applies them on the first request (same `d1_migrations` table as Wrangler, so nothing runs twice).

## Option C – Workers Builds (Git integration) for an existing Worker

Cloudflare dashboard → Workers & Pages → your Worker → Settings → Builds → Connect repository.

- Build command: `npm run build`
- Deploy command: `npm run deploy`
- Root directory: `/`
- Production branch: `main`

Add `SETUP_TOKEN` / `ENCRYPTION_KEY` under Settings → Variables and Secrets (type *Secret*).

## Migrations

- Location: `migrations/NNNN_name.sql`, statements separated by `--> statement-breakpoint` (needed for triggers in the runtime migrator; Wrangler ignores the comment).
- Apply locally: `npm run db:migrate:local`; remotely: `npm run db:migrate:remote` (also part of `npm run deploy`).
- Migrations are idempotent (`IF NOT EXISTS`) and recorded in `d1_migrations`; repeated deployments are safe.
- New migration: add `migrations/0002_xyz.sql` **and** register it in `src/database/migrate.ts`, mirror changes in `src/database/schema.ts` – the schema test fails otherwise.

## Custom domain

Example: `meet.example.com` (for instance `meet.oava.cloud`).

1. The zone (`example.com`) must be on Cloudflare.
2. Worker → Settings → Domains & Routes → **Add → Custom domain** → `meet.example.com`. Cloudflare creates DNS and the certificate (HTTPS only).
3. OpenMeet → Administration → Configuration → **Public URL** = `https://meet.example.com` (used in e-mails, ICS files, OAuth callbacks).
4. Optional hardening: set `ALLOWED_HOSTS` = `meet.example.com` (comma separated; add your `*.workers.dev` hostname if it should keep working). Requests with other Host headers are rejected.
5. Update the OAuth redirect URIs at Google/Microsoft/Zoom to `https://meet.example.com/auth/oauth/<provider>/callback`.
6. Embed snippets now use `https://meet.example.com/embed.js`.

Cookies are `Secure`, `HttpOnly`, `SameSite=Lax` and use the `__Host-` prefix on HTTPS.

## Post-install checklist

- [ ] Wizard completed (it locks itself – `/api/setup/*` returns 410 afterwards)
- [ ] Optional: delete the `SETUP_TOKEN` secret
- [ ] E-mail provider configured and "Send test e-mail" succeeded (Administration → Integrations)
- [ ] Google / Microsoft OAuth apps added if users should connect calendars
- [ ] Availability adjusted, event types reviewed
- [ ] Custom domain + Public URL (optional)
- [ ] Backups: see [docs/backup-restore.md](docs/backup-restore.md)

## Verification status

- `wrangler deploy --dry-run` validates the configuration and bundle in CI (`npm run check:deploy`).
- The deploy button flow itself requires the public repository `github.com/darkooom/OpenMeet` and a Cloudflare account; it has **not** been executed from this development environment (see PROGRESS.md → `[BLOCKED]`).
