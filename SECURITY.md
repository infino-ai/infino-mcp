# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and click **"Report a vulnerability."** We aim to acknowledge reports within
a few business days and will keep you updated on the fix.

## Data handling

This MCP server is designed to run **locally**, beside the client, and to keep
data and credentials on the user's machine:

- It runs as a local subprocess over stdio — there is **no network listener and
  no remote service**.
- Query and document embedding use a **local model**; text is never sent to a
  third-party embedding API, and there is no API key to provision.
- Storage credentials are read from standard provider environment variables and
  used only to reach the bucket you configure; they are **never logged or
  returned in tool output**.
- The server is **read-only by default** — document writes (add/update/delete)
  and DDL/DML SQL are exposed only when `INFINO_MCP_ENABLE_WRITES` is set.

See the "Security & data handling" section of the [README](./README.md) for more.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/mcp-server`](https://www.npmjs.com/package/@infino-ai/mcp-server)).
