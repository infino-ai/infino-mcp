# Infino MCP server

[![npm](https://img.shields.io/npm/v/@infino-ai/mcp-server.svg)](https://www.npmjs.com/package/@infino-ai/mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.infino--ai%2Fmcp--server-blue)](https://registry.modelcontextprotocol.io/?search=io.github.infino-ai/mcp-server)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-green.svg)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server for [Infino](https://github.com/infino-ai/infino) — it lets an AI agent run **keyword**, **semantic**, **hybrid**, and **SQL** retrieval over your data on object storage, from any MCP-compatible client (Claude Code, Claude Desktop, Cursor, VS Code, and others). Published on npm as [`@infino-ai/mcp-server`](https://www.npmjs.com/package/@infino-ai/mcp-server) and listed on the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.infino-ai/mcp-server` (which propagates to catalogs like Smithery, Glama, and PulseMCP).

- **No API key.** Semantic search embeds queries with a local model — nothing leaves the machine for embedding.
- **Read-only by default.** Writes and full SQL are opt-in behind a single environment flag.
- **Bring your own storage.** Point it at a local path or your own bucket (S3, GCS, Azure, or any S3-compatible store).

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Claude Code plugin (one-step install)](#claude-code-plugin-one-step-install)
- [Client setup](#client-setup)
  - [Claude Code](#claude-code)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [VS Code](#vs-code)
  - [Other MCP clients](#other-mcp-clients)
- [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [Storage backends](#storage-backends)
- [Tools](#tools)
- [Security & data handling](#security--data-handling)
- [How retrieval works](#how-retrieval-works)
- [Troubleshooting](#troubleshooting)
- [Local development](#local-development)
- [License](#license)

---

## Requirements

- **Node.js ≥ 18** (the server runs as a Node process over stdio).
- **An MCP-compatible client** (Claude Code, Claude Desktop, Cursor, VS Code, …).
- **Data reachable by Infino** — a local directory, or a bucket with credentials available in the environment (see [Storage backends](#storage-backends)).
- On first run the server downloads the local embedding model (~90 MB) once and caches it; subsequent runs are offline for embedding.

---

## Quick start

The server is launched by your MCP client over stdio — you don't run it directly in normal use. Every client config follows the same shape: command `npx -y @infino-ai/mcp-server`, with configuration supplied via environment variables. Set `INFINO_MCP_URI` to the data you want to serve — a local path or a bucket URI. If it's omitted, the server starts an ephemeral in-process catalog (`memory://`) that holds no data, so set it for any real use.

```jsonc
{
  "command": "npx",
  "args": ["-y", "@infino-ai/mcp-server"],
  "env": {
    "INFINO_MCP_URI": "/Users/me/.infino/memory"
  }
}
```

The sections below show the exact place each client expects this block.

---

## Claude Code plugin (one-step install)

For [Claude Code](https://claude.com/claude-code), this repo is also a plugin marketplace. Installing the plugin wires up the MCP server **plus** a how-to-use skill and an `/infino-search` command in one step — no JSON to edit. Inside Claude Code:

```
/plugin marketplace add infino-ai/infino-mcp
/plugin install infino@infino-ai
```

On enable you'll be prompted for your **Infino data URI** (`INFINO_MCP_URI`) and whether to **enable writes**. That's it — the `infino_*` tools, the `using-infino` skill, and `/infino-search <query>` are then available. (Other clients: use the [Client setup](#client-setup) configs below.)

---

## Client setup

### Claude Code

Add the server with the CLI. Use `--scope user` to make it available in every project, or `--scope project` to commit it to the repo (writes a shared `.mcp.json`); the default scope is `local` (this project only).

```sh
claude mcp add infino \
  --scope user \
  -e INFINO_MCP_URI=/Users/me/.infino/memory \
  -- npx -y @infino-ai/mcp-server
```

Add more knobs with repeated `-e` flags, e.g. `-e INFINO_MCP_ENABLE_WRITES=true`. Verify with:

```sh
claude mcp list
claude mcp get infino
```

### Claude Desktop

Edit the configuration file (create it if it doesn't exist), then fully restart Claude Desktop.

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```jsonc
{
  "mcpServers": {
    "infino": {
      "command": "npx",
      "args": ["-y", "@infino-ai/mcp-server"],
      "env": {
        "INFINO_MCP_URI": "/Users/me/.infino/memory"
      }
    }
  }
}
```

### Cursor

Add the server to **`~/.cursor/mcp.json`** (available in all projects) or **`<project>/.cursor/mcp.json`** (this project only), then reload. The format matches Claude Desktop:

```jsonc
{
  "mcpServers": {
    "infino": {
      "command": "npx",
      "args": ["-y", "@infino-ai/mcp-server"],
      "env": {
        "INFINO_MCP_URI": "/Users/me/.infino/memory"
      }
    }
  }
}
```

### VS Code

VS Code (1.102+) reads MCP servers from **`.vscode/mcp.json`** in the workspace (or your user `mcp.json` via the command palette → *MCP: Open User Configuration*). Note the top-level key is `servers` and each entry declares `"type": "stdio"`:

```jsonc
{
  "servers": {
    "infino": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@infino-ai/mcp-server"],
      "env": {
        "INFINO_MCP_URI": "/Users/me/.infino/memory"
      }
    }
  }
}
```

### Other MCP clients

Any client that speaks MCP over stdio works. Configure it to launch:

```
command: npx
args:    -y @infino-ai/mcp-server
env:     INFINO_MCP_URI=<path-or-bucket-uri>   (plus any options below)
```

Logs are written to **stderr** so they never corrupt the JSON-RPC stream on stdout — point your client's log capture there when debugging.

---

## Configuration

All configuration is via environment variables — there are no config files and no command-line flags to manage.

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `INFINO_MCP_URI` | No | `memory://` (ephemeral) | Data to serve: a local path (`/Users/me/.infino/memory`) or a bucket URI (`s3://…`, `gs://…`, `az://…`). If unset, an ephemeral in-process catalog is used (holds no data) — set it for any real use. |
| `INFINO_MCP_ENABLE_WRITES` | No | _off_ | When set (`1`/`true`/`yes`), exposes `infino_add_documents` **and** lets `infino_sql` run DDL/DML. Omit for a strictly read-only server. |
| `INFINO_MCP_EMBED_MODEL` | No | `Xenova/all-MiniLM-L6-v2` | Hugging Face feature-extraction model used for embedding. Must match the table's vector index dimension (default model is 384-dim). |
| `INFINO_MCP_S3_ENDPOINT` | No | — | Custom S3 endpoint for non-AWS S3-compatible stores (Cloudflare R2, MinIO, Backblaze B2, …). |
| `INFINO_MCP_S3_REGION` | No | `auto` | Region to send with a custom S3 endpoint. |

Cloud credentials are read from the standard provider environment variables — the server does not introduce its own:

| Backend | Credentials |
| --- | --- |
| AWS S3 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN` if used) |
| S3-compatible (R2/MinIO/B2) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` **and** `INFINO_MCP_S3_ENDPOINT` |
| Google Cloud Storage | `GOOGLE_APPLICATION_CREDENTIALS` (or ambient ADC) |
| Azure Blob | `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY` |

### Storage backends

```jsonc
// Local directory
"env": { "INFINO_MCP_URI": "/Users/me/.infino/memory" }

// AWS S3 — ambient AWS_* credentials, default endpoint
"env": {
  "INFINO_MCP_URI": "s3://my-bucket/infino",
  "AWS_ACCESS_KEY_ID": "…",
  "AWS_SECRET_ACCESS_KEY": "…"
}

// S3-compatible (Cloudflare R2 / MinIO / Backblaze B2) — custom endpoint
"env": {
  "INFINO_MCP_URI": "s3://my-bucket/infino",
  "INFINO_MCP_S3_ENDPOINT": "https://<account>.r2.cloudflarestorage.com",
  "INFINO_MCP_S3_REGION": "auto",
  "AWS_ACCESS_KEY_ID": "…",
  "AWS_SECRET_ACCESS_KEY": "…"
}
```

---

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `infino_semantic_search` | `table`, `query`, `k`, `column?`, `vectorColumn?`, `filter?` | Find passages by **meaning** — embeds the query with a local model (no key) and ranks by vector similarity. Handles paraphrase and synonyms. Optional `filter` (`{column, query, mode?}`) restricts the ranking to rows whose keyword column matches first (a pushdown pre-filter). |
| `infino_keyword_search` | `table`, `query`, `k`, `column?` | BM25 full-text search — for exact terms, identifiers, error codes, product names. |
| `infino_hybrid_search` | `table`, `query`, `k`, `column?`, `vectorColumn?` | **Fused** keyword + semantic search in one ranking pass — BM25 over the text column combined with vector similarity, so rows matching the literal terms *and* the meaning rank highest. |
| `infino_token_match` | `table`, `query`, `column?`, `mode?`, `limit?` | Unranked keyword filter — the set of rows whose text column contains the token(s). Use when you need the matches, not a relevance order. |
| `infino_exact_match` | `table`, `value`, `column?`, `limit?` | Unranked exact-equality filter over an indexed column (tag, status, id string). |
| `infino_sql` | `query` | SQL for counts, filters, joins, aggregates. Read-only (single `SELECT`/`WITH`) by default; accepts any single statement when `INFINO_MCP_ENABLE_WRITES` is set. |
| `infino_list_tables` | — | List the tables in the connected catalog. |
| `infino_describe_table` | `table` | Column names and types for a table. |
| `infino_add_documents` | `table`, `documents` | Append rows (one call = one commit); embeds the text column for vector tables. **Only when `INFINO_MCP_ENABLE_WRITES` is set.** |
| `infino_update_documents` | `table`, `predicate`, `documents` | Replace the rows matching a SQL predicate with new documents, 1:1 (missing vectors are embedded). Durable storage only. **Only when `INFINO_MCP_ENABLE_WRITES` is set.** |
| `infino_delete_documents` | `table`, `predicate` | Delete the rows matching a SQL predicate. Durable storage only. **Only when `INFINO_MCP_ENABLE_WRITES` is set.** |

The engine's search table functions (`bm25_search`, `vector_search`, `hybrid_search`, …) are not callable from `infino_sql` — retrieval goes through the dedicated search tools above, which embed and project for you. `infino_sql` is for filters, joins, and aggregates.

---

## Security & data handling

This server is designed to run locally, beside the client, and to keep data and credentials on the user's machine.

- **Local execution.** It runs as a subprocess of your MCP client over stdio. There is no network listener and no remote service.
- **No data sent for embedding.** Query and document embedding uses a local model — text is never sent to a third-party embedding API. There is no API key to provision or leak.
- **Credentials stay in the environment.** Storage credentials are read from standard provider environment variables and used only to reach the bucket you configured. They are never logged or returned in tool output.
- **Read-only by default.** Without `INFINO_MCP_ENABLE_WRITES`, the write tool is not even advertised to the agent, and `infino_sql` rejects anything but a single `SELECT`/`WITH`. Enable writes deliberately, and prefer scoping the server to data the agent is allowed to modify.
- **Least privilege.** Point `INFINO_MCP_URI` at the narrowest dataset the task needs, and supply storage credentials scoped to that bucket/prefix.

---

## How retrieval works

Semantic search embeds locally with Hugging Face transformers.js (`all-MiniLM-L6-v2`, 384-dim by default; override with `INFINO_MCP_EMBED_MODEL`). The server embeds **both** the documents it ingests (via `infino_add_documents`) and your queries with the same model, so they align in the same vector space.

If you change `INFINO_MCP_EMBED_MODEL`, the table's vector index must match the new model's dimension — embeddings produced by different models are not comparable, and a dimension mismatch will fail at search time.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Client shows no Infino tools | Server didn't start — check the client's MCP logs (stderr). Confirm `npx` is on `PATH` and `INFINO_MCP_URI` is set. Fully restart the client after editing config. |
| `INFINO_MCP_URI is required` | The env var isn't reaching the subprocess. In GUI clients, env must be inside the server's `env` block (the process won't inherit your shell). |
| `add_documents` not available | `INFINO_MCP_ENABLE_WRITES` isn't set, or the client wasn't restarted after setting it. |
| Slow first query | One-time embedding-model download (~90 MB). Subsequent runs use the cache. |
| Dimension / vector errors on semantic search | The table's vector index doesn't match the embedding model's dimension. Re-ingest, or set `INFINO_MCP_EMBED_MODEL` to the model the index was built with. |
| `… in SQL isn't supported from the server yet` | You called a search table function inside `infino_sql`. Use `infino_semantic_search` / `infino_keyword_search` instead. |

---

## Local development

The server depends on the published [`@infino-ai/infino`](https://www.npmjs.com/package/@infino-ai/infino) Node binding, which resolves from public npm like any other dependency.

```sh
npm install
npm run build
INFINO_MCP_URI=/path/to/data node dist/index.js   # runs on stdio
```

Point a client at `node /absolute/path/dist/index.js` over stdio to dogfood a local build, or use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## License

[Apache-2.0](./LICENSE)
