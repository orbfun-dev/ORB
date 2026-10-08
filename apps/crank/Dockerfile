# orbit-crank — multi-stage production image (Node 20).
#
# Build:   docker build -f apps/crank/Dockerfile -t orbit-crank:latest .
# Run:     docker run -d --name orbit-crank --restart unless-stopped \
#            -p 127.0.0.1:8080:8080 \
#            --env-file /etc/orbit-crank/orbit-crank.env \
#            -v orbit-crank-var:/opt/orbit-crank/apps/crank/var \
#            orbit-crank:latest
#
# The keeper identity arrives via CRANK_KEYPAIR_BASE58 in the env file, or
# mount the keypair file read-only and set CRANK_KEYPAIR_PATH to its
# container path. State (per-round randomness keypairs, quarantines, the
# audit log) MUST live on the named volume or restarts orphan signers.

FROM node:20-slim AS build
WORKDIR /repo
# Workspace manifests first — npm ci must see every workspace member to
# validate the lockfile, but only sdk + crank sources are needed after.
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/crank/package.json apps/crank/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps/crank apps/crank
RUN npm run build --workspace @orbit-jackpot/sdk \
 && npm run build --workspace @orbit-jackpot/crank \
 && npm prune --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
RUN useradd --system --create-home --uid 10001 orbit
WORKDIR /opt/orbit-crank
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages packages
COPY --from=build /repo/apps/crank apps/crank
COPY --from=build /repo/package.json package.json
USER orbit
WORKDIR /opt/orbit-crank/apps/crank
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
