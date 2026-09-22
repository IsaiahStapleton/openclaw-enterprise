ARG NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
FROM ${NODE_BASE_IMAGE} AS repository-client-build

WORKDIR /build
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/iam/package.json packages/iam/package.json
COPY packages/occ/package.json packages/occ/package.json
COPY packages/utils/package.json packages/utils/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=secret,id=COREPACK_NPM_REGISTRY,env=COREPACK_NPM_REGISTRY \
    corepack pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/controller apps/controller
COPY scripts/build-repository-credentials.mjs scripts/build-repository-credentials.mjs
COPY deploy/runtime/repository-credentials/.dockerignore deploy/runtime/repository-credentials/.dockerignore
RUN corepack pnpm credentials:build

# Build OpenClaw and its plugins from one immutable public source snapshot.
FROM ${NODE_BASE_IMAGE} AS openclaw-source
ARG OPENCLAW_SOURCE_COMMIT=20db76a79212c7d0c4f2106fea4d61fdce9972a3
ARG OPENCLAW_SOURCE_SHA256=456e6d042aff7dec501c9417e86ee4c41ec480cde0418468d8436e5785f5a6d0
ADD --checksum=sha256:${OPENCLAW_SOURCE_SHA256} https://codeload.github.com/openclaw/openclaw/tar.gz/${OPENCLAW_SOURCE_COMMIT} /tmp/openclaw.tar.gz
WORKDIR /openclaw
RUN tar -xzf /tmp/openclaw.tar.gz --strip-components=1 -C /openclaw \
    && rm /tmp/openclaw.tar.gz && corepack enable
ENV GIT_COMMIT=${OPENCLAW_SOURCE_COMMIT}

FROM openclaw-source AS openclaw-production-deps
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=secret,id=COREPACK_NPM_REGISTRY,env=COREPACK_NPM_REGISTRY \
    --mount=type=cache,id=oce-openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc

FROM openclaw-source AS openclaw-build
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=secret,id=COREPACK_NPM_REGISTRY,env=COREPACK_NPM_REGISTRY \
    --mount=type=cache,id=oce-openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=4096 \
    OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4096 \
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 \
    OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS="codex slack" pnpm build:docker \
    && OPENCLAW_PREFER_PNPM=1 pnpm ui:build

# Preserve compiled workspace packages and generated plugin assets without
# overwriting the clean production dependency tree with development dependencies.
FROM openclaw-build AS openclaw-build-output
RUN rm -rf node_modules ui/node_modules \
    && find packages extensions -name node_modules -prune -exec rm -rf {} +

FROM openclaw-production-deps AS openclaw-runtime
COPY --from=openclaw-build-output /openclaw/ ./
RUN OPENCLAW_EXTENSIONS="codex slack" node scripts/prune-docker-plugin-dist.mjs \
    && node scripts/docker/verify-fs-safe-native.mjs --package-root /openclaw --mode require \
    && rm -rf node_modules/openclaw node_modules/.bin/openclaw \
    && node scripts/check-package-dist-imports.mjs /openclaw \
    && rm -rf src test tests ui apps vendor .github

FROM ${NODE_BASE_IMAGE} AS runtime

ARG TARGETARCH

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 15) throw new Error(`OpenClaw Enterprise runtime images require Node.js 24.15+; found ${process.version}.`);'

RUN apt-get update && apt-get install -y --no-install-recommends tini git ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build-ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export CURL_CA_BUNDLE=/run/secrets/build-ca; fi; \
    architecture="${TARGETARCH:-amd64}"; \
    case "$architecture" in amd64|arm64) ;; *) exit 1 ;; esac; \
    cd /tmp; \
    curl --fail --location --silent --show-error -O "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_linux_${architecture}.tar.gz"; \
    curl --fail --location --silent --show-error -O "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_checksums.txt"; \
    grep " gh_2.100.0_linux_${architecture}.tar.gz$" gh_2.100.0_checksums.txt | sha256sum --check --strict; \
    tar -xzf "gh_2.100.0_linux_${architecture}.tar.gz"; \
    install -m 0755 "gh_2.100.0_linux_${architecture}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh_2.100.0*; \
    /usr/bin/git --version; \
    /usr/local/bin/gh --version | grep '^gh version 2.100.0 '

COPY --from=repository-client-build /build/.build/repository-credentials/client/package.json /opt/oce/repository-credentials/package.json
COPY --from=repository-client-build /build/.build/repository-credentials/client/dist /opt/oce/repository-credentials/dist
COPY deploy/runtime/bin /opt/oce/repository-credentials/bin
RUN chmod -R a+rX /opt/oce/repository-credentials \
    && chmod 0555 /opt/oce/repository-credentials/bin/gh \
    && test -f /opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/router.js \
    && test -f /opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/native-git.js \
    && /usr/bin/git config --system --add include.path /run/oce/repository-credentials/gitconfig

COPY --from=openclaw-runtime /openclaw /app/node_modules/openclaw

RUN mkdir -p node_modules/.bin ./plugin-skills /etc/openclaw /home/node/.codex/generated_images \
  && chown node:node /home/node/.codex /home/node/.codex/generated_images \
  && chmod 700 /home/node/.codex /home/node/.codex/generated_images \
  && ln -s ../openclaw/extensions/codex/node_modules/.bin/codex node_modules/.bin/codex \
  && cp -R node_modules/openclaw/extensions/slack/skills/slack ./plugin-skills/slack \
  && ln -s node_modules/openclaw/openclaw.mjs ./openclaw.mjs \
  && ln -s node_modules/openclaw/dist ./dist \
  && cp -R node_modules/openclaw/skills ./skills \
  && chmod -R a+rX /app \
  && test -L /app/dist \
  && test -d /app/skills \
  && test ! -L /app/skills \
  && test -d /app/plugin-skills/slack \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex)" = "node:node:700" \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex/generated_images)" = "node:node:700" \
  && node /app/openclaw.mjs --version \
  && codex --version \
  && test -f /app/dist/extensions/file-transfer/openclaw.plugin.json \
  && test -f /app/dist/extensions/memory-core/openclaw.plugin.json \
  && test -f /app/dist/extensions/codex/openclaw.plugin.json \
  && test -f /app/dist/extensions/slack/openclaw.plugin.json

USER node
