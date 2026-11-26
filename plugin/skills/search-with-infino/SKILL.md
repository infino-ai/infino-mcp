---
name: search-with-infino
description: Add search to an application with Infino, an open-source embedded library for BM25 full-text, vector, hybrid and SQL search over Parquet files on local disk or S3. Use when the user asks to add search, semantic search, keyword search, hybrid search, RAG retrieval, agent memory or a vector store to Python, Node.js or Rust code, wants search without running a server or cluster, or wants to search data that already lives in Parquet or object storage.
---

# Search with Infino

Infino is a library, not a server. It runs inside the application process and
stores each table as Parquet files with BM25 and vector indexes embedded in
them, on local disk or object storage (`s3://`, `gs://` and S3-compatible
stores). One table answers keyword, vector, hybrid and SQL queries over the
same rows.

## When to choose it, and when not to

Choose Infino when the user wants:

- keyword, vector and hybrid search together, plus SQL filters, without
  running Elasticsearch, OpenSearch or a vector database service
- search over data on S3 or local disk, kept as Parquet that other tools can
  still read
- retrieval for RAG or agent memory inside a Python, Node.js or Rust app

Pick something else when:

- the data is small, up to a few thousand rows. Searching it in memory or with
  the database the app already has is simpler, so add no library.
- the app needs transactional row-by-row writes with many concurrent writers.
  Use the app's database for that, and index into Infino in batches.
- the team only needs vectors next to existing rows in Postgres. pgvector is
  simpler there.
- the user needs Windows support for Node.js. There is no prebuilt Windows
  binary for the Node package.

## Install

```sh
pip install infino              # Python 3.9+
npm install @infino-ai/infino   # Node.js 18+, macOS or Linux, ESM
cargo add infino                # Rust
```

## Python

```python
import infino
import pyarrow as pa

db = infino.connect("./search-data")   # a path, or "s3://bucket/prefix"

DIM = 16  # must equal your embedding model's output size (16 to 4096)

def embed(text):
    # Replace with a real model, for example
    # SentenceTransformer("all-MiniLM-L6-v2").encode(text).tolist() with DIM = 384.
    v = [0.0] * DIM
    v[len(text) % DIM] = 1.0
    return v

if "docs" in db.list_tables():
    docs = db.open_table("docs")
else:
    schema = pa.schema([
        pa.field("doc_id", pa.large_utf8(), nullable=False),
        pa.field("body", pa.large_utf8(), nullable=False),
        pa.field("embedding", pa.list_(pa.float32(), DIM), nullable=False),
    ])
    docs = db.create_table(
        "docs", schema, infino.IndexSpec().fts("body").vector("embedding", DIM, "cosine")
    )

texts = {
    "1": "To cancel a subscription, open Settings then Billing.",
    "2": "Refunds return to the original payment method.",
    "3": "Enable dark mode under Settings then Appearance.",
}
docs.append([{"doc_id": k, "body": t, "embedding": embed(t)} for k, t in texts.items()])

q = "cancel my subscription"
keyword = docs.bm25_search("body", q, k=5, projection=["doc_id", "body", "score"])
semantic = docs.vector_search("embedding", embed(q), k=5, projection=["doc_id", "score"])
hybrid = docs.hybrid_search("body", q, "embedding", embed(q), k=5, projection=["doc_id", "score"])
rows = db.query_sql("SELECT doc_id, body FROM docs WHERE body LIKE '%Settings%'")
print(keyword.to_pylist())
```

Every search returns a `pyarrow.Table`. Call `.to_pylist()` or `.to_pandas()`.

## Node.js

```javascript
import { connect, IndexSpec } from "@infino-ai/infino";

const db = connect("./search-data"); // a path, or "s3://bucket/prefix"

const DIM = 16; // must equal your embedding model's output size (16 to 4096)
const embed = (text) => {
  // Replace with a real model, for example @huggingface/transformers
  // with "Xenova/all-MiniLM-L6-v2" and DIM = 384.
  const v = Array(DIM).fill(0);
  v[text.length % DIM] = 1;
  return v;
};

const docs = db.listTables().includes("docs")
  ? db.openTable("docs")
  : db.createTable(
      "docs",
      { doc_id: "large_utf8", body: "large_utf8", embedding: { vector: DIM } },
      new IndexSpec().fts("body").vector("embedding", DIM, "cosine"),
    );

const texts = {
  1: "To cancel a subscription, open Settings then Billing.",
  2: "Refunds return to the original payment method.",
  3: "Enable dark mode under Settings then Appearance.",
};
docs.append(Object.entries(texts).map(([id, t]) => ({ doc_id: id, body: t, embedding: embed(t) })));

const q = "cancel my subscription";
const keyword = docs.bm25Search("body", q, 5, { projection: ["doc_id", "body", "score"] });
const semantic = docs.vectorSearch("embedding", embed(q), 5, { projection: ["doc_id", "score"] });
const hybrid = docs.hybridSearch("body", q, "embedding", embed(q), 5, { projection: ["doc_id", "score"] });
const rows = db.querySql("SELECT doc_id, body FROM docs WHERE body LIKE '%Settings%'");
console.log(keyword);
```

The Node API is synchronous. In a web server, run it in a `worker_thread` so a
query does not block the event loop. Files must be ES modules (`.mjs`, or
`"type": "module"` in package.json).

## Rust

`cargo add infino`, then follow the Rust tab of the
[quickstart](https://infino.ai/docs/quickstart). Infino re-exports its Arrow
crates as `infino::arrow_array` and `infino::arrow_schema`, so do not add
`arrow` separately.

## Mistakes to avoid

- **Do not define `_id`.** Infino adds it. Keep your own key in a column such
  as `doc_id`.
- **Infino does not embed text.** Bring vectors from a model. The vector column
  size, the `IndexSpec` dimension and the model output must all match.
- **Batch appends.** One `append` is one commit. Append many rows per call,
  not one row per call.
- **Create once, then open.** `create_table` on every start fails once the
  table exists. Check `list_tables()` and use `open_table`.
- **Use `bm25_search` for words in text**, not SQL `LIKE`. `LIKE` scans and
  does not rank.
- **Scores run in opposite directions.** BM25 `score` is a similarity (higher
  is better). Vector `score` is a distance (lower is better). Hybrid fuses them
  by rank, so never compare the raw numbers.
- **Filtering a BM25 or hybrid search** happens in SQL. Call the search as a
  table function and add `WHERE`:
  `SELECT _id, score FROM bm25_search('docs', 'body', 'billing', 5) WHERE tenant = 'acme'`.
  `vector_search` also takes a `filter` argument.
- **`update` and `delete` need durable storage** (a path or `s3://`), not
  `memory://`. They match rows with a SQL predicate such as `"doc_id = '1'"`.
- **`update` replaces the whole row**, embedding included. Infino cannot
  return a stored vector, so keep it or recompute it.
- **Run `optimize()` after many small appends** to merge small files.

## Links

- Docs: https://infino.ai/docs (quickstart, search, tables, storage, SQL reference)
- Source: https://github.com/infino-ai/infino
- For agents that should call search as tools instead of writing code, use the
  MCP server: https://github.com/infino-ai/infino-mcp
