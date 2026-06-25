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
COPY apps/static-analyzer/package.json apps/static-analyzer/tsconfig.app.json ./apps/static-analyzer/
COPY apps/dynamic-analyzer/package.json apps/dynamic-analyzer/tsconfig.app.json ./apps/dynamic-analyzer/
COPY packages/common/package.json packages/common/tsconfig.lib.json packages/common/tsup.config.ts ./packages/common/

RUN bun install

# 2. Copy source code
COPY apps/dynamic-analyzer/src ./apps/dynamic-analyzer/src
COPY packages/common/src ./packages/common/src

# 3. Build via turbo
RUN bunx turbo run build --filter=dynamic-analyzer

# ── Runtime stage (Valgrind-enabled Linux) ──
FROM --platform=linux/amd64 ubuntu:22.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    valgrind \
    gcc \
    g++ \
    clang \
    make \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js for runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist/apps/dynamic-analyzer ./dist
COPY --from=build /app/node_modules ./node_modules

EXPOSE 50062

CMD ["node", "dist/main.js"]
