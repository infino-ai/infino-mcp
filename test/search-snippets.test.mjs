// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Search responses over the wire: hits carry the full text column unless the
// deployment sets INFINO_MCP_SNIPPET_CHARS or the call passes `snippetChars`,
// and every response says what its `score` means. Keyword search only, so no
// embedding model is involved; two servers boot against the same catalog, one
// with the deployment default set and one without. Requires `npm run build`
// first (the pretest script handles that).

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
let plain; // no deployment default: full text
let tuned; // INFINO_MCP_SNIPPET_CHARS=300

async function boot(extraEnv) {
  const client = new Client({ name: "snippet-check", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, INFINO_MCP_URI: dir, ...extraEnv },
      stderr: "ignore",
    }),
  );
  return client;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "infino-mcp-snippets-"));
  const db = connect(dir);
  const table = db.createTable("docs", { body: "large_utf8", path: "utf8" }, new IndexSpec().fts("body"));
  table.append([
    { body: LONG, path: "a/very/long/path/that/must/not/be/cut.txt" },
    { body: "needle short", path: "b.txt" },
  ]);
  plain = await boot({ INFINO_MCP_SNIPPET_CHARS: "" });
  tuned = await boot({ INFINO_MCP_SNIPPET_CHARS: "300" });
});

after(async () => {
  await plain.close();
  await tuned.close();
  rmSync(dir, { recursive: true, force: true });
});

const search = async (client, args) => {
  const res = await client.callTool({ name: "infino_keyword_search", arguments: { table: "docs", query: "needle", ...args } });
  assert.ok(!res.isError, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
};
const longHit = (body) => body.results.find((r) => r.body.startsWith("needle x"));

test("hits carry the full text column by default", async () => {
  const body = await search(plain, {});
  assert.equal(longHit(body).body, LONG);
});

test("a per-call snippetChars cuts the text column, ellipsis included", async () => {
  const body = await search(plain, { snippetChars: 300 });
  assert.equal(longHit(body).body.length, 301);
  assert.ok(longHit(body).body.endsWith("…"));
  assert.ok(body.results.find((r) => r.body === "needle short"), "values under the limit pass through unchanged");
});

test("INFINO_MCP_SNIPPET_CHARS sets the deployment default", async () => {
  const body = await search(tuned, {});
  assert.equal(longHit(body).body.length, 301);
});

test("a per-call value overrides the deployment default, and 0 means full", async () => {
  const wide = await search(tuned, { snippetChars: 1000 });
  assert.equal(longHit(wide).body.length, 1001);
  const full = await search(tuned, { snippetChars: 0 });
  assert.equal(longHit(full).body, LONG);
});

test("only the searched text column is cut; ids and other columns never are", async () => {
  const body = await search(tuned, { snippetChars: 8, columns: ["path", "body"] });
  const hit = body.results.find((r) => r.path.endsWith("cut.txt"));
  assert.ok(hit, "a path longer than the limit must survive intact");
  assert.equal(typeof hit._id, "string");
  assert.equal(hit.body.length, 9);
});

test("every search response states what its score means", async () => {
  const body = await search(plain, {});
  assert.match(body.score_kind, /higher is better/);
  assert.equal(typeof body.results[0].score, "number");
});
