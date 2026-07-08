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
// INFINO_MCP_URI (a local path, or the user's own s3://|az:// bucket).
// Credentials come from the standard AWS_*/AZURE_* environment variables. AWS
// S3 uses the default endpoint; for any S3-compatible store (Cloudflare R2,
// MinIO, Backblaze B2, …) set AWS_ENDPOINT_URL alongside the AWS_* keys.

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
        "own path or an s3://|az:// bucket.",
    );
    return dir;
  } catch (err) {
    console.error(
      `INFINO_MCP_URI not set and ${dir} is not writable ` +
        `(${(err as Error).message}) — serving an ephemeral in-process ` +
        "catalog (memory://).",
    );
    return "memory://";
  }
}

const uri = process.env.INFINO_MCP_URI ?? defaultUri();

// infino reads no credentials from the environment, so gather the standard
// provider variables here and hand them to connect as storageOptions, keyed
// by object_store's aws_*/azure_* config strings. Leaving them all unset
// falls back to ambient cloud identity (an IAM instance role or Azure managed
// identity).
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

// Opt into a connect-time probe so bad credentials or an unreachable bucket
// fail at startup instead of on the first search.
const validate = ["1", "true", "yes"].includes(
  (process.env.INFINO_MCP_VALIDATE ?? "").toLowerCase(),
);

const connectOptions: ConnectOptions = {};
if (Object.keys(storageOptions).length > 0) connectOptions.storageOptions = storageOptions;
if (validate) connectOptions.validate = true;

let db: ReturnType<typeof connect>;
try {
  db = connect(uri, connectOptions);
} catch (err) {
  console.error(`Failed to connect to ${uri}: ${(err as Error).message}`);
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
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

// When the caller doesn't name a column, search the first UTF-8 text column in
// the table's schema. (A table can have several; an explicit `column` overrides.)
function inferTextColumn(table: { schema(): { fields: Array<{ name: string; type: unknown }> } }):
  | string
  | undefined {
  const field = table.schema().fields.find((f) => String(f.type).toLowerCase().includes("utf8"));
  return field?.name;
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
// TVFs through query_sql work from this async host (they once aborted via the
// engine's blocking bridge; that's fixed). But hand-assembling a TVF call —
// especially a vector literal — is error-prone for an agent, so retrieval goes
// through the typed tools (infino_semantic_search / infino_keyword_search /
// infino_hybrid_search), which build the call internally.
const SEARCH_TVFS = ["bm25_search", "vector_search", "hybrid_search", "token_match", "exact_match"];

// Guard for infino_sql. Two layers:
//   - The search-TVF block is ALWAYS on. It is a usability policy: search TVFs
//     do work through query_sql now, but the typed retrieval tools are the
//     intended interface (they handle embedding and projection), so free-form
//     SQL is kept to filters/joins/aggregates and retrieval goes through them.
//   - The read-only restriction (single statement, must start with SELECT/WITH)
//     is policy, gated by the same INFINO_MCP_ENABLE_WRITES switch as
//     infino_add_documents. Off → read-only only, so the default install can't
//     write through SQL. On → any single statement (DDL/DML) is allowed, which
//     makes the binding's querySql fully reachable.
function guardSql(sql: string, allowWrites: boolean): string {
  const stripped = sql.trim().replace(/;\s*$/, "");
  if (stripped.includes(";")) throw new Error("only a single statement is allowed");
  const tvf = SEARCH_TVFS.find((fn) => new RegExp(`\\b${fn}\\s*\\(`, "i").test(stripped));
  if (tvf) {
    throw new Error(
      `${tvf}() isn't available through infino_sql — use the dedicated retrieval tools (infino_keyword_search, ` +
        `infino_semantic_search, infino_hybrid_search) instead. infino_sql is for filters, joins, and aggregates over your tables.`,
    );
  }
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
      return fail(`list_tables failed: ${(err as Error).message}`);
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
      return fail(`describe_table failed: ${(err as Error).message}`);
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

server.registerTool(
  "infino_semantic_search",
  {
    title: "Semantic (vector) search",
    description:
      "Use when searching for a concept by meaning and the exact wording is unknown — this retrieves paraphrases and " +
      "synonyms, not just literal matches. Embeds the query with a local model (no API key) and ranks a table's " +
      "embedding column by vector similarity, each hit with a score. Optional 'filter' restricts the ranking to rows " +
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
          "Columns to return with each hit (e.g. an id, path, or line range to cite). Defaults to the text column; '_id' and 'score' are always included.",
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
      const results = handle.vectorSearch(vecCol, vector, k, { projection, filter });
      return ok({ table, query, results });
    } catch (err) {
      return fail(`semantic_search failed: ${(err as Error).message}`);
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
      "tokens (and their stems) match, each with a relevance score. Matches exact tokens, not synonyms or paraphrases. " +
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
          "Columns to return with each hit (e.g. an id, path, or line range to cite). Defaults to the searched column; '_id' and 'score' are always included.",
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
      const results = handle.bm25Search(col, query, k, { projection: searchProjection(columns, col) });
      return ok({ table, column: col, query, results });
    } catch (err) {
      return fail(`keyword_search failed: ${(err as Error).message}`);
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
      "ranking pass, so rows matching the literal terms AND the meaning rank highest. Embeds the query with a local " +
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
          "Columns to return with each hit (e.g. an id, path, or line range to cite). Defaults to the text column; '_id' and 'score' are always included.",
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
      const results = handle.hybridSearch(textCol, query, vecCol, vector, k, {
        projection: searchProjection(columns, textCol),
      });
      return ok({ table, query, results });
    } catch (err) {
      return fail(`hybrid_search failed: ${(err as Error).message}`);
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
      const rows = handle.tokenMatch(col, query, { mode, projection: [col, "_id"] });
      return ok({ table, column: col, query, matched: rows.length, results: rows.slice(0, limit) });
    } catch (err) {
      return fail(`token_match failed: ${(err as Error).message}`);
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
      const rows = handle.exactMatch(col, value, { projection: [col, "_id"] });
      return ok({ table, column: col, value, matched: rows.length, results: rows.slice(0, limit) });
    } catch (err) {
      return fail(`exact_match failed: ${(err as Error).message}`);
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
      const count = handle.count(col, query, { mode });
      return ok({ table, column: col, query, count });
    } catch (err) {
      return fail(`count failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "infino_sql",
  {
    title: "SQL over Infino",
    description:
      "Use for structural or analytical questions — counts, GROUP BY, joins, aggregates, filtering by exact column " +
      "value — returning result rows. Row filters use literal/substring matching (e.g. LIKE), not ranked relevance, so " +
      "for ranked or meaning-based text search use infino_keyword_search / infino_semantic_search / infino_hybrid_search " +
      "instead (the engine's search table functions are not callable here). " +
      (writesEnabled
        ? "Any single statement is allowed (including DDL/DML), since INFINO_MCP_ENABLE_WRITES is set."
        : "Read-only: a single SELECT / WITH statement; DDL/DML is rejected."),
    inputSchema: {
      query: writesEnabled
        ? z.string().describe("A single SQL statement.")
        : z.string().describe("A single read-only SELECT or WITH statement."),
    },
  },
  async ({ query }) => {
    try {
      return ok({ rows: db.querySql(guardSql(query, writesEnabled)) });
    } catch (err) {
      return fail(`sql failed: ${(err as Error).message}`);
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
          .array(z.record(z.any()))
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
        return fail(`add_documents failed: ${(err as Error).message}`);
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
          .array(z.record(z.any()))
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
        return fail(`update_documents failed: ${(err as Error).message}`);
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
        return fail(`delete_documents failed: ${(err as Error).message}`);
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
  `infino MCP server ready on stdio (uri: ${uri}, writes: ${writesEnabled ? "on" : "off"}, embedder: ${embedderInfo()})`,
);
