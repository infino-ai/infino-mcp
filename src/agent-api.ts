// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The Infino Cloud routes the binding does not wrap: the account's switched-on
// features, and the agent routes an account reaches only when its agent APIs
// are switched on (a table's card, the keys tables join on). Called over plain
// HTTPS with the same API key the binding uses, and only on a hosted
// connection; an embedded catalog has none of these.

/** Where a hosted database lives: the service's origin (plus any path prefix
 * in front of the database) and the database name, the last path segment of
 * `https://<host>/<database>`. */
export interface HostedEndpoint {
  base: string;
  database: string;
}

/** Split a hosted URI into its service base and database, or `null` when the
 * URI names no database. */
export function hostedEndpoint(uri: string): HostedEndpoint | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const database = segments.pop();
  if (!database) return null;
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return { base: `${url.origin}${prefix}`, database: decodeURIComponent(database) };
}

/** A failed call to the service: the HTTP status, the service's own words,
 * and when it said to try again, if it did. */
export class AgentApiError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    detail: string,
    readonly retryAfterSecs?: number,
  ) {
    super(
      `${op}: the service answered ${status}: ${detail}` +
        (retryAfterSecs !== undefined ? `; it is busy, so try again in ${retryAfterSecs} s` : ""),
    );
  }
}

/** How long an ask may take when the caller sets no budget of its own: the
 * service runs a model loop, and stops it at its own cap before this. */
const ASK_TIMEOUT_MS = 600_000;

/** Wall clock an ask gets past its own budget: the loop may run right up to
 * the budget, and the answer still has to travel back. */
const ASK_MARGIN_SECS = 60;

/** One ask: a question about the database, and how wide and how long. */
export interface AskRequest {
  question: string;
  /** Text the service's model reads beside the question, not as part of it. */
  context?: string;
  /** The one table the question is about. */
  table?: string;
  /** The few tables the question is about, which the loop may join. */
  tables?: string[];
  /** Rows to return at most. */
  k?: number;
  /** A shorter wall-clock budget than the service allows, in seconds. */
  maxWallSecs?: number;
}

/** How long one call may take before it is given up on. A card or a join is a
 * read of state the service keeps; the first join over a pair of tables counts
 * it on the data, which is the slow case this allows for. */
const CALL_TIMEOUT_MS = 120_000;

/** How long the startup check waits: the server must come up even when the
 * service is slow to answer, and a check that times out reads as off. */
const FEATURES_TIMEOUT_MS = 10_000;

/** Options for a table card read as a column lookup. */
export interface ColumnLookup {
  pattern: string;
  limit?: number;
}

type Fetch = typeof fetch;

/** The agent-route client for one hosted database. */
export class AgentApi {
  constructor(
    private readonly endpoint: HostedEndpoint,
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** Whether the account has the agent routes switched on. A service that
   * does not know the features route (404) predates it and has none to
   * offer; any other failure is reported to the caller, which decides. */
  async agentApisEnabled(): Promise<boolean> {
    const response = await this.request("account features", `${this.endpoint.base}/v1/account/features`, {
      method: "GET",
      timeoutMs: FEATURES_TIMEOUT_MS,
      notFoundIsAnswer: true,
    });
    if (response === null) return false;
    return (response as { agent_apis?: unknown }).agent_apis === true;
  }

  /** The column entries of `table`'s card whose names match `pattern`, most
   * populated first, as the service's optimizer last described them. */
  async describeColumns(table: string, lookup: ColumnLookup): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ table, pattern: lookup.pattern });
    if (lookup.limit !== undefined) query.set("limit", String(lookup.limit));
    return (await this.request("table_card", `${this.dataUrl("table_card")}?${query}`, {
      method: "GET",
    })) as Record<string, unknown>;
  }

  /** The keys two or more tables join on, found by the service on their
   * values: each join's two sides, how much of one side's values the other
   * holds, and the ON clause to paste. */
  async joinKeys(tables: readonly string[]): Promise<Record<string, unknown>> {
    return (await this.request("join_keys", this.dataUrl("join_keys"), {
      method: "POST",
      body: JSON.stringify({ tables }),
    })) as Record<string, unknown>;
  }

  /** Ask the service's retrieval loop a question about the database: it
   * chooses and runs the searches and SQL itself and returns the rows it
   * found (`facts`), the statement whose rows answer the question
   * (`statement`), and how many rows that returned (`coverage`); a loop that
   * found no answer still returns, with `terminate` saying why. Only the
   * fields given are sent, since the service refuses unknown ones. */
  async ask(request: AskRequest): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { question: request.question };
    if (request.context !== undefined) body.context = request.context;
    if (request.table !== undefined) body.table = request.table;
    if (request.tables !== undefined && request.tables.length > 0) body.tables = request.tables;
    if (request.k !== undefined) body.k = request.k;
    if (request.maxWallSecs !== undefined) body.max_wall_secs = request.maxWallSecs;
    const timeoutMs =
      request.maxWallSecs !== undefined ? (request.maxWallSecs + ASK_MARGIN_SECS) * 1000 : ASK_TIMEOUT_MS;
    return (await this.request("ask", this.dataUrl("sub_agent"), {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs,
    })) as Record<string, unknown>;
  }

  private dataUrl(op: string): string {
    return `${this.endpoint.base}/v1/${op}/${encodeURIComponent(this.endpoint.database)}`;
  }

  private async request(
    op: string,
    url: string,
    options: { method: string; body?: string; timeoutMs?: number; notFoundIsAnswer?: boolean },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(url, {
      method: options.method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS),
    });
    if (response.status === 404 && options.notFoundIsAnswer) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new AgentApiError(op, response.status, errorDetail(text), retryAfter(response));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentApiError(op, response.status, `not JSON: ${text.slice(0, 200)}`);
    }
  }
}

/** HTTP statuses the service answers when it is busy for now and the call
 * may be made again: not ready yet (503), or at capacity (529). */
const BUSY_STATUSES = new Set([503, 529]);

/** The seconds a busy answer said to wait, from its `Retry-After` header. */
function retryAfter(response: Response): number | undefined {
  if (!BUSY_STATUSES.has(response.status)) return undefined;
  const secs = Number(response.headers.get("retry-after"));
  return Number.isFinite(secs) && secs > 0 ? secs : undefined;
}

/** The service's error message from a failed response body: its `error`
 * field when the body is the usual JSON envelope, else the text itself. */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON: the text is the message.
  }
  return text.trim().slice(0, 500) || "(no body)";
}
