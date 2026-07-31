# ── Build stage ──
FROM --platform=linux/amd64 node:22-slim AS build

# Build tools for native addons (tree-sitter node-gyp). Node 22-slim ships
# corepack, which pins the exact pnpm version from package.json's packageManager.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && corepack prepare pnpm@11.18.0 --activate

WORKDIR /app

# 1. Copy dependency manifests for layer caching
COPY package.json turbo.json tsconfig.base.json nest-cli.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all workspace package.json files for pnpm workspace resolution
COPY apps/static-analyzer/package.json apps/static-analyzer/tsconfig.app.json ./apps/static-analyzer/
COPY apps/dynamic-analyzer/package.json apps/dynamic-analyzer/tsconfig.app.json ./apps/dynamic-analyzer/
COPY packages/common/package.json packages/common/tsconfig.lib.json packages/common/tsup.config.ts ./packages/common/

RUN pnpm install --frozen-lockfile

# 2. Copy source code
COPY apps/dynamic-analyzer/src ./apps/dynamic-analyzer/src
COPY packages/common/src ./packages/common/src

# 3. Build via turbo
RUN pnpm exec turbo run build --filter=dynamic-analyzer

# ── Runtime stage (Valgrind-enabled Linux) ──
FROM --platform=linux/amd64 ubuntu:22.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    valgrind \
    gcc \
    g++ \
    clang \
    llvm \
    make \
    cmake \
    bear \
    && rm -rf /var/lib/apt/lists/*

# libFuzzer's runtime archive (libclang_rt.fuzzer-*.a) is only a RECOMMENDED dep of
# `clang` on Debian/Ubuntu, so --no-install-recommends above skips it — without it,
# `buildHarness(entryStyle="fuzzer")` links fine locally but fails on this image with
# "libclang_rt.fuzzer-x86_64.a not found". ubuntu:22.04's `clang` package is LLVM 14;
# update this version if the base image's default clang version changes.
RUN apt-get update && apt-get install -y --no-install-recommends libclang-rt-14-dev \
    && rm -rf /var/lib/apt/lists/*

# ASan/LSan symbolize stack frames at RUNTIME via llvm-symbolizer. Without it, leak
# frames are bare addresses (a.out+0x…) with no file:line — so dynamic findings cannot
# be correlated to a candidate and the evidence is silently dropped. The `llvm` package
# ships a versioned binary; expose it as plain `llvm-symbolizer` on PATH.
RUN SYM="$(ls /usr/bin/llvm-symbolizer* /usr/lib/llvm-*/bin/llvm-symbolizer 2>/dev/null | head -1)" \
    && [ -n "$SYM" ] && ln -sf "$SYM" /usr/local/bin/llvm-symbolizer
ENV ASAN_SYMBOLIZER_PATH=/usr/local/bin/llvm-symbolizer

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
