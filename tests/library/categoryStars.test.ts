import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase, openDatabase } from "../../src/db/database.js";
import { CategoryStarRepository } from "../../src/library/categoryStars.js";

test("category stars persist and toggle", async () => {
  const db = await openDatabase(":memory:");
  try {
    const stars = new CategoryStarRepository(db);
    assert.deepEqual(stars.list(), []);
    assert.equal(stars.toggle("/music/SeedheMauth"), true);
    assert.deepEqual(stars.list(), ["/music/SeedheMauth"]);
    assert.equal(stars.isStarred("/music/SeedheMauth"), true);
    assert.equal(stars.toggle("/music/SeedheMauth"), false);
    assert.equal(stars.isStarred("/music/SeedheMauth"), false);
  } finally { closeDatabase(db); }
});
