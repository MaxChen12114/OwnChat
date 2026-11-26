# SPIKE (2026-11-27): self-hosted OwnChat without Cloudflare.
# Not wired into any release process. See server/local.mjs for the binding shims.
#
# Build-time generators mirror the wrangler [build] command minus the syntax gate:
# the prompt registries and the l0 boot manifest are gitignored / content-hashed, so the image
# must materialise them before the runtime starts.
FROM node:24-alpine

WORKDIR /app

# Copy the runtime surface. Secrets (.dev.vars) are excluded by .dockerignore and must come in
# through the environment; nothing is written outside /data at runtime.
COPY . .

RUN node scripts/gen-prompts.mjs \
 && node l0/build.mjs --write \
 && mkdir -p /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8787

# busybox wget ships with alpine; /config.js is public on every OwnChat deployment, so it is a
# valid liveness probe that never touches an upstream model.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/config.js >/dev/null || exit 1

CMD ["node", "server/local.mjs"]
