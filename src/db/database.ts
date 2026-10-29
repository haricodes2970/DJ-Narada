import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, type Migration } from "./migrations.js";

export type AppliedMigration = {
  version: number;
  name: string;
  appliedAt: string;
};

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  ensureMigrationTable(db);
  return db
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        version: Number(record.version),
        name: String(record.name),
        appliedAt: String(record.applied_at),
      };
    });
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const rows = appliedMigrations(db);
  return rows.length === 0 ? 0 : rows[rows.length - 1].version;
}

/**
 * Apply pending migrations in order, one transaction per migration.
 *
 * A failing migration is rolled back completely, including its
 * schema_migrations row, so the database never reports a half-applied version.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): number[] {
  ensureMigrationTable(db);
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) throw new Error(`Duplicate migration version ${migration.version}`);
    seen.add(migration.version);
  }

  const applied = new Set(appliedMigrations(db).map((migration) => migration.version));
  const pending = [...migrations].filter((migration) => !applied.has(migration.version)).sort((a, b) => a.version - b.version);
  const appliedNow: number[] = [];

  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        now().toISOString(),
      );
      db.exec("COMMIT");
      appliedNow.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const version = currentSchemaVersion(db);
  db.exec(`PRAGMA user_version = ${version}`);
  return appliedNow;
}

export async function openDatabase(filePath: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (filePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  migrate(db);
  return db;
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
