# Backup and restore

All state lives in the D1 database (binding `DB`). Secrets live in Worker secrets – keep a copy of `ENCRYPTION_KEY` in your password manager: without it, stored OAuth tokens and provider keys cannot be decrypted (users would have to reconnect, data otherwise stays intact).

## 1. D1 Time Travel (built in)

D1 keeps a point-in-time history for 30 days.

```bash
npx wrangler d1 time-travel info openmeet            # current bookmark
npx wrangler d1 time-travel restore openmeet --timestamp 2026-11-24T10:00:00Z
```

Restoring replaces the current database state – take an export first.

## 2. SQL export (off-site backups)

```bash
npx wrangler d1 export openmeet --remote --output openmeet-$(date +%F).sql
```

Schedule it (e.g. a nightly GitHub Action with a scoped API token, or a cron job on a trusted machine) and store the dumps encrypted (they contain personal data).

Restore into a new or empty database:

```bash
npx wrangler d1 create openmeet-restore
npx wrangler d1 execute openmeet-restore --remote --file openmeet-2026-11-24.sql
# then point the DB binding in wrangler.jsonc to the restored database and deploy
```

## 3. JSON export (readable, without secrets)

Administration → System → **Download instance export** returns all tenant data as JSON (password hashes, tokens and encrypted credentials are omitted). It is meant for audits and migrations, not for a full restore. Every user can also export their own data under Settings → Privacy.

## Restore checklist

1. Same `ENCRYPTION_KEY` as before.
2. Run `npm run db:migrate:remote` if the backup is older than the current code (migrations are idempotent).
3. Check Administration → System (migrations, health) and Integrations (reconnect if tokens expired).
