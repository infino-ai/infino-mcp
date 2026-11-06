// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The agent tools offered on an Infino Cloud connection whose account has the
// agent routes on. Unit-level over the HTTPS client with a stand-in fetch, and
// end to end: the built server spawned over stdio against a local stand-in for
// the service, so the tool list is checked as a client sees it. The binding's
// own hosted transport is never reached here (nothing calls a binding tool).
// Requires `npm run build` first (the pretest script handles that).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentApi, AgentApiError, hostedEndpoint } from "../dist/agent-api.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const AGENT_TOOLS = ["infino_describe_columns", "infino_join_keys", "infino_ask"];

// --- the client, unit-level -------------------------------------------------

test("a hosted URI splits into the service base and the database", () => {
  assert.deepEqual(hostedEndpoint("https://api.example.com/logs"), {
    base: "https://api.example.com",
    database: "logs",
  });
  assert.deepEqual(hostedEndpoint("https://api.example.com/tenant-a/logs/"), {
    base: "https://api.example.com/tenant-a",
    database: "logs",
  });
  assert.equal(hostedEndpoint("https://api.example.com/"), null);
  assert.equal(hostedEndpoint("not a url"), null);
});

/** A fetch that records each call and answers with `status` and `body`. */
function recordingFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

const ENDPOINT = { base: "https://svc", database: "logs" };

test("the features check reads agent_apis, and a 404 reads as off", async () => {
  for (const [status, body, expected] of [
    [200, { agent_apis: true }, true],
    [200, { agent_apis: false }, false],
    [200, {}, false],
    [404, "not found", false],
  ]) {
    const { calls, fetchImpl } = recordingFetch(status, body);
    const api = new AgentApi(ENDPOINT, "inf_key", fetchImpl);
    assert.equal(await api.agentApisEnabled(), expected, `${status} ${JSON.stringify(body)}`);
    assert.equal(calls[0].url, "https://svc/v1/account/features");
    assert.equal(calls[0].init.headers.authorization, "Bearer inf_key");
  }
});

test("a failing features check is an error the caller decides on, not a silent off", async () => {
  const { fetchImpl } = recordingFetch(500, { error: "store unavailable" });
  const api = new AgentApi(ENDPOINT, "inf_key", fetchImpl);
  await assert.rejects(api.agentApisEnabled(), (err) => {
    assert.ok(err instanceof AgentApiError);
    assert.equal(err.status, 500);
    assert.match(err.message, /store unavailable/);
    return true;
  });
});

test("describe_columns reads the card with the pattern and limit", async () => {
  const { calls, fetchImpl } = recordingFetch(200, { matched: 2, card: { schema: [] } });
  const api = new AgentApi(ENDPOINT, "inf_key", fetchImpl);
  await api.describeColumns("events", { pattern: "property_*", limit: 5 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/table_card/logs");
  assert.equal(url.searchParams.get("table"), "events");
  assert.equal(url.searchParams.get("pattern"), "property_*");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(calls[0].init.method, "GET");
});

test("join_keys posts the tables, and a refusal keeps the service's words", async () => {
  const ok = recordingFetch(200, { joins: [] });
  await new AgentApi(ENDPOINT, "inf_key", ok.fetchImpl).joinKeys(["a", "b"]);
  assert.equal(ok.calls[0].url, "https://svc/v1/join_keys/logs");
  assert.equal(ok.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), { tables: ["a", "b"] });

  const refused = recordingFetch(403, { error: "the agent APIs are not enabled for this account" });
  await assert.rejects(new AgentApi(ENDPOINT, "inf_key", refused.fetchImpl).joinKeys(["a", "b"]), (err) => {
    assert.match(err.message, /join_keys: the service answered 403: the agent APIs are not enabled/);
    return true;
  });
});

test("an ask sends only the fields given, with the budget under the service's name", async () => {
  const { calls, fetchImpl } = recordingFetch(200, { facts: [], statement: "SELECT 1" });
  const api = new AgentApi(ENDPOINT, "inf_key", fetchImpl);
  await api.ask({
    question: "how many accounts are paying?",
    tables: ["accounts", "plans"],
    maxWallSecs: 60,
  });
  assert.equal(calls[0].url, "https://svc/v1/sub_agent/logs");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    question: "how many accounts are paying?",
    tables: ["accounts", "plans"],
    max_wall_secs: 60,
  });

  const bare = recordingFetch(200, {});
  await new AgentApi(ENDPOINT, "inf_key", bare.fetchImpl).ask({ question: "q", tables: [] });
  assert.deepEqual(JSON.parse(bare.calls[0].init.body), { question: "q" }, "an empty scope is not sent");
});

test("a busy answer says when to try again", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "the model pool is full" }), {
      status: 529,
      headers: { "retry-after": "12" },
    });
  await assert.rejects(new AgentApi(ENDPOINT, "inf_key", fetchImpl).ask({ question: "q" }), (err) => {
    assert.equal(err.retryAfterSecs, 12);
    assert.match(err.message, /the model pool is full; it is busy, so try again in 12 s/);
    return true;
  });
});

// --- the server, end to end -------------------------------------------------

/** A stand-in for the service: answers the features route with `features`
 * (an object, or a status number for a bare failure), the card and join
 * routes with fixed bodies, and records what it was asked. */
async function standIn(features) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const send = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/v1/account/features") {
        return typeof features === "number" ? send(features, { error: "no" }) : send(200, features);
      }
      if (req.url.startsWith("/v1/table_card/catalog?")) {
        return send(200, { matched: 3, card: { schema: [{ name: "property_a" }, { name: "property_b" }] } });
      }
      if (req.url === "/v1/join_keys/catalog") {
        return send(200, { joins: [{ predicate: "a.id = b.a_id" }] });
      }
      if (req.url === "/v1/sub_agent/catalog") {
        return send(200, {
          facts: [{ table: "a", row: { id: 1 } }],
          statement: "SELECT id FROM a",
          coverage: { rows_total: 1 },
        });
      }
      send(404, { error: `no route ${req.url}` });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, server, uri: `http://127.0.0.1:${server.address().port}/catalog` };
}

async function serve(features) {
  const svc = await standIn(features);
  const client = new Client({ name: "agent-tools", version: "0.0.0" });
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

const names = async (client) => (await client.listTools()).tools.map((t) => t.name);

test("an account with the agent routes on gets the agent tools, and they reach the service", async () => {
  const { client, svc } = await serve({ agent_apis: true });
  const listed = await names(client);
  for (const tool of AGENT_TOOLS) assert.ok(listed.includes(tool), `missing ${tool}`);
  assert.ok(listed.includes("infino_sql"), "the binding's tools are still there");

  const described = await client.callTool({
    name: "infino_describe_columns",
    arguments: { table: "events", pattern: "property_*" },
  });
  assert.ok(!described.isError, described.content[0].text);
  const body = JSON.parse(described.content[0].text);
  assert.equal(body.matched, 3);
  assert.equal(body.listed, 2);

  const joined = await client.callTool({ name: "infino_join_keys", arguments: { tables: ["a", "b"] } });
  assert.ok(!joined.isError, joined.content[0].text);
  assert.equal(JSON.parse(joined.content[0].text).joins[0].predicate, "a.id = b.a_id");

  const answered = await client.callTool({
    name: "infino_ask",
    arguments: { question: "which ids?", table: "a" },
  });
  assert.ok(!answered.isError, answered.content[0].text);
  assert.equal(JSON.parse(answered.content[0].text).statement, "SELECT id FROM a");
  const askCall = svc.seen.find((r) => r.url === "/v1/sub_agent/catalog");
  assert.deepEqual(JSON.parse(askCall.body), { question: "which ids?", table: "a" });

  const asked = svc.seen.filter((r) => r.url !== "/v1/account/features");
  assert.ok(
    asked.every((r) => r.auth === "Bearer inf_test"),
    "every call carries the key",
  );
});

for (const [why, features] of [
  ["the account has them switched off", { agent_apis: false }],
  ["the service has no features route (404)", 404],
  ["the features check fails (500)", 500],
]) {
  test(`no agent tools when ${why}`, async () => {
    const { client } = await serve(features);
    const listed = await names(client);
    for (const tool of AGENT_TOOLS) assert.ok(!listed.includes(tool), `${tool} offered when ${why}`);
    assert.ok(listed.includes("infino_sql"), "the server still serves the binding's tools");
  });
}
