'use strict';

/** @param {import('better-sqlite3').Database} db */
function migrateUsersTable(db) {
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((c) => c.name)
  );
  const add = (sql) => db.exec(sql);
  if (!cols.has('stripe_customer_id')) {
    add('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT');
  }
  if (!cols.has('stripe_subscription_id')) {
    add('ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT');
  }
  if (!cols.has('subscription_status')) {
    add('ALTER TABLE users ADD COLUMN subscription_status TEXT');
  }
  if (!cols.has('subscription_current_period_end')) {
    add('ALTER TABLE users ADD COLUMN subscription_current_period_end TEXT');
  }
  if (!cols.has('billing_interval')) {
    add('ALTER TABLE users ADD COLUMN billing_interval TEXT');
  }
  if (!cols.has('api_access_token')) {
    add('ALTER TABLE users ADD COLUMN api_access_token TEXT');
  }
  // Enforce per-user token uniqueness so two accounts can never silently share
  // one (a historical dirty-data bug — getUserFromRequest would resolve the
  // wrong user). Partial index ignores NULL/empty. Wrapped: pre-existing dups
  // would block creation (prod was de-duped 2026-06-01).
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token_uniq ON users(api_access_token) WHERE api_access_token IS NOT NULL AND api_access_token != ''");
  } catch (_) { /* leave un-indexed if legacy dups remain */ }
  if (!cols.has('hosted_prompts_used')) {
    add('ALTER TABLE users ADD COLUMN hosted_prompts_used INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('lingmodel_pro_day')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_pro_day TEXT');
  }
  if (!cols.has('lingmodel_pro_day_count')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_pro_day_count INTEGER NOT NULL DEFAULT 0');
  }
  // Storage add-on (Model B): bytes of à-la-carte object storage the user has
  // purchased on top of their tier's maxStorageBytes. Synced from the Stripe
  // subscription's add-on line-item quantity (stripe-sync.js). 0 = none.
  if (!cols.has('purchased_storage_bytes')) {
    add('ALTER TABLE users ADD COLUMN purchased_storage_bytes INTEGER NOT NULL DEFAULT 0');
  }
  // 5h rolling window cost ceiling for Pro tier — same pattern as Cursor /
  // Claude.ai. Window key is "YYYY-MM-DDTHH" where HH ∈ {00,05,10,15,20}.
  if (!cols.has('lingmodel_pro_window')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_pro_window TEXT');
  }
  if (!cols.has('lingmodel_pro_window_count')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_pro_window_count INTEGER NOT NULL DEFAULT 0');
  }
  // Pro-tier output-token accounting (mirror of the Free-tier columns).
  // Token caps are the actual cost ceiling — prompt counts can vary 100×
  // in token cost depending on prompt length and conversation context.
  if (!cols.has('lingmodel_pro_day_output_tokens')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_pro_day_output_tokens INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('lingmodel_pro_month')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_pro_month TEXT');
  }
  if (!cols.has('lingmodel_pro_month_output_tokens')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_pro_month_output_tokens INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('lingmodel_free_day')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_free_day TEXT');
  }
  if (!cols.has('lingmodel_free_day_count')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_free_day_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('lingmodel_free_day_output_tokens')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_free_day_output_tokens INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('lingmodel_free_month')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_free_month TEXT');
  }
  if (!cols.has('lingmodel_free_month_output_tokens')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_free_month_output_tokens INTEGER NOT NULL DEFAULT 0');
  }
  // Lifetime free-tier prompt counter — never resets. Powers the funnel:
  // once a free user hits LINGMODEL_FREE_LIFETIME_PROMPT_LIMIT (default 100)
  // cumulative prompts, every further request 402s with `upgrade_url`. The
  // existing daily counter still runs alongside as a soft rate limiter.
  if (!cols.has('lingmodel_free_lifetime_count')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_free_lifetime_count INTEGER NOT NULL DEFAULT 0');
  }
  // LingModel image-generation per-user monthly counter. Both columns share
  // a single bucket regardless of tier — quota lookup happens against the
  // tier-specific app_config key at request time.
  if (!cols.has('lingmodel_image_month')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_image_month TEXT');
  }
  if (!cols.has('lingmodel_image_month_count')) {
    add('ALTER TABLE users ADD COLUMN lingmodel_image_month_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('password_hash')) {
    add('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  if (!cols.has('password_reset_token')) {
    add('ALTER TABLE users ADD COLUMN password_reset_token TEXT');
  }
  if (!cols.has('password_reset_expires')) {
    add('ALTER TABLE users ADD COLUMN password_reset_expires TEXT');
  }
  if (!cols.has('email_verified')) {
    add('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  }
  if (!cols.has('email_verification_token')) {
    add('ALTER TABLE users ADD COLUMN email_verification_token TEXT');
  }
  if (!cols.has('email_verification_expires')) {
    add('ALTER TABLE users ADD COLUMN email_verification_expires TEXT');
  }
  // Persists `next` from /signin.html?next=<path> through the email-verify
  // round-trip — the verify link is opened in the email client's tab, so
  // sessionStorage and cookie-session can't carry the destination.
  if (!cols.has('email_verification_next')) {
    add('ALTER TABLE users ADD COLUMN email_verification_next TEXT');
  }
  if (!cols.has('google_sub')) {
    add('ALTER TABLE users ADD COLUMN google_sub TEXT');
    add('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');
  }
  // GitHub OAuth — used by /try.html "Save prototype to GitHub". Token has
  // `gist` + `public_repo` scopes; we store the user's login for display.
  if (!cols.has('github_token')) {
    add('ALTER TABLE users ADD COLUMN github_token TEXT');
  }
  if (!cols.has('github_username')) {
    add('ALTER TABLE users ADD COLUMN github_username TEXT');
  }
}

function migrateAccountTokensTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      digest_version TEXT NOT NULL CHECK(digest_version IN ('h1')),
      token_digest TEXT NOT NULL UNIQUE,
      display_prefix TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('account','project')),
      project_key TEXT,
      caps TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER,
      replaced_by TEXT,
      legacy_source TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(replaced_by) REFERENCES account_tokens(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_tokens_user_active
      ON account_tokens(user_id, revoked_at, expires_at);
  `);
}

/** @param {import('better-sqlite3').Database} db */
function migrateVoucherTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voucher_batches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 500),
      benefit_days INTEGER NOT NULL DEFAULT 30 CHECK(benefit_days > 0),
      redeem_by INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','closed','revoked')),
      created_by TEXT,
      created_at INTEGER NOT NULL,
      CHECK(redeem_by > created_at)
    );

    CREATE TABLE IF NOT EXISTS promotion_vouchers (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      serial_number INTEGER NOT NULL CHECK(serial_number > 0),
      digest_version TEXT NOT NULL CHECK(digest_version IN ('h1')),
      code_digest TEXT NOT NULL UNIQUE,
      display_suffix TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('available','reserved','redeemed','blocked','revoked')),
      reserved_by TEXT,
      reserved_until INTEGER,
      checkout_session_id TEXT UNIQUE,
      redeemed_by TEXT,
      redeemed_at INTEGER,
      stripe_subscription_id TEXT UNIQUE,
      card_fingerprint_digest TEXT,
      blocked_reason TEXT,
      revoked_at INTEGER,
      revoked_by TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(batch_id) REFERENCES voucher_batches(id) ON DELETE CASCADE,
      CHECK(
        (status = 'available'
          AND reserved_by IS NULL AND reserved_until IS NULL
          AND checkout_session_id IS NULL AND redeemed_by IS NULL AND redeemed_at IS NULL
          AND stripe_subscription_id IS NULL AND card_fingerprint_digest IS NULL
          AND blocked_reason IS NULL AND revoked_at IS NULL AND revoked_by IS NULL)
        OR
        (status = 'reserved'
          AND reserved_by IS NOT NULL AND reserved_until IS NOT NULL
          AND redeemed_by IS NULL AND redeemed_at IS NULL
          AND stripe_subscription_id IS NULL AND card_fingerprint_digest IS NULL
          AND blocked_reason IS NULL AND revoked_at IS NULL AND revoked_by IS NULL)
        OR
        (status = 'redeemed'
          AND reserved_by IS NOT NULL AND reserved_until IS NOT NULL
          AND checkout_session_id IS NOT NULL AND redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL
          AND stripe_subscription_id IS NOT NULL AND card_fingerprint_digest IS NOT NULL
          AND blocked_reason IS NULL AND revoked_at IS NULL AND revoked_by IS NULL)
        OR
        (status = 'blocked'
          AND reserved_by IS NOT NULL AND checkout_session_id IS NOT NULL
          AND redeemed_by IS NULL AND redeemed_at IS NULL
          AND stripe_subscription_id IS NULL AND card_fingerprint_digest IS NULL
          AND blocked_reason IS NOT NULL AND revoked_at IS NULL AND revoked_by IS NULL)
        OR
        (status = 'revoked'
          AND reserved_by IS NULL AND reserved_until IS NULL AND checkout_session_id IS NULL
          AND redeemed_by IS NULL AND redeemed_at IS NULL
          AND stripe_subscription_id IS NULL AND card_fingerprint_digest IS NULL
          AND blocked_reason IS NULL AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS voucher_audit_events (
      id TEXT PRIMARY KEY,
      voucher_id TEXT,
      batch_id TEXT,
      actor_user_id TEXT,
      event_type TEXT NOT NULL,
      reason_code TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(voucher_id) REFERENCES promotion_vouchers(id) ON DELETE SET NULL,
      FOREIGN KEY(batch_id) REFERENCES voucher_batches(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_batch_serial
      ON promotion_vouchers(batch_id, serial_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_redeemed_user
      ON promotion_vouchers(redeemed_by) WHERE status = 'redeemed';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_redeemed_card
      ON promotion_vouchers(card_fingerprint_digest)
      WHERE status = 'redeemed' AND card_fingerprint_digest IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_voucher_batch_status
      ON promotion_vouchers(batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_voucher_reservation_expiry
      ON promotion_vouchers(status, reserved_until);
  `);
}

/** @param {import('better-sqlite3').Database} db */
function migrateStatsTables(db) {
  // One row per UTC day, populated by the nightly scheduler. Lets admin dashboard
  // show longer-than-log-retention cohorts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stats_daily (
      date TEXT PRIMARY KEY,
      active_installs INTEGER NOT NULL DEFAULT 0,
      dmg_downloads INTEGER NOT NULL DEFAULT 0,
      signups INTEGER NOT NULL DEFAULT 0,
      collected_at TEXT NOT NULL
    )
  `);
  // Simple KV for manual numbers pasted from App Store Connect + Stripe weekly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS manual_stats (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/** @param {import('better-sqlite3').Database} db */
function migrateTelemetryTables(db) {
  // One row per event. The Mac app batches and POSTs these to
  // /api/telemetry/model-events. Only metadata ever leaves the device:
  // provider/model, token counts, latency, an anonymous install UUID,
  // and the conversation UUID (random, not the title/text).
  //
  // Model switches are derived at read time by looking for consecutive
  // 'response' rows in the same conversation_id where (provider, model)
  // changed — no separate 'switch' row is emitted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_telemetry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      install_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      latency_ms INTEGER,
      accepted INTEGER,
      file_count INTEGER,
      client_ts TEXT NOT NULL,
      received_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mt_conv ON model_telemetry_events(conversation_id, client_ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mt_install ON model_telemetry_events(install_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mt_received ON model_telemetry_events(received_at)');
}

/** @param {import('better-sqlite3').Database} db */
function migrateCLITables(db) {
  // One row per CLI install. CLI sends a heartbeat once per day from
  // any agentic invocation; we upsert so first_seen sticks but
  // last_seen / version / count refresh. install_id is a random UUID
  // generated client-side; no PII.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_heartbeats (
      install_id TEXT PRIMARY KEY,
      version TEXT,
      os TEXT,
      arch TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cli_last ON cli_heartbeats(last_seen)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cli_version ON cli_heartbeats(version)');

  // Mac app session tracking: one row per (user, minute) so we can compute
  // active minutes per day. INSERT OR IGNORE makes repeat heartbeats within
  // the same minute idempotent. minute_bucket = floor(unix_seconds / 60).
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_usage_minutes (
      user_id INTEGER NOT NULL,
      minute_bucket INTEGER NOT NULL,
      version TEXT,
      PRIMARY KEY (user_id, minute_bucket)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_app_usage_user_minute ON app_usage_minutes(user_id, minute_bucket)');

  // DMG download stats. Populated by `scripts/aggregate-downloads.js` on a
  // daily cron — it scrapes nginx access logs (which logrotate retains for
  // 14 days) and upserts per-(day, filename) totals here. Once a row lands
  // it survives the source log being deleted, giving us lifetime totals.
  db.exec(`
    CREATE TABLE IF NOT EXISTS download_stats (
      day TEXT NOT NULL,
      filename TEXT NOT NULL,
      count_200 INTEGER NOT NULL DEFAULT 0,
      count_206 INTEGER NOT NULL DEFAULT 0,
      unique_ips INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, filename)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_download_stats_day ON download_stats(day)');
}

/** @param {import('better-sqlite3').Database} db */
function migrateSavedPrototypesTable(db) {
  // Per-user "save my prototype" rows. Stores the base64 share payload
  // (compatible with /try.html#p=<base64>) so the row is self-contained
  // and the URL can be reconstructed from origin + pathname + share_version.
  // Storing the payload (vs the literal URL) keeps the row portable across
  // any future SHARE_KEY rotation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_prototypes (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      title           TEXT NOT NULL,
      share_payload   TEXT NOT NULL,
      share_version   INTEGER NOT NULL DEFAULT 1,
      source_prompt   TEXT,
      provider_id     TEXT,
      created_at      INTEGER NOT NULL,
      last_opened_at  INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_saved_user_created ON saved_prototypes(user_id, created_at DESC)');
  // Optional thumbnail (data: URL, ~50-150KB cap). Captured client-side via
  // SVG foreignObject when the user saves; lets the account.html grid show
  // a visual preview instead of just a title.
  const cols = new Set(
    db.prepare('PRAGMA table_info(saved_prototypes)').all().map((c) => c.name)
  );
  if (!cols.has('thumbnail')) {
    db.exec('ALTER TABLE saved_prototypes ADD COLUMN thumbnail TEXT');
  }
  // chat_history is a base64-encoded gzip of a small JSON blob with the
  // published pane's turns + history + system + tools. Owner-only; only
  // returned by GET /api/account/saved-prototypes/:id, never by the
  // list endpoint. Capped at 200 KB pre-compression in the POST handler.
  if (!cols.has('chat_history')) {
    db.exec('ALTER TABLE saved_prototypes ADD COLUMN chat_history TEXT');
  }
  // Visibility: 1 = public (anyone with UUID can view), 0 = private (owner only).
  // Defaults to 1 to preserve existing behaviour for all already-saved prototypes.
  if (!cols.has('is_public')) {
    db.exec('ALTER TABLE saved_prototypes ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1');
  }
  // payload_external = 1 → the real share_payload lives in the cloud Postgres
  // blob store (lingcode_prototype_blobs), not inline here (large prototypes).
  if (!cols.has('payload_external')) {
    db.exec('ALTER TABLE saved_prototypes ADD COLUMN payload_external INTEGER NOT NULL DEFAULT 0');
  }
}

/** @param {import('better-sqlite3').Database} db */
function migrateSupabaseTables(db) {
  // OAuth tokens for users who connected their Supabase account. One row
  // per user (1:1 with users.id). refresh_token is the long-lived token
  // returned by the Management API OAuth dance — supabase-management.js
  // exchanges it for short-lived access tokens on demand and caches those
  // in memory. We persist the refresh token in plaintext to match the
  // github_token storage convention; encryption-at-rest is a separate
  // concern (Phase 4 secrets-vault) with its own KMS setup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS supabase_oauth_tokens (
      user_id                  TEXT PRIMARY KEY,
      refresh_token            TEXT NOT NULL,
      scope                    TEXT,
      connected_at             TEXT NOT NULL,
      last_refreshed_at        TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // One row per saved prototype that has a Supabase project provisioned
  // for it. Phase 2's auto-provision flow will INSERT here after a
  // successful Management API project create. Empty by default; safe to
  // ship the schema before the provisioning flow exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS prototype_supabase_projects (
      prototype_id      TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      project_ref       TEXT NOT NULL,
      organization_id   TEXT NOT NULL,
      region            TEXT,
      anon_key          TEXT,
      created_at        TEXT NOT NULL,
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_psp_user ON prototype_supabase_projects(user_id)');
}

/** @param {import('better-sqlite3').Database} db */
function migrateSecretsVaultTable(db) {
  // Per-prototype encrypted secrets. Phase 4 of the /try Lovable-parity
  // plan. Used by the AI's `deploy_edge_function` flow + by the user's
  // explicit "Set STRIPE_SECRET_KEY" UI. encrypted_value is opaque base64
  // (see secrets-vault.js for format); SQL-side never sees plaintext.
  //
  // (prototype_id, key) is unique so updates overwrite. user_id is
  // denormalized so we can fast-filter on owner without joining
  // saved_prototypes — the FK still enforces referential integrity.
  db.exec(`
    CREATE TABLE IF NOT EXISTS prototype_secrets (
      id              TEXT PRIMARY KEY,
      prototype_id    TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      key             TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(prototype_id, key),
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_secrets_proto ON prototype_secrets(prototype_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_secrets_user ON prototype_secrets(user_id)');
}

/** @param {import('better-sqlite3').Database} db */
function migratePrototypeDomainsTable(db) {
  // Custom domains attached to a prototype's deploy. Phase 5b/7 of the
  // /try Lovable-parity plan. Empty in v1; populated when the
  // domains-routes module wires up alongside Vercel/CF Pages deploys.
  //
  // target_type values:
  //   'netlify'        — points at the existing Netlify zip-deploy
  //   'edge_function'  — points at a Supabase Edge Function URL
  //   'vercel'         — points at a Vercel deployment (Phase 7)
  //   'cf_pages'       — points at a Cloudflare Pages deployment (Phase 7)
  //
  // status values: 'pending' (CNAME created, awaiting propagation) /
  //                'live' (DoH verified) / 'failed' (took >1h to propagate)
  db.exec(`
    CREATE TABLE IF NOT EXISTS prototype_domains (
      id                    TEXT PRIMARY KEY,
      prototype_id          TEXT NOT NULL,
      user_id               TEXT NOT NULL,
      hostname              TEXT NOT NULL,
      target_type           TEXT NOT NULL,
      target_value          TEXT NOT NULL,
      cloudflare_record_id  TEXT,
      status                TEXT NOT NULL DEFAULT 'pending',
      created_at            TEXT NOT NULL,
      verified_at           TEXT,
      UNIQUE(hostname),
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_domains_proto ON prototype_domains(prototype_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_domains_user ON prototype_domains(user_id)');
}

/** @param {import('better-sqlite3').Database} db */
function migrateCollabTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_members (
      id            TEXT PRIMARY KEY,
      prototype_id  TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      invited_by    TEXT,
      created_at    INTEGER NOT NULL,
      invite_token  TEXT,
      invite_expires INTEGER,
      UNIQUE(prototype_id, user_id),
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cm_proto ON collab_members(prototype_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cm_user  ON collab_members(user_id)');

  // collab_ydoc_state — composite PK (prototype_id, file_id) supports
  // multi-file collab sessions. file_id is project-root-relative POSIX path,
  // or the sentinel '_main' for legacy single-file rows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_ydoc_state (
      prototype_id  TEXT NOT NULL,
      file_id       TEXT NOT NULL DEFAULT '_main',
      state_blob    BLOB NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (prototype_id, file_id),
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_comments (
      id           TEXT PRIMARY KEY,
      prototype_id TEXT NOT NULL,
      thread_id    TEXT,
      author_id    TEXT NOT NULL,
      selector     TEXT,
      xpath        TEXT,
      text_prefix  TEXT,
      body         TEXT NOT NULL,
      resolved     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id),
      FOREIGN KEY(author_id)    REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_proto  ON collab_comments(prototype_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cc_thread ON collab_comments(thread_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      prototype_id TEXT NOT NULL,
      user_id      TEXT,
      update_blob  BLOB NOT NULL,
      server_ts    INTEGER NOT NULL,
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ch_proto ON collab_history(prototype_id, server_ts DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ch_user  ON collab_history(user_id, server_ts DESC)');

  // Pending invites for emails that don't yet have a LingCode account.
  // Owner enters an email, server stashes (token, prototype_id, email, role)
  // and emails a sign-up link. After the recipient signs up + clicks the link,
  // GET /api/collab/claim?token=... inserts the collab_members row and marks
  // this invite consumed. (prototype_id, email) is unique so re-inviting the
  // same address upserts (refreshes the token + expiry instead of duplicating).
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_pending_invites (
      id            TEXT PRIMARY KEY,
      prototype_id  TEXT NOT NULL,
      email         TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      token         TEXT NOT NULL UNIQUE,
      invited_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      consumed_at   INTEGER,
      consumed_by   TEXT,
      UNIQUE(prototype_id, email),
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id),
      FOREIGN KEY(invited_by)   REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cpi_token ON collab_pending_invites(token)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cpi_proto ON collab_pending_invites(prototype_id)');

  // Bump legacy single-file schema (file_id absent) → multi-file. Idempotent;
  // re-running on an already-bumped DB is a no-op.
  bumpCollabSchemaToMultiFile(db);
}

/**
 * One-shot legacy→multi-file schema bump for collab tables. Detects whether
 * `file_id` exists on collab_ydoc_state / collab_history and adds it where
 * missing — backfilling legacy rows with the '_main' sentinel.
 *
 * Idempotent. Exported so tests can exercise it against an in-memory DB.
 *
 * @param {import('better-sqlite3').Database} db
 */
function bumpCollabSchemaToMultiFile(db) {
  const ydocCols = new Set(
    db.prepare('PRAGMA table_info(collab_ydoc_state)').all().map((c) => c.name)
  );
  if (!ydocCols.has('file_id')) {
    // SQLite cannot alter a PRIMARY KEY in place — rebuild via temp table.
    // The order here matters: create-v2 → INSERT … SELECT → DROP old → RENAME.
    db.exec(`
      CREATE TABLE collab_ydoc_state_v2 (
        prototype_id TEXT NOT NULL,
        file_id      TEXT NOT NULL DEFAULT '_main',
        state_blob   BLOB NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (prototype_id, file_id)
      )
    `);
    db.exec(`
      INSERT INTO collab_ydoc_state_v2 (prototype_id, file_id, state_blob, updated_at)
      SELECT prototype_id, '_main', state_blob, updated_at FROM collab_ydoc_state
    `);
    db.exec('DROP TABLE collab_ydoc_state');
    db.exec('ALTER TABLE collab_ydoc_state_v2 RENAME TO collab_ydoc_state');
  }

  const histCols = new Set(
    db.prepare('PRAGMA table_info(collab_history)').all().map((c) => c.name)
  );
  if (!histCols.has('file_id')) {
    db.exec("ALTER TABLE collab_history ADD COLUMN file_id TEXT NOT NULL DEFAULT '_main'");
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_ch_proto_file_ts ON collab_history(prototype_id, file_id, server_ts DESC)');
}

// The `app_config` and `agent_sdk_*` schemas were provisioned on the prod
// droplet out-of-band — the corresponding CREATE TABLE migrations were
// never written into this file, but index.js imports the functions and
// invokes them at boot. These no-op stubs keep the boot path from
// crashing; the tables already exist in prod. New local dev needs to
// hand-roll them once, or replace these stubs with real
// CREATE TABLE IF NOT EXISTS bodies.
function migrateAppConfigTable(_db) {}
function migrateAgentSdkTables(_db) {}

// Feedback table — historically provisioned out-of-band on prod, no schema
// migration. Filled in here because we need to ADD a column for inline
// screenshot attachments (data: URL, capped server-side). Both the CREATE
// and the ADD are idempotent so prod's existing table is left alone except
// for the new column.
function migrateFeedbackTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT    NOT NULL,
      category    TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      details     TEXT,
      email       TEXT,
      app_version TEXT,
      os_version  TEXT,
      client_ip   TEXT
    )
  `);
  // SQLite has no `ADD COLUMN IF NOT EXISTS`. Inspect via pragma and only
  // add when absent so re-running on prod (where the column will exist
  // after the first deploy) doesn't throw "duplicate column name".
  const cols = db.prepare('PRAGMA table_info(feedback)').all();
  if (!cols.some(c => c.name === 'screenshot_data_url')) {
    db.exec('ALTER TABLE feedback ADD COLUMN screenshot_data_url TEXT');
  }
}

/** @param {import('better-sqlite3').Database} db */
function migrateCloudBackendTables(db) {
  // LingCode Cloud (managed backend) control-plane metadata. The tenant
  // DATA lives in the separate Postgres data plane (see website/cloud-infra/);
  // these SQLite tables only track which prototype owns which backend, plus
  // the encrypted signing secret, usage counters, and a capped log buffer.

  // One row per provisioned backend (1:1 with saved_prototypes). `id` is the
  // routing key (be_<id> schema, <id>.api.lingcode.dev host in Phase 2).
  // anon_jwt is public-by-design (only grants what the tenant role allows);
  // the signing secret + service creds live in backend_signing_secrets.
  db.exec(`
    CREATE TABLE IF NOT EXISTS prototype_backends (
      id              TEXT PRIMARY KEY,
      prototype_id    TEXT NOT NULL UNIQUE,
      user_id         TEXT NOT NULL,
      isolation       TEXT NOT NULL DEFAULT 'schema',
      cluster_id      TEXT,
      schema_name     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'provisioning',
      gateway_url     TEXT,
      anon_jwt        TEXT,
      tier            TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      FOREIGN KEY(prototype_id) REFERENCES saved_prototypes(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_backends_user ON prototype_backends(user_id)');

  // Per-tenant JWT signing secret (AES-256-GCM via secrets-vault.js). NEVER
  // serialized to the browser. service_role_jwt_enc reserved for Phase 2+.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_signing_secrets (
      backend_id            TEXT PRIMARY KEY,
      encrypted_secret      TEXT NOT NULL,
      service_role_jwt_enc  TEXT,
      created_at            TEXT NOT NULL
    )
  `);

  // Daily metered counters — drives the Usage tab + future quota enforcement.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_usage (
      backend_id        TEXT NOT NULL,
      day               TEXT NOT NULL,
      db_rows_read      INTEGER NOT NULL DEFAULT 0,
      db_rows_written   INTEGER NOT NULL DEFAULT 0,
      storage_bytes     INTEGER NOT NULL DEFAULT 0,
      func_invocations  INTEGER NOT NULL DEFAULT 0,
      auth_users        INTEGER NOT NULL DEFAULT 0,
      emails_sent       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (backend_id, day)
    )
  `);
  // Additive column for DBs created before managed email — idempotent.
  if (!new Set(db.prepare('PRAGMA table_info(backend_usage)').all().map((c) => c.name)).has('emails_sent')) {
    db.exec('ALTER TABLE backend_usage ADD COLUMN emails_sent INTEGER NOT NULL DEFAULT 0');
  }

  // Object storage (Phase 4). Small blobs stored base64 in the control-plane
  // DB; a production storage-api swap keeps the same routes. Capped per-object
  // + per-backend in the route handler.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_objects (
      id            TEXT PRIMARY KEY,
      backend_id    TEXT NOT NULL,
      bucket        TEXT NOT NULL DEFAULT 'public',
      path          TEXT NOT NULL,
      content_type  TEXT,
      bytes         INTEGER NOT NULL DEFAULT 0,
      data_b64      TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      UNIQUE(backend_id, bucket, path),
      -- account_backends, NOT prototype_backends: real backends live in
      -- account_backends (prototype_backends is the legacy /try table). The old
      -- FK made every account-backend storage upload fail "FOREIGN KEY constraint
      -- failed" (e.g. avatar upload 500). Live data.db was rebuilt to match.
      FOREIGN KEY(backend_id) REFERENCES account_backends(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_objects ON backend_objects(backend_id, bucket)');
  // Spaces offload (additive): when spaces_key is set, the bytes live in DO
  // Spaces and data_b64 is left empty. Legacy rows keep data_b64 inline.
  try {
    const ocols = db.prepare('PRAGMA table_info(backend_objects)').all().map((c) => c.name);
    if (!ocols.includes('spaces_key')) db.exec('ALTER TABLE backend_objects ADD COLUMN spaces_key TEXT');
    if (!ocols.includes('etag')) db.exec('ALTER TABLE backend_objects ADD COLUMN etag TEXT');
    // Per-user isolation (additive): owner_user_id = the tenant user who owns the
    // object. NULL = shared/legacy (anon-key or owner-console writes) — preserves
    // existing behavior. Private-bucket objects written by an authenticated user
    // are namespaced under u_<userId>/ in their path, so each user has an isolated
    // keyspace and reads/deletes are scoped to the owner.
    if (!ocols.includes('owner_user_id')) db.exec('ALTER TABLE backend_objects ADD COLUMN owner_user_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_backend_objects_owner ON backend_objects(backend_id, owner_user_id)');
  } catch (_) { /* best-effort */ }

  // De-dupe flags for the storage near-limit warning email: one row per backend,
  // each flag set when its 80%/95% email has been sent and cleared when usage drops
  // back below 80% — so the owner gets one email per threshold crossing, not per write.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_storage_alerts (
      backend_id  TEXT PRIMARY KEY,
      warned_80   INTEGER NOT NULL DEFAULT 0,
      warned_95   INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Serverless functions (arbitrary customer code, run in a sandboxed Deno
  // subprocess by cloud-functions-runtime.js). `secrets` is a JSON array of
  // secret NAMES to resolve from the vault and inject as ctx.secrets at call
  // time. Built-in curated templates (echo/send-email) live in code, not here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_functions (
      id          TEXT PRIMARY KEY,
      backend_id  TEXT NOT NULL,
      slug        TEXT NOT NULL,
      source      TEXT NOT NULL,
      runtime     TEXT NOT NULL DEFAULT 'deno-ts',
      enabled     INTEGER NOT NULL DEFAULT 1,
      secrets     TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(backend_id, slug)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_functions ON backend_functions(backend_id)');

  // Repository-backed backend definitions. The local `lingcode/` directory is
  // the source of truth; these rows record the last successfully deployed hash
  // for drift detection and retry-safe manifest deployment.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_source_artifacts (
      backend_id   TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK(kind IN ('migration','function')),
      name         TEXT NOT NULL,
      path         TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      user_id      TEXT,
      deployed_at  TEXT NOT NULL,
      PRIMARY KEY (backend_id, kind, name),
      FOREIGN KEY (backend_id) REFERENCES account_backends(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_source_artifacts_backend ON backend_source_artifacts(backend_id, kind, name)');

  // Push notifications. backend_push_config holds the per-backend VAPID keypair
  // (private key AES-256-GCM encrypted) + optional BYO FCM service account.
  // backend_push_subscriptions holds each device subscription, keyed by
  // endpoint (web push URL or FCM/APNs token), optionally tied to a tenant user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_push_config (
      backend_id        TEXT PRIMARY KEY,
      vapid_public      TEXT,
      vapid_private_enc TEXT,
      fcm_key_enc       TEXT,
      apns_key_enc      TEXT,
      apns_key_id       TEXT,
      apns_team_id      TEXT,
      apns_topic        TEXT,
      apns_env          TEXT NOT NULL DEFAULT 'production',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `);
  // Additive: apns_env distinguishes Apple's sandbox vs production push hosts.
  // Dev/debug-build device tokens only deliver on sandbox; TestFlight/App-Store
  // tokens use production. Backfill existing rows to 'production'.
  {
    const pushCfgCols = new Set(
      db.prepare('PRAGMA table_info(backend_push_config)').all().map((c) => c.name)
    );
    if (!pushCfgCols.has('apns_env')) {
      db.exec("ALTER TABLE backend_push_config ADD COLUMN apns_env TEXT NOT NULL DEFAULT 'production'");
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_push_subscriptions (
      id          TEXT PRIMARY KEY,
      backend_id  TEXT NOT NULL,
      user_id     TEXT,
      kind        TEXT NOT NULL DEFAULT 'webpush',
      endpoint    TEXT NOT NULL,
      p256dh      TEXT,
      auth        TEXT,
      created_at  TEXT NOT NULL,
      UNIQUE(backend_id, endpoint)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_subs ON backend_push_subscriptions(backend_id, user_id)');

  // Capped ring buffer of recent events for the Logs tab.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      backend_id  TEXT NOT NULL,
      ts          TEXT NOT NULL,
      source      TEXT NOT NULL,
      level       TEXT NOT NULL DEFAULT 'info',
      message     TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_logs ON backend_logs(backend_id, id DESC)');

  // Passwordless magic-link tokens (managed email auth). We store only the
  // sha256 hash of the token; the plaintext lives solely in the emailed link.
  // Single-use (used_at) + short TTL (expires_at).
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_magic_links (
      id          TEXT PRIMARY KEY,
      backend_id  TEXT NOT NULL,
      email       TEXT NOT NULL,
      token_hash  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_magic_links ON backend_magic_links(backend_id, token_hash)');

  // Standalone (account/project) backends — for the IDE / CLI / external MCP
  // clients, which have no /try prototype to attach to. Same shape as
  // prototype_backends minus the prototype FK; keyed on (user_id, project_key).
  // The data plane + per-backend MCP route by `id` and work unchanged once a
  // row exists (backend-id lookups check both tables). Kept SEPARATE from
  // prototype_backends to avoid a risky live rebuild of that NOT NULL column.
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_backends (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      project_key   TEXT NOT NULL,
      schema_name   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'provisioning',
      gateway_url   TEXT,
      anon_jwt      TEXT,
      tier          TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(user_id, project_key),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_account_backends_user ON account_backends(user_id)');
  // Human-readable project name (the workspace folder name) so the console
  // shows "MyCal" instead of an opaque project_key hash.
  const accountBackendColumns = new Set(db.prepare('PRAGMA table_info(account_backends)').all().map((c) => c.name));
  if (!accountBackendColumns.has('label')) {
    db.exec('ALTER TABLE account_backends ADD COLUMN label TEXT');
  }
  // Deployment safety must never infer production from a human label. Existing
  // backends are production by default; future isolated backends opt into the
  // development environment explicitly.
  if (!accountBackendColumns.has('environment')) {
    db.exec(`ALTER TABLE account_backends
      ADD COLUMN environment TEXT NOT NULL DEFAULT 'production'
      CHECK(environment IN ('development','production'))`);
  }
  // Preview: opt-in per-backend flag gating the Python custom-functions runtime
  // (cloud-python-runtime.js). Default 0 so existing backends see no behavior
  // change; ops flips to 1 via SQL / admin console to enroll a backend in
  // Preview. See cloud-functions-routes.js:runtimeAllowedForBackend.
  if (!accountBackendColumns.has('python_runtime_enabled')) {
    db.exec('ALTER TABLE account_backends ADD COLUMN python_runtime_enabled INTEGER NOT NULL DEFAULT 0');
  }

  // Short-lived, hash-bound production deployment previews. The payload is the
  // already-normalized manifest content, never arbitrary request fields or
  // secret values. Plans are single-use and scoped to one user/backend.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_deployment_plans (
      id              TEXT PRIMARY KEY,
      backend_id      TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      environment     TEXT NOT NULL CHECK(environment IN ('development','production')),
      manifest_digest TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      summary_json    TEXT NOT NULL,
      warnings_json   TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL CHECK(status IN ('pending','consumed')),
      expires_at      INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      consumed_at     INTEGER,
      FOREIGN KEY(backend_id) REFERENCES account_backends(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_deployment_plans_backend_status ON backend_deployment_plans(backend_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_deployment_plans_expires ON backend_deployment_plans(expires_at)');

  // BYO OAuth: a backend's own provider client (overrides the managed shared
  // one). client_secret is AES-256-GCM encrypted (see cloud-oauth.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_oauth_providers (
      backend_id    TEXT NOT NULL,
      provider      TEXT NOT NULL,
      client_id     TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (backend_id, provider)
    )
  `);
  // Apple BYO needs more than client_id/secret: the .p8 private key (stored
  // encrypted in client_secret) plus the team/key ids to sign the client_secret
  // JWT, and the native app's bundle id (the aud of the native identity token).
  {
    const cols = new Set(db.prepare('PRAGMA table_info(backend_oauth_providers)').all().map((c) => c.name));
    if (!cols.has('team_id')) db.exec('ALTER TABLE backend_oauth_providers ADD COLUMN team_id TEXT');
    if (!cols.has('key_id')) db.exec('ALTER TABLE backend_oauth_providers ADD COLUMN key_id TEXT');
    if (!cols.has('bundle_id')) db.exec('ALTER TABLE backend_oauth_providers ADD COLUMN bundle_id TEXT');
  }

  // Per-backend auth settings. mfa_required gates server-side MFA enforcement
  // (default off so existing apps are unaffected); when on, the data proxy
  // rejects a user access token whose aal is not 'aal2'. allowed_fetch_hosts is
  // a comma-separated egress allow-list for the http-fetch function template
  // (empty = deny all outbound — secure default).
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_auth_settings (
      backend_id   TEXT PRIMARY KEY,
      mfa_required INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT
    )
  `);
  {
    const cols = new Set(db.prepare('PRAGMA table_info(backend_auth_settings)').all().map((c) => c.name));
    if (!cols.has('allowed_fetch_hosts')) db.exec('ALTER TABLE backend_auth_settings ADD COLUMN allowed_fetch_hosts TEXT');
    // allowed_redirect_origins: comma-separated extra hostnames a backend accepts
    // as OAuth sign-in redirect targets, beyond the always-allowed localhost and
    // *.lingcode.dev (see cloud-oauth.js redirectAllowed). Empty/absent = none.
    if (!cols.has('allowed_redirect_origins')) db.exec('ALTER TABLE backend_auth_settings ADD COLUMN allowed_redirect_origins TEXT');
    // require_email_verification: when on, password signup creates an UNVERIFIED
    // user + emails a confirmation link, and sign-in is blocked until verified
    // (Supabase/Firebase-style). Default off so existing apps are unaffected.
    if (!cols.has('require_email_verification')) db.exec('ALTER TABLE backend_auth_settings ADD COLUMN require_email_verification INTEGER NOT NULL DEFAULT 0');
  }

  // Single-use email-confirmation tokens for password signup (kind 'verify_email').
  // Same shape/handling as backend_magic_links: store only sha256(token), short TTL,
  // single-use (used_at).
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_email_verifications (
      id          TEXT PRIMARY KEY,
      backend_id  TEXT NOT NULL,
      email       TEXT NOT NULL,
      token_hash  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_email_verifications ON backend_email_verifications(backend_id, token_hash)');

  // Per-backend encrypted secrets (3rd-party API keys for function templates).
  // AES-256-GCM at rest via secrets-vault.js; keyed by backend_id (account
  // backends have no prototype_id). Values never leave the server.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_secrets (
      backend_id      TEXT NOT NULL,
      key             TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (backend_id, key)
    )
  `);
  // 'secret' (write-only, masked in console) vs 'var' (non-sensitive config like
  // NODE_ENV — readable back in plaintext in the console). BOTH ship to a deployed
  // Worker as c.env.<KEY> bindings; `kind` governs console read-back only. Additive.
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(backend_secrets)').all().map((c) => c.name));
    if (!cols.has('kind')) db.exec("ALTER TABLE backend_secrets ADD COLUMN kind TEXT NOT NULL DEFAULT 'secret'");
  } catch (_) { /* best-effort; table created just above */ }

  // Email OTP codes (6-digit, hashed, single-use, short TTL).
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_otp_codes (
      id          TEXT PRIMARY KEY,
      backend_id  TEXT NOT NULL,
      email       TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_otp_codes ON backend_otp_codes(backend_id, email)');

  // Per-backend email-template overrides for the managed auth emails. `kind` is
  // 'magiclink' | 'otp'. When no row exists for a (backend, kind), the built-in
  // default in cloud-backend.js EMAIL_DEFAULTS is used. subject/html may contain
  // {{link}}, {{code}}, {{email}} placeholders, substituted at send time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_email_templates (
      backend_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      subject     TEXT NOT NULL,
      html        TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (backend_id, kind)
    )
  `);

  // Custom domains: map a customer's own hostname to a published prototype.
  // status active ⇒ the on-demand-TLS proxy may issue a cert + serve the app.
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_domains (
      domain       TEXT PRIMARY KEY,
      prototype_id TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_custom_domains_user ON custom_domains(user_id)');
}

/** @param {import('better-sqlite3').Database} db */
function migrateCloudAppsTables(db) {
  // "Cloud Apps" — BUILT static frontends (Vite/React/etc.) deployed from the
  // native IDE, served at /apps/<id>/* with REAL sub-path asset serving + SPA
  // fallback. Kept SEPARATE from saved_prototypes: that subsystem stores a
  // single base64 blob rendered inside a sandboxed <iframe srcdoc>, which can't
  // serve hashed /assets/*.js chunks a build emits. Metadata lives here; file
  // bytes go to the roomy cloud Postgres (lingcode_app_blobs) so they don't
  // bloat the disk-tight control-plane SQLite. See cloud-apps.js.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_apps (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      title          TEXT NOT NULL,
      index_path     TEXT NOT NULL DEFAULT 'index.html',
      version        INTEGER NOT NULL DEFAULT 1,
      total_bytes    INTEGER NOT NULL DEFAULT 0,
      file_count     INTEGER NOT NULL DEFAULT 0,
      is_public      INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_opened_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_apps_user ON cloud_apps(user_id, created_at DESC)');

  // Vanity subdomain label (<slug>.apps.lingcode.dev). Auto-assigned on first
  // deploy so a routed SPA serves at ROOT (the /apps/<id>/ sub-path serves a
  // base-href'd build, which blanks any client-side router). See cloud-apps.js.
  if (!new Set(db.prepare('PRAGMA table_info(cloud_apps)').all().map((c) => c.name)).has('slug')) {
    db.exec('ALTER TABLE cloud_apps ADD COLUMN slug TEXT');
  }

  // LingCode Cloud COMPUTE tier (cloud-workers.js): one row per full-stack/SSR
  // app deployed as an isolated Cloudflare Worker in the dispatch namespace and
  // served at <id>.run.lingcode.dev. The Worker bytes + assets live in Cloudflare
  // (not Postgres), so this is just the control-plane record. `id` is the tenant
  // script name (also the subdomain label).
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_workers (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      title      TEXT NOT NULL,
      hostname   TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_workers_user ON cloud_workers(user_id, created_at DESC)');

  // Per-Worker env secrets, set directly on a deployed Worker (no managed backend
  // required). Encrypted at rest with the same vault key as backend_secrets; bound
  // to the Worker as c.env.<KEY> on every deploy (see cloud-workers.js syncWorkerSecrets).
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_secrets (
      worker_id       TEXT NOT NULL,
      key             TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (worker_id, key)
    )
  `);

  // Kill-switch: a deployed Worker can be suspended (over-quota / abuse / non-pay)
  // instead of only deleted. 'active' | 'suspended'. Edge enforcement lives in the
  // out-of-repo lingcode-dispatch router (reads a CF KV mirror); this column is the
  // control-plane source of truth. Additive + idempotent (same pattern as
  // backend_usage.emails_sent).
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(cloud_workers)').all().map((c) => c.name));
    if (!cols.has('status')) db.exec("ALTER TABLE cloud_workers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    // 'manual' (owner/admin) vs 'quota' (auto over daily requests). The usage poller
    // only auto-resumes 'quota' suspensions at day rollover — never a manual one.
    if (!cols.has('status_reason')) db.exec('ALTER TABLE cloud_workers ADD COLUMN status_reason TEXT');
  } catch (_) { /* best-effort; table created just above so this should hold */ }

  // Scheduled jobs (cron) for a deployed Worker. Cloudflare rejects per-tenant Cron
  // Triggers on dispatch scripts, so LingCode runs ONE scheduler (cloud-worker-cron.js)
  // that fans out signed HTTP calls to <worker>.run.lingcode.dev<path> on each due
  // row. `schedule` is a 5-field cron expr; `next_run_at`/`last_run_at` are epoch ms
  // so the loop survives restarts. `headers_json` is optional extra request headers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_crons (
      id           TEXT PRIMARY KEY,
      worker_id    TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      schedule     TEXT NOT NULL,
      path         TEXT NOT NULL DEFAULT '/',
      method       TEXT NOT NULL DEFAULT 'POST',
      headers_json TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_at  INTEGER,
      last_status  INTEGER,
      next_run_at  INTEGER,
      created_at   INTEGER NOT NULL,
      FOREIGN KEY(worker_id) REFERENCES cloud_workers(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_worker_crons_worker ON worker_crons(worker_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_worker_crons_due ON worker_crons(enabled, next_run_at)');

  // Scheduled serverless functions (managed-backend tier). Same 5-field cron +
  // epoch-ms next/last as worker_crons, but the scheduler INVOKES the Deno function
  // in-process (cloud-function-cron.js) instead of firing an HTTP call. `input_json`
  // is optional payload merged into the function's scheduled input.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_function_schedules (
      id           TEXT PRIMARY KEY,
      backend_id   TEXT NOT NULL,
      slug         TEXT NOT NULL,
      schedule     TEXT NOT NULL,
      input_json   TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_at  INTEGER,
      last_status  TEXT,
      next_run_at  INTEGER,
      created_at   INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bfs_backend ON backend_function_schedules(backend_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bfs_due ON backend_function_schedules(enabled, next_run_at)');

  // Daily metered counters per deployed Worker — drives the Usage panel + request
  // quota enforcement. Populated by the CF GraphQL analytics poller (cloud-worker-
  // usage.js), keyed by scriptName=<id>. Mirrors backend_usage's shape.
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_usage (
      worker_id  TEXT NOT NULL,
      day        TEXT NOT NULL,
      requests   INTEGER NOT NULL DEFAULT 0,
      errors     INTEGER NOT NULL DEFAULT 0,
      cpu_ms     INTEGER NOT NULL DEFAULT 0,
      subrequests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (worker_id, day),
      FOREIGN KEY(worker_id) REFERENCES cloud_workers(id)
    )
  `);

  // Capped ring buffer of recent log events for a deployed Worker's Logs panel.
  // Fed by an out-of-repo CF Tail Worker POSTing to /api/account/cloud-workers/:id/logs/ingest.
  // Mirrors backend_logs; pruned to ~500 rows/worker on ingest.
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id  TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      level      TEXT NOT NULL DEFAULT 'info',
      message    TEXT,
      FOREIGN KEY(worker_id) REFERENCES cloud_workers(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_worker_logs ON worker_logs(worker_id, id DESC)');

  // One row per file in the deployed dist tree. `path` is normalized (no leading
  // slash, no traversal). `blob_key` keys into the Postgres byte store.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_app_files (
      app_id       TEXT NOT NULL,
      path         TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_len     INTEGER NOT NULL,
      blob_key     TEXT NOT NULL,
      PRIMARY KEY (app_id, path)
    )
  `);

  // custom_domains was created (in migrateCloudBackendTables) mapping a domain
  // to a prototype_id. A domain may now instead point at a cloud app. Additive
  // nullable column avoids a risky rebuild of the NOT NULL prototype_id. App
  // rows store app_id set + prototype_id = '' (a sentinel; the middleware
  // branches on app_id first). Idempotent.
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(custom_domains)').all().map((c) => c.name));
    if (!cols.has('app_id')) db.exec('ALTER TABLE custom_domains ADD COLUMN app_id TEXT');
    if (!cols.has('worker_id')) db.exec('ALTER TABLE custom_domains ADD COLUMN worker_id TEXT');   // hosted Worker custom domains
    // Domainee (domainee.dev) connection id when this domain is edge-proxied by
    // Domainee instead of our own Caddy edge. NULL → served by our edge (manual DNS).
    if (!cols.has('domainee_id')) db.exec('ALTER TABLE custom_domains ADD COLUMN domainee_id TEXT');
  } catch (_) { /* best-effort; table may not exist yet on a fresh DB ordering */ }

  // Deploy history — one immutable row per cloud-app deploy, so users get
  // GitHub-style "see what each deploy changed + roll back" without GitHub.
  // `files_json` is the version's full file manifest ({path,content_type,
  // byte_len,blob_key}); because old blobs are now RETAINED (see cloud-apps.js),
  // a rollback re-points cloud_app_files at a prior deployment's blobs — code
  // only, never touches database data. status: live | superseded | rolled_back.
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id             TEXT PRIMARY KEY,
      app_id         TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      version        INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'live',
      title          TEXT,
      index_path     TEXT,
      total_bytes    INTEGER NOT NULL DEFAULT 0,
      file_count     INTEGER NOT NULL DEFAULT 0,
      files_json     TEXT NOT NULL,
      source_version INTEGER,
      note           TEXT,
      created_at     INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_deployments_app ON deployments(app_id, version DESC)');

  // Schema-change audit log — one row per apply_migration call against a managed
  // backend, recorded at the tool call sites. Gives the console a history of
  // every DDL (what ran, who, when, applied/failed) so schema changes aren't a
  // black box. Does NOT auto-reverse — data-safe by design.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      backend_id TEXT NOT NULL,
      user_id    TEXT,
      sql        TEXT NOT NULL,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_schema_migrations_backend ON schema_migrations(backend_id, created_at DESC)');
}

/** @param {import('better-sqlite3').Database} db */
function migrateCloudTelemetryTables(db) {
  // Backbone ① — the telemetry plane behind Analytics, Crashlytics, Performance,
  // and Release Monitoring. Apps POST events to /api/cloud/be/:id/telemetry; we
  // store DAILY AGGREGATES (not raw events) so row counts stay bounded by
  // days×names×versions regardless of event volume — keeps the disk-tight
  // control-plane DB safe. Crashes are grouped by fingerprint (capped + pruned).
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_analytics_daily (
      backend_id   TEXT NOT NULL,
      day          TEXT NOT NULL,
      event_name   TEXT NOT NULL,
      app_version  TEXT NOT NULL DEFAULT 'unknown',
      count        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (backend_id, day, event_name, app_version)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_be_day ON backend_analytics_daily(backend_id, day)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_perf_daily (
      backend_id   TEXT NOT NULL,
      day          TEXT NOT NULL,
      metric_name  TEXT NOT NULL,
      app_version  TEXT NOT NULL DEFAULT 'unknown',
      count        INTEGER NOT NULL DEFAULT 0,
      sum_ms       REAL NOT NULL DEFAULT 0,
      max_ms       REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (backend_id, day, metric_name, app_version)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_perf_be_day ON backend_perf_daily(backend_id, day)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_crashes (
      id           TEXT PRIMARY KEY,
      backend_id   TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      message      TEXT,
      stack        TEXT,
      app_version  TEXT,
      platform     TEXT,
      count        INTEGER NOT NULL DEFAULT 1,
      first_seen   TEXT NOT NULL,
      last_seen    TEXT NOT NULL,
      UNIQUE (backend_id, fingerprint)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_crashes_be_seen ON backend_crashes(backend_id, last_seen DESC)');

  // ── Product analytics (user-level): raw 90-day event log + per-client
  // first/last-seen helper + conversion config. The hybrid model behind
  // DAU/MAU, retention, funnels, and param breakdowns (the aggregate tables
  // above stay for instant top-line). Raw log is pruned to 90 days on ingest.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_event_log (
      id           TEXT PRIMARY KEY,
      backend_id   TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      day          TEXT NOT NULL,
      client_id    TEXT,
      user_id      TEXT,
      session_id   TEXT,
      event_name   TEXT NOT NULL,
      params_json  TEXT,
      app_version  TEXT NOT NULL DEFAULT 'unknown',
      platform     TEXT NOT NULL DEFAULT 'web'
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_evlog_be_ts ON backend_event_log(backend_id, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_evlog_be_name_ts ON backend_event_log(backend_id, event_name, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_evlog_be_client_ts ON backend_event_log(backend_id, client_id, ts)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_client_seen (
      backend_id      TEXT NOT NULL,
      client_id       TEXT NOT NULL,
      first_seen_day  TEXT NOT NULL,
      last_seen_day   TEXT NOT NULL,
      user_id         TEXT,
      app_version     TEXT,
      PRIMARY KEY (backend_id, client_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_client_seen_be_first ON backend_client_seen(backend_id, first_seen_day)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_client_seen_be_last ON backend_client_seen(backend_id, last_seen_day)');
  // Latest user properties per client (JSON) — powers property-based segments.
  const _seenCols = new Set(db.prepare('PRAGMA table_info(backend_client_seen)').all().map((c) => c.name));
  if (!_seenCols.has('props_json')) db.exec('ALTER TABLE backend_client_seen ADD COLUMN props_json TEXT');
  // Country code (from Cloudflare CF-IPCountry at ingest) — country-only geo,
  // no IP / precise location stored. Powers country segments.
  if (!_seenCols.has('country')) db.exec('ALTER TABLE backend_client_seen ADD COLUMN country TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_key_events (
      backend_id  TEXT NOT NULL,
      event_name  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (backend_id, event_name)
    )
  `);

  // A/B testing + Remote Config: one row per experiment. variants_json is
  // [{name, value, weight}]; clients are bucketed deterministically by id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backend_experiments (
      id            TEXT PRIMARY KEY,
      backend_id    TEXT NOT NULL,
      param_key     TEXT NOT NULL,
      variants_json TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',
      created_at    TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_experiments_be ON backend_experiments(backend_id, status)');
}

/** @param {import('better-sqlite3').Database} db */
function migrateSlackTables(db) {
  // One row per workspace installation. `team_id` is the Slack workspace ID.
  // Stores the bot token used to post messages as the LingCode bot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_installations (
      team_id         TEXT PRIMARY KEY,
      team_name       TEXT,
      bot_token       TEXT NOT NULL,
      bot_user_id     TEXT,
      installed_at    TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `);

  // Short-lived nonces generated by GET /api/slack/install-link. The IDE
  // includes the nonce as `state` in the Slack OAuth URL so the callback can
  // attribute the install to the right LingCode user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_link_states (
      state_nonce       TEXT PRIMARY KEY,
      lingcode_user_id  INTEGER NOT NULL,
      created_at        TEXT NOT NULL
    )
  `);

  // One row per LingCode user. Maps a signed-in user to the Slack workspace
  // + channel they want Ship & Announce to post to.
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_user_links (
      lingcode_user_id  INTEGER PRIMARY KEY,
      team_id           TEXT NOT NULL,
      workspace_name    TEXT,
      channel_id        TEXT,
      channel_name      TEXT,
      linked_at         TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `);
}

/**
 * Unified "project" entity for cross-user sharing of deployed resources.
 *
 * A LingCode project spans three independent silos — a managed backend
 * (account_backends), a deployed app/worker (cloud_apps / cloud_workers), and
 * the project source — each historically keyed only by `user_id`. This table
 * gives them ONE owner-assigned identity so a single invite grants consistent
 * owner/editor/viewer access to all of them. Membership (project_members) and
 * by-email invites (project_pending_invites) mirror the collab_* tables.
 *
 * Resources attach via a nullable `project_id` column added below; a NULL means
 * "legacy solo resource" and ownership still falls back to the `user_id` check.
 *
 * MUST run AFTER migrateCloudBackendTables (account_backends) and
 * migrateCloudAppsTables (cloud_apps / cloud_workers).
 *
 * @param {import('better-sqlite3').Database} db
 */
function migrateProjectsTables(db) {
  const crypto = require('crypto');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id             TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL,
      name           TEXT NOT NULL,
      git_remote     TEXT,
      default_branch TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      FOREIGN KEY(owner_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      role           TEXT NOT NULL DEFAULT 'viewer',
      invited_by     TEXT,
      created_at     INTEGER NOT NULL,
      invite_token   TEXT,
      invite_expires INTEGER,
      UNIQUE(project_id, user_id),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(user_id)    REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pm_project ON project_members(project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pm_user    ON project_members(user_id)');

  // Pending invites for emails with no LingCode account yet — same shape and
  // claim flow as collab_pending_invites. (project_id, email) unique so a
  // re-invite upserts (refreshes token + expiry) instead of duplicating.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_pending_invites (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'viewer',
      token       TEXT NOT NULL UNIQUE,
      invited_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by TEXT,
      UNIQUE(project_id, email),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(invited_by) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ppi_token   ON project_pending_invites(token)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ppi_project ON project_pending_invites(project_id)');

  // Pending ownership transfers — accept-required handoff. The target must
  // already be a member; on accept the swap is atomic (projects.owner_id +
  // the two project_members rows). project_id is UNIQUE so re-initiating a
  // transfer replaces the prior pending one (one in flight per project).
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_pending_transfers (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL UNIQUE,
      to_user_id   TEXT NOT NULL,
      from_user_id TEXT NOT NULL,
      token        TEXT NOT NULL UNIQUE,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      FOREIGN KEY(project_id)   REFERENCES projects(id),
      FOREIGN KEY(to_user_id)   REFERENCES users(id),
      FOREIGN KEY(from_user_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ppt_to ON project_pending_transfers(to_user_id)');

  // Net-new "source snapshot" tier — bytes of a project source tarball for the
  // repo-less fallback path (git remote is preferred). blob_key keys into the
  // same Postgres byte store cloud_apps uses. Phase 3 populates it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_source_snapshots (
      project_id  TEXT NOT NULL,
      version     INTEGER NOT NULL,
      blob_key    TEXT NOT NULL,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (project_id, version),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )
  `);

  // Attach the three resources via a nullable, indexed project_id column.
  const addProjectIdColumn = (table) => {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!cols.has('project_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${table}(project_id)`);
  };
  addProjectIdColumn('account_backends');
  addProjectIdColumn('cloud_apps');
  addProjectIdColumn('cloud_workers');

  // ── Idempotent backfill ────────────────────────────────────────────────────
  // Every existing resource row with no project_id becomes its own solo project
  // (one projects row + an owner project_members row). We do NOT auto-merge an
  // app and a backend — there's no reliable server-side key linking them; the
  // Mac app merges them client-side once the .lingcode/project.json manifest
  // exists (POST /api/projects/:id/link-resource).
  const backfill = db.transaction(() => {
    const now = Date.now();
    const ensureOwner = (projectId, ownerId) => {
      db.prepare(`INSERT OR IGNORE INTO project_members (id, project_id, user_id, role, invited_by, created_at)
                  VALUES (?, ?, ?, 'owner', ?, ?)`)
        .run(crypto.randomUUID(), projectId, ownerId, ownerId, now);
    };
    const backfillTable = (table, nameExpr) => {
      const rows = db.prepare(`SELECT id, user_id, ${nameExpr} AS pname FROM ${table} WHERE project_id IS NULL`).all();
      for (const r of rows) {
        const projectId = crypto.randomUUID();
        db.prepare('INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(projectId, r.user_id, String(r.pname || 'Project').slice(0, 120), now, now);
        ensureOwner(projectId, r.user_id);
        db.prepare(`UPDATE ${table} SET project_id = ? WHERE id = ?`).run(projectId, r.id);
      }
    };
    backfillTable('account_backends', "COALESCE(label, project_key)");
    backfillTable('cloud_apps', 'title');
    backfillTable('cloud_workers', 'title');
  });
  backfill();
}

/**
 * remote_hosts — "easy remote coding" hosts (a user's Mac or a Cloud workspace).
 * Each row's id doubles as the collab room id; the host + web client connect to
 * /ws/collab/<id>/__serve and the serve tunnel rides that room. Owner-scoped:
 * only the owning user may attach. See
 * docs/superpowers/specs/2026-06-18-easy-remote-coding-design.md.
 * @param {import('better-sqlite3').Database} db
 */
function migrateRemoteHostsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_hosts (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      name         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER,
      FOREIGN KEY(owner_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_remote_hosts_owner ON remote_hosts(owner_id)');

  // remote_host_shares — read-only "share view-only link" tokens for a host.
  // The token is an unguessable bearer credential the relay validates on connect
  // and pins to a read-only viewer role. Owner-revocable; auto-expires.
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_host_shares (
      token       TEXT PRIMARY KEY,
      host_id     TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      permission  TEXT NOT NULL DEFAULT 'view',
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER,
      revoked     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(host_id)  REFERENCES remote_hosts(id),
      FOREIGN KEY(owner_id) REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_remote_shares_host ON remote_host_shares(host_id)');
}

// migrateComputeTables — control-plane metadata for the LingCode Cloud COMPUTE
// TIER (cloud-compute.js): long-running container jobs that run against a
// tenant backend's Postgres schema with a privileged, role-scoped connection
// (LINGCODE_DB_URL). The job DEFINITION + run ledger live here in SQLite; the
// container itself runs on a worker droplet in the VPC and the tenant DATA it
// touches lives in the separate Postgres data plane (see cloud-data-plane.js).
// This is the heavier sibling of cloud-workers.js (edge apps) + cloud-worker-
// cron.js (30s HTTP cron) — it exists for the 800s-batch / headless-Chromium /
// arbitrary-code workloads those tiers deliberately can't host.
function migrateComputeTables(db) {
  // One row per declared job (1:N with compute_runs). `name` is unique per
  // backend so a manifest can address a job by stable name. `image` is a docker
  // image ref the runner pulls; `entrypoint`/`env_json` are optional overrides.
  // Resource caps (cpu/memory/timeout) are enforced by the runner at `docker
  // run` time and bounded by the owner tier's compute limits (cloud-limits.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_jobs (
      id            TEXT PRIMARY KEY,
      backend_id    TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      image         TEXT NOT NULL,
      entrypoint    TEXT,
      cpu           REAL NOT NULL DEFAULT 1,
      memory_mb     INTEGER NOT NULL DEFAULT 512,
      timeout_sec   INTEGER NOT NULL DEFAULT 900,
      env_json      TEXT,
      egress_hosts  TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(backend_id, name),
      FOREIGN KEY(user_id)    REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_compute_jobs_backend ON compute_jobs(backend_id)');
  // Idempotent backfill (egress_hosts added after the initial compute_jobs shape).
  {
    const jobCols = new Set(db.prepare('PRAGMA table_info(compute_jobs)').all().map((c) => c.name));
    if (!jobCols.has('egress_hosts')) db.exec('ALTER TABLE compute_jobs ADD COLUMN egress_hosts TEXT');
  }

  // The run ledger. A runner claims a 'queued' row (atomic UPDATE … WHERE
  // status='queued'), flips it to 'running', executes the container, streams a
  // capped log tail into `logs`, then records the terminal status + exit code.
  // status ∈ queued | running | succeeded | failed | timed_out | canceled.
  // `trigger` records what enqueued it (manual now; schedule/http/event in SP2+).
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_runs (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL,
      backend_id    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'queued',
      trigger       TEXT NOT NULL DEFAULT 'manual',
      input_json    TEXT,
      exit_code     INTEGER,
      worker_id     TEXT,
      logs          TEXT,
      error         TEXT,
      schedule_id   TEXT,
      attempt       INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 0,
      retry_scheduled INTEGER NOT NULL DEFAULT 0,
      not_before    TEXT,
      run_seconds   REAL,
      queued_at     TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT,
      FOREIGN KEY(job_id)     REFERENCES compute_jobs(id)
    )
  `);
  // Idempotent backfill for DBs created before the scheduler/metering columns shipped.
  const runCols = new Set(db.prepare('PRAGMA table_info(compute_runs)').all().map((c) => c.name));
  for (const [col, ddl] of [
    ['schedule_id', 'schedule_id TEXT'],
    ['attempt', 'attempt INTEGER NOT NULL DEFAULT 0'],
    ['max_attempts', 'max_attempts INTEGER NOT NULL DEFAULT 0'],
    ['retry_scheduled', 'retry_scheduled INTEGER NOT NULL DEFAULT 0'],
    ['not_before', 'not_before TEXT'],
    ['run_seconds', 'run_seconds REAL'],
  ]) { if (!runCols.has(col)) db.exec(`ALTER TABLE compute_runs ADD COLUMN ${ddl}`); }
  // The runner's claim query scans this index (status, queued_at) every poll.
  db.exec('CREATE INDEX IF NOT EXISTS idx_compute_runs_claim ON compute_runs(status, queued_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_compute_runs_job ON compute_runs(job_id, queued_at)');

  // Schedules (Sub-project 2): a cron expression + overlap/retry policy attached to
  // a job. The compute scheduler (cloud-compute-scheduler.js) ticks every 60s,
  // enqueues a 'schedule'-trigger run when due (subject to the overlap policy), and
  // re-enqueues failed scheduled runs up to max_retries with exponential backoff.
  // last_run_at/next_run_at are epoch ms (matching worker_crons).
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_schedules (
      id                TEXT PRIMARY KEY,
      job_id            TEXT NOT NULL,
      backend_id        TEXT NOT NULL,
      schedule          TEXT NOT NULL,
      overlap_policy    TEXT NOT NULL DEFAULT 'skip',
      max_retries       INTEGER NOT NULL DEFAULT 0,
      retry_backoff_sec INTEGER NOT NULL DEFAULT 60,
      input_json        TEXT,
      enabled           INTEGER NOT NULL DEFAULT 1,
      last_run_at       INTEGER,
      last_status       TEXT,
      next_run_at       INTEGER,
      created_at        TEXT NOT NULL,
      FOREIGN KEY(job_id)     REFERENCES compute_jobs(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_compute_schedules_due ON compute_schedules(enabled, next_run_at)');

  // Per-backend privileged-DB credential. The minted login role `clogin_<id>`
  // (a member of the tenant's trole_<id>, search_path pinned to be_<id>) gets a
  // generated password we store AES-256-GCM-encrypted (secrets-vault.js) so the
  // same LINGCODE_DB_URL can be reissued to each run without a rotation. Distinct
  // from backend_signing_secrets (JWT signing) — this is a real Postgres login.
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_db_creds (
      backend_id    TEXT PRIMARY KEY,
      role_name     TEXT NOT NULL,
      password_enc  TEXT NOT NULL,
      created_at    TEXT NOT NULL
    )
  `);

  // Metering (SP4): roll compute run-seconds into the existing per-day usage table
  // (backend_usage, created by migrateCloudBackendTables which runs before this).
  // Additive + idempotent so it backfills cleanly on an existing DB.
  try {
    const usageCols = new Set(db.prepare('PRAGMA table_info(backend_usage)').all().map((c) => c.name));
    if (!usageCols.has('compute_run_seconds')) {
      db.exec('ALTER TABLE backend_usage ADD COLUMN compute_run_seconds REAL NOT NULL DEFAULT 0');
    }
  } catch (_) { /* backend_usage may not exist yet on a partial boot — best effort */ }
}

// ── Backend child tables: drop the prototype-only parent FK ────────────────
//
// A backend can live in EITHER `prototype_backends` (created from a /try
// prototype) or `account_backends` (created from the IDE for a project) —
// `getAnyBackendById` in cloud-backend.js resolves across both. But these child
// tables were all declared `REFERENCES prototype_backends(id)`, so for an
// ACCOUNT backend the parent row does not exist and every insert dies on
// "FOREIGN KEY constraint failed" (better-sqlite3 enforces FKs by default).
//
// Real-world symptom that led here: on an account backend, password signup
// worked but OTP, magic-link and managed email ALL 500'd — those three bump
// `backend_usage.emails_sent` first, and `logEvent` writes `backend_logs`, so
// not even an error log survived.
//
// SQLite cannot express "FK to either of two tables" and cannot reference a
// view, and there is no ALTER TABLE DROP CONSTRAINT — so the fix is to rebuild
// each table without the constraint and keep relying on application-level
// resolution, which already handles both parents.
const BACKEND_CHILD_TABLES = [
  'backend_signing_secrets', 'backend_usage', 'backend_logs',
  'backend_magic_links', 'backend_email_verifications',
  'compute_jobs', 'compute_runs', 'compute_schedules', 'compute_db_creds',
];

// Strip `FOREIGN KEY(backend_id) REFERENCES prototype_backends(...)` from a
// CREATE TABLE statement, handling the clause appearing last (leading comma) or
// mid-list (trailing comma).
function stripBackendParentFK(sql) {
  const clause = String.raw`FOREIGN\s*KEY\s*\(\s*backend_id\s*\)\s*REFERENCES\s+prototype_backends\s*\([^)]*\)(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT))*`;
  const withLeadingComma = new RegExp(`,\\s*${clause}`, 'i');
  if (withLeadingComma.test(sql)) return sql.replace(withLeadingComma, '');
  return sql.replace(new RegExp(`${clause}\\s*,`, 'i'), '');
}

function migrateBackendParentFKs(db) {
  const pending = BACKEND_CHILD_TABLES.filter((t) => {
    try {
      return db.prepare(`PRAGMA foreign_key_list(${t})`).all()
        .some((fk) => fk.table === 'prototype_backends' && fk.from === 'backend_id');
    } catch (_) { return false; }   // table not created yet on a partial boot
  });
  if (pending.length === 0) return;   // idempotent: nothing left pointing at the wrong parent

  // Pragma changes can't happen inside a transaction, so bracket it. FKs must be
  // off during a rebuild or the DROP would cascade-check children of our own
  // tables mid-swap.
  const hadFK = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const table of pending) {
        const createSql = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(table)?.sql;
        if (!createSql) continue;

        const rebuilt = stripBackendParentFK(createSql);
        if (rebuilt === createSql) continue;   // nothing matched — leave it alone

        // Indexes live in sqlite_master and die with the table; capture their
        // DDL so we can recreate them verbatim after the swap.
        const indexes = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
        ).all(table).map((r) => r.sql);

        const tmp = `${table}__fkfix`;
        db.exec(rebuilt.replace(
          new RegExp(`CREATE TABLE(\\s+IF\\s+NOT\\s+EXISTS)?\\s+["'\`]?${table}["'\`]?`, 'i'),
          `CREATE TABLE ${tmp}`
        ));
        // Name the columns explicitly so the copy can't silently mis-map if the
        // rebuilt column order ever drifts from the original.
        const cols = db.prepare(`PRAGMA table_info(${tmp})`).all().map((c) => `"${c.name}"`).join(', ');
        db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
        for (const idx of indexes) db.exec(idx);
      }
    })();
  } finally {
    db.pragma(`foreign_keys = ${hadFK ? 'ON' : 'OFF'}`);
  }
}

// migrateHostedAppsTables — control-plane metadata for the LingCode Cloud
// HOSTED-APPS tier. Long-lived Python HTTP apps deployed from source, built
// into per-app Docker images by the buildpack, supervised by the compute
// runner (extends cloud-compute-runner.js; new job kind='web'), routed via
// Caddy at <slug>.apps.lingcode.dev. Full design in
// docs/superpowers/specs/2026-08-13-python-app-hosting-design.md.
//
// Convention (copied from compute_jobs): NO FK on backend_id. A backend can
// live in either prototype_backends or account_backends, and adding an FK to
// one silently breaks inserts for the other. Application code enforces
// referential integrity via getAnyBackendById / owner-lookup in the routes.
// These tables are ALSO not in BACKEND_CHILD_TABLES above — there is no
// legacy prototype_backends FK to strip.
function migrateHostedAppsTables(db) {
  // The app definition. One row per deployed Python app. `subdomain` is
  // UNIQUE across the droplet — the Caddy admin API route key hangs off it.
  // `port` is a per-droplet allocation in 10000–19999. A partial UNIQUE
  // index below enforces uniqueness only among rows that hold a port, so
  // paused/deleted apps that released their port coexist as NULLs.
  // `healthcheck_path` defaults to '/' but is per-app-configurable so apps
  // whose '/' returns 404 or serves static assets don't get restart-looped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_apps (
      id                    TEXT PRIMARY KEY,
      backend_id            TEXT NOT NULL,
      user_id               TEXT NOT NULL,
      name                  TEXT NOT NULL,
      subdomain             TEXT NOT NULL UNIQUE,
      kind                  TEXT NOT NULL DEFAULT 'python-web'
                              CHECK(kind IN ('python-web')),
      status                TEXT NOT NULL DEFAULT 'building'
                              CHECK(status IN ('building','running','paused','crashed','deleted')),
      current_deploy_id     TEXT,
      procfile_web          TEXT,
      runtime_version       TEXT NOT NULL DEFAULT '3.12',
      healthcheck_path      TEXT NOT NULL DEFAULT '/',
      port                  INTEGER,
      container_id          TEXT,
      memory_mb             INTEGER NOT NULL DEFAULT 256,
      cpu_shares            INTEGER NOT NULL DEFAULT 512,
      restart_count         INTEGER NOT NULL DEFAULT 0,
      restart_window_start  INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      paused_at             INTEGER,
      UNIQUE(backend_id, name),
      FOREIGN KEY(user_id)  REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_hosted_apps_backend ON hosted_apps(backend_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_apps_port ON hosted_apps(port) WHERE port IS NOT NULL');

  // Deploy history. One row per build attempt (success or fail). Also the
  // build queue: rows with status='queued' are picked up by the runner on
  // the same tick as compute_runs (extended dispatch loop; the state
  // machine lives in cloud-hosted-app-runner.js, not the compute runner).
  // `requirements_sha` is the docker-build cache key — when it matches an
  // earlier successful deploy, --cache-from turns a 90 s pip install into
  // a <5 s layer reuse. `build_log` is truncated to 64 KB by the runner
  // (a full pip -v log easily hits 500 KB otherwise).
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_app_deploys (
      id                 TEXT PRIMARY KEY,
      app_id             TEXT NOT NULL,
      source_sha256      TEXT NOT NULL,
      requirements_sha   TEXT,
      image_tag          TEXT,
      status             TEXT NOT NULL DEFAULT 'queued'
                           CHECK(status IN ('queued','building','running','failed','superseded')),
      build_log          TEXT,
      error              TEXT,
      started_at         INTEGER NOT NULL,
      finished_at        INTEGER,
      user_id            TEXT NOT NULL,
      FOREIGN KEY(user_id)  REFERENCES users(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_hosted_app_deploys_app ON hosted_app_deploys(app_id, started_at DESC)');
  // Runner claim query index (mirrors compute_runs pattern).
  db.exec('CREATE INDEX IF NOT EXISTS idx_hosted_app_deploys_claim ON hosted_app_deploys(status, started_at)');

  // Ring-buffered lifecycle events (start/stop/crash/restart/pause/resume/
  // deploy/deploy_fail/quota_pause/quota_warn). A separate cron sweep caps
  // this at 1000 rows per app_id. Container stdout/stderr are NOT mirrored
  // here — volume would blow up disk. Runtime logs are served on demand
  // via `docker logs` (see hosted-app routes).
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_app_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id  TEXT NOT NULL,
      ts      INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      message TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_hosted_app_events ON hosted_app_events(app_id, id DESC)');

  // Uptime + egress metering, hourly buckets. Written by the runner sweeper
  // every 5 min (uptime += 300 s for each status='running' app;
  // egress_bytes += docker stats delta). Rolled into
  // backend_usage.app_uptime_seconds / .app_egress_bytes once buckets age
  // past 24 h so historical aggregates live on the same per-backend row as
  // the other meters (emails_sent, compute_run_seconds, etc.).
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_app_uptime (
      app_id         TEXT NOT NULL,
      window_start   INTEGER NOT NULL,
      uptime_seconds INTEGER NOT NULL DEFAULT 0,
      egress_bytes   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, window_start)
    )
  `);

  // Additive columns on backend_usage — mirror how compute_run_seconds was
  // added by migrateComputeTables (idempotent, best-effort against missing
  // parent table during partial boot).
  try {
    const usageCols = new Set(db.prepare('PRAGMA table_info(backend_usage)').all().map((c) => c.name));
    if (!usageCols.has('app_uptime_seconds')) {
      db.exec('ALTER TABLE backend_usage ADD COLUMN app_uptime_seconds INTEGER NOT NULL DEFAULT 0');
    }
    if (!usageCols.has('app_egress_bytes')) {
      db.exec('ALTER TABLE backend_usage ADD COLUMN app_egress_bytes INTEGER NOT NULL DEFAULT 0');
    }
  } catch (_) { /* backend_usage may not exist yet on a partial boot — best effort */ }

  // Additive runner-internal columns on hosted_apps. Kept underscore-prefixed
  // so nobody mistakes them for user-facing fields: they hold cumulative
  // counters the runner reads to compute *deltas* on each poll tick
  // (Docker's per-container RestartCount + accumulated NetIO). Missing on
  // this table before the runner shipped; runner reads via a safe getter
  // that returns 0 when the column doesn't exist, so this is purely a
  // schema-completeness ALTER — no code change needed alongside it.
  try {
    const appsCols = new Set(db.prepare('PRAGMA table_info(hosted_apps)').all().map((c) => c.name));
    if (!appsCols.has('_last_docker_restart_cumulative')) {
      db.exec('ALTER TABLE hosted_apps ADD COLUMN _last_docker_restart_cumulative INTEGER NOT NULL DEFAULT 0');
    }
    if (!appsCols.has('_last_egress_cumulative')) {
      db.exec('ALTER TABLE hosted_apps ADD COLUMN _last_egress_cumulative INTEGER NOT NULL DEFAULT 0');
    }
    // cloud-hosted-app-runner.js:474-478 writes `last_deployed_at` on the
    // hosted_apps row when a deploy transitions to running. The original
    // CREATE TABLE never declared this column, so the UPDATE silently
    // no-op'd via _safeRun's error swallow — `hosted_apps.status` stayed
    // 'building' forever even though the container was live + healthy on
    // its port. Symptom: cloud-hosted-app-proxy.js's Host-dispatch would
    // return the "Building" 503 placeholder indefinitely while the real
    // FastAPI process happily served /127.0.0.1:<port>/. Discovered
    // 2026-08-13 as the final unblocker of the smoke test.
    if (!appsCols.has('last_deployed_at')) {
      db.exec('ALTER TABLE hosted_apps ADD COLUMN last_deployed_at TEXT');
    }
  } catch (_) { /* hosted_apps just created above — this should not fail */ }

  // Additive runner-lifecycle columns on hosted_app_deploys. cloud-hosted-app-
  // runner.js writes to four columns the original CREATE TABLE never declared:
  //
  //   worker_id         TEXT — set by _claimQueued when a runner picks up a
  //                            queued deploy (WORKER_ID = "<hostname>:<pid>").
  //                            Lets the ops team + tests answer "which worker
  //                            is building this?" from the DB alone.
  //   build_started_at  TEXT — ISO timestamp of the same claim event.
  //   build_finished_at TEXT — ISO timestamp of terminal state (running / failed).
  //                            Distinct from the existing `finished_at` INTEGER
  //                            column that the HTTP route in cloud-hosted-apps.js
  //                            writes; the two lifecycles evolved separately
  //                            and normalizing them is a follow-on.
  //   error_code        TEXT — machine-readable failure category from
  //                            _failDeploy() (e.g. 'build_failed',
  //                            'healthcheck_failed', 'caddy_upsert_failed').
  //                            The existing `error` column keeps the
  //                            human-readable message.
  //
  // Discovered 2026-08-13 during the hosted-apps smoke test — the runner had
  // been silently no-op'ing since the tier first deployed because _safeRun
  // swallows the "no such column" SQL error, and _failDeploy hit the same
  // trap so failures never even surfaced as `status='failed'`. Adding these
  // columns is what actually unblocks Python app hosting on prod.
  try {
    const deployCols = new Set(db.prepare('PRAGMA table_info(hosted_app_deploys)').all().map((c) => c.name));
    if (!deployCols.has('worker_id')) {
      db.exec('ALTER TABLE hosted_app_deploys ADD COLUMN worker_id TEXT');
    }
    if (!deployCols.has('build_started_at')) {
      db.exec('ALTER TABLE hosted_app_deploys ADD COLUMN build_started_at TEXT');
    }
    if (!deployCols.has('build_finished_at')) {
      db.exec('ALTER TABLE hosted_app_deploys ADD COLUMN build_finished_at TEXT');
    }
    if (!deployCols.has('error_code')) {
      db.exec('ALTER TABLE hosted_app_deploys ADD COLUMN error_code TEXT');
    }
  } catch (_) { /* hosted_app_deploys just created above — this should not fail */ }

  // Additive runner-lifecycle columns on hosted_app_events. cloud-hosted-app-
  // runner.js's _emitEvent (~:270) writes to `created_at` (ISO text) and
  // `extra_json` (JSON payload) — richer than the original schema's
  // (app_id, ts INTEGER, kind, message) shape. Every deploy/pause/resume/
  // crash silently dropped its event row because _safeRun swallowed the
  // "no such column: created_at" SQL error (fixed at the log level by
  // PR #40, which is how we found this bug ~5s after landing PR #40).
  //
  // Note: the legacy `ts INTEGER NOT NULL` column stays. The runner's
  // INSERT is being updated in the same PR to include ts=Date.now() so
  // the NOT NULL is satisfied without a table rebuild. A future migration
  // could drop `ts` entirely if we decide `created_at` supersedes it.
  try {
    const eventsCols = new Set(db.prepare('PRAGMA table_info(hosted_app_events)').all().map((c) => c.name));
    if (!eventsCols.has('created_at')) {
      db.exec('ALTER TABLE hosted_app_events ADD COLUMN created_at TEXT');
    }
    if (!eventsCols.has('extra_json')) {
      db.exec('ALTER TABLE hosted_app_events ADD COLUMN extra_json TEXT');
    }
  } catch (_) { /* hosted_app_events just created above — this should not fail */ }
}

// Audit-log retention, in ms. 400 days ≈ 13 months: long enough to cover a
// 12-month SOC 2 Type II observation window plus the lag before an auditor
// actually pulls the evidence. Mirrored in cloud-audit.js — change both.
const AUDIT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * Append-only audit log for control-plane actions (who did what, when, from where).
 *
 * Shape follows voucher_audit_events (the best-formed audit table already here),
 * with the actor promoted to real columns instead of being interpolated into a
 * message string the way backend_logs does it (cloud-backend.js:67-76).
 *
 * Two properties an auditor will actually look for:
 *
 *  - Append-only. SQLite has no REVOKE, so immutability is enforced with triggers.
 *    UPDATE is blocked outright. DELETE is blocked only for rows still inside the
 *    retention window — that is precisely the shape tampering takes, while still
 *    letting the retention sweeper prune genuinely aged-out rows. A blanket DELETE
 *    ban would make retention impossible and get worked around instead.
 *  - Gap-detectable ids. INTEGER PRIMARY KEY AUTOINCREMENT never reuses a rowid,
 *    so a missing id is evidence of a removed row even if someone reaches the file.
 *
 * @param {import('better-sqlite3').Database} db
 */
function migrateAuditLogTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'success',
      actor_user_id TEXT,
      actor_token_id TEXT,
      resource_type TEXT,
      resource_id TEXT,
      project_id TEXT,
      ip TEXT,
      user_agent TEXT,
      request_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_request ON audit_log(request_id);
  `);

  // Immutability triggers. Created separately from the CREATE TABLE block so an
  // existing deployment picks them up on the next boot without a table rebuild.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete_within_retention
    BEFORE DELETE ON audit_log
    WHEN OLD.created_at > ((CAST(strftime('%s','now') AS INTEGER) * 1000) - ${AUDIT_RETENTION_MS})
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only: rows inside the retention window cannot be deleted');
    END;
  `);
}

module.exports = { migrateUsersTable, migrateAccountTokensTable, migrateVoucherTables, migrateStatsTables, migrateTelemetryTables, migrateCLITables, migrateSavedPrototypesTable, migrateSupabaseTables, migrateSecretsVaultTable, migratePrototypeDomainsTable, migrateCollabTables, migrateAppConfigTable, migrateAgentSdkTables, migrateFeedbackTable, migrateCloudBackendTables, migrateCloudAppsTables, migrateProjectsTables, migrateCloudTelemetryTables, migrateSlackTables, migrateRemoteHostsTable, migrateComputeTables, migrateBackendParentFKs, stripBackendParentFK, migrateHostedAppsTables, bumpCollabSchemaToMultiFile, migrateAuditLogTable, AUDIT_RETENTION_MS };
