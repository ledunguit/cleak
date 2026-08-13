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
    ccache \
    && rm -rf /var/lib/apt/lists/*

# Debian's ccache package installs compiler-name symlinks (gcc/g++/cc/c++/
# clang/clang++ -> ccache) under /usr/lib/ccache — ccache reads argv[0] to
# figure out which real compiler to invoke. Prepending that dir to PATH makes
# EVERY build path (build-target.service.ts's plain `execSync(buildCommand)`,
# harness-build.service.ts's direct `clang` invocations via runConfined) hit
# the cache transparently — no buildCommand string rewriting, no CC/CXX env
# juggling. Real payoff on a corpus like LAMeD (41 cases, only 7 distinct
# project/commit trees) where many cases rebuild near-identical source.
ENV PATH="/usr/lib/ccache:${PATH}"
ENV CCACHE_DIR=/ccache

# libFuzzer's runtime archive (libclang_rt.fuzzer-*.a, needed by
# buildHarness(entryStyle="fuzzer")) ships in `libclang-common-14-dev`, which
# `clang` above already pulls in as a hard dependency — verified directly
# (`dpkg -L libclang-common-14-dev | grep libclang_rt.fuzzer`), no separate
# install needed. (A prior `libclang-rt-14-dev` package no longer resolves on
# current ubuntu:22.04 archives — "E: Unable to locate package" — this step
# used to install it explicitly; removed as redundant now that the file is
# confirmed present via the dependency above.)

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

# ── Non-root runtime user: NOT enabled by default — why ─────────────────────
# This container BUILD-AND-RUNS untrusted C/C++ projects INTO host bind-mounts
# that docker-compose mounts READ-WRITE (`./demo:/workspace/demo`,
# `./targets:/workspace/targets`), plus the named volumes `runs:/runs` and
# `ccache-data:/ccache` (build-target.service.ts, harness-build.service.ts and
# ccache all write there). Host bind-mounts keep the host owner's uid, and
# fresh named volumes are initialized root-owned on first mount — so a plain
# non-root `USER` in this image alone makes every build/sanitizer write fail
# with EACCES. Dropping root here REQUIRES out-of-image coordination:
#   1. docker-compose `user: "${UID}:${GID}"` (host uid/gid) so the process can
#      write the host rw bind-mounts;
#   2. pre-chown the named volumes once, e.g. an init step:
#        docker run --rm -v runs:/runs -v ccache-data:/ccache \
#          alpine chown -R <UID>:<GID> /runs /ccache
#      before the first `up`;
#   3. create /home/<user> + chown it (node cache), and keep /app readable
#      (dist + node_modules already are — no /app writes beyond RUNS_DIR=/runs).
# Without steps 1–2 the container is broken as non-root, so enabling `USER`
# here is intentionally left to the deployment that guarantees those mounts.
# (static-analyzer CAN run non-root by default — it has read-only mounts only;
# see its Dockerfile for the applied pattern.)

EXPOSE 50062

CMD ["node", "dist/main.js"]
