// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Search responses over the wire: hits carry a snippet of the text column by
// default (widened or disabled with `snippetChars`), and every response says
// what its `score` means. Keyword search only, so no embedding model is
// involved; the table is created in the catalog before the server boots.
// Requires `npm run build` first (the pretest script handles that).

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
  dir = mkdtempSync(join(tmpdir(), "infino-mcp-snippets-"));
  const db = connect(dir);
  const table = db.createTable("docs", { body: "large_utf8", path: "utf8" }, new IndexSpec().fts("body"));
  table.append([
    { body: LONG, path: "a/very/long/path/that/must/not/be/cut.txt" },
    { body: "needle short", path: "b.txt" },
  ]);

  client = new Client({ name: "snippet-check", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, INFINO_MCP_URI: dir },
    stderr: "ignore",
  });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

const search = async (args) => {
  const res = await client.callTool({ name: "infino_keyword_search", arguments: { table: "docs", query: "needle", ...args } });
  assert.ok(!res.isError, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
};

test("hits carry a 300-character snippet by default", async () => {
  const body = await search({});
  const long = body.results.find((r) => r.body.startsWith("needle x"));
  assert.ok(long, "the long row must match");
  assert.equal(long.body.length, 301, "300 chars plus the ellipsis");
  assert.ok(long.body.endsWith("…"));
  const short = body.results.find((r) => r.body === "needle short");
  assert.ok(short, "values under the limit pass through unchanged");
});

test("snippetChars widens the cut, and 0 disables it", async () => {
  const wide = await search({ snippetChars: 1000 });
  assert.equal(wide.results.find((r) => r.body.startsWith("needle x")).body.length, 1001);
  const full = await search({ snippetChars: 0 });
  assert.equal(full.results.find((r) => r.body.startsWith("needle x")).body, LONG);
});

test("non-text fields and ids are never cut", async () => {
  const body = await search({ snippetChars: 8, columns: ["path", "body"] });
  const hit = body.results.find((r) => r.path.endsWith("cut.txt"));
  assert.ok(hit, "path longer than the limit must survive intact");
  assert.equal(typeof hit._id, "string");
  assert.equal(hit.body.length, 9);
});

test("every search response states what its score means", async () => {
  const body = await search({});
  assert.match(body.score_kind, /higher is better/);
  assert.equal(typeof body.results[0].score, "number");
});
