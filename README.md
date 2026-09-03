# Infino MCP server

[![npm](https://img.shields.io/npm/v/@infino-ai/mcp-server.svg)](https://www.npmjs.com/package/@infino-ai/mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.infino--ai%2Fmcp--server-blue)](https://registry.modelcontextprotocol.io/?search=io.github.infino-ai/mcp-server)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-green.svg)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server for [Infino](https://github.com/infino-ai/infino) — it lets an AI agent run **keyword**, **semantic**, **hybrid**, and **SQL** retrieval over your data on object storage, from any MCP-compatible client (Claude Code, Claude Desktop, Cursor, VS Code, and others). Published on npm as [`@infino-ai/mcp-server`](https://www.npmjs.com/package/@infino-ai/mcp-server) and listed on the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.infino-ai/mcp-server` (which propagates to catalogs like Smithery, Glama, and PulseMCP).

- **Local embeddings, no key.** Semantic search embeds queries with a local model — nothing leaves the machine for embedding.
- **The agent owns the data.** Every tool, writes included, is always available. On Infino Cloud the API key's capabilities decide what a connection may do; every tool carries MCP annotations so your client can ask before a destructive call.
- **Local or hosted.** Point it at a local path, your own bucket (S3, Azure, or any S3-compatible store), or a hosted Infino Cloud endpoint with an API key.

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
- **Data reachable by Infino** — a local directory, a bucket with credentials available in the environment, or a hosted Infino Cloud endpoint with an API key (see [Storage backends](#storage-backends)).
- On first run the server downloads the local embedding model (~90 MB) once and caches it; subsequent runs are offline for embedding.

---

## Quick start

The server is launched by your MCP client over stdio — you don't run it directly in normal use. Every client config follows the same shape: command `npx -y @infino-ai/mcp-server`, with configuration supplied via environment variables. Set `INFINO_MCP_URI` to the data you want to serve — a local path or a bucket URI. If it's omitted, the server uses a durable per-user directory (`~/.infino/mcp`) so data persists across restarts; point `INFINO_MCP_URI` at your own path or bucket to serve existing data.

```jsonc
{
  "command": "npx",
  "args": ["-y", "@infino-ai/mcp-server"],
  "env": {
    "INFINO_MCP_URI": "/Users/me/.infino/memory"
  }
}
```

To serve a **hosted Infino Cloud** database instead, point `INFINO_MCP_URI` at
the `https://<host>/<database>` endpoint and supply your API key. Everything
else is identical:

```jsonc
{
  "command": "npx",
  "args": ["-y", "@infino-ai/mcp-server"],
  "env": {
    "INFINO_MCP_URI": "https://api.platform.infino.ws/my-database",
    "INFINO_API_KEY": "inf_…"
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

On enable you'll be prompted for your **Infino data URI** (`INFINO_MCP_URI`) and, for Infino Cloud, your **API key**. That's it: the `infino_*` tools, the `using-infino` skill, and `/infino-search <query>` are then available. (Other clients: use the [Client setup](#client-setup) configs below.)

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

Add more knobs with repeated `-e` flags, e.g. `-e INFINO_MCP_VALIDATE=true`. Verify with:

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
| `INFINO_MCP_URI` | No | `~/.infino/mcp` (persistent) | Data to serve: a local path (`/Users/me/.infino/memory`), a bucket URI (`s3://…`, `az://…`), or a hosted endpoint (`https://<host>/<database>`, Infino Cloud). If unset, a durable per-user directory (`~/.infino/mcp`) is used so data persists across restarts; it falls back to an ephemeral in-process catalog (`memory://`) only if that directory can't be created. |
| `INFINO_API_KEY` | With a hosted URI | — | API key (`inf_…`) for a hosted `https://` endpoint. Required when `INFINO_MCP_URI` is an `https://` URI; ignored for local and object-storage connections. |
| `INFINO_MCP_EMBED_PROVIDER` | No | `local` | Embedding provider: `local` (Hugging Face transformers.js, no key, nothing leaves the machine) or `openai` (any OpenAI-compatible `/embeddings` endpoint — OpenAI, Azure OpenAI's `/openai/v1` surface, or a compatible server). Inferred as `openai` when `INFINO_MCP_EMBED_BASE_URL` is set. |
| `INFINO_MCP_EMBED_BASE_URL` | With `openai` | — | Base URL of the OpenAI-compatible embeddings API, e.g. `https://api.openai.com/v1` or `https://<resource>.openai.azure.com/openai/v1`. The server POSTs to `<base>/embeddings`. |
| `INFINO_MCP_EMBED_API_KEY` | No | — | API key for the `openai` provider. Sent as both `Authorization: Bearer` and `api-key`, so one value works for OpenAI and Azure OpenAI. Omit to call an unauthenticated or ambient-identity endpoint. |
| `INFINO_MCP_EMBED_MODEL` | No | `Xenova/all-MiniLM-L6-v2` (local) · `text-embedding-3-small` (openai) | The embedding model. For `local`, a Hugging Face feature-extraction model; for `openai`, the model/deployment name. **Must match the model that produced the table's stored vectors** — and therefore its vector-index dimension (e.g. `text-embedding-3-small` is 1536-dim; the default local model is 384-dim). |
| `INFINO_MCP_VALIDATE` | No | _off_ | When set (`1`/`true`/`yes`), probes the object store at startup so bad credentials or an unreachable bucket fail then instead of on the first search. |

Cloud credentials are read from the standard provider environment variables — the server maps them to the store's config and introduces no credential vars of its own. Omit them entirely to use ambient cloud identity (an IAM instance role or Azure managed identity).

**Serving a catalog embedded with OpenAI / Azure OpenAI.** If your tables were vectorized with a hosted embedding model rather than the local default, point the server at that same model so query and document vectors align:

```jsonc
"env": {
  "INFINO_MCP_URI": "s3://my-bucket/infino",
  "INFINO_MCP_EMBED_PROVIDER": "openai",
  "INFINO_MCP_EMBED_BASE_URL": "https://my-resource.openai.azure.com/openai/v1",
  "INFINO_MCP_EMBED_API_KEY": "…",
  "INFINO_MCP_EMBED_MODEL": "text-embedding-3-small"
}
```

The model must match what produced the stored vectors — a mismatch yields meaningless similarity or a dimension error. Keyword and SQL search are unaffected by the embedder.

| Backend | Credentials |
| --- | --- |
| AWS S3 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`, `AWS_REGION` if used) |
| S3-compatible (R2/MinIO/B2) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` **and** `AWS_ENDPOINT_URL` |
| Azure Blob | `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY` |
| Infino Cloud (hosted) | `INFINO_API_KEY` — no object-storage credentials needed (the platform owns the storage) |

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
  "AWS_ENDPOINT_URL": "https://<account>.r2.cloudflarestorage.com",
  "AWS_ACCESS_KEY_ID": "…",
  "AWS_SECRET_ACCESS_KEY": "…"
}

// Azure Blob
"env": {
  "INFINO_MCP_URI": "az://my-container/infino",
  "AZURE_STORAGE_ACCOUNT": "…",
  "AZURE_STORAGE_KEY": "…"
}

// Infino Cloud (hosted) — the database is the last path segment
"env": {
  "INFINO_MCP_URI": "https://api.platform.infino.ws/my-database",
  "INFINO_API_KEY": "inf_…"
}
```

On a hosted connection the search, SQL, and write tools all
behave exactly as they do locally — the only difference is where the data
lives. Compaction and garbage collection are handled server-side, so they are
not exposed as client operations. Note that semantic and hybrid search still
embed queries **locally** in this server, so `INFINO_MCP_EMBED_MODEL` must match
the model that produced the hosted table's stored vectors (see the OpenAI /
Azure OpenAI note above) — this matters especially when someone else ingested
the data.

---

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `infino_semantic_search` | `table`, `query`, `k`, `column?`, `vectorColumn?`, `columns?`, `filter?` | Find passages by **meaning** — embeds the query with a local model (no key) and ranks by vector similarity. Handles paraphrase and synonyms. `score` is a **distance** (lower is closer). Optional `filter` (`{column, query, mode?}`) restricts the ranking to rows whose keyword column matches first (a pushdown pre-filter). Optional `columns` chooses which fields each hit returns (e.g. a path + line range to cite); defaults to the text column, with `_id` and `score` always included. |
| `infino_keyword_search` | `table`, `query`, `k`, `column?`, `mode?`, `stats?`, `columns?` | BM25 full-text search — for exact terms, identifiers, error codes, product names. `score` is a relevance (higher is better). `mode` is `or` (default) or `and`; `stats` is `per_superfile` (default) or `global` for one table-wide idf. |
| `infino_hybrid_search` | `table`, `query`, `k`, `column?`, `vectorColumn?`, `mode?`, `columns?` | **Fused** keyword + semantic search in one ranking pass — BM25 over the text column combined with vector similarity, so rows matching the literal terms *and* the meaning rank highest. `score` is the fused rank (higher is better). |
| `infino_token_match` | `table`, `query`, `column?`, `mode?`, `limit?` | Unranked keyword filter — the set of rows whose text column contains the token(s). Use when you need the matches, not a relevance order. |
| `infino_exact_match` | `table`, `value`, `column?`, `limit?` | Unranked exact-equality filter over an indexed column (tag, status, id string). |
| `infino_count` | `table`, `query`, `column?`, `mode?` | Count how many rows match a keyword query, without fetching them — a fast tally over the text column. For the matching rows use `infino_keyword_search` or `infino_token_match`. |
| `infino_sql` | `query`, `embed?` | SQL for counts, filters, joins, aggregates. The engine's search table functions are callable inside it; a `{{name}}` placeholder is filled with the vector of `embed[name]`. Any single statement, DDL/DML included. |
| `infino_list_tables` | — | List the tables in the connected catalog. |
| `infino_describe_table` | `table` | Column names and types for a table. |
| `infino_create_database` | — | Provision the database the connection names (Infino Cloud); a no-op success locally. Idempotent. |
| `infino_create_table` | `table`, `columns`, `fts?`, `vector?` | Create a table from a `{column: type}` descriptor. Full-text indexes on `fts` (default: every `large_utf8` column). `vector: true` adds an `embedding` column sized to the server's embedder, with a cosine index. |
| `infino_drop_table` | `table`, `purge?` | Drop a table and, by default, delete its storage objects; `purge: false` only unregisters the name. |
| `infino_add_documents` | `table`, `documents` | Append rows (one call = one commit). Rows without a vector are embedded from the text column, all in one batch; the result reports `appended` and `embedded`. A key that is not a column is an error. |
| `infino_update_documents` | `table`, `predicate`, `documents` | Replace the rows matching a SQL predicate with new documents, 1:1 (missing vectors are embedded). Durable storage only. |
| `infino_delete_documents` | `table`, `predicate` | Delete the rows matching a SQL predicate. Durable storage only. |

Search hits return **full column values** — the `columns` argument is a projection passed straight to the engine (embedded or hosted), so any column in the table can come back with each hit: `["id"]` for compact hits at a large `k`, `["id", "text"]` for the full text alongside an id to cite, metadata columns for filtering. It defaults to the text column, with `_id` and `score` always included, and nothing is ever truncated; to keep results small, project fewer columns or ask for a smaller `k`. Every search response also carries `score_kind`, stating whether its `score` is a distance (semantic: lower is closer) or a relevance (keyword and hybrid: higher is better).

For plain retrieval prefer the dedicated search tools, which embed and project for you. `infino_sql` is for filters, joins, and aggregates, including over a search table function's results, so one query can rank and aggregate at once.

### Writing data

The write path an agent follows, each step one tool call and one commit:

1. `infino_create_database` if a hosted database answers 404.
2. `infino_create_table` with a `utf8` key column, `large_utf8` text columns, and `vector: true` for semantic search. The server sizes the vector column to its embedder; the agent never types a dimension. Keep the result: its `indexes` field is the only record of which columns are indexed.
3. `infino_add_documents`, tens of rows per call, always including the key. Missing vectors are embedded in one batch.
4. To replace rows, `infino_delete_documents` by key predicate, then add again. To remove rows, check the predicate with `infino_count` first.

A tool call carries tens of documents. For a whole corpus, use the [`infino` CLI](https://github.com/infino-ai/infino-cli) (`infino ingest` takes Parquet or NDJSON against the same URI) or an SDK. The CLI is bring-your-own-vectors like the engine, so include the `embedding` column in the rows or load text and search by keyword.

There is no server-side write gate, and the retired `INFINO_MCP_ENABLE_WRITES` variable is ignored (the server says so on stderr if it is set). On Infino Cloud the API key's capabilities bound what the connection may do: a read-scoped key is refused every write, and the tool result says to mint one with write capability. Locally, point the server only at data the agent may change.

---

## Security & data handling

This server runs locally, beside the client, and keeps data and credentials on the user's machine.

- **Local execution, no inbound listener.** It runs as a subprocess of your MCP client over stdio and opens no network listener. In the default local/bucket mode it contacts no remote service. When `INFINO_MCP_URI` is a hosted `https://` endpoint, it makes **outbound** TLS calls to that endpoint to serve searches, SQL, and (if enabled) writes — so the data in those requests reaches the hosted service you configured, and nothing else.
- **No data sent for embedding, by default.** With the default provider, query and document embedding uses a local model, so text is never sent to a third-party embedding API and there is no embedding API key to provision or leak. In hosted mode only the resulting vector, not the text, reaches the Infino Cloud endpoint. If you configure the OpenAI-compatible provider, the text being embedded is sent to the endpoint you name.
- **Credentials stay in the environment.** Storage credentials (`AWS_*`/`AZURE_*`) and the hosted API key (`INFINO_API_KEY`) are read from environment variables and used only to reach the store or endpoint you configured. They are never logged or returned in tool output.
- **Who can write is decided outside the server.** The full toolset, writes included, is always available to the agent. On Infino Cloud the API key's capabilities bound what the connection may do (a read-scoped key is refused every write). Locally, point the server only at data the agent may change. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`) so your client can ask for confirmation on its own terms.
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
| A write says the key "was rejected or lacks write capability" | On Infino Cloud the API key is read-scoped (HTTP 403) or wrong. Mint a key with write capability and restart the server with it. |
| A write says "another writer won the commit race" | Two writers hit the same table at once and this call did not land. Reissue it. |
| Slow first query | One-time embedding-model download (~90 MB). Subsequent runs use the cache. |
| Auth error against a hosted `https://` URI | `INFINO_API_KEY` is missing, wrong, or lacks access to that database. Confirm the key (`inf_…`) and that the URI's last path segment is a database you can reach. |
| Dimension / vector errors on semantic search | The table's vector index doesn't match the embedding model's dimension. Re-ingest, or set `INFINO_MCP_EMBED_MODEL` to the model the index was built with. |

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
