// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The embedding glue, observed from outside: the server is pointed at an
// in-process OpenAI-compatible /embeddings stub that records every request, so
// the tests can see how many calls a tool makes and with what. Covers the
// three things that glue is responsible for: sizing a new table's vector
// column from the embedder, embedding many rows in one request instead of one
// per row, and refusing a table whose vector width the embedder cannot match.
// Requires `npm run build` first (the pretest script handles that).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connect, IndexSpec } from "@infino-ai/infino";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
// The engine's smallest vector width.
const DIM = 16;

// A deterministic, text-dependent unit vector: identical texts embed
// identically, so a semantic search for a row's own text finds it.
function fakeVector(text) {
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) + i) % DIM] += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let dir;
let client;
let stub;
/** Every request body the stub has seen, in order. */
const requests = [];

before(async () => {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ path: req.url, body });
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      // Answer out of order on purpose: a correct client sorts by `index`.
      const data = inputs.map((text, index) => ({ index, embedding: fakeVector(text) })).reverse();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${stub.address().port}/v1`;

  dir = mkdtempSync(join(tmpdir(), "infino-mcp-embed-"));
  client = new Client({ name: "embed-batches", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...process.env,
        INFINO_MCP_URI: dir,
        INFINO_MCP_EMBED_PROVIDER: "openai",
        INFINO_MCP_EMBED_BASE_URL: baseUrl,
        INFINO_MCP_EMBED_MODEL: "stub",
      },
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client.close();
  await new Promise((r) => stub.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, body: res.content?.[0]?.text ? safeJson(res.content[0].text) : undefined };
};
const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

test("create_table with vector: true sizes the embedding column from the embedder", async () => {
  const { res, body } = await call("infino_create_table", {
    table: "memories",
    columns: { key: "utf8", body: "large_utf8" },
    vector: true,
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.deepEqual(body.indexes, { fts: ["body"], vector: ["embedding"] });
  const embedding = body.columns.find((c) => c.name === "embedding");
  assert.ok(embedding, "an embedding column was added");
  assert.match(embedding.type, new RegExp(`\\b${DIM}\\b`), `vector width is ${DIM}: ${embedding.type}`);
  // Learning the width cost one probe request, and nothing else.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/v1/embeddings");
});

test("add_documents embeds all rows in one request, not one per row", async () => {
  const seen = requests.length;
  const documents = Array.from({ length: 50 }, (_, i) => ({ key: `m${i}`, body: `memory number ${i}` }));
  const { res, body } = await call("infino_add_documents", { table: "memories", documents });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.equal(body.appended, 50);
  assert.equal(body.embedded, 50);
  const mine = requests.slice(seen);
  assert.equal(mine.length, 1, "one embeddings request for the whole batch");
  assert.deepEqual(mine[0].body.input, documents.map((d) => d.body));
  assert.equal(mine[0].body.model, "stub");
});

test("rows that arrive with a vector are not re-embedded", async () => {
  const seen = requests.length;
  const { res, body } = await call("infino_add_documents", {
    table: "memories",
    documents: [
      { key: "pre", body: "already embedded", embedding: fakeVector("already embedded") },
      { key: "new", body: "needs a vector" },
    ],
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.equal(body.embedded, 1);
  assert.deepEqual(requests.slice(seen)[0].body.input, ["needs a vector"]);
});

test("semantic_search embeds the query and finds the row with the same text", async () => {
  const { res, body } = await call("infino_semantic_search", {
    table: "memories",
    query: "memory number 7",
    k: 1,
  });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.equal(body.results[0].body, "memory number 7");
});

test("hybrid_search passes mode through to the keyword half", async () => {
  // "memory number 7" appears in exactly one row, so `and` should narrow the
  // keyword half to it; `or` matches every row on "memory" / "number".
  const run = async (mode) =>
    (await call("infino_hybrid_search", { table: "memories", query: "memory number 7", k: 5, mode })).body;
  const anded = await run("and");
  assert.equal(anded.results[0].body, "memory number 7");
  const ored = await run("or");
  assert.ok(ored.results.length >= anded.results.length);
});

test("a table whose vector width the embedder cannot match is refused with both numbers", async () => {
  // Built directly with the binding, as if someone else ingested it with a
  // wider model.
  const db = connect(dir);
  db.createTable(
    "foreign",
    { body: "large_utf8", embedding: { vector: 32 } },
    new IndexSpec().fts("body").vector("embedding", 32, "cosine"),
  );
  const { res } = await call("infino_add_documents", {
    table: "foreign",
    documents: [{ body: "hello" }],
  });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /16/);
  assert.match(res.content[0].text, /32/);
  assert.match(res.content[0].text, /INFINO_MCP_EMBED_MODEL/);
});
