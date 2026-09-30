FROM docker.io/library/node:24-bookworm-slim

# Compute starts runtime wrappers under tini, as the runtime image provides it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/tini

COPY --chown=node:node server.mjs probe.mjs /fixture/
COPY --chown=node:node openclaw.mjs /app/openclaw.mjs

USER 1000:1000
EXPOSE 8080

CMD ["node", "/fixture/server.mjs"]
