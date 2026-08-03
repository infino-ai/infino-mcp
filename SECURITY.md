# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and click **"Report a vulnerability."** We aim to acknowledge reports within
a few business days and will keep you updated on the fix.

## Data handling

This MCP server runs **locally**, beside the client, and keeps data and
credentials on the user's machine:

- It runs as a local subprocess over stdio and opens **no inbound network
  listener**. In the default local/bucket mode it contacts no remote service;
  when pointed at a hosted `https://` Infino Cloud endpoint it makes
  **outbound** TLS calls to that endpoint to serve searches and writes, so those
  request payloads reach the hosted service you configured.
- Query and document embedding use a **local model**; text is never sent to a
  third-party embedding API, and there is no embedding API key to provision.
- Storage credentials and the hosted API key (`INFINO_API_KEY`) are read from
  environment variables and used only to reach the store or endpoint you
  configure; they are **never logged or returned in tool output**.
- The server is **read-only by default** — document writes (add/update/delete)
  and DDL/DML SQL are exposed only when `INFINO_MCP_ENABLE_WRITES` is set.

See the "Security & data handling" section of the [README](./README.md) for more.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/mcp-server`](https://www.npmjs.com/package/@infino-ai/mcp-server)).
