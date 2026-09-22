# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the five long-running processes (section 3.4, C3–C7). One
# image per service, selected with `--target`:
#
#   docker build --target indexer      -t kydo/indexer .
#   docker build --target keeper       -t kydo/keeper .
#   docker build --target trial-engine -t kydo/trial-engine .
#   docker build --target terminal     -t kydo/terminal .
#   docker build --target landing      -t kydo/landing .
#
# Every image carries its own .env, copied verbatim from .env.example at build
# time. Compose passes nothing in. Public URLs, the program id and the network
# all live in .env.example; the four compose-topology values are ENV in the
# `service` stage. USDC_MINT is only known after `pnpm devnet:bootstrap`, so set
# it in .env.example and rebuild before shipping.
#
# The vault program is deliberately NOT built here: a reproducible program
# artifact comes from `anchor build --verifiable` / `solana-verify`, which use
# their own canonical image. Building it in a bespoke Dockerfile would yield a
# different hash and defeat the verification.

# Node 22, not the 18 in `engines`: services/{indexer,trial-engine} rely on the
# test runner expanding `src/**/*.test.ts` itself. Same pin as CI.
ARG NODE_VERSION=22-slim

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
# pnpm-lock.yaml is lockfileVersion 6.0. Pnpm 9+ rewrites it and
# --frozen-lockfile then fails.
RUN npm install --global pnpm@8 && npm cache clean --force
WORKDIR /app
ENV CI=true

# ---------------------------------------------------------------------------
# Dependencies. Manifests only, so this layer is invalidated by a package.json
# or lockfile change. Not by every source edit.
FROM base AS deps
# node-gyp needs a toolchain for ws's optional native deps (bufferutil,
# utf-8-validate) and blake-hash. Build stage only. Never in a runtime image.
RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY packages/sdk/package.json          packages/sdk/
COPY packages/ui/package.json           packages/ui/
COPY services/indexer/package.json      services/indexer/
COPY services/keeper/package.json       services/keeper/
COPY services/trial-engine/package.json services/trial-engine/
COPY apps/terminal/package.json         apps/terminal/
COPY apps/landing/package.json          apps/landing/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Services: tsc → dist/. @kydo/sdk resolves through dist/ for every service, so
# it is built first.
FROM deps AS build-services
COPY . .
RUN pnpm --filter @kydo/sdk build \
 && pnpm -r --filter './services/**' build

# Runtime for all three services. node_modules is hoisted (see .npmrc), so the
# root tree plus the workspace symlink targets is everything that resolves.
# `dotenv/config` reads /app/.env, which is WORKDIR.
FROM base AS service
ENV NODE_ENV=production
# --chown at copy time: `RUN chown -R` would rewrite every inode in
# node_modules into a second full-size layer.
COPY --chown=node:node --from=build-services /app/node_modules  ./node_modules
COPY --chown=node:node --from=build-services /app/packages/sdk  ./packages/sdk
COPY --chown=node:node --from=build-services /app/services      ./services
COPY --chown=node:node package.json pnpm-workspace.yaml .npmrc ./
# WORKDIR is /app, which is where `dotenv/config` looks.
COPY --chown=node:node .env.example ./.env
# Compose topology. These are the four values .env.example cannot carry. It
# has to stay correct for a plain `pnpm dev:*` run on a laptop, where Postgres
# is on localhost and the keys are in ~/.config/solana. Set here rather than
# in compose; dotenv never overwrites an existing process env var, so these win
# over the copied .env.
ENV DATABASE_URL=postgres://kydo:kydo@postgres:5432/kydo \
    INDEXER_URL=http://indexer:4000 \
    KEEPER_KEYPAIR=/run/keys/keeper.json \
    TRIAL_ATTESTOR_KEYPAIR=/run/keys/attestor.json
USER node

FROM service AS indexer
EXPOSE 4000
CMD ["node", "services/indexer/dist/index.js"]

FROM service AS keeper
# KEEPER_KEYPAIR (/run/keys/keeper.json) must be mounted at runtime. It is a
# signing key that holds SOL and collects bounties (section 3.2).
CMD ["node", "services/keeper/dist/index.js"]

FROM service AS trial-engine
EXPOSE 4100
CMD ["node", "services/trial-engine/dist/index.js"]

# ---------------------------------------------------------------------------
# Next.js apps. NEXT_PUBLIC_* is inlined by `next build`, so .env has to be in
# the app directory *before* the build. Re-pointing a domain means a rebuild.
#
# Each build drops `.next/cache` before the runtime stage copies the app dir.
# `next start` never reads it. It is webpack's build cache, and it was ~650 MB
# of the terminal's ~740 MB `.next`. Note that .dockerignore does NOT cover
# this: it filters the build context sent from the client, while the runtime
# stage below copies from *this stage's* filesystem, where `next build` had
# just written the cache. Baking it made every deploy add hundreds of MB of
# dead layer to the host and is what filled its disk (the build died extracting
# .next/cache/webpack/server-production/index.pack, "no space left on device").
FROM deps AS build-terminal
COPY . .
# next reads .env from the app directory, and NEXT_PUBLIC_* is inlined here.
COPY .env.example ./apps/terminal/.env
# next.config.js aliases @kydo/sdk to packages/sdk/src, but `next build` still
# typechecks against the package's declared types.
RUN pnpm --filter @kydo/sdk build \
 && pnpm --filter @kydo/terminal build \
 && rm -rf apps/terminal/.next/cache

FROM base AS terminal
ENV NODE_ENV=production
COPY --chown=node:node --from=build-terminal /app/node_modules ./node_modules
COPY --chown=node:node --from=build-terminal /app/packages     ./packages
COPY --chown=node:node --from=build-terminal /app/apps/terminal ./apps/terminal
COPY --chown=node:node package.json pnpm-workspace.yaml .npmrc ./
USER node
WORKDIR /app/apps/terminal
EXPOSE 3000
CMD ["/app/node_modules/.bin/next", "start", "-p", "3000"]

# The landing is wallet-free and has no workspace deps. No @kydo/sdk build.
FROM deps AS build-landing
COPY . .
# next reads .env from the app directory, and NEXT_PUBLIC_* is inlined here.
COPY .env.example ./apps/landing/.env
RUN pnpm --filter @kydo/landing build \
 && rm -rf apps/landing/.next/cache

FROM base AS landing
ENV NODE_ENV=production
COPY --chown=node:node --from=build-landing /app/node_modules ./node_modules
COPY --chown=node:node --from=build-landing /app/apps/landing ./apps/landing
COPY --chown=node:node package.json pnpm-workspace.yaml .npmrc ./
USER node
WORKDIR /app/apps/landing
EXPOSE 3001
CMD ["/app/node_modules/.bin/next", "start", "-p", "3001"]
