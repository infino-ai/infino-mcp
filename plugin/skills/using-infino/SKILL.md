---
name: using-infino
description: How to retrieve from Infino — choosing keyword vs semantic vs hybrid search, SQL, and the catalog tools exposed by the Infino MCP server. Use when the user wants to search, query, retrieve, or recall from data stored in Infino or on object storage (S3/GCS/Azure).
---

# Using Infino for retrieval

Infino is an embedded retrieval engine over data on object storage: it runs
full-text (BM25), vector, hybrid, and SQL search over one copy of the data,
in-process, with no separate server. These tools (from the Infino MCP server)
operate on a connected catalog of tables.

## 1. Discover before you search

- **`infino_list_tables`** — list the tables in the catalog. Start here when you
  don't already know the table name.
- **`infino_describe_table`** — get a table's columns and types, so you know
  which column to target and what each result row carries.

## 2. Pick the right search tool by the question shape

- **`infino_keyword_search`** — literal terms: identifiers, error codes, product
  names, exact phrases. Ranked BM25. Use when the wording is known.
- **`infino_semantic_search`** — meaning/paraphrase when the exact wording is
  unknown. Pass `filter` (`{column, query}`) to first restrict to rows whose
  keyword column matches, then rank semantically within them.
- **`infino_hybrid_search`** — the query has *both* specific terms and an intent.
  Fuses keyword + vector in one ranking pass. A good default when unsure between
  keyword and semantic.
- **`infino_sql`** — structural/analytical questions: counts, GROUP BY, joins,
  aggregates, filtering by exact column value. Not for ranked relevance.
- **`infino_token_match` / `infino_exact_match`** — unranked filters: the set of
  rows containing a token, or rows where a column exactly equals a value.

Prefer the dedicated search tools over hand-writing SQL for retrieval — they
embed the query and project results for you.

## 3. Writes (only when the server has writes enabled)

If `INFINO_MCP_ENABLE_WRITES` is set, three more tools appear:
`infino_add_documents`, `infino_update_documents` (replace rows matching a SQL
predicate, 1:1), and `infino_delete_documents`. Missing vectors are embedded
from the text column automatically. Confirm intent with the user before writing.

## Tips

- Vectors are embedded locally (no API key); the table's vector index dimension
  must match the embedding model.
- `_id` comes back as a string; use it to fetch or mutate specific rows.
- If a tool reports "no vector column" or "no text column", call
  `infino_describe_table` first and pass the column explicitly.
