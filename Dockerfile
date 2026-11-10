FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /app/agent-workdir \
    && chown -R bun:bun /data /app
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts ./scripts
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
# railway may mount data as root so only permission repair runs before dropping privileges
ENTRYPOINT ["/bin/sh", "-ec", "if [ \"$(id -u)\" = 0 ]; then mkdir -p /data/omp/agent /data/omp/sessions /data/backups; chown -R bun:bun /data; exec gosu bun \"$@\"; fi; test -w /data || { echo '/data is not writable: configure Railway RAILWAY_RUN_UID=0 for startup permission repair' >&2; exit 1; }; exec \"$@\"", "--"]
CMD ["bun", "run", "start"]
