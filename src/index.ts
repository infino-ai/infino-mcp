#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// MCP server for Infino — lets an agent run retrieval over data on object
// storage from any MCP client. Exposes catalog discovery (list/describe),
// keyword (BM25), semantic (local-embedding vector), and hybrid (fused)
// search, unranked token/exact match, and read-only SQL; document writes
// (add/update/delete) and full SQL are opt-in behind INFINO_MCP_ENABLE_WRITES.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect, type ConnectOptions } from "@infino-ai/infino";
import { embed, embedderInfo } from "./embedding.js";

// --- connection (env-configured, opened once at startup) -------------------
//
// The agent never manages connections: the server is pointed at the data via
// INFINO_MCP_URI, which selects the backend by its scheme:
//   - a local path or an s3://|az:// bucket  → an embedded catalog opened
//     in-process, with credentials from the standard AWS_*/AZURE_* variables
//     (AWS S3 uses the default endpoint; for an S3-compatible store — Cloudflare
//     R2, MinIO, Backblaze B2 — set AWS_ENDPOINT_URL alongside the AWS_* keys);
//   - an https://<host>/<database> URI       → the hosted Infino Cloud service,
//     authenticated with an API key (INFINO_API_KEY).

// When INFINO_MCP_URI is unset, default to a durable per-user directory so a
// fresh install persists across restarts with no configuration. Fall back to
// an ephemeral in-process catalog if that directory can't be created (a
// sandboxed or read-only host, or a registry health-check spawn): the server
// must always start — a hard exit would leave it permanently "unhealthy".
// Real deployments set INFINO_MCP_URI to their own path or an s3://|az:// URI.
function defaultUri(): string {
  const dir = join(homedir(), ".infino", "mcp");
  try {
    mkdirSync(dir, { recursive: true });
    console.error(
      `INFINO_MCP_URI not set — using ${dir} (persistent; read-only until ` +
        "INFINO_MCP_ENABLE_WRITES is set). Set INFINO_MCP_URI to point at your " +
        "own path, an s3://|az:// bucket, or a hosted https://<host>/<database> " +
        "endpoint.",
    );
    return dir;
  } catch (err) {
    console.error(
      `INFINO_MCP_URI not set and ${dir} is not writable ` +
        `(${errText(err)}) — serving an ephemeral in-process ` +
        "catalog (memory://).",
    );
    return "memory://";
  }
}

const uri = process.env.INFINO_MCP_URI ?? defaultUri();

// A hosted (Infino Cloud) target is an https:// URI that carries the database
// in its path (https://<host>/<database>); any other scheme is an embedded
// catalog on a local path or an object-storage bucket. The two authenticate
// differently — a hosted connection with an API key, an embedded one with the
// object store's own AWS_*/AZURE_* variables — so the scheme selects which
// credential we hand to connect below.
const isHosted = /^https?:\/\//i.test(uri);

// For an embedded catalog, infino reads no credentials from the environment, so
// gather the standard provider variables here and hand them to connect as
// storageOptions, keyed by object_store's aws_*/azure_* config strings. Leaving
// them all unset falls back to ambient cloud identity (an IAM instance role or
// Azure managed identity). These are ignored for a hosted connection.
const storageOptions: Record<string, string> = {};
const addStorageOption = (key: string, value: string | undefined) => {
  if (value) storageOptions[key] = value;
};

// S3, and S3-compatible stores (Cloudflare R2 / MinIO / Backblaze B2) via a
// custom endpoint.
addStorageOption("aws_access_key_id", process.env.AWS_ACCESS_KEY_ID);
addStorageOption("aws_secret_access_key", process.env.AWS_SECRET_ACCESS_KEY);
addStorageOption("aws_session_token", process.env.AWS_SESSION_TOKEN);
addStorageOption("aws_region", process.env.AWS_REGION);
const s3Endpoint = process.env.AWS_ENDPOINT_URL;
if (s3Endpoint) {
  storageOptions.aws_endpoint = s3Endpoint;
  // A custom endpoint needs a region; default to "auto" (what R2 expects).
  if (!storageOptions.aws_region) storageOptions.aws_region = "auto";
  // object_store rejects a plain-HTTP endpoint unless HTTP is allowed.
  if (s3Endpoint.startsWith("http://")) storageOptions.aws_allow_http = "true";
}

// Azure Blob.
addStorageOption("azure_storage_account_name", process.env.AZURE_STORAGE_ACCOUNT);
addStorageOption("azure_storage_account_key", process.env.AZURE_STORAGE_KEY);

// API key for a hosted (https://) connection. The binding also reads
// INFINO_API_KEY on its own, but we pass it explicitly so the credential path
// is visible here and we can warn on an obvious misconfiguration.
const apiKey = process.env.INFINO_API_KEY;

// Opt into a connect-time probe so bad credentials or an unreachable bucket
// fail at startup instead of on the first search.
const validate = ["1", "true", "yes"].includes(
  (process.env.INFINO_MCP_VALIDATE ?? "").toLowerCase(),
);

const connectOptions: ConnectOptions = {};
if (isHosted) {
  // Hosted (Infino Cloud): authenticate with the API key; the platform owns the
  // storage, so the object-store credentials don't apply.
  if (apiKey) {
    connectOptions.apiKey = apiKey;
  } else {
    console.error(
      "INFINO_MCP_URI is a hosted https:// endpoint but INFINO_API_KEY is not " +
        "set — requests will likely be rejected with an authentication error.",
    );
  }
} else {
  if (Object.keys(storageOptions).length > 0) connectOptions.storageOptions = storageOptions;
  if (apiKey) {
    console.error(
      "INFINO_API_KEY is set but INFINO_MCP_URI is not a hosted https:// " +
        "endpoint — the key is ignored for local and object-storage connections.",
    );
  }
}
if (validate) connectOptions.validate = true;

let db: ReturnType<typeof connect>;
try {
  db = connect(uri, connectOptions);
} catch (err) {
  console.error(`Failed to connect to ${uri}: ${errText(err)}`);
  process.exit(1);
}

// Writes (infino_add_documents) are off unless explicitly enabled, so the
// default install is read-only and the write tool isn't even advertised.
const writesEnabled = ["1", "true", "yes"].includes(
  (process.env.INFINO_MCP_ENABLE_WRITES ?? "").toLowerCase(),
);

// --- helpers ---------------------------------------------------------------

// `_id` comes back as a bigint, which JSON can't serialize — render it as a string.
const toText = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: toText(value) }] });

// Wall-clock of a synchronous engine call, so results can carry the true engine
// time (`took_ms`) — this excludes query embedding and the MCP/stdio transport,
// which the client can't isolate from its own round-trip timing.
function timed<T>(fn: () => T): { value: T; tookMs: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, tookMs: Math.round((performance.now() - t0) * 1000) / 1000 };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Substitute `{{name}}` placeholders in a SQL string with a query vector: embed
// each `embeds[name]` text with the server's embedder and inline it as a
// comma-separated float literal. This is what lets the vector_search /
// hybrid_search TVFs run from SQL (the engine itself never embeds). The
// injected values are model-generated floats, so there's no injection surface;
// a referenced placeholder with no supplied text is a hard error.
async function applyEmbeds(sql: string, embeds: Record<string, string> | undefined): Promise<string> {
  const referenced = new Set<string>();
  for (const m of sql.matchAll(PLACEHOLDER)) referenced.add(m[1]);
  if (referenced.size === 0) return sql;
  if (!embeds) {
    throw new Error(
      `query has placeholder(s) {{${[...referenced].join("}}, {{")}}} but no 'embed' map was provided`,
    );
  }
  const literals = new Map<string, string>();
  for (const name of referenced) {
    const text = embeds[name];
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`no 'embed' text supplied for placeholder {{${name}}}`);
    }
    const vec = await embed(text);
    literals.set(name, `'${Array.from(vec).join(",")}'`);
  }
  return sql.replace(PLACEHOLDER, (full, name) => literals.get(name) ?? full);
}
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

// Translate raw engine/transport errors into messages an agent (or human)
// can act on. Two sources of signal: the HTTP status a hosted (Infino Cloud)
// connection attaches to thrown errors, and the engine's index-metadata
// errors, which surface when a search needs an index the table wasn't
// created with.
function errText(err: unknown): string {
  const e = err as Error & { status?: number };
  const message = e?.message ?? String(err);
  if (/KV metadata key "inf\.fts\./.test(message)) {
    return (
      "this table has no full-text index, so keyword/BM25/hybrid search is " +
      "unavailable on it — query it with infino_sql instead, or recreate the " +
      "table with an FTS index on the text column"
    );
  }
  if (/KV metadata key "inf\.vec\./.test(message)) {
    return (
      "this table has no vector index, so semantic/hybrid search is " +
      "unavailable on it — query it with infino_sql instead, or recreate the " +
      "table with a vector index"
    );
  }
  if (e?.status === 503) {
    return "the database is starting up (transient 503) — retry in a few seconds";
  }
  if (e?.status === 404) {
    return `not found (404): ${message}`;
  }
  if (e?.status === 409) {
    return `already exists (409): ${message}`;
  }
  return message;
}

// When the caller doesn't name a column, infer the searchable text column.
// FTS indexes require LargeUtf8, so a LargeUtf8 column is almost certainly
// the indexed one; plain Utf8 columns are typically ids and short labels.
// Prefer LargeUtf8, fall back to the first Utf8. (An explicit `column`
// always overrides.)
function inferTextColumn(table: { schema(): { fields: Array<{ name: string; type: unknown }> } }):
  | string
  | undefined {
  const fields = table.schema().fields;
  const large = fields.find((f) => String(f.type).toLowerCase().includes("largeutf8"));
  if (large) return large.name;
  const any = fields.find((f) => String(f.type).toLowerCase().includes("utf8"));
  return any?.name;
}

// The first list-typed column (the vector index lives on a FixedSizeList<float32>).
function inferVectorColumn(table: { schema(): { fields: Array<{ name: string; type: unknown }> } }):
  | string
  | undefined {
  const field = table.schema().fields.find((f) => String(f.type).toLowerCase().includes("list"));
  return field?.name;
}

// When a table has a vector index, fill in a missing vector for each row by
// embedding its text column with the local model. Shared by the add and update
// write tools so an agent can pass plain text and never a raw vector.
type SchemaHandle = { schema(): { fields: Array<{ name: string; type: unknown }> } };
async function embedRows(
  handle: SchemaHandle,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const vecCol = inferVectorColumn(handle);
  if (!vecCol) return rows;
  const textCol = inferTextColumn(handle);
  return Promise.all(
    rows.map(async (doc) =>
      doc[vecCol] == null && textCol && typeof doc[textCol] === "string"
        ? { ...doc, [vecCol]: await embed(doc[textCol] as string) }
        : doc,
    ),
  );
}

// Search table functions are routed to the dedicated search tools instead of
// infino_sql. This is now a usability policy, not a technical limit: search
// Guard for infino_sql. The engine's search TVFs (bm25_search / vector_search /
// hybrid_search / token_match / exact_match) ARE allowed here — they compose
// with GROUP BY / joins / aggregates, which is the point of exposing SQL. The
// vector TVFs need a query vector, which applyEmbeds() supplies from {{name}}
// placeholders. The one restriction is the read-only policy (single statement,
// must start with SELECT/WITH), gated by the same INFINO_MCP_ENABLE_WRITES
// switch as infino_add_documents: off → read-only, so the default install can't
// write through SQL; on → any single statement (DDL/DML) is allowed.
function guardSql(sql: string, allowWrites: boolean): string {
  const stripped = sql.trim().replace(/;\s*$/, "");
  if (stripped.includes(";")) throw new Error("only a single statement is allowed");
  if (!allowWrites && !/^(select|with)\b/i.test(stripped)) {
    throw new Error(
      "only read-only SELECT / WITH queries are allowed (set INFINO_MCP_ENABLE_WRITES to permit DDL/DML through SQL)",
    );
  }
  return stripped;
}

// --- server ----------------------------------------------------------------

// Server-level instructions are returned to the client on initialize and shown
// to the model — the highest-leverage place to position Infino and steer which
// tool fires when. Kept factual and answer-first (no keyword stuffing).
const server = new McpServer(
  { name: "infino", version: "0.1.0" },
  {
    instructions:
      "Infino is an embedded retrieval engine for data on object storage: full-text (BM25), vector, " +
      "hybrid, and SQL search over one copy of the data, in-process, with no separate server or managed " +
      "service. These tools retrieve from a connected catalog of tables.\n\n" +
      "Pick a tool by the question shape:\n" +
      "- infino_keyword_search — literal terms, identifiers, error codes, names (ranked BM25).\n" +
      "- infino_semantic_search — meaning or paraphrase when the exact wording is unknown; its optional " +
      "'filter' restricts the ranking to rows matching a keyword predicate first.\n" +
      "- infino_hybrid_search — a query carrying both specific terms and an intent (fuses keyword + semantic in one pass).\n" +
      "- infino_sql — counts, joins, aggregates, and filtering by exact column value (structural, not relevance).\n" +
      "- infino_token_match / infino_exact_match — unranked keyword / exact-equality filters.\n" +
      "- infino_list_tables / infino_describe_table — discover the tables and their columns before searching.\n\n" +
      "The server is read-only by default; document writes (add/update/delete) and DDL/DML SQL are available " +
      "only when the operator has enabled writes.",
  },
);

server.registerTool(
  "infino_list_tables",
  {
    title: "List Infino tables",
    description:
      "List the tables in the connected catalog. Call this first to discover what is available to search or query.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok({ tables: db.listTables() });
    } catch (err) {
      return fail(`list_tables failed: ${errText(err)}`);
    }
  },
);

server.registerTool(
  "infino_describe_table",
  {
    title: "Describe an Infino table",
    description:
      "Return a table's column names and types — call before searching so you know which column to target and what " +
      "fields each result row carries.",
    inputSchema: {
      table: z.string().describe("Table name (from infino_list_tables)."),
    },
  },
  async ({ table }) => {
    try {
      const columns = db
        .openTable(table)
        .schema()
        .fields.map((f: { name: string; type: unknown }) => ({ name: f.name, type: String(f.type) }));
      return ok({ table, columns });
    } catch (err) {
      return fail(`describe_table failed: ${errText(err)}`);
    }
  },
);

// Build the returned-column projection for a search hit. A caller-supplied
// `columns` list is honored so clients can retrieve the fields they need
// (e.g. a path + line range to cite), with `_id` and `score` always appended
// so every hit keeps its id and ranking score. Defaults to the (searched)
// text column plus `_id`/`score`.
function searchProjection(
  columns: string[] | undefined,
  textCol: string | undefined,
): string[] {
  const base = columns && columns.length > 0 ? columns : textCol ? [textCol] : [];
  return [...new Set([...base, "_id", "score"])];
}

// What a hit's `score` means differs per tool, and the direction flips: the
// engine reports vector kNN as a distance and BM25/RRF as relevance. Every
// search response says which, so a client never ranks or thresholds backwards.
const SCORE_KIND = {
  semantic: "distance: lower is closer, 0 is an identical vector",
  keyword: "bm25 relevance: higher is better",
  hybrid: "reciprocal-rank fusion of keyword and semantic ranks: higher is better",
} as const;

server.registerTool(
  "infino_semantic_search",
  {
    title: "Semantic (vector) search",
    description:
      "Use when searching for a concept by meaning and the exact wording is unknown — this retrieves paraphrases and " +
      "synonyms, not just literal matches. Embeds the query with a local model (no API key) and ranks a table's " +
      "embedding column by vector similarity. Each hit carries a score that is a DISTANCE (lower is closer) plus the " +
      "columns you project ('columns'; the full text column by default). Optional 'filter' restricts the ranking to rows " +
      "whose keyword column matches a predicate first (a pushdown pre-filter, e.g. semantic search only within rows " +
      "tagged 'billing'). For exact terms use infino_keyword_search; when the query has both literal terms and an " +
      "intent use infino_hybrid_search.",
    inputSchema: {
      table: z.string().describe("Table to search."),
      query: z.string().describe("Query text; embedded and matched by vector similarity."),
      k: z.number().int().positive().max(100).default(10).describe("Maximum results."),
      column: z.string().optional().describe("Text column to return with each hit; inferred if omitted."),
      vectorColumn: z.string().optional().describe("Vector column to search; inferred if omitted."),
      columns: z
        .array(z.string())
        .optional()
        .describe(
          "Which of the table's columns each hit returns, with full values (a projection passed straight to the engine). Defaults to the text column; '_id' and 'score' are always included. Any column works: ['id'] for compact hits at a large k, ['id', 'text'] to get the full text alongside an id to cite, ['title', 'created_at'] for metadata. Nothing is truncated; read fewer columns or a smaller k to keep results small.",
        ),
      filter: z
        .object({
          column: z.string().describe("Keyword-indexed (FTS) column the predicate applies to."),
          query: z.string().describe("Terms the column must match."),
          mode: z
            .enum(["or", "and"])
            .optional()
            .describe("Match any term ('or', the default) or every term ('and')."),
        })
        .optional()
        .describe(
          "Pre-filter: rank the kNN only among rows whose FTS 'column' matches 'query' (a pushdown pre-filter, not a post-filter on the results).",
        ),
    },
  },
  async ({ table, query, k, column, vectorColumn, columns, filter }) => {
    try {
      const handle = db.openTable(table);
      const vecCol = vectorColumn ?? inferVectorColumn(handle);
      if (!vecCol) return fail(`semantic_search: no vector column in '${table}' — pass 'vectorColumn'.`);
      const textCol = column ?? inferTextColumn(handle);
      const vector = await embed(query);
      const projection = searchProjection(columns, textCol);
      const { value: results, tookMs } = timed(() => handle.vectorSearch(vecCol, vector, k, { projection, filter }));
      return ok({
        table,
        query,
        score_kind: SCORE_KIND.semantic,
        results,
        took_ms: tookMs,
      });
    } catch (err) {
      return fail(`semantic_search failed: ${errText(err)}`);
    }
  },
);

server.registerTool(
  "infino_keyword_search",
  {
    title: "Keyword (BM25) search",
    description:
      "Use when the query is literal terms — identifiers, error codes, product names, exact phrases — and you want " +
      "results ranked by relevance. BM25 full-text search over a text column: ranks rows by how well the query's " +
      "tokens (and their stems) match, each with a relevance score (higher is better) plus the columns you project " +
      "('columns'; the full text column by default). Matches exact tokens, not synonyms or paraphrases. " +
      "Prefer this over SQL LIKE for known literal terms. For meaning-based search use infino_semantic_search; for " +
      "both at once use infino_hybrid_search.",
    inputSchema: {
      table: z.string().describe("Table to search."),
      query: z.string().describe("Query terms, matched as literal tokens."),
      k: z.number().int().positive().max(100).default(10).describe("Maximum results to return."),
      column: z
        .string()
        .optional()
        .describe("Text column to search; inferred from the table schema when omitted."),
      columns: z
        .array(z.string())
        .optional()
        .describe(
          "Which of the table's columns each hit returns, with full values (a projection passed straight to the engine). Defaults to the searched column; '_id' and 'score' are always included. Any column works: ['id'] for compact hits at a large k, ['id', 'text'] to get the full text alongside an id to cite, ['title', 'created_at'] for metadata. Nothing is truncated; read fewer columns or a smaller k to keep results small.",
        ),
    },
  },
  async ({ table, query, k, column, columns }) => {
    try {
      const handle = db.openTable(table);
      const col = column ?? inferTextColumn(handle);
      if (!col) {
        return fail(`keyword_search: no text column found in '${table}' — pass 'column' explicitly.`);
      }
      const { value: results, tookMs } = timed(() =>
        handle.bm25Search(col, query, k, { projection: searchProjection(columns, col) }),
      );
      return ok({
        table,
        column: col,
        query,
        score_kind: SCORE_KIND.keyword,
        results,
        took_ms: tookMs,
      });
    } catch (err) {
      return fail(`keyword_search failed: ${errText(err)}`);
    }
  },
);

server.registerTool(
  "infino_hybrid_search",
  {
    title: "Hybrid (keyword + semantic) search",
    description:
      "Use when a query carries both specific terms and an intent — you want exact-term precision without giving up " +
      "paraphrase recall. Fuses BM25 over a text column with vector similarity over the embedding column in a single " +
      "ranking pass, so rows matching the literal terms AND the meaning rank highest; the score is the fused rank " +
      "(higher is better) plus the columns you project ('columns'; the full text column by default). Embeds the query with a local " +
      "model (no API key). Sits between infino_keyword_search (literal only) and infino_semantic_search (meaning only).",
    inputSchema: {
      table: z.string().describe("Table to search."),
      query: z.string().describe("Query text; matched as keyword terms AND embedded for vector similarity."),
      k: z.number().int().positive().max(100).default(10).describe("Maximum results."),
      column: z.string().optional().describe("Text column for the keyword half; inferred if omitted."),
      vectorColumn: z.string().optional().describe("Vector column for the semantic half; inferred if omitted."),
      columns: z
        .array(z.string())
        .optional()
        .describe(
          "Which of the table's columns each hit returns, with full values (a projection passed straight to the engine). Defaults to the text column; '_id' and 'score' are always included. Any column works: ['id'] for compact hits at a large k, ['id', 'text'] to get the full text alongside an id to cite, ['title', 'created_at'] for metadata. Nothing is truncated; read fewer columns or a smaller k to keep results small.",
        ),
    },
  },
  async ({ table, query, k, column, vectorColumn, columns }) => {
    try {
      const handle = db.openTable(table);
      const textCol = column ?? inferTextColumn(handle);
      if (!textCol) return fail(`hybrid_search: no text column in '${table}' — pass 'column'.`);
      const vecCol = vectorColumn ?? inferVectorColumn(handle);
      if (!vecCol) return fail(`hybrid_search: no vector column in '${table}' — pass 'vectorColumn'.`);
      const vector = await embed(query);
      const { value: results, tookMs } = timed(() =>
        handle.hybridSearch(textCol, query, vecCol, vector, k, {
          projection: searchProjection(columns, textCol),
        }),
      );
      return ok({
        table,
        query,
        score_kind: SCORE_KIND.hybrid,
        results,
        took_ms: tookMs,
      });
    } catch (err) {
      return fail(`hybrid_search failed: ${errText(err)}`);
    }
  },
);

server.registerTool(
  "infino_token_match",
  {
    title: "Token match (unranked keyword filter)",
    description:
      "Use when you need the SET of rows containing a keyword, not a ranked order — a fast unranked keyword filter. " +
      "Returns rows whose text column contains the token(s), matching indexed tokens and their stems. For ranked " +
      "results use infino_keyword_search; for analytical filtering across columns use infino_sql.",
    inputSchema: {
      table: z.string().describe("Table to search."),
      query: z.string().describe("Token(s) to match."),
      column: z.string().optional().describe("Text column to match; inferred if omitted."),
      mode: z
        .enum(["or", "and"])
        .optional()
        .describe("Match any token ('or', the default) or every token ('and')."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .default(100)
        .describe("Max rows to return; matches beyond this are counted in 'matched' but not returned."),
    },
  },
  async ({ table, query, column, mode, limit }) => {
    try {
      const handle = db.openTable(table);
      const col = column ?? inferTextColumn(handle);
      if (!col) return fail(`token_match: no text column in '${table}' — pass 'column'.`);
      const { value: rows, tookMs } = timed(() => handle.tokenMatch(col, query, { mode, projection: [col, "_id"] }));
      return ok({ table, column: col, query, matched: rows.length, results: rows.slice(0, limit), took_ms: tookMs });
    } catch (err) {
      return fail(`token_match failed: ${errText(err)}`);
    }
  },
);

server.registerTool(
  "infino_exact_match",
  {
    title: "Exact match (unranked exact filter)",
    description:
      "Use to fetch rows whose column exactly equals a value — a tag, status, or id string. Unranked exact-equality " +
      "filter over an indexed column. For ranked text relevance use infino_keyword_search; for multi-column " +
      "analytical filtering use infino_sql.",
    inputSchema: {
      table: z.string().describe("Table to search."),
      value: z.string().describe("The exact value the column must equal."),
      column: z.string().optional().describe("Column to match; inferred (first text column) if omitted."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .default(100)
        .describe("Max rows to return; matches beyond this are counted in 'matched' but not returned."),
    },
  },
  async ({ table, value, column, limit }) => {
    try {
      const handle = db.openTable(table);
      const col = column ?? inferTextColumn(handle);
      if (!col) return fail(`exact_match: no column found in '${table}' — pass 'column'.`);
      const { value: rows, tookMs } = timed(() => handle.exactMatch(col, value, { projection: [col, "_id"] }));
      return ok({ table, column: col, value, matched: rows.length, results: rows.slice(0, limit), took_ms: tookMs });
    } catch (err) {
      return fail(`exact_match failed: ${errText(err)}`);
    }
  },
);

server.registerTool(
  "infino_count",
  {
    title: "Count keyword matches",
    description:
      "Use when you only need HOW MANY rows match a keyword query, not the rows themselves — a fast tally over a text " +
      "column, without fetching or ranking. Cheaper than infino_keyword_search when a number is all you need (e.g. " +
      "'how many docs mention X'). For the matching rows use infino_keyword_search or infino_token_match.",
    inputSchema: {
      table: z.string().describe("Table to search."),
      query: z.string().describe("Query terms, matched as literal tokens."),
      column: z
        .string()
        .optional()
        .describe("Text column to search; inferred from the table schema when omitted."),
      mode: z
        .enum(["or", "and"])
        .optional()
        .describe("Match any token ('or', the default) or every token ('and')."),
    },
  },
  async ({ table, query, column, mode }) => {
    try {
      const handle = db.openTable(table);
      const col = column ?? inferTextColumn(handle);
      if (!col) {
        return fail(`count: no text column found in '${table}' — pass 'column' explicitly.`);
      }
      const { value: count, tookMs } = timed(() => handle.count(col, query, { mode }));
      return ok({ table, column: col, query, count, took_ms: tookMs });
    } catch (err) {
      return fail(`count failed: ${errText(err)}`);
    }
  },
);

server.registerTool(
  "infino_sql",
  {
    title: "SQL over Infino",
    description:
      "Use for structural or analytical questions — counts, GROUP BY, joins, aggregates, filtering by column value — " +
      "returning result rows. The engine's search functions are callable as table-valued relations, so a single query " +
      "can rank AND aggregate: bm25_search('table','text_col','terms', k) — also bm25_search_prefix / token_match / " +
      "exact_match — need no embedding. vector_search('table','vec_col', {{q}}, k) and " +
      "hybrid_search('table','text_col','terms','vec_col', {{q}}, k) need a query vector: put a {{name}} placeholder " +
      "where the vector goes and pass embed:{\"name\":\"query text\"} — the server embeds the text and substitutes the " +
      "vector in. Example: SELECT path, SUM(end_line - start_line + 1) AS lines FROM " +
      "bm25_search('docs','body','error timeout', 300) GROUP BY path ORDER BY lines DESC. " +
      (writesEnabled
        ? "Any single statement is allowed (including DDL/DML), since INFINO_MCP_ENABLE_WRITES is set."
        : "Read-only: a single SELECT / WITH statement; DDL/DML is rejected."),
    inputSchema: {
      query: writesEnabled
        ? z.string().describe("A single SQL statement. May use search TVFs and {{name}} vector placeholders.")
        : z
            .string()
            .describe("A single read-only SELECT or WITH statement. May use search TVFs and {{name}} vector placeholders."),
      embed: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Map of placeholder name -> query text. Each text is embedded with the server's embedder and its vector " +
            "is substituted for every {{name}} in the query — required to use vector_search / hybrid_search. " +
            'E.g. {"q":"error timeout"} fills {{q}}.',
        ),
    },
  },
  async ({ query, embed: embeds }) => {
    try {
      const sql = await applyEmbeds(query, embeds as Record<string, string> | undefined);
      const { value: rows, tookMs } = timed(() => db.querySql(guardSql(sql, writesEnabled)));
      return ok({ rows, took_ms: tookMs });
    } catch (err) {
      return fail(`sql failed: ${errText(err)}`);
    }
  },
);

// Write tool — registered only when writes are enabled, so a read-only install
// never advertises it to the agent.
if (writesEnabled) {
  server.registerTool(
    "infino_add_documents",
    {
      title: "Add documents to an Infino table",
      description:
        "Append documents (rows, as JSON objects keyed by column name) to a table — one call is one commit. " +
        "If the table has a vector index and a document omits the vector, the server embeds its text column " +
        "(a local model, no API key). Available only because INFINO_MCP_ENABLE_WRITES is set.",
      inputSchema: {
        table: z.string().describe("Table to append to."),
        documents: z
          .array(z.record(z.string(), z.any()))
          .min(1)
          .describe("Rows to append, as JSON objects keyed by column name."),
      },
    },
    async ({ table, documents }) => {
      try {
        const handle = db.openTable(table);
        const rows = await embedRows(handle, documents as Array<Record<string, unknown>>);
        handle.append(rows);
        return ok({ table, appended: rows.length });
      } catch (err) {
        return fail(`add_documents failed: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    "infino_update_documents",
    {
      title: "Update documents in an Infino table",
      description:
        "Replace the rows matching a SQL predicate with new documents, 1:1 — the number of matched rows must equal " +
        "the number of replacement documents. As with add, a row that omits its vector has it embedded from the text " +
        "column (local model, no API key). Requires durable storage (not memory://). Available only because " +
        "INFINO_MCP_ENABLE_WRITES is set.",
      inputSchema: {
        table: z.string().describe("Table to update."),
        predicate: z
          .string()
          .describe("SQL predicate selecting the rows to replace, e.g. \"status = 'draft'\"."),
        documents: z
          .array(z.record(z.string(), z.any()))
          .min(1)
          .describe("Replacement rows, as JSON objects keyed by column name (one per matched row)."),
      },
    },
    async ({ table, predicate, documents }) => {
      try {
        const handle = db.openTable(table);
        const rows = await embedRows(handle, documents as Array<Record<string, unknown>>);
        const stats = handle.update(predicate, rows);
        return ok({ table, predicate, ...stats });
      } catch (err) {
        return fail(`update_documents failed: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    "infino_delete_documents",
    {
      title: "Delete documents from an Infino table",
      description:
        "Delete the rows matching a SQL predicate, e.g. \"status = 'spam'\". Returns how many rows matched and were " +
        "removed. Requires durable storage (not memory://). Available only because INFINO_MCP_ENABLE_WRITES is set.",
      inputSchema: {
        table: z.string().describe("Table to delete from."),
        predicate: z
          .string()
          .describe("SQL predicate selecting the rows to delete, e.g. \"status = 'spam'\"."),
      },
    },
    async ({ table, predicate }) => {
      try {
        const stats = db.openTable(table).delete(predicate);
        return ok({ table, predicate, ...stats });
      } catch (err) {
        return fail(`delete_documents failed: ${errText(err)}`);
      }
    },
  );
}

// --- transport -------------------------------------------------------------
// stdio for desktop/CLI clients (Claude Desktop/Code, Cursor). Logs go to
// stderr so they never corrupt the JSON-RPC stream on stdout.

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `infino MCP server ready on stdio (uri: ${uri}, mode: ${isHosted ? "hosted" : "embedded"}, ` +
    `writes: ${writesEnabled ? "on" : "off"}, embedder: ${embedderInfo()})`,
);
