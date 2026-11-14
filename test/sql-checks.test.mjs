// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The checks infino_sql runs on an Infino Cloud connection: a query that
// searches a text column has its rows checked against its question, and on an
// account with the agent tools on, a statement that joins tables without a key
// the service found is refused with the keys. Unit-level over the join gate
// and the HTTPS client, and end to end: the built server spawned over stdio
// against a local stand-in for the service.
// Requires `npm run build` first (the pretest script handles that).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentApi, AgentApiError, searchedTextColumn, validationUnavailable } from "../dist/agent-api.js";
import { joinGate, joinsTables, withoutComments } from "../dist/join-gate.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

// --- the join gate, unit-level ----------------------------------------------

const KNOWN = ["visitors", "events", "accounts"];
const KEYS = [{ from_table: "events", to_table: "visitors", predicate: "events.visitor_id = visitors.id" }];
const keys = async () => KEYS;

test("a join on the key the service found runs, aliases and either order included", async () => {
  for (const sql of [
    "SELECT * FROM events JOIN visitors ON events.visitor_id = visitors.id",
    "SELECT * FROM events e JOIN visitors AS v ON v.id = e.visitor_id",
    "SELECT * FROM events e, visitors v WHERE e.visitor_id = v.id",
  ]) {
    assert.equal((await joinGate(sql, KNOWN, keys)).kind, "run", sql);
  }
});

test("a join on another pair of columns is refused with the keys", async () => {
  const verdict = await joinGate(
    "SELECT * FROM events e JOIN visitors v ON e.account = v.account",
    KNOWN,
    keys,
  );
  assert.equal(verdict.kind, "refuse");
  assert.deepEqual(verdict.tables, ["visitors", "events"]);
  assert.equal(verdict.keys[0].predicate, "events.visitor_id = visitors.id");
});

test("statements that join nothing run without asking for keys", async () => {
  let asked = 0;
  const counting = async () => (asked++, KEYS);
  for (const sql of [
    "SELECT count(*) FROM events",
    "SELECT count(*) FROM events UNION ALL SELECT count(*) FROM visitors",
    "SELECT (SELECT count(*) FROM events), (SELECT count(*) FROM visitors)",
    "SELECT * FROM events WHERE note = 'visitors joined'",
  ]) {
    assert.equal((await joinGate(sql, KNOWN, counting)).kind, "run", sql);
  }
  assert.equal(asked, 0);
});

test("a key written between subqueries and CTEs, each over one table, is the tables' key", async () => {
  // Each table grouped by its key in a subquery, then the two joined on it.
  const grouped =
    "SELECT v.id, v.n, e.events FROM (SELECT id, count(*) AS n FROM visitors GROUP BY id) v " +
    "LEFT JOIN (SELECT visitor_id, count(*) AS events FROM events GROUP BY visitor_id) e " +
    "ON e.visitor_id = v.id ORDER BY v.n DESC LIMIT 40";
  assert.equal((await joinGate(grouped, KNOWN, keys)).kind, "run");
  for (const sql of [
    "WITH v AS (SELECT id FROM visitors), e AS (SELECT visitor_id FROM events) SELECT count(*) FROM v JOIN e ON e.visitor_id = v.id",
    "WITH recent AS (SELECT * FROM events WHERE ts > 0) SELECT r.visitor_id FROM visitors s JOIN recent r ON r.visitor_id = s.id",
  ]) {
    assert.equal((await joinGate(sql, KNOWN, keys)).kind, "run", sql);
  }
  // On another pair of columns, the subqueries are refused as the tables are.
  const off = grouped.replace("ON e.visitor_id = v.id", "ON e.events = v.n");
  assert.equal((await joinGate(off, KNOWN, keys)).kind, "refuse");
});

test("a subquery over two tables stands for neither", async () => {
  // The join inside is held to the key on its own; an outer join on the
  // subquery's columns names no table the check can hold it to.
  const inner = "SELECT x.id FROM (SELECT v.id FROM visitors v JOIN events e ON e.visitor_id = v.id) x";
  assert.equal((await joinGate(inner, KNOWN, keys)).kind, "run");
  const innerOff = inner.replace("ON e.visitor_id = v.id", "ON e.account = v.account");
  assert.equal((await joinGate(innerOff, KNOWN, keys)).kind, "refuse");
});

test("a subquery over another table is a join", () => {
  assert.ok(joinsTables("SELECT * FROM events WHERE visitor_id IN (SELECT id FROM visitors)", KNOWN));
});

test("two tables with no key between them run as written", async () => {
  const verdict = await joinGate(
    "SELECT * FROM events JOIN accounts ON events.a = accounts.b",
    KNOWN,
    async () => [],
  );
  assert.equal(verdict.kind, "run");
});

test("a table named only in a comment is not in the statement", () => {
  assert.equal(
    withoutComments("SELECT 1 -- FROM visitors\nFROM events /* JOIN visitors */"),
    "SELECT 1 \nFROM events  ",
  );
  assert.equal(
    withoutComments("SELECT '--not a comment' FROM events"),
    "SELECT '--not a comment' FROM events",
  );
});

// --- the checked query, unit-level ------------------------------------------

test("the searched column is read off the first text search of a read", () => {
  assert.deepEqual(searchedTextColumn("SELECT * FROM bm25_search('docs', 'body', 'timeout', 10)"), {
    table: "docs",
    column: "body",
  });
  assert.deepEqual(
    searchedTextColumn(
      "WITH h AS (SELECT * FROM hybrid_search('docs','title','x','vec','0.1,0.2',5)) SELECT * FROM h",
    ),
    { table: "docs", column: "title" },
  );
  assert.equal(searchedTextColumn("SELECT * FROM vector_search('docs','vec','0.1,0.2',5)"), null);
  assert.equal(searchedTextColumn("SELECT count(*) FROM docs"), null);
  assert.equal(
    searchedTextColumn("DELETE FROM docs WHERE id IN (SELECT id FROM bm25_search('docs','body','x',5))"),
    null,
  );
});

test("a checked query posts the statement with its validation under the service's names", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ rows: [{ id: 1 }], validation: { valid: true, check: "anchors" } }));
  };
  const api = new AgentApi({ base: "https://svc", database: "logs" }, "inf_key", fetchImpl);
  const result = await api.querySqlValidated("SELECT 1", { table: "docs", column: "body", question: "q?" });
  assert.equal(calls[0].url, "https://svc/v1/query_sql/logs");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "SELECT 1",
    validate: { table_name: "docs", field_name: "body", question: "q?" },
  });
  assert.deepEqual(result, { rows: [{ id: 1 }], validation: { valid: true, check: "anchors" } });
});

test("only the deployment's own 'not available' reads as no check", () => {
  const unavailable = new AgentApiError(
    "query_sql",
    400,
    "query_sql validation is not available on this deployment; send the query without `validate`",
  );
  assert.ok(validationUnavailable(unavailable));
  assert.ok(
    !validationUnavailable(new AgentApiError("query_sql", 400, "GROUP BY over bm25_search with k 10")),
  );
  assert.ok(!validationUnavailable(new Error("validation is not available on this deployment")));
});

// --- the server, end to end -------------------------------------------------

/** A stand-in for the service: the features route answers `features`, the
 * binding's table listing two tables, join_keys one key, and query_sql the
 * checked envelope, or `sqlRefusal` as a 400 when given. */
async function standIn(features, sqlRefusal) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      const send = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/v1/account/features") return send(200, features);
      if (req.url === "/v1/list_tables/catalog") return send(200, ["events", "visitors"]);
      if (req.url === "/v1/join_keys/catalog") {
        return send(200, {
          joins: [
            { from_table: "events", to_table: "visitors", predicate: "events.visitor_id = visitors.id" },
          ],
        });
      }
      if (req.url === "/v1/query_sql/catalog") {
        if (sqlRefusal) return send(400, { error: sqlRefusal });
        return send(200, { rows: [{ path: "a.rs" }], validation: { valid: false, absent: ["frobnicate"] } });
      }
      send(404, { error: `no route ${req.url}` });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, server, uri: `http://127.0.0.1:${server.address().port}/catalog` };
}

async function serve(features, sqlRefusal) {
  const svc = await standIn(features, sqlRefusal);
  const client = new Client({ name: "sql-checks", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, INFINO_MCP_URI: svc.uri, INFINO_API_KEY: "inf_test" },
      stderr: "ignore",
    }),
  );
  after(async () => {
    await client.close();
    svc.server.close();
  });
  return { client, svc };
}

const SEARCH = "SELECT path FROM bm25_search('events', 'body', 'frobnicate', 10)";

test("a text search on Cloud comes back with its verdict, whatever the account's agent switch", async () => {
  for (const features of [{ agent_apis: false }, { agent_apis: true }]) {
    const { client, svc } = await serve(features);
    const result = await client.callTool({
      name: "infino_sql",
      arguments: { query: SEARCH, question: "who frobnicates?" },
    });
    assert.ok(!result.isError, result.content[0].text);
    const body = JSON.parse(result.content[0].text);
    assert.deepEqual(body.rows, [{ path: "a.rs" }]);
    assert.deepEqual(body.validation.absent, ["frobnicate"]);
    const sent = JSON.parse(svc.seen.find((r) => r.url === "/v1/query_sql/catalog").body);
    assert.deepEqual(sent.validate, {
      table_name: "events",
      field_name: "body",
      question: "who frobnicates?",
    });
  }
});

test("the service's refusal of a statement reaches the caller in its words", async () => {
  const { client } = await serve(
    { agent_apis: false },
    "GROUP BY over bm25_search with a k under 300 ranks a share",
  );
  const result = await client.callTool({ name: "infino_sql", arguments: { query: SEARCH } });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /ranks a share/);
});

test("on an account with the agent tools, a join off the key is refused with it", async () => {
  const { client, svc } = await serve({ agent_apis: true });
  const result = await client.callTool({
    name: "infino_sql",
    arguments: { query: "SELECT * FROM events e JOIN visitors v ON e.account = v.account" },
  });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /events\.visitor_id = visitors\.id/);
  assert.ok(!svc.seen.some((r) => r.url === "/v1/query_sql/catalog"), "the refused statement never ran");
});

test("without the agent tools, a join is not checked and the tool text does not mention it", async () => {
  const { client, svc } = await serve({ agent_apis: false });
  const sql = (await client.listTools()).tools.find((t) => t.name === "infino_sql");
  assert.doesNotMatch(sql.description, /infino_join_keys/);
  assert.match(sql.description, /validation/);
  await client.callTool({
    name: "infino_sql",
    arguments: { query: "SELECT * FROM events e JOIN visitors v ON e.account = v.account" },
  });
  assert.ok(!svc.seen.some((r) => r.url === "/v1/join_keys/catalog"));
});
