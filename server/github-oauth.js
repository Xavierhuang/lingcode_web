'use strict';

// github-oauth.js — wires "Save prototype to GitHub" for /try.html.
//
// Flow:
//   1. User clicks "Save to GitHub" → frontend opens popup at /api/github/oauth/start
//   2. We generate a state token, redirect to github.com/login/oauth/authorize
//   3. GitHub bounces back to /api/github/callback with code + state
//   4. We exchange code → access token, fetch the username, persist on user row
//   5. Callback page postMessages 'github-connected' to opener and closes
//   6. Frontend now POSTs to /api/github/save-gist with the HTML
//
// Scopes requested: `gist` (level A — save as gist) + `public_repo` (level B —
// future "Deploy to Pages"). User can revoke any time at github.com/settings/applications.

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');

function envOrThrow(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function isConfigured() {
  return !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET;
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerGithubRoutes(app, db) {
  // ---- Status: does this signed-in user have GitHub connected? ----
  app.get('/api/github/status', (req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'github_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({
      ok: true,
      connected: !!user.github_token,
      username: user.github_username || null,
    });
  });

  // ---- Disconnect (clears the token; user keeps the gists they made) ----
  app.post('/api/github/disconnect', (req, res) => {
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    db.prepare('UPDATE users SET github_token = NULL, github_username = NULL WHERE id = ?').run(user.id);
    res.json({ ok: true });
  });

  // ---- Step 1: redirect to GitHub authorize ----
  app.get('/api/github/oauth/start', (req, res) => {
    if (!isConfigured()) return res.status(503).send('GitHub OAuth not configured on server');
    const user = getUserFromRequest(db, req);
    if (!user) {
      // Bounce to sign-in then back. Preserve `next` so the popup re-tries.
      const next = encodeURIComponent('/api/github/oauth/start');
      return res.redirect(`/signin.html?next=${next}`);
    }
    const state = crypto.randomBytes(24).toString('hex');
    req.session.github_oauth_state = state;
    req.session.github_oauth_uid = user.id;
    const params = new URLSearchParams({
      client_id: envOrThrow('GITHUB_CLIENT_ID'),
      redirect_uri: redirectUri(req),
      scope: 'gist public_repo',
      state,
      // `allow_signup=true` keeps the GitHub sign-up path visible for new users.
      allow_signup: 'true',
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  // ---- Step 2: GitHub returns here with code ----
  app.get('/api/github/callback', async (req, res) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const expected = req.session?.github_oauth_state;
    const uid = req.session?.github_oauth_uid;
    delete req.session.github_oauth_state;
    delete req.session.github_oauth_uid;
    if (!code || !state || !expected || state !== expected) {
      return res.status(400).send(callbackHtml(false, 'state mismatch — please retry'));
    }
    if (!uid) return res.status(401).send(callbackHtml(false, 'session expired — please retry'));

    // Exchange code for access token.
    let tokenJson;
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          client_id: envOrThrow('GITHUB_CLIENT_ID'),
          client_secret: envOrThrow('GITHUB_CLIENT_SECRET'),
          code,
          redirect_uri: redirectUri(req),
        }),
      });
      tokenJson = await tokenRes.json();
    } catch (e) {
      return res.status(502).send(callbackHtml(false, 'GitHub token exchange failed'));
    }
    const accessToken = tokenJson?.access_token;
    if (!accessToken) {
      return res.status(400).send(callbackHtml(false, tokenJson?.error_description || 'no access_token returned'));
    }

    // Fetch username for display + sanity check.
    let username = null;
    try {
      const u = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
      });
      if (u.ok) {
        const j = await u.json();
        username = j?.login || null;
      }
    } catch { /* non-fatal — username is decorative */ }

    db.prepare('UPDATE users SET github_token = ?, github_username = ? WHERE id = ?')
      .run(accessToken, username, uid);
    res.send(callbackHtml(true, '', username));
  });

  // ---- Save current prototype as a gist ----
  app.post('/api/github/save-gist', async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'github_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!user.github_token) return res.status(403).json({ ok: false, error: 'github_not_connected' });

    const { html, filename, description, public: isPublic } = req.body || {};
    if (typeof html !== 'string' || html.length < 10) {
      return res.status(400).json({ ok: false, error: 'html_required' });
    }
    if (html.length > 1_000_000) {
      return res.status(413).json({ ok: false, error: 'html_too_large' });
    }
    const safeFilename = sanitizeFilename(filename) || 'prototype.html';
    const safeDescription = String(description || 'LingCode prototype').slice(0, 256);
    const isPub = isPublic === true || isPublic === 'true';

    let result;
    try {
      const r = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.github_token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'lingcode',
        },
        body: JSON.stringify({
          description: safeDescription,
          public: isPub,
          files: { [safeFilename]: { content: html } },
        }),
      });
      result = { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'github_unreachable' });
    }
    if (result.status === 401) {
      // Token was revoked — clear it so next save re-OAuths.
      db.prepare('UPDATE users SET github_token = NULL WHERE id = ?').run(user.id);
      return res.status(401).json({ ok: false, error: 'github_token_revoked' });
    }
    if (result.status >= 400) {
      return res.status(result.status).json({
        ok: false,
        error: 'github_api_error',
        message: result.body?.message || 'unknown GitHub error',
      });
    }
    res.json({
      ok: true,
      url: result.body.html_url,
      id: result.body.id,
      filename: safeFilename,
      revisions: Array.isArray(result.body.history) ? result.body.history.length : 1,
    });
  });

  // POST /api/github/commit — Commit dirty files to a GitHub repo branch
  app.post('/api/github/commit', async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: 'github_not_configured' });
    const user = getUserFromRequest(db, req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!user.github_token) return res.status(403).json({ ok: false, error: 'github_not_connected' });

    const { owner, repo, branch, message = 'Update from LingCode', files } = req.body;
    if (!owner || !repo || !branch || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'owner, repo, branch, and files required' });
    }

    const token = user.github_token;
    const h = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'LingCode/1.0',
    };

    try {
      // 1. Get current HEAD SHA for the branch
      const refRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        { headers: h }
      );
      if (!refRes.ok) {
        const body = await refRes.json().catch(() => ({}));
        if (refRes.status === 404) {
          return res.status(404).json({ ok: false, error: 'branch_not_found', message: `Branch "${branch}" not found — cannot push to a non-branch ref.` });
        }
        return res.status(refRes.status).json({ ok: false, error: 'github_error', message: body.message || `HTTP ${refRes.status}` });
      }
      const refData = await refRes.json();
      const headSha = refData.object.sha;

      // 2. Get tree SHA from that commit
      const commitRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/commits/${headSha}`,
        { headers: h }
      );
      if (!commitRes.ok) {
        const body = await commitRes.json().catch(() => ({}));
        return res.status(commitRes.status).json({ ok: false, error: 'get_commit_failed', message: body.message });
      }
      const commitData = await commitRes.json();
      const treeSha = commitData.tree.sha;

      // 3. Create blobs for every dirty file
      const treeEntries = [];
      for (const { path, content } of files) {
        const blobRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
          { method: 'POST', headers: h, body: JSON.stringify({ content, encoding: 'utf-8' }) }
        );
        if (!blobRes.ok) {
          const b = await blobRes.json().catch(() => ({}));
          return res.status(blobRes.status).json({ ok: false, error: 'blob_error', message: b.message || `Failed to create blob for ${path}` });
        }
        const blobData = await blobRes.json();
        treeEntries.push({ path, sha: blobData.sha, mode: '100644', type: 'blob' });
      }

      // 4. Create new tree (base_tree preserves unchanged files)
      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees`,
        { method: 'POST', headers: h, body: JSON.stringify({ base_tree: treeSha, tree: treeEntries }) }
      );
      if (!treeRes.ok) {
        const b = await treeRes.json().catch(() => ({}));
        return res.status(treeRes.status).json({ ok: false, error: 'tree_error', message: b.message });
      }
      const treeData = await treeRes.json();

      // 5. Create commit
      const newCommitRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/commits`,
        { method: 'POST', headers: h, body: JSON.stringify({ message, tree: treeData.sha, parents: [headSha] }) }
      );
      if (!newCommitRes.ok) {
        const b = await newCommitRes.json().catch(() => ({}));
        return res.status(newCommitRes.status).json({ ok: false, error: 'commit_error', message: b.message });
      }
      const newCommit = await newCommitRes.json();

      // 6. Fast-forward the branch ref
      const updateRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        { method: 'PATCH', headers: h, body: JSON.stringify({ sha: newCommit.sha }) }
      );
      if (!updateRes.ok) {
        const b = await updateRes.json().catch(() => ({}));
        if (b.message?.includes('not a fast forward')) {
          return res.status(409).json({ ok: false, error: 'not_fast_forward', message: 'Branch has diverged — pull the latest changes first.' });
        }
        return res.status(updateRes.status).json({ ok: false, error: 'ref_update_failed', message: b.message });
      }

      res.json({ ok: true, sha: newCommit.sha, commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}` });
    } catch (e) {
      console.error('[github/commit]', e);
      res.status(500).json({ ok: false, error: 'server_error', message: e.message });
    }
  });
}

// ---- Helpers ----

function redirectUri(req) {
  // GitHub requires this exactly match the value registered in the OAuth app.
  // We registered https://lingcode.dev/api/github/callback — derive it from
  // the request so localhost + alt-host setups still work.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/github/callback`;
}

function sanitizeFilename(name) {
  if (typeof name !== 'string') return '';
  // Strip path separators and control chars; cap length.
  const cleaned = name.replace(/[/\\\x00-\x1f]/g, '').trim().slice(0, 80);
  if (!cleaned) return '';
  // Force an extension so GitHub renders it.
  if (!/\.[a-z0-9]{1,6}$/i.test(cleaned)) return cleaned + '.html';
  return cleaned;
}

function callbackHtml(success, errorMsg = '', username = '') {
  // Tiny self-contained page that postMessages the parent and closes.
  // No external deps — the popup may be blocked from loading anything else.
  const status = success ? 'github-connected' : 'github-error';
  const safeErr = (errorMsg || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const safeUser = (username || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${success ? 'Connected' : 'Error'}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0b0b0e; color: #fff; margin: 0; height: 100vh; display: grid; place-items: center; }
  .box { text-align: center; padding: 32px; }
  .ok { color: #4ade80; font-size: 32px; margin: 0 0 8px; }
  .err { color: #f87171; font-size: 22px; margin: 0 0 8px; }
  .sub { color: #aaa; font-size: 14px; }
</style></head>
<body>
  <div class="box">
    ${success
      ? `<h1 class="ok">✓ Connected</h1><p class="sub">${safeUser ? 'as <b>' + safeUser + '</b>' : ''}</p><p class="sub">You can close this window.</p>`
      : `<h1 class="err">✗ Error</h1><p class="sub">${safeErr}</p>`}
  </div>
  <script>
    try { if (window.opener) window.opener.postMessage({ kind: '${status}', username: '${safeUser}' }, '*'); } catch (e) {}
    setTimeout(function () { try { window.close(); } catch (e) {} }, ${success ? 600 : 4000});
  </script>
</body></html>`;
}

module.exports = { registerGithubRoutes, isConfigured };
