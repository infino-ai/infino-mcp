#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// MCP server for Infino. Lets an agent run retrieval and writes over data on
// object storage from any MCP client. Exposes catalog discovery and management
// (list/describe/create/drop), keyword (BM25), semantic (local-embedding
// vector), and hybrid (fused) search, unranked token/exact match, SQL, and
// document writes (add/update/delete).
//
// Scope rule: one tool per operation the `@infino-ai/infino` binding exposes,
// plus the one piece of glue the engine's bring-your-own-vectors model forces
// on an agent: turning text into a vector (see embedding.ts). Nothing else is
// invented here; bulk ingestion, chunking, and upsert live in the CLI, the
// SDKs, or the engine.
//
// The full surface is always advertised. Who may write is decided by the
// hosted API key's capabilities (a read-scoped key gets 403 on writes) and by
// whoever configured the local path or bucket credentials; how much a client
// confirms before a destructive call is the client's decision, driven by the
// tool annotations below. There is no server-side write gate.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect, IndexSpec, type ConnectOptions } from "@infino-ai/infino";
import { embed, embedMany, embedderDim, embedderInfo } from "./embedding.js";
import { errText as translate, guardSql } from "./guards.js";

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
      `INFINO_MCP_URI not set; using ${dir} (persistent). Set INFINO_MCP_URI to ` +
        "point at your own path, an s3://|az:// bucket, or a hosted " +
        "https://<host>/<database> endpoint.",
    );
    return dir;
  } catch (err) {
    console.error(
      `INFINO_MCP_URI not set and ${dir} is not writable ` +
        `(${translate(err)}); serving an ephemeral in-process ` +
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
  console.error(`Failed to connect to ${uri}: ${translate(err, { hosted: isHosted })}`);
  process.exit(1);
}


// Writes used to sit behind INFINO_MCP_ENABLE_WRITES. The variable is accepted
// and ignored so an existing config keeps booting; it is never honored, because
// honoring it would reintroduce the read-only mode this server no longer has.
if (process.env.INFINO_MCP_ENABLE_WRITES !== undefined) {
  console.error(
    "INFINO_MCP_ENABLE_WRITES is set but no longer read: writes are always on. " +
      "Remove the variable; scope the API key instead to restrict a hosted connection.",
  );
}

// --- helpers ---------------------------------------------------------------

// Tool annotations, per the MCP spec: the client reads these to decide what to
// confirm with its user. With no server-side write gate they are the safety
// signal, so every tool carries one. `openWorldHint` says whether the call
// leaves the machine, which on a hosted connection every one of them does.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: isHosted,
} as const;
// Adds data without replacing or removing any: a repeat is a duplicate, not a loss.
const ADDITIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: isHosted,
} as const;
const ADDITIVE_IDEMPOTENT = { ...ADDITIVE, idempotentHint: true } as const;
// May replace or remove data.
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: isHosted,
} as const;

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

// Error translation lives in guards.ts; this binds the connection mode so call
// sites only say what kind of operation failed.
const errText = (err: unknown, op?: "create" | "write") => translate(err, { op, hosted: isHosted });

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

// Rows arrive as JSON objects keyed by column name. Before they reach the
// binding: (1) a key that is not a column is an error naming it, because the
// binding builds columns from the schema and would otherwise drop the key
// silently; (2) int64 columns need BigInt, which JSON cannot carry, so numbers
// are widened here; (3) a row with no vector gets one from its text column.
// Shared by the add and update tools.
type SchemaHandle = { schema(): { fields: Array<{ name: string; type: unknown }> } };
async function prepareRows(
  handle: SchemaHandle,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ rows: Array<Record<string, unknown>>; embedded: number }> {
  const fields = handle.schema().fields as Array<{ name: string; type: unknown; nullable?: boolean }>;
  const columns = fields.map((f) => f.name);
  // A table created from a descriptor has no nullable columns, so a row that
  // omits one fails inside Arrow with a message about nullability. Name the
  // column instead. The vector column is exempt: embedRows fills it in.
  const vecCol = inferVectorColumn(handle);
  const required = fields.filter((f) => f.nullable === false && f.name !== vecCol).map((f) => f.name);
  rows.forEach((doc, i) => {
    for (const key of Object.keys(doc)) {
      if (!columns.includes(key)) {
        throw new Error(
          `document ${i}: '${key}' is not a column of this table (columns: ${columns.join(", ")})`,
        );
      }
    }
    const missing = required.filter((c) => doc[c] == null);
    if (missing.length > 0) {
      throw new Error(
        `document ${i}: missing ${missing.map((c) => `'${c}'`).join(", ")}; every column of this table is required in each row (columns: ${columns.join(", ")})`,
      );
    }
  });
  const int64 = fields.filter((f) => /int64/i.test(String(f.type))).map((f) => f.name);
  const widened =
    int64.length === 0
      ? rows
      : rows.map((doc) => {
          const out = { ...doc };
          for (const col of int64) {
            if (typeof out[col] === "number") out[col] = BigInt(Math.trunc(out[col] as number));
          }
          return out;
        });
  return embedRows(handle, widened, table);
}

// The configured embedder must produce vectors as wide as the table's vector
// column, or every vector written or searched is meaningless (and the engine
// rejects the width). Checked once per table and column, before the first
// embedding into or against it, so a mismatch names both numbers up front
// instead of surfacing as an Arrow length error.
const widthChecked = new Set<string>();
async function assertVectorWidth(handle: SchemaHandle, table: string, vecCol: string): Promise<void> {
  const key = `${table} ${vecCol}`;
  if (widthChecked.has(key)) return;
  const field = handle.schema().fields.find((f) => f.name === vecCol);
  const width = (field?.type as { listSize?: number } | undefined)?.listSize;
  const dim = await embedderDim();
  if (typeof width === "number" && width !== dim) {
    throw new Error(
      `the embedder produces ${dim}-dimensional vectors but '${vecCol}' in '${table}' is ${width}-dimensional; ` +
        "set INFINO_MCP_EMBED_MODEL (and provider) to the model that built this table, or recreate the table",
    );
  }
  widthChecked.add(key);
}

// When a table has a vector index, fill in a missing vector for each row by
// embedding its text column, every missing vector in one batched call.
// Returns the rows and how many were embedded.
async function embedRows(
  handle: SchemaHandle,
  rows: Array<Record<string, unknown>>,
  table: string,
): Promise<{ rows: Array<Record<string, unknown>>; embedded: number }> {
  const vecCol = inferVectorColumn(handle);
  if (!vecCol) return { rows, embedded: 0 };
  const textCol = inferTextColumn(handle);
  const pending: number[] = [];
  rows.forEach((doc, i) => {
    if (doc[vecCol] == null && textCol && typeof doc[textCol] === "string") pending.push(i);
  });
  if (pending.length === 0) return { rows, embedded: 0 };
  await assertVectorWidth(handle, table, vecCol);
  const vectors = await embedMany(pending.map((i) => rows[i][textCol as string] as string));
  const out = rows.slice();
  pending.forEach((i, n) => (out[i] = { ...out[i], [vecCol]: vectors[n] }));
  return { rows: out, embedded: pending.length };
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
      "Writing data, in order: infino_create_database if a hosted database answers 404; infino_create_table " +
      "with a utf8 key column, large_utf8 text columns, and vector: true for semantic search (the server sizes " +
      "the vector column to its embedder); infino_add_documents with tens of rows per call, always including " +
      "the key; rows without a vector are embedded from their text. To replace rows, infino_delete_documents " +
      "by key predicate then add again; before any delete, check the predicate with infino_count or infino_sql. " +
      "Every write is one commit and is durable when the tool returns. For a whole corpus use the infino CLI " +
      "(infino ingest) or an SDK, not this server. There is no server-side write gate: the API key's " +
      "capabilities decide what a hosted connection may do, and you are responsible for what you change.",
  },
);

server.registerTool(
  "infino_list_tables",
  {
    title: "List Infino tables",
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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

// --- catalog management ------------------------------------------------------

server.registerTool(
  "infino_create_database",
  {
    title: "Create the database this server is connected to",
    annotations: ADDITIVE_IDEMPOTENT,
    description:
      "Provision the database named in the connection. On Infino Cloud this registers the database; on a " +
      "local path or bucket the catalog root is the database, so this is a no-op success. Idempotent: an " +
      "existing database is reported as created: false. Call it when a hosted connection answers 404.",
    inputSchema: {},
  },
  async () => {
    try {
      db.createDatabase();
      return ok({ created: true });
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e?.status === 409) return ok({ created: false, note: "database already exists" });
      return fail(`create_database failed: ${errText(err, "create")}`);
    }
  },
);

// The scalar column types the binding's schema descriptor accepts. Full-text
// indexes require large_utf8, which is why the descriptor spells both string
// widths out instead of offering a single "string".
const COLUMN_TYPES = ["utf8", "large_utf8", "bool", "int32", "int64", "float32", "float64"] as const;
// Name of the vector column `vector: true` adds. Fixed so the skill, the
// searches' column inference, and the tables the server creates all agree.
const VECTOR_COLUMN = "embedding";

server.registerTool(
  "infino_create_table",
  {
    title: "Create an Infino table",
    annotations: ADDITIVE,
    description:
      "Create a table from a {column: type} descriptor. Full-text (BM25) indexes go on the columns named in " +
      "'fts' (default: every large_utf8 column; the index requires that type). With vector: true the server " +
      "adds an 'embedding' column sized to its embedder and a cosine vector index on it, so semantic and hybrid " +
      "search work and rows added without a vector are embedded from their text. Every column is required in " +
      "every row you add, so declare only columns you will always fill. Give every table a stable key " +
      "column of type utf8 so rows can be replaced or removed later by predicate (e.g. key = 'doc-1'); keep " +
      "utf8 for ids and short labels and large_utf8 for the text to search, so the searches infer the right column.",
    inputSchema: {
      table: z.string().describe("Table name."),
      columns: z
        .record(z.string(), z.enum(COLUMN_TYPES))
        .describe(
          "Columns as {name: type}. large_utf8 for text to search; utf8 for a key, ids, and short labels.",
        ),
      fts: z
        .array(z.string())
        .optional()
        .describe("Columns to full-text index. Default: every large_utf8 column. Must be large_utf8."),
      vector: z
        .boolean()
        .optional()
        .describe(
          "Add an 'embedding' vector column sized to the server's embedder, with a cosine index. Default false.",
        ),
    },
  },
  async ({ table, columns, fts, vector }) => {
    try {
      const descriptor = { ...columns } as Record<string, string | { vector: number }>;
      const vectorColumns: string[] = [];
      let spec = new IndexSpec();
      if (vector) {
        if (VECTOR_COLUMN in descriptor) {
          return fail(
            `create_table: '${VECTOR_COLUMN}' is reserved for the vector column that vector: true adds; rename it.`,
          );
        }
        const dim = await embedderDim();
        descriptor[VECTOR_COLUMN] = { vector: dim };
        spec = spec.vector(VECTOR_COLUMN, dim, "cosine");
        vectorColumns.push(VECTOR_COLUMN);
      }
      const ftsColumns =
        fts ?? Object.entries(columns).filter(([, t]) => t === "large_utf8").map(([n]) => n);
      for (const col of ftsColumns) {
        if (!(col in descriptor)) return fail(`create_table: fts column '${col}' is not in 'columns'.`);
        if (descriptor[col] !== "large_utf8") {
          return fail(
            `create_table: fts column '${col}' is ${descriptor[col]}; a full-text index requires large_utf8.`,
          );
        }
      }
      for (const col of ftsColumns) spec = spec.fts(col);
      const handle = db.createTable(table, descriptor, spec);
      const schema = handle
        .schema()
        .fields.map((f: { name: string; type: unknown }) => ({ name: f.name, type: String(f.type) }));
      return ok({ table, columns: schema, indexes: { fts: ftsColumns, vector: vectorColumns } });
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e?.status === 409 || /already ?exists/i.test(e?.message ?? "")) {
        return fail(`create_table: table '${table}' already exists; inspect it with infino_describe_table.`);
      }
      return fail(`create_table failed: ${errText(err, "create")}`);
    }
  },
);

server.registerTool(
  "infino_drop_table",
  {
    title: "Drop an Infino table",
    annotations: DESTRUCTIVE,
    description:
      "Drop a table from the catalog and, by default, delete its storage objects too. Pass purge: false to only " +
      "unregister the table and leave the bytes in place. Irreversible.",
    inputSchema: {
      table: z.string().describe("Table to drop."),
      purge: z
        .boolean()
        .optional()
        .describe("Also delete the table's storage objects. Default true; false only unregisters the name."),
    },
  },
  async ({ table, purge }) => {
    try {
      const reclaim = purge ?? true;
      db.dropTable(table, reclaim);
      return ok({ table, dropped: true, purged: reclaim });
    } catch (err) {
      return fail(`drop_table failed: ${errText(err, "write")}`);
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
    annotations: READ_ONLY,
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
      await assertVectorWidth(handle, table, vecCol);
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
    annotations: READ_ONLY,
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
      mode: z
        .enum(["or", "and"])
        .optional()
        .describe("Match any query token ('or', the default) or require every token ('and')."),
      stats: z
        .enum(["per_superfile", "global"])
        .optional()
        .describe(
          "BM25 statistics scope: 'per_superfile' (the default; each segment scored against its own statistics) or 'global' (one table-wide idf, so a table written in many small batches ranks like one corpus).",
        ),
      columns: z
        .array(z.string())
        .optional()
        .describe(
          "Which of the table's columns each hit returns, with full values (a projection passed straight to the engine). Defaults to the searched column; '_id' and 'score' are always included. Any column works: ['id'] for compact hits at a large k, ['id', 'text'] to get the full text alongside an id to cite, ['title', 'created_at'] for metadata. Nothing is truncated; read fewer columns or a smaller k to keep results small.",
        ),
    },
  },
  async ({ table, query, k, column, mode, stats, columns }) => {
    try {
      const handle = db.openTable(table);
      const col = column ?? inferTextColumn(handle);
      if (!col) {
        return fail(`keyword_search: no text column found in '${table}' — pass 'column' explicitly.`);
      }
      const { value: results, tookMs } = timed(() =>
        handle.bm25Search(col, query, k, { mode, stats, projection: searchProjection(columns, col) }),
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
    annotations: READ_ONLY,
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
      mode: z
        .enum(["or", "and"])
        .optional()
        .describe("Keyword half: match any query token ('or', the default) or require every token ('and')."),
      columns: z
        .array(z.string())
        .optional()
        .describe(
          "Which of the table's columns each hit returns, with full values (a projection passed straight to the engine). Defaults to the text column; '_id' and 'score' are always included. Any column works: ['id'] for compact hits at a large k, ['id', 'text'] to get the full text alongside an id to cite, ['title', 'created_at'] for metadata. Nothing is truncated; read fewer columns or a smaller k to keep results small.",
        ),
    },
  },
  async ({ table, query, k, column, vectorColumn, mode, columns }) => {
    try {
      const handle = db.openTable(table);
      const textCol = column ?? inferTextColumn(handle);
      if (!textCol) return fail(`hybrid_search: no text column in '${table}' — pass 'column'.`);
      const vecCol = vectorColumn ?? inferVectorColumn(handle);
      if (!vecCol) return fail(`hybrid_search: no vector column in '${table}' — pass 'vectorColumn'.`);
      await assertVectorWidth(handle, table, vecCol);
      const vector = await embed(query);
      const { value: results, tookMs } = timed(() =>
        handle.hybridSearch(textCol, query, vecCol, vector, k, {
          mode,
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
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: DESTRUCTIVE,
    description:
      "Use for structural or analytical questions — counts, GROUP BY, joins, aggregates, filtering by column value — " +
      "returning result rows. The engine's search functions are callable as table-valued relations, so a single query " +
      "can rank AND aggregate: bm25_search('table','text_col','terms', k) — also bm25_search_prefix / token_match / " +
      "exact_match — need no embedding. vector_search('table','vec_col', {{q}}, k) and " +
      "hybrid_search('table','text_col','terms','vec_col', {{q}}, k) need a query vector: put a {{name}} placeholder " +
      "where the vector goes and pass embed:{\"name\":\"query text\"} — the server embeds the text and substitutes the " +
      "vector in. Example: SELECT path, SUM(end_line - start_line + 1) AS lines FROM " +
      "bm25_search('docs','body','error timeout', 300) GROUP BY path ORDER BY lines DESC. " +
      "Any single statement is allowed, DDL/DML included.",
    inputSchema: {
      query: z.string().describe("A single SQL statement. May use search TVFs and {{name}} vector placeholders."),
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
      const { value: rows, tookMs } = timed(() => db.querySql(guardSql(sql)));
      return ok({ rows, took_ms: tookMs });
    } catch (err) {
      return fail(`sql failed: ${errText(err)}`);
    }
  },
);

// --- document writes ---------------------------------------------------------

server.registerTool(
  "infino_add_documents",
  {
    title: "Add documents to an Infino table",
    annotations: ADDITIVE,
    description:
      "Append documents (rows, as JSON objects keyed by column name) to a table; one call is one commit. " +
      "If the table has a vector index and a document omits the vector, the server embeds its text column " +
      "(a local model, no API key). Send tens of rows per call; for a whole corpus use the infino CLI or an SDK.",
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
      const { rows, embedded } = await prepareRows(handle, table, documents as Array<Record<string, unknown>>);
      const { tookMs } = timed(() => handle.append(rows));
      return ok({
        table,
        appended: rows.length,
        embedded,
        took_ms: tookMs,
        verify: `infino_count or a search on '${table}' shows the new rows`,
      });
    } catch (err) {
      return fail(`add_documents failed: ${errText(err, "write")}`);
    }
  },
);

server.registerTool(
  "infino_update_documents",
  {
    title: "Update documents in an Infino table",
    annotations: DESTRUCTIVE,
    description:
      "Replace the rows matching a SQL predicate with new documents, 1:1; the number of matched rows must equal " +
      "the number of replacement documents. As with add, a row that omits its vector has it embedded from the text " +
      "column (local model, no API key). Requires durable storage (not memory://).",
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
      const { rows, embedded } = await prepareRows(handle, table, documents as Array<Record<string, unknown>>);
      const stats = handle.update(predicate, rows);
      return ok({ table, predicate, ...stats, embedded });
    } catch (err) {
      return fail(`update_documents failed: ${errText(err, "write")}`);
    }
  },
);

server.registerTool(
  "infino_delete_documents",
  {
    title: "Delete documents from an Infino table",
    annotations: DESTRUCTIVE,
    description:
      "Delete the rows matching a SQL predicate, e.g. \"status = 'spam'\". Returns how many rows matched and were " +
      "removed. Check the predicate first with infino_count or infino_sql. Requires durable storage (not memory://).",
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
      return fail(`delete_documents failed: ${errText(err, "write")}`);
    }
  },
);

// --- transport -------------------------------------------------------------
// stdio for desktop/CLI clients (Claude Desktop/Code, Cursor). Logs go to
// stderr so they never corrupt the JSON-RPC stream on stdout.

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `infino MCP server ready on stdio (uri: ${uri}, mode: ${isHosted ? "hosted" : "embedded"}, ` +
    `embedder: ${embedderInfo()})`,
);
