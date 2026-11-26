# syntax=docker/dockerfile:1
#
# Container image for the Infino MCP server (stdio transport).
#
# It installs the published @infino-ai/mcp-server package at the version this
# commit's package.json declares, so an image built from a commit runs exactly
# the release cut from it. The default local embedding model is downloaded at
# build time, so semantic search works on the first call and a fresh container
# never downloads it again.
#
# Data: with INFINO_MCP_URI unset, the server writes to ~/.infino/mcp, which is
# /home/node/.infino/mcp here. Mount a volume on /home/node/.infino to keep it:
#
#   docker run -i --rm -v infino-data:/home/node/.infino <image>
#
# Point INFINO_MCP_URI at an s3:// or az:// bucket, or at an Infino Cloud
# https://<host>/<database> endpoint (with INFINO_API_KEY), to serve data that
# lives outside the container.

# Debian (glibc), not Alpine: the ONNX runtime used for local embeddings ships
# no musl build.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /opt/infino-mcp

# Only package.json is needed: it names the version to install.
COPY package.json ./

# Install the published package globally, then pre-download the default local
# embedding model into the package's own cache directory, which stays
# root-owned and read-only at runtime.
RUN VERSION="$(node -p "require('./package.json').version")" \
 && npm install --global --omit=dev "@infino-ai/mcp-server@${VERSION}" \
 && npm cache clean --force \
 && cd "$(npm root --global)/@infino-ai/mcp-server" \
 && node --input-type=module -e "const { pipeline } = await import('@huggingface/transformers'); await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');" \
 && rm -rf /opt/infino-mcp

# The default data directory, created owned by the runtime user so a named
# volume mounted here starts out writable by that user.
RUN mkdir -p /home/node/.infino/mcp && chown -R node:node /home/node/.infino

USER node
WORKDIR /home/node
VOLUME ["/home/node/.infino"]

ENTRYPOINT ["infino-mcp"]
