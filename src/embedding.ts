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

// Lazily load the local pipeline once and reuse it; the first call downloads +
// caches the model. Never imported when a remote provider is configured.
let pipe: Promise<(text: string, opts: object) => Promise<{ data: ArrayLike<number> }>> | null =
  null;
function getPipe() {
  if (!pipe) {
    pipe = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", MODEL)) as never;
    })();
  }
  return pipe;
}

/** Embed one text via an OpenAI-compatible /embeddings endpoint. */
async function embedRemote(text: string): Promise<number[]> {
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
    body: JSON.stringify({ model: MODEL, input: text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embeddings request failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("embeddings response did not contain data[0].embedding");
  }
  return Array.from(vector, Number);
}

/** Embed one text into a vector with the configured provider. */
export async function embed(text: string): Promise<number[]> {
  if (USE_REMOTE) return embedRemote(text);
  const extractor = await getPipe();
  // Mean-pool token vectors and L2-normalize → one sentence embedding.
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data, Number);
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
