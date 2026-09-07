// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The files that describe this server to humans and registries have to agree
// with each other. They drifted before: the README promised a read-only
// default for weeks after the code stopped having one. These checks run in
// the normal suite, so a PR that changes one surface and not the others fails
// here instead of being noticed by a user.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

// Environment variables the README documents: the first column of the table
// under "### Environment variables".
function readmeEnvVars() {
  const readme = read("README.md");
  const start = readme.indexOf("### Environment variables");
  const end = readme.indexOf("\n### ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]).sort();
}

test("README environment table and server.json agree on the variables", () => {
  const registry = json("server.json")
    .packages[0].environmentVariables.map((v) => v.name)
    .sort();
  assert.deepEqual(readmeEnvVars(), registry);
});

test("every INFINO_* variable smithery.yaml passes exists in server.json", () => {
  const registry = new Set(json("server.json").packages[0].environmentVariables.map((v) => v.name));
  const passed = [...read("smithery.yaml").matchAll(/\b(INFINO_[A-Z0-9_]+)\b/g)].map((m) => m[1]);
  assert.ok(passed.length > 0, "smithery.yaml names no variables");
  for (const name of new Set(passed)) assert.ok(registry.has(name), `${name} is not in server.json`);
});

test("the plugin's env mapping names only variables server.json lists", () => {
  const registry = new Set(json("server.json").packages[0].environmentVariables.map((v) => v.name));
  const env = json("plugin/.mcp.json").mcpServers.infino.env;
  for (const name of Object.keys(env)) assert.ok(registry.has(name), `${name} is not in server.json`);
});

test("plugin manifest and marketplace agree on the plugin version", () => {
  const plugin = json("plugin/.claude-plugin/plugin.json");
  const listing = json(".claude-plugin/marketplace.json").plugins.find((p) => p.name === plugin.name);
  assert.ok(listing, `marketplace lists no plugin named ${plugin.name}`);
  assert.equal(listing.version, plugin.version);
});

test("the retired writes flag is mentioned by no surface except as retired", () => {
  for (const file of [
    "server.json",
    "smithery.yaml",
    "plugin/.mcp.json",
    "plugin/.claude-plugin/plugin.json",
    "SECURITY.md",
  ]) {
    assert.doesNotMatch(read(file), /INFINO_MCP_ENABLE_WRITES/, `${file} still documents the retired flag`);
  }
});

test("package.json engines floor matches the README requirement", () => {
  const engines = json("package.json").engines.node;
  const floor = engines.match(/>=\s*(\d+)/)?.[1];
  assert.ok(floor, `engines.node is not a >= range: ${engines}`);
  assert.match(
    read("README.md"),
    new RegExp(`Node\\.js\\s*≥\\s*${floor}\\b`),
    `README does not state Node.js ≥ ${floor}`,
  );
});
