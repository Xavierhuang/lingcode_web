'use strict';

const crypto = require('crypto');
const { getUserFromRequest } = require('./auth-helpers');
const { broadcastToPrototype, getUserRole, getInitials } = require('./collab-server');
const { sendResendEmail } = require('./mail-resend');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MAX = 2000;
const SELECTOR_MAX = 500;
const INVITE_TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const PENDING_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Per-inviter rate limit on POST /collab/members so an owner can't spam emails.
// Same Map-of-buckets pattern as saved-prototypes.js's saveBuckets.
const INVITE_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const INVITE_RATE_MAX = 30;
const inviteBuckets = new Map();
function allowInvite(userId) {
  const now = Date.now();
  let b = inviteBuckets.get(userId);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + INVITE_RATE_WINDOW_MS };
    inviteBuckets.set(userId, b);
  }
  b.count += 1;
  return b.count <= INVITE_RATE_MAX;
}

// Role hierarchy: numeric weight for comparison
const ROLE_WEIGHT = { owner: 3, editor: 2, viewer: 1 };

function roleAtLeast(userRole, minRole) {
  return (ROLE_WEIGHT[userRole] || 0) >= (ROLE_WEIGHT[minRole] || 0);
}

function requireJsonContent(req, res) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    res.status(415).json({ ok: false, error: 'unsupported_media_type' });
    return false;
  }
  return true;
}

/** Build a public-facing user shape (no PII beyond email) */
function publicUser(row) {
  if (!row) return null;
  const name = row.email.split('@')[0];
  return { id: row.id, email: row.email, name, initials: getInitials(name) };
}

/**
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
function registerCollabRoutes(app, db) {

  // ── Permission middleware factory ──────────────────────────────────────────
  function requireCollabRole(minRole) {
    return (req, res, next) => {
      const u = getUserFromRequest(db, req);
      if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const protoId = req.params.id;
      if (!protoId || !UUID_RE.test(protoId)) return res.status(400).json({ ok: false, error: 'invalid_id' });
      const role = getUserRole(u.id, protoId, db);
      if (!role || !roleAtLeast(role, minRole)) return res.status(403).json({ ok: false, error: 'forbidden' });
      req._collabUser = u;
      req._collabRole = role;
      next();
    };
  }

  // ── Members ────────────────────────────────────────────────────────────────

  // GET /api/prototypes/:id/collab/members — list members (editor+)
  app.get('/api/prototypes/:id/collab/members', requireCollabRole('viewer'), (req, res) => {
    const rows = db.prepare(`
      SELECT cm.user_id, cm.role, cm.created_at, u.email
      FROM collab_members cm JOIN users u ON cm.user_id = u.id
      WHERE cm.prototype_id = ?
      ORDER BY cm.created_at ASC
    `).all(req.params.id);
    const members = rows.map((r) => ({
      ...publicUser({ id: r.user_id, email: r.email }),
      role: r.role,
      joined_at: r.created_at,
    }));
    res.json({ ok: true, members });
  });

  // POST /api/prototypes/:id/collab/members — invite by email (owner only)
  app.post('/api/prototypes/:id/collab/members', requireCollabRole('owner'), async (req, res) => {
    if (!requireJsonContent(req, res)) return;
    if (!allowInvite(req._collabUser.id)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'viewer');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!['editor', 'viewer'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'invalid_role' });
    }
    const invitee = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);

    // ── Pending-invite branch: invitee has no LingCode account yet ───────────
    if (!invitee) {
      const proto = db.prepare('SELECT title FROM saved_prototypes WHERE id = ?').get(req.params.id);
      if (!proto) return res.status(404).json({ ok: false, error: 'prototype_not_found' });

      const token = crypto.randomBytes(24).toString('base64url');
      const now = Date.now();
      const expiresAt = now + PENDING_INVITE_TTL_MS;
      // Upsert by (prototype_id, email): re-invite refreshes token + expiry
      const existing = db.prepare('SELECT id FROM collab_pending_invites WHERE prototype_id = ? AND email = ?')
        .get(req.params.id, email);
      if (existing) {
        db.prepare('UPDATE collab_pending_invites SET role = ?, token = ?, invited_by = ?, created_at = ?, expires_at = ?, consumed_at = NULL, consumed_by = NULL WHERE id = ?')
          .run(role, token, req._collabUser.id, now, expiresAt, existing.id);
      } else {
        db.prepare('INSERT INTO collab_pending_invites (id, prototype_id, email, role, token, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), req.params.id, email, role, token, req._collabUser.id, now, expiresAt);
      }

      // Email a sign-up link with the claim token.
      let emailSent = false;
      try {
        const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') || 'https://lingcode.dev';
        const claimUrl = `${publicOrigin}/api/collab/claim?token=${encodeURIComponent(token)}`;
        const inviterEmail = req._collabUser.email || '';
        const inviterName = inviterEmail.split('@')[0] || 'A collaborator';
        const html = `
<p>${escapeHtml(inviterName)} invited you to collaborate on <strong>${escapeHtml(proto.title)}</strong> as <strong>${escapeHtml(role)}</strong> on LingCode.</p>
<p style="margin:18px 0;"><a href="${escapeHtml(claimUrl)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Sign up &amp; open</a></p>
<p style="color:#666;font-size:13px;line-height:1.5;">LingCode is a real-time prototyping playground. Once you create an account, you'll land directly in the prototype with ${escapeHtml(role)} access.</p>
<p style="color:#999;font-size:12px;margin-top:24px;">This invite expires in 14 days. If the button does not work, copy this URL:<br>${escapeHtml(claimUrl)}</p>
`;
        const sent = await sendResendEmail({
          to: email,
          subject: `${inviterName} invited you to collaborate on ${proto.title}`,
          html,
        });
        emailSent = !!sent.ok;
        if (!sent.ok) console.error('[collab] pending-invite email failed:', sent.error);
      } catch (e) {
        console.error('[collab] pending-invite email exception:', e.message);
      }

      return res.status(201).json({ ok: true, action: 'pending', role, email_sent: emailSent });
    }

    const existing = db.prepare('SELECT role FROM collab_members WHERE prototype_id = ? AND user_id = ?')
      .get(req.params.id, invitee.id);
    if (existing) {
      // Already a member — update role if different
      if (existing.role !== role) {
        db.prepare('UPDATE collab_members SET role = ? WHERE prototype_id = ? AND user_id = ?')
          .run(role, req.params.id, invitee.id);
      }
      return res.json({ ok: true, action: 'updated', role });
    }

    db.prepare('INSERT INTO collab_members (id, prototype_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), req.params.id, invitee.id, role, req._collabUser.id, Date.now());

    // Send invite email (best-effort — membership is already saved, email is just notification)
    let emailSent = false;
    try {
      const proto = db.prepare('SELECT title, share_payload, share_version FROM saved_prototypes WHERE id = ?').get(req.params.id);
      if (proto) {
        const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') || 'https://lingcode.dev';
        const shareKey = (proto.share_version >= 2) ? 'gp' : 'p';
        const shareUrl = `${publicOrigin}/try.html#${shareKey}=${encodeURIComponent(proto.share_payload)}`;
        const inviterEmail = req._collabUser.email || '';
        const inviterName = inviterEmail.split('@')[0] || 'A collaborator';
        const html = `
<p>${escapeHtml(inviterName)} invited you to collaborate on <strong>${escapeHtml(proto.title)}</strong> as <strong>${escapeHtml(role)}</strong>.</p>
<p style="margin:18px 0;"><a href="${escapeHtml(shareUrl)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Open prototype</a></p>
<p style="color:#666;font-size:13px;line-height:1.5;">You'll see ${escapeHtml(inviterName)}'s edits appear in real time, and they'll see yours. ${role === 'viewer' ? 'You have read-only access.' : 'You can edit text inline by ⌘-clicking any element.'}</p>
<p style="color:#999;font-size:12px;margin-top:24px;">If the button does not work, copy this URL:<br>${escapeHtml(shareUrl)}</p>
`;
        const sent = await sendResendEmail({
          to: invitee.email,
          subject: `${inviterName} invited you to collaborate on ${proto.title}`,
          html,
        });
        emailSent = !!sent.ok;
        if (!sent.ok) console.error('[collab] invite email failed:', sent.error);
      }
    } catch (e) {
      console.error('[collab] invite email exception:', e.message);
    }

    res.status(201).json({ ok: true, action: 'invited', role, email_sent: emailSent });
  });

  // PATCH /api/prototypes/:id/collab/members/:userId — change role (owner)
  app.patch('/api/prototypes/:id/collab/members/:userId', requireCollabRole('owner'), (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const targetId = req.params.userId;
    if (!UUID_RE.test(targetId)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const role = String((req.body || {}).role || '');
    if (!['editor', 'viewer'].includes(role)) {
      return res.status(400).json({ ok: false, error: 'invalid_role' });
    }
    // Cannot change another owner's role without checking — but owners are set only by the system
    const result = db.prepare('UPDATE collab_members SET role = ? WHERE prototype_id = ? AND user_id = ? AND role != ?')
      .run(role, req.params.id, targetId, 'owner');
    if (result.changes === 0) return res.status(404).json({ ok: false, error: 'not_found_or_owner' });
    res.json({ ok: true });
  });

  // DELETE /api/prototypes/:id/collab/members/:userId — remove (owner)
  app.delete('/api/prototypes/:id/collab/members/:userId', requireCollabRole('owner'), (req, res) => {
    const targetId = req.params.userId;
    if (!UUID_RE.test(targetId)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    // Cannot remove the owner
    const target = db.prepare('SELECT role FROM collab_members WHERE prototype_id = ? AND user_id = ?')
      .get(req.params.id, targetId);
    if (!target) return res.status(404).json({ ok: false, error: 'not_found' });
    if (target.role === 'owner') return res.status(400).json({ ok: false, error: 'cannot_remove_owner' });
    db.prepare('DELETE FROM collab_members WHERE prototype_id = ? AND user_id = ?').run(req.params.id, targetId);
    res.json({ ok: true });
  });

  // GET /api/prototypes/:id/collab/room — room info for clients about to connect
  // Returns the WS URL (with token), the caller's role, and the member roster.
  // The Mac collab-bridge calls this after join to learn where to connect.
  app.get('/api/prototypes/:id/collab/room', requireCollabRole('viewer'), (req, res) => {
    const protoId = req.params.id;
    const callerRole = req._collabRole;
    const callerUser = req._collabUser;

    const rows = db.prepare(`
      SELECT cm.user_id, cm.role, cm.created_at, u.email
      FROM collab_members cm JOIN users u ON cm.user_id = u.id
      WHERE cm.prototype_id = ?
      ORDER BY cm.created_at ASC
    `).all(protoId);
    const members = rows.map((r) => ({
      ...publicUser({ id: r.user_id, email: r.email }),
      role: r.role,
      joined_at: r.created_at,
    }));

    // Caller's API access token (so they can attach it to the WS URL). The
    // bridge could read its own token from disk, but returning it here keeps
    // the connection ceremony to a single round-trip.
    const tokenRow = db.prepare('SELECT api_access_token FROM users WHERE id = ?').get(callerUser.id);
    const apiToken = tokenRow && tokenRow.api_access_token ? tokenRow.api_access_token : null;

    const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') || 'https://lingcode.dev';
    const wsBase = publicOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const wsUrl = apiToken
      ? `${wsBase}/ws/collab/${protoId}?token=${encodeURIComponent(apiToken)}`
      : `${wsBase}/ws/collab/${protoId}`;

    res.json({
      ok: true,
      prototypeId: protoId,
      myRole: callerRole,
      myUserId: callerUser.id,
      myEmail: callerUser.email,
      wsUrl,
      members,
    });
  });

  // GET /api/prototypes/:id/collab/share-link — generate invite token (owner)
  app.get('/api/prototypes/:id/collab/share-link', requireCollabRole('owner'), (req, res) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = Date.now() + INVITE_TOKEN_TTL_MS;
    // Store token on the prototype's owner member row (reuse invite_token column)
    db.prepare('UPDATE collab_members SET invite_token = ?, invite_expires = ? WHERE prototype_id = ? AND role = ?')
      .run(token, expires, req.params.id, 'owner');
    const publicOrigin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') || 'https://lingcode.dev';
    res.json({ ok: true, url: `${publicOrigin}/try.html?collab_join=${token}&proto=${req.params.id}`, expires_at: expires });
  });

  // POST /api/prototypes/:id/collab/join — consume invite token
  app.post('/api/prototypes/:id/collab/join', (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const u = getUserFromRequest(db, req);
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const token = String((req.body || {}).token || '');
    if (!token) return res.status(400).json({ ok: false, error: 'missing_token' });

    const ownerRow = db.prepare('SELECT user_id, invite_token, invite_expires FROM collab_members WHERE prototype_id = ? AND role = ?')
      .get(req.params.id, 'owner');
    if (!ownerRow || ownerRow.invite_token !== token) {
      return res.status(403).json({ ok: false, error: 'invalid_token' });
    }
    if (!ownerRow.invite_expires || Date.now() > ownerRow.invite_expires) {
      return res.status(403).json({ ok: false, error: 'token_expired' });
    }
    // Check if already a member
    const existing = db.prepare('SELECT role FROM collab_members WHERE prototype_id = ? AND user_id = ?')
      .get(req.params.id, u.id);
    if (existing) return res.json({ ok: true, role: existing.role, action: 'already_member' });

    db.prepare('INSERT INTO collab_members (id, prototype_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), req.params.id, u.id, 'viewer', ownerRow.user_id, Date.now());
    res.status(201).json({ ok: true, role: 'viewer', action: 'joined' });
  });

  // GET /api/collab/claim?token=<token> — entrypoint from the pending-invite email.
  // If signed in: claim → insert collab_members → 302 to the prototype's share URL.
  // If not signed in: 302 to /signin.html?next=<this URL> so signup/signin flow lands back here.
  // Idempotent: re-clicking after claim still redirects to the prototype.
  app.get('/api/collab/claim', (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).type('html').send('<p>Missing token.</p>');

    const invite = db.prepare('SELECT * FROM collab_pending_invites WHERE token = ?').get(token);
    if (!invite) return res.status(404).type('html').send('<p>Invite not found or already claimed under a different account. Ask the owner to resend.</p>');
    if (invite.expires_at < Date.now() && !invite.consumed_at) {
      return res.status(410).type('html').send('<p>Invite expired. Ask the owner to resend.</p>');
    }

    const user = getUserFromRequest(db, req);
    if (!user) {
      // Bounce through signin/signup, then back here. signin.html honors ?next=.
      const nextUrl = `/api/collab/claim?token=${encodeURIComponent(token)}`;
      return res.redirect(`/signin.html?invite=1&next=${encodeURIComponent(nextUrl)}`);
    }

    const proto = db.prepare('SELECT id, share_payload, share_version FROM saved_prototypes WHERE id = ?').get(invite.prototype_id);
    if (!proto) return res.status(404).type('html').send('<p>The prototype this invite refers to no longer exists.</p>');

    // Idempotent insert + consume
    const existing = db.prepare('SELECT role FROM collab_members WHERE prototype_id = ? AND user_id = ?')
      .get(invite.prototype_id, user.id);
    db.transaction(() => {
      if (!existing) {
        db.prepare('INSERT INTO collab_members (id, prototype_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), invite.prototype_id, user.id, invite.role, invite.invited_by, Date.now());
      }
      if (!invite.consumed_at) {
        db.prepare('UPDATE collab_pending_invites SET consumed_at = ?, consumed_by = ? WHERE id = ?')
          .run(Date.now(), user.id, invite.id);
      }
    })();

    const shareKey = (proto.share_version >= 2) ? 'gp' : 'p';
    res.redirect(`/try.html#${shareKey}=${encodeURIComponent(proto.share_payload)}`);
  });

  // ── Comments ───────────────────────────────────────────────────────────────

  // GET /api/prototypes/:id/collab/comments
  app.get('/api/prototypes/:id/collab/comments', requireCollabRole('viewer'), (req, res) => {
    const protoId = req.params.id;
    const selectorFilter = req.query.selector ? String(req.query.selector) : null;
    let rows;
    if (selectorFilter) {
      rows = db.prepare(`
        SELECT cc.*, u.email FROM collab_comments cc JOIN users u ON cc.author_id = u.id
        WHERE cc.prototype_id = ? AND cc.selector = ? AND cc.resolved = 0
        ORDER BY cc.created_at ASC
      `).all(protoId, selectorFilter.slice(0, SELECTOR_MAX));
    } else {
      rows = db.prepare(`
        SELECT cc.*, u.email FROM collab_comments cc JOIN users u ON cc.author_id = u.id
        WHERE cc.prototype_id = ? AND cc.resolved = 0
        ORDER BY cc.created_at ASC
      `).all(protoId);
    }
    const comments = rows.map((r) => ({
      id: r.id,
      thread_id: r.thread_id,
      author: publicUser({ id: r.author_id, email: r.email }),
      selector: r.selector,
      xpath: r.xpath,
      text_prefix: r.text_prefix,
      body: r.body,
      resolved: !!r.resolved,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    res.json({ ok: true, comments });
  });

  // POST /api/prototypes/:id/collab/comments — create (editor+)
  app.post('/api/prototypes/:id/collab/comments', requireCollabRole('editor'), (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const body = req.body || {};
    const threadId = body.thread_id ? String(body.thread_id) : null;
    const commentBody = String(body.body || '').trim();
    const selector = body.selector ? String(body.selector).slice(0, SELECTOR_MAX) : null;
    const xpath = body.xpath ? String(body.xpath).slice(0, 1000) : null;
    const textPrefix = body.text_prefix ? String(body.text_prefix).slice(0, 80) : null;

    if (!commentBody || commentBody.length > BODY_MAX) {
      return res.status(400).json({ ok: false, error: 'invalid_body' });
    }
    if (threadId) {
      if (!UUID_RE.test(threadId)) return res.status(400).json({ ok: false, error: 'invalid_thread_id' });
      const parent = db.prepare('SELECT id FROM collab_comments WHERE id = ? AND prototype_id = ? AND thread_id IS NULL')
        .get(threadId, req.params.id);
      if (!parent) return res.status(404).json({ ok: false, error: 'thread_not_found' });
    } else if (!selector) {
      return res.status(400).json({ ok: false, error: 'selector_required_for_root' });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO collab_comments (id, prototype_id, thread_id, author_id, selector, xpath, text_prefix, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, threadId, req._collabUser.id, selector, xpath, textPrefix, commentBody, now, now);

    const newRow = db.prepare('SELECT cc.*, u.email FROM collab_comments cc JOIN users u ON cc.author_id = u.id WHERE cc.id = ?').get(id);
    const comment = {
      id: newRow.id,
      thread_id: newRow.thread_id,
      author: publicUser({ id: newRow.author_id, email: newRow.email }),
      selector: newRow.selector,
      body: newRow.body,
      resolved: false,
      created_at: newRow.created_at,
      updated_at: newRow.updated_at,
    };

    broadcastToPrototype(req.params.id, { type: 'lc-comment-broadcast', action: 'created', comment });
    res.status(201).json({ ok: true, id, comment });
  });

  // PATCH /api/prototypes/:id/collab/comments/:commentId — edit/resolve
  app.patch('/api/prototypes/:id/collab/comments/:commentId', requireCollabRole('viewer'), (req, res) => {
    if (!requireJsonContent(req, res)) return;
    const commentId = req.params.commentId;
    if (!UUID_RE.test(commentId)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const existing = db.prepare('SELECT * FROM collab_comments WHERE id = ? AND prototype_id = ?').get(commentId, req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

    const u = req._collabUser;
    const role = req._collabRole;
    const body = req.body || {};
    const now = Date.now();

    // Body edit: author only
    if (body.body !== undefined) {
      if (existing.author_id !== u.id) return res.status(403).json({ ok: false, error: 'not_author' });
      const newBody = String(body.body).trim();
      if (!newBody || newBody.length > BODY_MAX) return res.status(400).json({ ok: false, error: 'invalid_body' });
      db.prepare('UPDATE collab_comments SET body = ?, updated_at = ? WHERE id = ?').run(newBody, now, commentId);
    }

    // Resolve: author or editor/owner
    if (body.resolved !== undefined) {
      const canResolve = existing.author_id === u.id || roleAtLeast(role, 'editor');
      if (!canResolve) return res.status(403).json({ ok: false, error: 'forbidden' });
      db.prepare('UPDATE collab_comments SET resolved = ?, updated_at = ? WHERE id = ?')
        .run(body.resolved ? 1 : 0, now, commentId);
    }

    const updated = db.prepare('SELECT cc.*, u.email FROM collab_comments cc JOIN users u ON cc.author_id = u.id WHERE cc.id = ?').get(commentId);
    const comment = {
      id: updated.id,
      thread_id: updated.thread_id,
      author: publicUser({ id: updated.author_id, email: updated.email }),
      selector: updated.selector,
      body: updated.body,
      resolved: !!updated.resolved,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    };
    broadcastToPrototype(req.params.id, { type: 'lc-comment-broadcast', action: 'updated', comment });
    res.json({ ok: true, comment });
  });

  // DELETE /api/prototypes/:id/collab/comments/:commentId — delete (author or owner)
  app.delete('/api/prototypes/:id/collab/comments/:commentId', requireCollabRole('viewer'), (req, res) => {
    const commentId = req.params.commentId;
    if (!UUID_RE.test(commentId)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const existing = db.prepare('SELECT * FROM collab_comments WHERE id = ? AND prototype_id = ?').get(commentId, req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'not_found' });

    const u = req._collabUser;
    const role = req._collabRole;
    const canDelete = existing.author_id === u.id || role === 'owner';
    if (!canDelete) return res.status(403).json({ ok: false, error: 'forbidden' });

    // Also delete replies
    db.prepare('DELETE FROM collab_comments WHERE thread_id = ?').run(commentId);
    db.prepare('DELETE FROM collab_comments WHERE id = ?').run(commentId);

    broadcastToPrototype(req.params.id, { type: 'lc-comment-broadcast', action: 'deleted', id: commentId });
    res.json({ ok: true });
  });

  // ── History ────────────────────────────────────────────────────────────────

  // GET /api/prototypes/:id/collab/history?since=<ts>&limit=50
  app.get('/api/prototypes/:id/collab/history', requireCollabRole('viewer'), (req, res) => {
    const protoId = req.params.id;
    const since = Number(req.query.since) || 0;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const WINDOW_MS = 5 * 60 * 1000; // 5-minute windows

    // Aggregate: count edits per (userId, 5-min window)
    const rows = db.prepare(`
      SELECT ch.user_id, ch.server_ts, u.email
      FROM collab_history ch
      LEFT JOIN users u ON ch.user_id = u.id
      WHERE ch.prototype_id = ? AND ch.server_ts > ?
      ORDER BY ch.server_ts DESC
      LIMIT ?
    `).all(protoId, since, limit * 10); // over-fetch to allow aggregation

    // Group into 5-min windows per user
    const windows = new Map(); // key = `${userId}:${windowStart}`
    for (const row of rows) {
      const windowStart = Math.floor(row.server_ts / WINDOW_MS) * WINDOW_MS;
      const key = `${row.user_id || '_anon'}:${windowStart}`;
      if (!windows.has(key)) {
        const name = row.email ? row.email.split('@')[0] : 'Anonymous';
        windows.set(key, {
          userId: row.user_id,
          displayName: name,
          initials: getInitials(name),
          windowStart,
          editCount: 0,
        });
      }
      windows.get(key).editCount++;
    }

    const timeline = Array.from(windows.values())
      .sort((a, b) => b.windowStart - a.windowStart)
      .slice(0, limit);

    res.json({ ok: true, timeline });
  });
}

module.exports = { registerCollabRoutes };
