# ── Build stage ──
FROM --platform=linux/amd64 node:22-slim AS build

# Install Bun + build tools for native addons (tree-sitter node-gyp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip python3 make g++ && \
    curl -fsSL https://bun.sh/install | bash && \
    rm -rf /var/lib/apt/lists/*
ENV BUN_INSTALL="/root/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

WORKDIR /app

# 1. Copy dependency manifests for layer caching
COPY package.json turbo.json tsconfig.base.json nest-cli.json bun.lock ./

# Copy all workspace package.json files for Bun workspace resolution
COPY apps/control-plane/package.json apps/control-plane/tsconfig.app.json ./apps/control-plane/
COPY apps/static-analyzer/package.json apps/static-analyzer/tsconfig.app.json ./apps/static-analyzer/
COPY apps/dynamic-analyzer/package.json apps/dynamic-analyzer/tsconfig.app.json ./apps/dynamic-analyzer/
COPY packages/common/package.json packages/common/tsconfig.lib.json ./packages/common/

RUN bun install

# 2. Copy source code
COPY apps/control-plane/src ./apps/control-plane/src
COPY packages/common/src ./packages/common/src
COPY proto ./proto

# 3. Build via turbo
RUN bunx turbo run build --filter=control-plane

# ── Runtime stage ──
FROM --platform=linux/amd64 node:22-slim AS runtime

# git + CA certs are required to clone GitHub repositories on demand at scan time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist/apps/control-plane ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/proto ./proto

EXPOSE 8090

CMD ["node", "dist/main.js"]
