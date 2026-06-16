# Infino MCP server

An [MCP](https://modelcontextprotocol.io) server for [Infino](https://github.com/infino-ai/infino) — lets an AI agent run keyword, semantic, and SQL retrieval over your data on object storage, from any MCP client. Published on npm as [`@infino-ai/mcp-server`](https://www.npmjs.com/package/@infino-ai/mcp-server).

> Status: early. Read-only retrieval (keyword + semantic search + SQL) by default; writes opt-in behind a flag.

## Configure

Point the server at your data with `INFINO_MCP_URI` — a local path or your own bucket. That's all that's required: keyword **and** semantic search work out of the box, because the server embeds queries with a **local** model (downloaded once, no API key). Writes are off unless you set `INFINO_MCP_ENABLE_WRITES`. Example MCP client config (Claude Desktop / Cursor `mcpServers`):

```jsonc
{
  "mcpServers": {
    "infino": {
      "command": "npx",
      "args": ["-y", "@infino-ai/mcp-server"],
      "env": {
        "INFINO_MCP_URI": "/Users/me/.infino/memory",
        "INFINO_MCP_ENABLE_WRITES": "true" // exposes infino_add_documents + lets infino_sql run DDL/DML; omit for read-only
        // remote storage: s3://|gs://|az:// with standard AWS_*/GOOGLE_*/AZURE_* creds
        // S3-compatible (Cloudflare R2, MinIO, Backblaze B2): also set
        // INFINO_MCP_S3_ENDPOINT (and optionally INFINO_MCP_S3_REGION)
      }
    }
  }
}
```

## Tools

| Tool | Args | What it does |
| --- | --- | --- |
| `infino_semantic_search` | `table`, `query`, `k`, `column?`, `vectorColumn?` | Find passages by **meaning** — embeds the query with a local model (**no key**) and ranks by vector similarity |
| `infino_keyword_search` | `table`, `query`, `k`, `column?` | BM25 full-text search — for exact terms, names, codes; no key |
| `infino_sql` | `query` | SQL for counts, filters, joins, aggregates. Read-only (single `SELECT`/`WITH`) by default; with `INFINO_MCP_ENABLE_WRITES` set it accepts any single statement (DDL/DML). For retrieval use the search tools; search table functions in SQL aren't supported from the server yet |
| `infino_list_tables` | — | List tables in the catalog |
| `infino_describe_table` | `table` | Column names and types |
| `infino_add_documents` | `table`, `documents` | Append rows (one call = one commit); embeds the text column for vector tables. Only when `INFINO_MCP_ENABLE_WRITES` is set |

Semantic search embeds locally (Hugging Face transformers.js, `all-MiniLM-L6-v2`, 384-dim by default; override with `INFINO_MCP_EMBED_MODEL`). The server embeds both the documents it ingests and your queries with the same model, so they align — but the table's vector index must match that model's dimension. Hybrid (fused keyword + semantic) is reachable in the engine via SQL and will return as a tool once that path is supported from the server.

## Local development

The server depends on the published `infino` Node binding. It currently resolves from the public Gemfury proxy (see `.npmrc`); once `infino` is on public npm, delete `.npmrc` and it resolves from there.

```sh
npm install
npm run build
INFINO_MCP_URI=/path/to/data node dist/index.js   # stdio
```

Point a client at `node /abs/path/dist/index.js` over stdio to dogfood, or use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).
