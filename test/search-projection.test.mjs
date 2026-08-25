// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Search responses over the wire: `columns` is a projection handed to the
// engine, so hits carry exactly the requested columns with full values
// (plus _id and score), defaulting to the text column; and every response
// says what its `score` means. Keyword search only, so no embedding model is
// involved. Requires `npm run build` first (the pretest script handles that).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connect, IndexSpec } from "@infino-ai/infino";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const LONG = "needle " + "x".repeat(1200);

let dir;
let client;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "infino-mcp-projection-"));
  const db = connect(dir);
  const table = db.createTable(
    "docs",
    { body: "large_utf8", path: "utf8", year: "int32" },
    new IndexSpec().fts("body"),
  );
  table.append([
    { body: LONG, path: "a/long/document.txt", year: 2024 },
    { body: "needle short", path: "b.txt", year: 2025 },
  ]);
  client = new Client({ name: "projection-check", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, INFINO_MCP_URI: dir },
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

const search = async (args) => {
  const res = await client.callTool({
    name: "infino_keyword_search",
    arguments: { table: "docs", query: "needle", ...args },
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
};

test("hits carry the full text column by default, never truncated", async () => {
  const body = await search({});
  const hit = body.results.find((r) => r.body.startsWith("needle x"));
  assert.equal(hit.body, LONG);
  assert.deepEqual(Object.keys(hit).sort(), ["_id", "body", "score"]);
});

test("columns projects exactly the requested columns, with _id and score kept", async () => {
  const body = await search({ columns: ["path", "year"] });
  for (const hit of body.results) {
    assert.deepEqual(Object.keys(hit).sort(), ["_id", "path", "score", "year"]);
    assert.ok(!("body" in hit), "the text column must not come back unless projected");
  }
  const long = body.results.find((r) => r.path === "a/long/document.txt");
  assert.equal(long.year, 2024);
});

test("projecting the text column explicitly returns its full value", async () => {
  const body = await search({ columns: ["path", "body"] });
  const hit = body.results.find((r) => r.path === "a/long/document.txt");
  assert.equal(hit.body, LONG);
});

test("every search response states what its score means", async () => {
  const body = await search({});
  assert.match(body.score_kind, /higher is better/);
  assert.equal(typeof body.results[0].score, "number");
});
