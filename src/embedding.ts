// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Server-side embedding. infino is bring-your-own-vectors (the engine doesn't
// embed) and an agent can't produce a query vector — so the server turns text
// into vectors for semantic search.
//
// Embedding is LOCAL: a Hugging Face transformers.js model (all-MiniLM-L6-v2,
// 384-dim by default) downloaded once, with no API key and no per-query
// network. The server embeds both ingested documents (infino_add_documents)
// and queries with the same model, so they always align. Override the model
// with INFINO_MCP_EMBED_MODEL (any HF feature-extraction model); the table's
// vector index must match its dimension.

const MODEL = process.env.INFINO_MCP_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";

// Lazily load the pipeline once and reuse it; the first call downloads + caches the model.
let pipe: Promise<(text: string, opts: object) => Promise<{ data: ArrayLike<number> }>> | null = null;
function getPipe() {
  if (!pipe) {
    pipe = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", MODEL)) as never;
    })();
  }
  return pipe;
}

/** Embed one text into a vector with the local model. */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getPipe();
  // Mean-pool token vectors and L2-normalize → one sentence embedding.
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data, Number);
}

/** Human-readable description of the embedder, for the startup log. */
export function embedderInfo(): string {
  return `local ${MODEL} (no key)`;
}
