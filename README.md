# LingCode marketing site

Static site for lingcode.dev (home, **features.html**, blog, support, etc.). Deploy to your DigitalOcean droplet (45.55.39.39).

## Upload to server

Nginx serves lingcode.dev from **/var/www/html** (see `/etc/nginx/sites-enabled/lingcode.dev`).

**Using the deploy script (from repo root):**

```bash
./website/deploy.sh
```

Override SSH user if needed: `LINGCODE_SSH_USER=root ./website/deploy.sh` (default is `root`). Host and path are set in the script (45.55.39.39, /var/www/html).

**Manual upload:**

```bash
scp -r website/* root@45.55.39.39:/var/www/html/
```

First-time setup on the server (if needed):

1. Create directory: `ssh USER@45.55.39.39 "mkdir -p /var/www/html"`
2. Nginx config at `/etc/nginx/sites-enabled/lingcode.dev` uses `root /var/www/html;` for `lingcode.dev` and `www.lingcode.dev`. Ensure DNS A records point to 45.55.39.39.

## Local preview

```bash
cd website
python3 -m http.server 8000
```

Then open http://localhost:8000

## Search Console (SEO)

Google Search Console is the supported way to submit your sitemap, confirm indexing, and see queries and Core Web Vitals for `lingcode.dev`.

1. Open [Google Search Console](https://search.google.com/search-console) and sign in.
2. Add a **URL prefix** property: `https://lingcode.dev/` (or **Domain** property for `lingcode.dev` if you control DNS).
3. **Verify** ownership using one of:
   - **HTML file:** Download the verification file from Search Console and upload it to the site root next to `index.html` (e.g. `/var/www/html/google*.html` on the server), then deploy and click Verify in Search Console.
   - **HTML tag:** Paste the meta tag Google gives you into the `<head>` of [`index.html`](index.html), deploy, verify, then you may remove the tag after verification if you prefer.
   - **DNS TXT record:** Use the Domain property flow if you manage DNS for `lingcode.dev`.
4. Under **Sitemaps**, submit: `https://lingcode.dev/sitemap.xml` (already referenced in [`robots.txt`](robots.txt)).
5. After a few days, check **Performance** (queries, clicks), **Pages** (indexing), and **Experience** (Core Web Vitals). Fix any crawl errors or “Page with redirect” issues for canonical URLs.

For Bing, add the same site in [Bing Webmaster Tools](https://www.bing.com/webmasters) and submit the sitemap there as well.

### Content ideas (keyword-focused articles)

Use the blog to target queries people actually type; link each post to [`/features.html`](features.html), [`/claude-sessions.html`](claude-sessions.html), or the home download as relevant.

- Native Mac AI IDE vs Electron editors (performance, memory, native integrations).
- Multiple Claude Code sessions workflow (parallel tasks, when to split sessions).
- LingCode + Cursor rules migration (`.mdc`, `WORKSPACE.md`, no migration).
- iPad remote control / SSH workflows for Claude Code on a Mac.
- Privacy: local code, Keychain API keys, zero telemetry (aligns with [`/privacy.html`](privacy.html)).
