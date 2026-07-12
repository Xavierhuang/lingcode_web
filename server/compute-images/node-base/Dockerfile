# lingcode/compute-node:20 — the managed base image for compute-tier jobs.
# Jobs build FROM this image (so `require('pg')` resolves) and COPY their entry
# script, OR reference it directly with an entrypoint override. Keep it lean:
# a Node runtime + the pg client + CA certs. The SP3 browser image extends this
# (adds Chromium + the caps it needs).
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# pg preinstalled so jobs can talk to LINGCODE_DB_URL with zero setup.
RUN npm init -y >/dev/null 2>&1 && npm install pg@8 >/dev/null 2>&1
ENV NODE_ENV=production

# A job overrides this (entrypoint in the manifest, or CMD in its own Dockerfile).
CMD ["node", "-e", "console.log('lingcode compute base — provide an entrypoint')"]
