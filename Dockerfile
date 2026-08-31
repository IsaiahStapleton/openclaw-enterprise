# syntax=docker/dockerfile:1
# Operators must select an approved, immutable Node 24 base image explicitly.
ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS dependencies

WORKDIR /app
RUN node -e "if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('The approved production base image must use Node.js 24.')"
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/iam/package.json packages/iam/package.json
COPY packages/occ/package.json packages/occ/package.json
COPY packages/utils/package.json packages/utils/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    corepack pnpm install --frozen-lockfile --prod --ignore-scripts

FROM dependencies AS development
ENV NODE_ENV=development
WORKDIR /app

COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages packages
COPY --chown=node:node apps/controller apps/controller
COPY --chown=node:node migrations migrations
COPY --chown=node:node scripts scripts
RUN mkdir -p /app/.development/configurations && chown -R node:node /app/.development

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]

FROM ${NODE_BASE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/ ./
COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages/audit/package.json packages/audit/package.json
COPY --chown=node:node packages/audit/src packages/audit/src
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/contracts/src packages/contracts/src
COPY --chown=node:node packages/iam/package.json packages/iam/package.json
COPY --chown=node:node packages/iam/src packages/iam/src
COPY --chown=node:node packages/occ/package.json packages/occ/package.json
COPY --chown=node:node packages/occ/src packages/occ/src
COPY --chown=node:node packages/utils/package.json packages/utils/package.json
COPY --chown=node:node packages/utils/src packages/utils/src
COPY --chown=node:node apps/controller/package.json apps/controller/package.json
COPY --chown=node:node apps/controller/src/index.ts apps/controller/src/index.ts
COPY --chown=node:node apps/controller/src/server.mjs apps/controller/src/server.mjs
COPY --chown=node:node apps/controller/src/worker.mjs apps/controller/src/worker.mjs
COPY --chown=node:node apps/controller/src/worker.ts apps/controller/src/worker.ts
COPY --chown=node:node apps/controller/src/admission/admission-verifier.ts apps/controller/src/admission/admission-verifier.ts
COPY --chown=node:node apps/controller/src/auth/index.ts apps/controller/src/auth/index.ts
COPY --chown=node:node apps/controller/src/composition/installation-config.ts apps/controller/src/composition/installation-config.ts
COPY --chown=node:node apps/controller/src/composition/production.ts apps/controller/src/composition/production.ts
COPY --chown=node:node apps/controller/src/composition/production-harness.ts apps/controller/src/composition/production-harness.ts
COPY --chown=node:node apps/controller/src/drivers/compute/lifecycle-hooks.ts apps/controller/src/drivers/compute/lifecycle-hooks.ts
COPY --chown=node:node apps/controller/src/drivers/compute/operation-context.ts apps/controller/src/drivers/compute/operation-context.ts
COPY --chown=node:node apps/controller/src/drivers/compute/kubernetes/index.ts apps/controller/src/drivers/compute/kubernetes/index.ts
COPY --chown=node:node apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts
COPY --chown=node:node apps/controller/src/drivers/configuration/kubernetes/index.ts apps/controller/src/drivers/configuration/kubernetes/index.ts
COPY --chown=node:node migrations/[0-9]*.sql migrations/
COPY --chown=node:node migrations/meta/_journal.json migrations/meta/_journal.json
COPY --chown=node:node scripts/migrate-production.mjs scripts/migrate-production.mjs
COPY --chown=node:node scripts/bootstrap-production.mjs scripts/bootstrap-production.mjs
COPY --chown=node:node scripts/production-healthcheck.mjs scripts/production-healthcheck.mjs

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]
