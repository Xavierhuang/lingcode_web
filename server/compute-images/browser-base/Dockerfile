# lingcode/compute-browser:20 — base image for jobs that drive a headless browser
# (cliffslist's custom-URL scraper, screenshotting, render-to-PDF). Built on the
# official Playwright image so Chromium + all its system deps are present and
# version-matched. `pg` is added so a scrape job can also persist via LINGCODE_DB_URL.
#
# RUNNER NOTE: the default hardening flags (--cap-drop=ALL --read-only) prevent
# Chromium from launching. Browser jobs run with a relaxed profile — set
# COMPUTE_HARDEN_FLAGS on the runner to e.g.
#   --pids-limit=1024 --security-opt=no-new-privileges --tmpfs=/tmp:rw,size=1g
# and launch Chromium with `--no-sandbox` (the container is already the sandbox).
# Per-job hardening profiles are the box-side completion of SP3.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
RUN npm init -y >/dev/null 2>&1 && npm install pg@8 playwright-core@1.49 >/dev/null 2>&1
ENV NODE_ENV=production
# Chromium must run --no-sandbox inside a container with dropped privileges.
ENV LINGCODE_BROWSER=chromium

CMD ["node", "-e", "console.log('lingcode compute browser base — provide an entrypoint')"]
