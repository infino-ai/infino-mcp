// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Server-side embedding. infino is bring-your-own-vectors (the engine doesn't
// embed) and an agent can't produce a query vector — so the server turns text
// into vectors for semantic search. The server embeds both queries and, when
// writes are enabled, ingested documents with the SAME model, so they align.
//
// Two providers, selected by environment:
//
//   • local (default) — a Hugging Face transformers.js model
//     (all-MiniLM-L6-v2, 384-dim) downloaded once, no API key, no per-query
//     network. Override the model with INFINO_MCP_EMBED_MODEL.
//
//   • openai — any OpenAI-compatible /embeddings endpoint (OpenAI, Azure
//     OpenAI's /openai/v1 surface, or a self-hosted compatible server). Use
//     this to serve a catalog whose vectors were produced by that same
//     provider/model — e.g. a table embedded with text-embedding-3-small
//     (1536-dim). Set INFINO_MCP_EMBED_BASE_URL (+ INFINO_MCP_EMBED_API_KEY,
//     INFINO_MCP_EMBED_MODEL).
//
// Whichever provider you use, its model MUST match the model that produced the
// table's stored vectors (and the vector index's dimension), or semantic /
// hybrid search returns meaningless results (or errors on a dimension mismatch).

const PROVIDER = (process.env.INFINO_MCP_EMBED_PROVIDER ?? "").toLowerCase();
const BASE_URL = process.env.INFINO_MCP_EMBED_BASE_URL;
const API_KEY = process.env.INFINO_MCP_EMBED_API_KEY;

// Resolve the provider: explicit INFINO_MCP_EMBED_PROVIDER wins; otherwise a
// base URL implies the remote provider; otherwise local.
const USE_REMOTE =
  PROVIDER === "openai" ||
  PROVIDER === "azure" ||
  (PROVIDER === "" && typeof BASE_URL === "string" && BASE_URL.length > 0);

const LOCAL_MODEL_DEFAULT = "Xenova/all-MiniLM-L6-v2";
const REMOTE_MODEL_DEFAULT = "text-embedding-3-small";
const MODEL =
  process.env.INFINO_MCP_EMBED_MODEL ??
  (USE_REMOTE ? REMOTE_MODEL_DEFAULT : LOCAL_MODEL_DEFAULT);

// Batch sizes. The local pipeline runs one forward pass per call, so a batch
// amortizes model overhead across texts without letting the ONNX arenas grow
// past what a handful of documents needs. The remote size stays well inside
// every OpenAI-compatible provider's per-request input limit.
const LOCAL_BATCH = 32;
const REMOTE_BATCH = 100;

// Lazily load the local pipeline once and reuse it; the first call downloads +
// caches the model. Never imported when a remote provider is configured.
type Tensor = { data: ArrayLike<number>; dims: number[] };
let pipe: Promise<(texts: string[], opts: object) => Promise<Tensor>> | null = null;
function getPipe() {
  if (!pipe) {
    pipe = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", MODEL)) as never;
    })();
  }
  return pipe;
}

/** Embed up to REMOTE_BATCH texts in one OpenAI-compatible /embeddings call. */
async function embedRemoteBatch(texts: string[]): Promise<number[][]> {
  if (!BASE_URL) {
    throw new Error(
      "INFINO_MCP_EMBED_BASE_URL is required when INFINO_MCP_EMBED_PROVIDER is 'openai'.",
    );
  }
  const url = `${BASE_URL.replace(/\/$/, "")}/embeddings`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Send both auth styles so one config works for OpenAI (Authorization:
  // Bearer) and Azure OpenAI's v1 surface (api-key); each ignores the other.
  if (API_KEY) {
    headers["authorization"] = `Bearer ${API_KEY}`;
    headers["api-key"] = API_KEY;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embeddings request failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(
      `embeddings response carried ${Array.isArray(data) ? data.length : 0} vectors for ${texts.length} inputs`,
    );
  }
  // The spec orders `data` by `index`, but a provider may not; honor the
  // index so vectors land on the text that produced them.
  const out: number[][] = new Array(texts.length);
  data.forEach((item, position) => {
    const at = typeof item.index === "number" ? item.index : position;
    if (!Array.isArray(item.embedding) || at < 0 || at >= texts.length || out[at]) {
      throw new Error("embeddings response did not contain one embedding per input");
    }
    out[at] = Array.from(item.embedding, Number);
  });
  return out;
}

/** Embed up to LOCAL_BATCH texts in one forward pass of the local model. */
async function embedLocalBatch(texts: string[]): Promise<number[][]> {
  const extractor = await getPipe();
  // Mean-pool token vectors and L2-normalize → one sentence embedding per text,
  // returned as an [n, dim] tensor.
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const dim = output.dims[output.dims.length - 1];
  const flat = Array.from(output.data, Number);
  return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
}

/** Embed many texts with the configured provider, in batches, preserving order. */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const size = USE_REMOTE ? REMOTE_BATCH : LOCAL_BATCH;
  const run = USE_REMOTE ? embedRemoteBatch : embedLocalBatch;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    out.push(...(await run(texts.slice(i, i + size))));
  }
  return out;
}

/** Embed one text into a vector with the configured provider. */
export async function embed(text: string): Promise<number[]> {
  return (await embedMany([text]))[0];
}

// The embedder's output width, learned once by embedding a short constant
// string. Sizes the vector column of a table the server creates, and is
// compared against the vector column of any table it embeds into.
let dim: Promise<number> | null = null;
export function embedderDim(): Promise<number> {
  if (!dim) dim = embed("infino").then((v) => v.length);
  return dim;
}

/** Human-readable description of the embedder, for the startup log. */
export function embedderInfo(): string {
  if (USE_REMOTE) {
    let host = BASE_URL ?? "?";
    try {
      host = new URL(BASE_URL as string).host;
    } catch {
      /* keep raw value if not a valid URL */
    }
    return `remote ${MODEL} @ ${host}${API_KEY ? "" : " (no key)"}`;
  }
  return `local ${MODEL} (no key)`;
}
