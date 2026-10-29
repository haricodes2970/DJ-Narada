import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase, openDatabase } from "../../src/db/database.js";
import { TrackRepository } from "../../src/db/tracks.js";
import { addPlaylistTrack, createPlaylist, listPlaylistTracks, recordFeedback, recordPlayEvent } from "../../src/library/history.js";

test("history records play events and feedback", async () => {
  const db = await openDatabase(":memory:");
  try {
    new TrackRepository(db).upsert({ id: "a", path: "/music/a.mp3", title: "A", sizeBytes: 1 });
    const playId = recordPlayEvent(db, { trackId: "a", playedSeconds: 42, sessionId: "session-1" });
    assert.ok(playId > 0);
    const feedbackId = recordFeedback(db, { trackId: "a", kind: "like", value: 1, note: "great" });
    assert.ok(feedbackId > 0);
    const row = db.prepare("SELECT played_seconds, session_id FROM play_events WHERE id = ?").get(playId) as Record<string, unknown>;
    assert.equal(row.played_seconds, 42);
    assert.equal(row.session_id, "session-1");
    const feedback = db.prepare("SELECT kind, value, note FROM feedback WHERE id = ?").get(feedbackId) as Record<string, unknown>;
    assert.equal(feedback.kind, "like");
    assert.equal(feedback.value, 1);
    assert.equal(feedback.note, "great");
  } finally { closeDatabase(db); }
});

test("playlists preserve explicit ordering", async () => {
  const db = await openDatabase(":memory:");
  try {
    const repository = new TrackRepository(db);
    repository.upsert({ id: "a", path: "/music/a.mp3", title: "A", sizeBytes: 1 });
    repository.upsert({ id: "b", path: "/music/b.mp3", title: "B", sizeBytes: 1 });
    const playlistId = createPlaylist(db, "Night Drive");
    addPlaylistTrack(db, playlistId, "b");
    addPlaylistTrack(db, playlistId, "a");
    assert.deepEqual(listPlaylistTracks(db, playlistId).map((track) => track.id), ["b", "a"]);
  } finally { closeDatabase(db); }
});
