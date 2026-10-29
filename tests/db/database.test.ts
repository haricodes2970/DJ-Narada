import assert from "node:assert/strict";
import test from "node:test";

import {
  appliedMigrations,
  closeDatabase,
  currentSchemaVersion,
  migrate,
  openDatabase,
} from "../../src/db/database.js";

test("openDatabase applies the current schema and records its version", async () => {
  const db = await openDatabase(":memory:");
  try {
    assert.equal(currentSchemaVersion(db), 2);
    assert.deepEqual(appliedMigrations(db).map((migration) => migration.version), [1, 2]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String((row as Record<string, unknown>).name));
    for (const table of ["tracks", "artists", "track_artists", "scan_runs", "play_events", "schema_migrations"]) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
  } finally {
    closeDatabase(db);
  }
});

test("migrate is idempotent", async () => {
  const db = await openDatabase(":memory:");
  try {
    assert.deepEqual(migrate(db), []);
    assert.equal(currentSchemaVersion(db), 2);
  } finally {
    closeDatabase(db);
  }
});

test("a failing migration rolls back without advancing the version", async () => {
  const db = await openDatabase(":memory:");
  try {
    assert.throws(() =>
      migrate(db, [{ version: 3, name: "broken", up: "CREATE TABLE broken (" }]),
    );
    assert.equal(currentSchemaVersion(db), 2);
    assert.deepEqual(appliedMigrations(db).map((migration) => migration.version), [1, 2]);
    const broken = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broken'")
      .get();
    assert.equal(broken, undefined);
  } finally {
    closeDatabase(db);
  }
});
