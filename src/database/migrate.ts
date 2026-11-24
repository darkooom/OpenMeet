/**
 * Runtime migrator – a safety net next to `wrangler d1 migrations apply`.
 *
 * It uses the same bookkeeping table as Wrangler (`d1_migrations`), so both
 * mechanisms are interchangeable: migrations applied by Wrangler during
 * deployment are skipped here, and migrations applied here are skipped by
 * Wrangler. Each migration runs inside one D1 batch (= one transaction)
 * together with its bookkeeping row, so concurrent isolates cannot apply a
 * migration twice (the UNIQUE name makes the second batch roll back).
 */
import m0001 from "../../migrations/0001_initial.sql";

export const MIGRATIONS: { name: string; sql: string }[] = [{ name: "0001_initial.sql", sql: m0001 }];

let migrated: Promise<void> | null = null;

export function ensureMigrated(db: D1Database): Promise<void> {
  if (!migrated) {
    migrated = runMigrations(db).then(
      () => undefined,
      (err: unknown) => {
        migrated = null;
        throw err;
      },
    );
  }
  return migrated;
}

export function splitStatements(sql: string): string[] {
  return sql
    .split(/^-->\s*statement-breakpoint\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

export async function runMigrations(db: D1Database): Promise<string[]> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    )
    .run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));
  const newlyApplied: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const statements = splitStatements(m.sql).map((s) => db.prepare(s));
    statements.push(db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name));
    try {
      await db.batch(statements);
      newlyApplied.push(m.name);
    } catch (err) {
      // Another isolate may have applied it concurrently.
      const row = await db.prepare("SELECT 1 AS ok FROM d1_migrations WHERE name = ?").bind(m.name).first();
      if (!row) throw err;
    }
  }
  return newlyApplied;
}
