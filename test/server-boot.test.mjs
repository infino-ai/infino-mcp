// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// End-to-end boot check: spawn the built server (dist/index.js) over stdio as
// a real MCP client would, and make one round-trip. Catches what the binding
// contract test can't — the server failing to start or wire its tools after
// an engine upgrade. The local embedder is lazy, so nothing here downloads a
// model. Requires `npm run build` first (the pretest script handles that).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let dir;
let client;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "infino-mcp-boot-"));
  client = new Client({ name: "boot-smoke", version: "0.0.0" });
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

// The full surface, always: one tool per binding operation, no write gate.
const ALL_TOOLS = [
  "infino_list_tables",
  "infino_describe_table",
  "infino_keyword_search",
  "infino_semantic_search",
  "infino_hybrid_search",
  "infino_token_match",
  "infino_exact_match",
  "infino_count",
  "infino_sql",
  "infino_create_database",
  "infino_create_table",
  "infino_drop_table",
  "infino_add_documents",
  "infino_update_documents",
  "infino_delete_documents",
];

test("server advertises the full toolset with no flag set", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of ALL_TOOLS) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

test("infino_list_tables answers over the wire", async () => {
  const res = await client.callTool({ name: "infino_list_tables", arguments: {} });
  assert.ok(!res.isError);
  const body = JSON.parse(res.content[0].text);
  assert.deepEqual(body.tables, []);
});

// Tool annotations are how a client decides what to confirm: the server has
// no write gate of its own, so every tool must say what it does.
test("tools carry read-only / destructive annotations", async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
  for (const name of [
    "infino_list_tables",
    "infino_describe_table",
    "infino_keyword_search",
    "infino_semantic_search",
    "infino_hybrid_search",
    "infino_token_match",
    "infino_exact_match",
    "infino_count",
  ]) {
    assert.equal(byName[name].readOnlyHint, true, `${name} should be read-only`);
  }
  for (const name of [
    "infino_sql",
    "infino_update_documents",
    "infino_delete_documents",
    "infino_drop_table",
  ]) {
    assert.equal(byName[name].readOnlyHint, false, `${name} should not be read-only`);
    assert.equal(byName[name].destructiveHint, true, `${name} should be destructive`);
  }
  for (const name of ["infino_add_documents", "infino_create_table", "infino_create_database"]) {
    assert.equal(byName[name].readOnlyHint, false, `${name} should not be read-only`);
    assert.equal(byName[name].destructiveHint, false, `${name} should not be destructive`);
  }
  assert.equal(byName.infino_create_database.idempotentHint, true);
});

// The retired INFINO_MCP_ENABLE_WRITES is accepted and ignored: the surface
// is identical, and stderr says the variable no longer does anything.
test("the retired writes flag changes nothing and is called out on stderr", async () => {
  const flagged = new Client({ name: "boot-smoke-flag", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, INFINO_MCP_URI: dir, INFINO_MCP_ENABLE_WRITES: "false" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => (stderr += chunk));
  await flagged.connect(transport);
  try {
    const { tools } = await flagged.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ALL_TOOLS) assert.ok(names.includes(expected), `missing tool: ${expected}`);
    assert.match(stderr, /INFINO_MCP_ENABLE_WRITES .*no longer read/);
  } finally {
    await flagged.close();
  }
});

// Catalog management over the wire, on an embedded catalog. The binding calls
// behind these are exercised end to end: create → describe → append → count →
// drop → list.
test("infino_create_database is a no-op success on a local catalog", async () => {
  const res = await client.callTool({ name: "infino_create_database", arguments: {} });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.deepEqual(JSON.parse(res.content[0].text), { created: true });
});

// The table convention the skill teaches: a `utf8` key column (matched by SQL
// predicate, never full-text indexed, so it is never mistaken for the text
// column) and `large_utf8` for text. With that shape the default FTS set and
// the searches' column inference both land on `body`.
test("infino_create_table builds the table with FTS on every large_utf8 column by default", async () => {
  const res = await client.callTool({
    name: "infino_create_table",
    arguments: { table: "notes", columns: { key: "utf8", body: "large_utf8", n: "int64" } },
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.table, "notes");
  assert.deepEqual(
    body.columns.map((c) => c.name),
    ["key", "body", "n"],
  );
  assert.deepEqual(body.indexes, { fts: ["body"], vector: [] });

  const described = JSON.parse(
    (await client.callTool({ name: "infino_describe_table", arguments: { table: "notes" } })).content[0].text,
  );
  assert.deepEqual(described.columns.map((c) => c.name), ["key", "body", "n"]);
  assert.match(described.columns[0].type, /^Utf8/i);
  assert.match(described.columns[1].type, /LargeUtf8/i);
  assert.match(described.columns[2].type, /Int64/i);
});

test("infino_create_table refuses an fts column that is not large_utf8", async () => {
  const res = await client.callTool({
    name: "infino_create_table",
    arguments: { table: "bad", columns: { tag: "utf8" }, fts: ["tag"] },
  });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /tag.*utf8.*large_utf8/);
});

test("infino_create_table on an existing table points at describe_table", async () => {
  const res = await client.callTool({
    name: "infino_create_table",
    arguments: { table: "notes", columns: { body: "large_utf8" } },
  });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /already exists.*infino_describe_table/);
});

test("infino_add_documents appends and the rows are searchable", async () => {
  const res = await client.callTool({
    name: "infino_add_documents",
    arguments: {
      table: "notes",
      documents: [
        { key: "a", body: "alpha bravo", n: 1 },
        { key: "b", body: "charlie delta", n: 2 },
      ],
    },
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.equal(JSON.parse(res.content[0].text).appended, 2);
  const count = JSON.parse(
    (await client.callTool({ name: "infino_count", arguments: { table: "notes", query: "alpha" } })).content[0]
      .text,
  );
  assert.equal(count.count, 1);
});

test("infino_add_documents names a key that is not a column instead of dropping it", async () => {
  const res = await client.callTool({
    name: "infino_add_documents",
    arguments: { table: "notes", documents: [{ key: "c", body: "echo", n: 3, bogus: "x" }] },
  });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /'bogus'.*not a column/);
});

// The binding's BM25 options the searches pass through: boolean `mode` and
// the `stats` scope.
// Tables created from a descriptor have no nullable columns, so a row that
// omits one fails inside Arrow; the server says which column, up front.
test("infino_add_documents names a column a row omits instead of surfacing an Arrow error", async () => {
  const res = await client.callTool({
    name: "infino_add_documents",
    arguments: { table: "notes", documents: [{ key: "d", body: "no n here" }] },
  });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /document 0.*missing.*'n'/);
  assert.doesNotMatch(res.content[0].text, /non-nullable/);
});

test("infino_keyword_search honours mode: and", async () => {
  const search = async (mode) =>
    JSON.parse(
      (
        await client.callTool({
          name: "infino_keyword_search",
          arguments: { table: "notes", query: "alpha delta", k: 10, mode },
        })
      ).content[0].text,
    ).results.length;
  assert.equal(await search("or"), 2);
  assert.equal(await search("and"), 0);
});

test("infino_keyword_search accepts stats: global", async () => {
  const res = await client.callTool({
    name: "infino_keyword_search",
    arguments: { table: "notes", query: "alpha", k: 10, stats: "global" },
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.equal(JSON.parse(res.content[0].text).results.length, 1);
});

test("infino_delete_documents removes the row a key predicate selects", async () => {
  const res = await client.callTool({
    name: "infino_delete_documents",
    arguments: { table: "notes", predicate: "key = 'a'" },
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  const stats = JSON.parse(res.content[0].text);
  assert.equal(stats.matched, 1);
  assert.equal(stats.nTombstoned, 1);
  const count = JSON.parse(
    (await client.callTool({ name: "infino_count", arguments: { table: "notes", query: "alpha" } })).content[0]
      .text,
  );
  assert.equal(count.count, 0);
});

test("infino_sql accepts a non-SELECT statement", async () => {
  const res = await client.callTool({
    name: "infino_sql",
    arguments: { query: "DELETE FROM notes WHERE key = 'zzz'" },
  });
  // Whatever the engine makes of DDL/DML, the server's guard no longer
  // rejects it up front with the read-only message.
  assert.doesNotMatch(res.content[0].text, /only read-only SELECT/);
});

// Same default as the binding and the hosted API: a drop reclaims storage
// unless the caller asks to keep the bytes.
test("infino_drop_table removes the table from the catalog and purges by default", async () => {
  const res = await client.callTool({ name: "infino_drop_table", arguments: { table: "notes" } });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.deepEqual(JSON.parse(res.content[0].text), { table: "notes", dropped: true, purged: true });
  const tables = JSON.parse(
    (await client.callTool({ name: "infino_list_tables", arguments: {} })).content[0].text,
  ).tables;
  assert.ok(!tables.includes("notes"));
});
