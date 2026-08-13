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

test("server advertises the read-only toolset by default", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    "infino_list_tables",
    "infino_describe_table",
    "infino_keyword_search",
    "infino_semantic_search",
    "infino_hybrid_search",
    "infino_token_match",
    "infino_exact_match",
    "infino_count",
    "infino_sql",
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  // Writes are off unless INFINO_MCP_ENABLE_WRITES is set — the write tools
  // must not even be advertised.
  assert.ok(!names.includes("infino_add_documents"));
});

test("infino_list_tables answers over the wire", async () => {
  const res = await client.callTool({ name: "infino_list_tables", arguments: {} });
  assert.ok(!res.isError);
  const body = JSON.parse(res.content[0].text);
  assert.deepEqual(body.tables, []);
});
