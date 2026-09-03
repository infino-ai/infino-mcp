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
- With the default embedding provider, query and document embedding use a
  **local model**; text is never sent to a third-party embedding API, and there
  is no embedding API key to provision. If you configure the OpenAI-compatible
  provider, the text being embedded is sent to the endpoint you name.
- Storage credentials and the hosted API key (`INFINO_API_KEY`) are read from
  environment variables and used only to reach the store or endpoint you
  configure; they are **never logged or returned in tool output**.
- **Who can write is decided outside the server.** The full toolset, writes
  included, is always available to the agent. On Infino Cloud the API key's
  capabilities bound what the connection may do (a read-scoped key is refused
  every write). Locally, point the server only at data the agent may change.
  Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`) so
  your client can ask for confirmation on its own terms.

See the "Security & data handling" section of the [README](./README.md) for more.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/mcp-server`](https://www.npmjs.com/package/@infino-ai/mcp-server)).
