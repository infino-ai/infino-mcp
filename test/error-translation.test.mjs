// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The messages an agent gets back when the engine or the hosted service
// refuses a call. Each one has to say what to do next, because with writes
// always on the agent is the one acting on it. Unit-level over the exported
// helpers, with the errors the binding actually throws: a hosted failure
// carries the HTTP status as `status`, except 401/403 which the transport
// folds into one message with no status. Requires `npm run build` first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { errText, guardSql } from "../dist/guards.js";

const hosted = (status, message = `op: server returned ${status}: body`) =>
  Object.assign(new Error(message), { status });

test("a rejected or read-only key says to mint a write-capable key", () => {
  assert.match(errText(hosted(403), { op: "write" }), /write capability/);
  // The transport's own wording for both 401 and 403, status lost.
  assert.match(
    errText(new Error("append: unauthorized (check the API key): forbidden"), { op: "write" }),
    /rejected or lacks write capability/,
  );
});

test("an oversized batch names the cap and says to send fewer rows", () => {
  const msg = errText(hosted(413), { op: "write" });
  assert.match(msg, /128 MiB/);
  assert.match(msg, /fewer documents/);
});

test("409 on a create is 'already exists'; 409 on a write is a lost commit race to reissue", () => {
  assert.match(errText(hosted(409), { op: "create" }), /already exists/);
  const write = errText(hosted(409), { op: "write" });
  assert.match(write, /commit race/);
  assert.match(write, /nothing was written/);
  assert.match(write, /reissue/);
});

test("404 on a hosted connection points at infino_create_database", () => {
  assert.match(errText(hosted(404), { hosted: true }), /infino_create_database/);
  assert.doesNotMatch(errText(hosted(404), { hosted: false }), /infino_create_database/);
});

test("503 is transient and says to retry", () => {
  assert.match(errText(hosted(503)), /retry/);
});

test("a missing index is explained in terms of the table, not the engine", () => {
  assert.match(errText(new Error('KV metadata key "inf.fts.body" not found')), /no full-text index/);
  assert.match(errText(new Error('KV metadata key "inf.vec.embedding" not found')), /no vector index/);
});

test("anything else passes through unchanged", () => {
  assert.equal(errText(new Error("something specific")), "something specific");
});

test("guardSql allows any single statement and strips one trailing semicolon", () => {
  assert.equal(guardSql("DELETE FROM t WHERE k = 'a';"), "DELETE FROM t WHERE k = 'a'");
  assert.equal(guardSql("  SELECT 1  "), "SELECT 1");
});

test("guardSql rejects more than one statement", () => {
  assert.throws(() => guardSql("SELECT 1; SELECT 2"), /single statement/);
});
