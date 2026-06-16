#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// MCP server for Infino — lets an agent run retrieval over data on object
// storage from any MCP client. Exposes catalog discovery (list/describe),
// keyword (BM25) and semantic (local-embedding vector) search, and read-only
// SQL; document writes and full SQL are opt-in behind INFINO_MCP_ENABLE_WRITES.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect, type ConnectOptions } from "infino";
import { embed, embedderInfo } from "./embedding.js";

// --- connection (env-configured, opened once at startup) -------------------
//
// The agent never manages connections: the server is pointed at the data via
// INFINO_MCP_URI (a local path, or the user's own s3://|gs://|az:// bucket).
// AWS S3 uses the default endpoint + ambient AWS_* creds. For any other
// S3-compatible store (Cloudflare R2, MinIO, Backblaze B2, …) set
// INFINO_MCP_S3_ENDPOINT (and optionally INFINO_MCP_S3_REGION) alongside
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. GCS/Azure use GOOGLE_*/AZURE_* creds.

const uri = process.env.INFINO_MCP_URI;
if (!uri) {
  console.error(
    "INFINO_MCP_URI is required — a local path (e.g. /Users/me/.infino/memory) " +
      "or an s3://|gs://|az:// URI for the data to serve.",
  );
  process.exit(1);
}

// A custom S3 endpoint (non-AWS S3-compatible store) requires the region and
// access/secret keys to be supplied with it; AWS S3 needs none of this.
let connectOptions: ConnectOptions | undefined;
const s3Endpoint = process.env.INFINO_MCP_S3_ENDPOINT;
if (s3Endpoint) {
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) {
    console.error(
      "INFINO_MCP_S3_ENDPOINT is set but AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are missing.",
    );
    process.exit(1);
  }
  connectOptions = {
    endpoint: s3Endpoint,
    region: process.env.INFINO_MCP_S3_REGION ?? "auto",
    accessKey,
    secretKey,
  };
}

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

// Search table functions are routed to the dedicated search tools instead of
// infino_sql: calling one inside query_sql currently takes the engine's
// multi-thread-only blocking bridge, which aborts when invoked from this
// (async) host. Rejecting them here keeps the SQL tool to the paths that work
// from the server today (plain filters/joins/aggregates); retrieval goes
// through infino_semantic_search / infino_keyword_search.
const SEARCH_TVFS = ["bm25_search", "vector_search", "hybrid_search", "token_match", "exact_match"];

// Guard for infino_sql. Two layers:
//   - The search-TVF block is ALWAYS on. It is not a policy choice: calling a
//     search table function inside query_sql takes the engine's
//     multi-thread-only blocking bridge, which aborts this (async) host. So it
//     is rejected regardless of the writes flag — retrieval goes through
//     infino_semantic_search / infino_keyword_search.
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
      `${tvf}() in SQL isn't supported from the MCP server yet — use infino_semantic_search or ` +
        `infino_keyword_search for retrieval. infino_sql is for filters, joins, and aggregates over your tables.`,
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

const server = new McpServer({ name: "infino", version: "0.1.0" });

server.registerTool(
  "infino_list_tables",
  {
    title: "List Infino tables",
    description: "List the names of the tables in the connected Infino catalog.",
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
      "Return a table's column names and types, so you know which column to search and what fields each result row carries.",
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

server.registerTool(
  "infino_semantic_search",
  {
    title: "Semantic (vector) search",
    description:
      "Vector similarity search over a table's embedding column. Embeds the query text with a local model (no API " +
      "key), then returns the rows whose stored vectors are nearest, each with a similarity score. Matches on meaning, " +
      "so it also retrieves paraphrases and synonyms of the query, not only literal term matches. Prefer this over " +
      "SQL LIKE when searching a free-text column for a concept whose exact wording is unknown (it retrieves paraphrases).",
    inputSchema: {
      table: z.string().describe("Table to search."),
      query: z.string().describe("Query text; embedded and matched by vector similarity."),
      k: z.number().int().positive().max(100).default(10).describe("Maximum results."),
      column: z.string().optional().describe("Text column to return with each hit; inferred if omitted."),
      vectorColumn: z.string().optional().describe("Vector column to search; inferred if omitted."),
    },
  },
  async ({ table, query, k, column, vectorColumn }) => {
    try {
      const handle = db.openTable(table);
      const vecCol = vectorColumn ?? inferVectorColumn(handle);
      if (!vecCol) return fail(`semantic_search: no vector column in '${table}' — pass 'vectorColumn'.`);
      const textCol = column ?? inferTextColumn(handle);
      const vector = await embed(query);
      const projection = textCol ? [textCol, "_id", "score"] : ["_id", "score"];
      const results = handle.vectorSearch(vecCol, vector, k, { projection });
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
      "BM25 full-text search over a text column. Ranks rows by how well the query's literal terms match the column's " +
      "tokens, returning each with a relevance score. Matches exact tokens (and their stems), not synonyms or " +
      "paraphrases. No API key. Prefer this over SQL LIKE when searching a free-text column for known literal terms " +
      "(error codes, names, exact phrases) and you want results ranked by relevance.",
    inputSchema: {
      table: z.string().describe("Table to search."),
      query: z.string().describe("Query terms, matched as literal tokens."),
      k: z.number().int().positive().max(100).default(10).describe("Maximum results to return."),
      column: z
        .string()
        .optional()
        .describe("Text column to search; inferred from the table schema when omitted."),
    },
  },
  async ({ table, query, k, column }) => {
    try {
      const handle = db.openTable(table);
      const col = column ?? inferTextColumn(handle);
      if (!col) {
        return fail(`keyword_search: no text column found in '${table}' — pass 'column' explicitly.`);
      }
      const results = handle.bm25Search(col, query, k, { projection: [col, "_id", "score"] });
      return ok({ table, column: col, query, results });
    } catch (err) {
      return fail(`keyword_search failed: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "infino_sql",
  {
    title: "SQL over Infino",
    description:
      "Run SQL over the catalog's tables — counts, GROUP BY, filtering by column value, joins, aggregates — returning " +
      "result rows. Row filters use literal/substring matching (e.g. LIKE), not ranked relevance. The engine's search " +
      "table functions (bm25_search, vector_search) are not callable from SQL on this server. For ranked or " +
      "meaning-based text search, use the infino_keyword_search and infino_semantic_search tools instead. " +
      "Prefer this for structural or analytical questions (counts, joins, filtering by an exact column value), " +
      "not for finding text by relevance. " +
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
        const vecCol = inferVectorColumn(handle);
        const textCol = inferTextColumn(handle);
        let rows = documents as Array<Record<string, unknown>>;
        if (vecCol) {
          // Embed the text column into the vector column for rows that omit it.
          rows = await Promise.all(
            rows.map(async (doc) =>
              doc[vecCol] == null && textCol && typeof doc[textCol] === "string"
                ? { ...doc, [vecCol]: await embed(doc[textCol] as string) }
                : doc,
            ),
          );
        }
        handle.append(rows);
        return ok({ table, appended: rows.length });
      } catch (err) {
        return fail(`add_documents failed: ${(err as Error).message}`);
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
