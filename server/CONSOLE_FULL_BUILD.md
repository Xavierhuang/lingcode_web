# LingCode Cloud console — "full blood" build spec (handoff)

Goal: take `website/backends.html` (the per-user backend console) from its current
**v2** (sidebar + Database/Auth/SQL/Settings) to **Supabase/Firebase parity**.

This doc has everything pre-discovered so a fresh session can execute without re-investigating.

## Current state (already shipped & live)
- `website/backends.html` = sidebar console. Views: **Database** (sortable cols, prev/next paging, client-side filter, insert/edit/delete row via modal), **Authentication** (list/remove tenant users), **SQL** (read-only query → results grid + migration runner), **Settings** (rename, connection info+copy, delete backend). Light theme, vars under `:root` (`--c-*`).
- Backends are named: `account_backends.label` (folder name, set by IDE Connect's eager-provision + console Rename). `beName(b)` in the JS.
- All account-console API routes live in `website/server/cloud-backend.js` under `registerCloudBackendRoutes`, gated by the `accountBackend(req,res)` preflight (owner-by-user_id). Deploy server = `website/server/deploy-api.sh`; deploy site = `website/deploy.sh` (SKIP_PAGEFIND=1).

## Key facts (already discovered)
- **Storage** = SQLite table `backend_objects(id, backend_id, bucket, path, content_type, bytes, data_b64, created_at)` — files stored **inline as base64 in `data_b64`**. No filesystem. Delete = delete the row. Upload route (anon-key Bearer): `POST /api/cloud/be/:backendId/storage/upload {bucket?, path, content_type, data_b64}`. Public read: `GET /api/cloud/be/:backendId/storage/object?bucket=&path=`. The console has the backend's `anon_key` + `gateway_url` (from the list endpoint / publicBackend) so it can upload directly via the anon-key route.
- **Logs** = SQLite table `backend_logs(id, backend_id, ts, source, level, message)`. `logEvent(db, backendId, source, level, message)` writes them (capped 500/backend).
- **Usage** = `backend_usage(backend_id, day, db_rows_read, db_rows_written, emails_sent)`. Overview route already returns `{table_count, usage:{reads,writes}}`.
- **Row count helper** already added (un-wired): `dataPlane.countRows(backendId, table)` in `cloud-data-plane.js` (RLS-bypassed admin count). NOTE: export it from the module.exports list and wire it.
- **Schema editing** needs NO new endpoint — generate `ALTER TABLE` / `CREATE TABLE` SQL in the UI and POST to the existing `POST /api/cloud/account/backends/:backendId/sql/migrate {sql}`.
- Tenant data ops bypass RLS for the owner via `proxy*(..., {admin:true})`. Tables/columns: `dataPlane.listTables(id)`, `dataPlane.primaryKeyColumns(id, table)`. Column types are NOT currently returned — add a `columnsOf(backendId, table)` data-plane fn (query `information_schema.columns` in the schema `be_<id>`) for the schema editor.

## Remaining work (the "full blood" checklist)

### Server (cloud-backend.js, all under accountBackend preflight)
1. `GET /api/cloud/account/backends/:backendId/storage/objects` → `SELECT bucket,path,content_type,bytes,created_at FROM backend_objects WHERE backend_id=? ORDER BY created_at DESC LIMIT 500`. Add a `url` per object = `${proto}://${host}/api/cloud/be/${id}/storage/object?bucket=&path=`.
2. `DELETE /api/cloud/account/backends/:backendId/storage/objects` (body `{bucket, path}`) → `DELETE FROM backend_objects WHERE backend_id=? AND bucket=? AND path=?`.
3. `GET /api/cloud/account/backends/:backendId/logs` → `SELECT ts,source,level,message FROM backend_logs WHERE backend_id=? ORDER BY id DESC LIMIT 200`.
4. Wire **row count**: in the rows GET route include `total: await dataPlane.countRows(ctx.row.id, table)`; export `countRows`.
5. Add `dataPlane.columnsOf(backendId, table)` → `[{column, type, nullable, default}]` from `information_schema.columns` (search_path/schema = `be_<id>`), + a route `GET .../tables/:table/columns`. Used by the schema editor.
6. (optional) account-scoped owner upload alias if you don't want the console using the anon key.

### Frontend (backends.html) — new sidebar views + features
- **Overview** (new default view, icon ⌂): cards/stat tiles — status, # tables, total rows (sum of countRows or show per table), users count, storage objects + total bytes, reads/writes (from overview usage). Recent activity (last few logs).
- **Storage** (icon ▣): list objects (name/path, type, size, date) + image thumbnails for image/* via the public url; **Upload** (file input → base64 → POST to `…/be/:id/storage/upload` with `Authorization: Bearer <anon_key>`); **Delete** (DELETE account route); copy public url.
- **Logs** (icon ☰): table of recent `backend_logs` (ts/source/level/message), level color-coding, refresh, auto-poll optional.
- **Database deepening**:
  - Show **exact total rows** (use `total` from the rows route) + real paging "1–50 of N".
  - **Schema editor**: "+ New table" (form → CREATE TABLE migration), per-table "Edit columns" (add column → ALTER TABLE ADD COLUMN; drop column → ALTER TABLE DROP COLUMN), using `columnsOf` + the migrate route. Show column types in the grid header (from `columnsOf`).
  - **Insert/Edit modal**: use column types (date pickers, bool toggles, null checkbox) instead of plain text inputs.
  - CSV export of the current table (client-side from loaded rows, or a server stream).
- **Settings additions**: auth-providers status (which of google/github/apple/otp are available — there's `GET /api/cloud/be/:id/auth/providers`), MCP connect snippet (Claude Desktop / Cursor JSON), custom-domains entry (links to account.html prototype domains — note: account backends aren't prototypes, custom domains attach to prototypes today; decide if account backends should get domains too).
- **Polish**: loading skeletons, empty states per view, toast on success/error instead of alert(), keyboard focus, mobile sidebar toggle.

### Authentication — Sign-in methods chooser (Firebase "Sign-in method" tab)
Today every provider is always-on; the Auth view just lists users. Make providers
**toggleable + configurable per backend**. Three layers:
1. **Storage**: add `backend_auth_methods(backend_id, method, enabled, updated_at)` (methods:
   `password, magic_link, otp, google, github, apple`), OR reuse/extend `backend_oauth_providers`
   (it already holds BYO google/github/apple). Default = all enabled (so existing apps don't break).
2. **Enforcement (server)**: a helper `methodEnabled(db, backendId, method)`; gate each auth route —
   `/auth/signup|signin` (password), `/auth/magiclink/*`, `/auth/otp/*`, `/auth/oauth/:provider/start`,
   `/auth/apple/native` — return 403 `method_disabled` when off. `GET /auth/providers` must only list
   enabled+available providers. New owner routes: `GET /api/cloud/account/backends/:id/auth/methods`
   (status of all), `PUT …/auth/methods/:method {enabled}` (toggle).
3. **UI (Auth view)**: a "Sign-in methods" card above Users — one row per method with a toggle; for
   google/github/apple a "Configure" expander (managed vs BYO — POST to the existing BYO config /
   `set_auth_provider` logic; show the redirect_uri to register). Mirror Firebase's layout.

### Entry / project chooser (Firebase-style)
Optional: instead of auto-selecting the first backend, make `/backends.html` a **project-list landing**
(grid of backend cards: name, status, table/row count, created) → clicking a card enters that backend's
console (current sidebar). Keep the sidebar switcher for fast switching once inside. This matches
Firebase's "choose a project" entry.

### Stretch (true parity)
- Realtime tail on a table (subscribe to `…/be/:id/realtime?table=` and live-append to the grid).
- pgvector awareness (show vector columns; a "similarity search" mini-tool).
- Per-backend API docs / code snippets (like Supabase's auto-generated docs).
- Usage charts over time (needs daily series from `backend_usage`).
- Email templates / auth settings editing.

## Pointers
- Console JS pattern: single IIFE, `S` state object, `api()/apiW()` helpers, `base()` = `/api/cloud/account/backends/<active>`, render functions per view. Keep adding views to the `navItems` array + `renderView()` switch.
- Test endpoints server-side with a user's `api_access_token` as Bearer (see memory `reference_lingcode_auth_token_integrity`).
- Memory: `reference_lingcode_cloud_supabase_parity`, `reference_lingcode_custom_domains`.
