---
description: Search your Infino data (hybrid keyword + semantic) and summarize the top results.
argument-hint: "[table] <query>"
---

Retrieve from Infino for this request: **$ARGUMENTS**

Steps:

1. If a table name is given as the first argument, use it. Otherwise call
   `infino_list_tables` and pick the most relevant table (ask the user if it's
   ambiguous).
2. Run **`infino_hybrid_search`** on that table with the query text (the part of
   `$ARGUMENTS` that isn't the table name), `k: 10`. Hybrid fuses keyword +
   semantic, so it works whether the query is literal terms, a concept, or both.
3. If hybrid returns nothing useful, fall back to `infino_keyword_search` (for
   exact terms) or `infino_semantic_search` (for meaning).
4. Summarize the top results concisely — show the matched text and the score,
   and cite the row `_id`s so the user can act on specific rows.

Do not write to the data; this command is read-only.
