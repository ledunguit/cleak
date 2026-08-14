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
COPY apps/static-analyzer/package.json apps/static-analyzer/tsconfig.app.json apps/static-analyzer/webpack.config.js ./apps/static-analyzer/
COPY apps/dynamic-analyzer/package.json apps/dynamic-analyzer/tsconfig.app.json ./apps/dynamic-analyzer/
COPY packages/common/package.json packages/common/tsconfig.lib.json packages/common/tsup.config.ts ./packages/common/
COPY packages/observability/package.json packages/observability/tsconfig.json packages/observability/tsup.config.ts ./packages/observability/

RUN pnpm install --frozen-lockfile

# 2. Copy source code
COPY apps/static-analyzer/src ./apps/static-analyzer/src
COPY packages/common/src ./packages/common/src
COPY packages/observability/src ./packages/observability/src

# 3. Build via turbo
RUN pnpm exec turbo run build --filter=static-analyzer

# ── Runtime stage ──
FROM --platform=linux/amd64 node:22-slim AS runtime

# Runtime needs: node-gyp toolchain for the tree-sitter native addon
# (python3/make/g++), plus the Clang Static Analyzer (clang + clang-tools
# provides `scan-build`) and gcc so scan-build can intercept project builds.
# `perl` is REQUIRED: scan-build is a Perl script that `use`s FindBin — the slim
# base only ships perl-base (no FindBin), so without this scan-build aborts at
# startup and the deep-static slot silently returns zero findings.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ gcc clang clang-tools perl && rm -rf /var/lib/apt/lists/* && \
    # Debian ships scan-build as a versioned binary (scan-build-NN); expose an
    # unversioned `scan-build` on PATH so the adapter's default works.
    if ! command -v scan-build >/dev/null 2>&1; then \
      ln -s "$(ls /usr/bin/scan-build-* | head -n1)" /usr/local/bin/scan-build; \
    fi

WORKDIR /app
COPY --from=build /app/dist/apps/static-analyzer ./dist
# pnpm's node_modules is symlink-based (top-level packages link into
# node_modules/.pnpm/<pkg>@<version>/...) — copy the whole tree in one shot so
# the tree-sitter native addons' symlinks resolve; copying an individual
# package dir on its own would carry the symlink without its target.
COPY --from=build /app/node_modules ./node_modules

# ── Non-root runtime user ──────────────────────────────────────────────────
# Safe to run as non-root here: this service only READS the scanned project
# (docker-compose mounts ./demo + ./targets READ-ONLY — scan-build writes its
# reports under RUNS_DIR, default ./runs, inside the container) and binds the
# unprivileged MCP port 50061 (>1024). So there are no host-writable bind-mounts
# to break by dropping root — unlike dynamic-analyzer, which builds INTO host rw
# mounts and needs mount-ownership coordination first (see its Dockerfile).
RUN groupadd --system --gid 10001 cleak \
 && useradd --system --uid 10001 --gid 10001 --home-dir /home/cleak --shell /usr/sbin/nologin cleak \
 && mkdir -p /home/cleak /app/runs \
 && chown -R cleak:cleak /home/cleak /app/runs
USER cleak

EXPOSE 50061

CMD ["node", "dist/main.js"]
