// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Pure helpers between the agent and the engine: the SQL guard, and the
// translation of raw engine / hosted-transport errors into messages that say
// what to do next. Kept free of server state so they can be unit-tested.

/** What the failing call was doing; decides how an ambiguous status reads. */
export interface ErrContext {
  /** `create` (table / database), `write` (append / update / delete), or `read`. */
  op?: "create" | "write" | "read";
  /** Whether the connection is a hosted (https://) one. */
  hosted?: boolean;
}

/**
 * Translate a raw engine or hosted-transport error into an actionable
 * message. Two sources of signal: the HTTP status a hosted connection attaches
 * to thrown errors as `status`, and the engine's own error texts.
 *
 * The hosted transport folds 401 and 403 into one message with no status, so
 * that text is matched directly. It also reports both a name collision and a
 * lost commit race as 409, dropping the worker's `Retry-After` that tells them
 * apart, so the 409 is read by which operation raised it: a create collided,
 * a write lost the race and can be reissued.
 */
export function errText(err: unknown, ctx: ErrContext = {}): string {
  const e = err as Error & { status?: number };
  const message = e?.message ?? String(err);
  if (/KV metadata key "inf\.fts\./.test(message)) {
    return (
      "this table has no full-text index, so keyword/BM25/hybrid search is " +
      "unavailable on it; query it with infino_sql instead, or recreate the " +
      "table with an FTS index on the text column"
    );
  }
  if (/KV metadata key "inf\.vec\./.test(message)) {
    return (
      "this table has no vector index, so semantic/hybrid search is " +
      "unavailable on it; query it with infino_sql instead, or recreate the " +
      "table with a vector index"
    );
  }
  if (e?.status === 401 || e?.status === 403 || /unauthorized \(check the API key\)/.test(message)) {
    return (
      "the API key was rejected or lacks write capability for this database; " +
      "for writes, mint a key with write capability and restart the server with it"
    );
  }
  if (e?.status === 413) {
    return "the batch is over the hosted 128 MiB request-body cap; send fewer documents per call";
  }
  if (e?.status === 503) {
    return "the database is starting up (transient 503); retry in a few seconds";
  }
  if (e?.status === 404) {
    return ctx.hosted
      ? `not found (404): ${message}. If the database itself is missing, call infino_create_database`
      : `not found (404): ${message}`;
  }
  if (e?.status === 409) {
    return ctx.op === "write"
      ? "another writer won the commit race on this table; nothing was written, so reissue the call"
      : `already exists (409): ${message}`;
  }
  return message;
}

/**
 * Guard for infino_sql. The engine's search table functions compose with
 * GROUP BY / joins / aggregates, which is the point of exposing SQL, and any
 * statement is allowed, DDL/DML included. The one restriction is one
 * statement per call, so a result always answers exactly one query.
 */
export function guardSql(sql: string): string {
  const stripped = sql.trim().replace(/;\s*$/, "");
  if (stripped.includes(";")) throw new Error("only a single statement is allowed");
  return stripped;
}
