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
COPY apps/static-analyzer/src ./apps/static-analyzer/src
COPY packages/common/src ./packages/common/src
COPY proto ./proto

# 3. Build via turbo
RUN bunx turbo run build --filter=static-analyzer

# ── Runtime stage ──
FROM --platform=linux/amd64 node:22-slim AS runtime

# Runtime needs: node-gyp toolchain for the tree-sitter native addon
# (python3/make/g++), plus the Clang Static Analyzer (clang + clang-tools
# provides `scan-build`) and gcc so scan-build can intercept project builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ gcc clang clang-tools && rm -rf /var/lib/apt/lists/* && \
    # Debian ships scan-build as a versioned binary (scan-build-NN); expose an
    # unversioned `scan-build` on PATH so the adapter's default works.
    if ! command -v scan-build >/dev/null 2>&1; then \
      ln -s "$(ls /usr/bin/scan-build-* | head -n1)" /usr/local/bin/scan-build; \
    fi

WORKDIR /app
COPY --from=build /app/dist/apps/static-analyzer ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/proto ./proto

# tree-sitter native addon
COPY --from=build /app/node_modules/tree-sitter ./node_modules/tree-sitter
COPY --from=build /app/node_modules/tree-sitter-c ./node_modules/tree-sitter-c

EXPOSE 50051 50061

CMD ["node", "dist/main.js"]
