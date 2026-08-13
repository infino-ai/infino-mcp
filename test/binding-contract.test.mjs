// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Behavioral contract with @infino-ai/infino: exercises every engine call the
// server makes (src/index.ts), against a real embedded catalog in a temp
// directory. tsc already catches API-shape breaks in an engine upgrade; this
// catches the behavior breaks that compile clean — a search that stops
// returning `score`, an append that stops persisting, a mutation that stops
// reporting counts. Vectors are supplied by hand, so no embedding model is
// involved.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, IndexSpec } from "@infino-ai/infino";

// The engine accepts vector dims in [16, 4096]; use the smallest.
const DIM = 16;
const TABLE = "smoke";

// The i-th basis vector: orthogonal to the others, so nearest-neighbor
// results are unambiguous.
const unit = (i) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

const ROWS = [
  { content: "alpha bravo charlie", tag: "keep", embedding: unit(0) },
  { content: "delta echo foxtrot", tag: "beta", embedding: unit(1) },
  { content: "alpha zulu", tag: "gamma", embedding: unit(2) },
];

let dir;
let db;
let table;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "infino-mcp-smoke-"));
  db = connect(dir);
  table = db.createTable(
    TABLE,
    { content: "large_utf8", tag: "utf8", embedding: { vector: DIM } },
    new IndexSpec().fts("content").vector("embedding", DIM, "cosine"),
  );
  table.append(ROWS);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("listTables and openTable see the created table", () => {
  assert.ok(db.listTables().includes(TABLE));
  assert.ok(db.openTable(TABLE));
});

// The server infers which column to search from the schema: the first field
// whose type mentions utf8 is the text column, the first list-typed field is
// the vector column (inferTextColumn / inferVectorColumn in src/index.ts).
test("schema exposes fields the column inference relies on", () => {
  const fields = table.schema().fields;
  const textField = fields.find((f) => String(f.type).toLowerCase().includes("utf8"));
  const vecField = fields.find((f) => String(f.type).toLowerCase().includes("list"));
  assert.equal(textField?.name, "content");
  assert.equal(vecField?.name, "embedding");
});

test("bm25Search ranks matches and carries _id and score", () => {
  const hits = table.bm25Search("content", "alpha", 10, {
    projection: ["content", "_id", "score"],
  });
  assert.equal(hits.length, 2);
  for (const hit of hits) {
    assert.ok("content" in hit);
    assert.ok("_id" in hit);
    assert.equal(typeof hit.score, "number");
  }
});

test("vectorSearch returns nearest neighbors", () => {
  const hits = table.vectorSearch("embedding", unit(0), 2, {
    projection: ["content", "_id", "score"],
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].content, "alpha bravo charlie");
});

test("vectorSearch filter pre-restricts the kNN candidates", () => {
  const hits = table.vectorSearch("embedding", unit(0), 3, {
    projection: ["content", "_id", "score"],
    filter: { column: "content", query: "zulu" },
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, "alpha zulu");
});

test("hybridSearch fuses keyword and vector rankings", () => {
  // "zulu" appears in exactly one document, and unit(2) is exactly that
  // document's vector — both halves rank it first, so the fused top hit is
  // deterministic. (A query matching several near-equal documents can tie in
  // the fusion, and tie-break order is not part of the contract.)
  const hits = table.hybridSearch("content", "zulu", "embedding", unit(2), 3, {
    projection: ["content", "_id", "score"],
  });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].content, "alpha zulu");
  assert.equal(typeof hits[0].score, "number");
});

test("tokenMatch honors or/and modes", () => {
  const anyTerm = table.tokenMatch("content", "alpha", { projection: ["content", "_id"] });
  assert.equal(anyTerm.length, 2);
  const allTerms = table.tokenMatch("content", "alpha zulu", {
    mode: "and",
    projection: ["content", "_id"],
  });
  assert.equal(allTerms.length, 1);
  assert.equal(allTerms[0].content, "alpha zulu");
});

test("exactMatch returns only exact-equality rows", () => {
  const hits = table.exactMatch("content", "alpha zulu", { projection: ["content", "_id"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, "alpha zulu");
});

test("count tallies keyword matches without fetching rows", () => {
  assert.equal(table.count("content", "alpha"), 2);
});

test("querySql answers plain SQL over the catalog", () => {
  const rows = db.querySql(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].n), ROWS.length);
});

// infino_sql advertises the search table functions; make sure the composed
// form the tool description documents keeps working.
test("querySql composes with the bm25_search table function", () => {
  const rows = db.querySql(
    `SELECT content, score FROM bm25_search('${TABLE}', 'content', 'alpha', 10)`,
  );
  assert.equal(rows.length, 2);
  assert.equal(typeof rows[0].score, "number");
});

test("update replaces matched rows 1:1 and reports stats", () => {
  const stats = table.update("tag = 'beta'", [
    { content: "delta echo foxtrot updated", tag: "beta", embedding: unit(1) },
  ]);
  assert.equal(stats.matched, 1);
  const hits = table.tokenMatch("content", "updated", { projection: ["content", "_id"] });
  assert.equal(hits.length, 1);
});

test("delete removes matched rows and reports stats", () => {
  const stats = table.delete("tag = 'gamma'");
  assert.equal(stats.matched, 1);
  const rows = db.querySql(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  assert.equal(Number(rows[0].n), ROWS.length - 1);
});
