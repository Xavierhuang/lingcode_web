-- LingCode Cloud — Phase 1 data-plane bootstrap.
-- Runs once on first `docker compose up` (Postgres initdb hook).
--
-- Role model (the core of multi-tenant isolation):
--   cloud_admin    : the control plane connects as this (superuser-ish via
--                    initdb POSTGRES_USER). Creates tenant schemas + roles,
--                    runs migrations, grants. Never exposed to the browser.
--   authenticator  : the role PostgREST logs in as (Phase 2). NOINHERIT +
--                    LOGIN. It is GRANTed each per-tenant role so it can
--                    SET ROLE into the tenant at request time. The control
--                    plane also GRANTs tenant roles to itself so it can
--                    SET LOCAL ROLE for the data proxy.
--   cloud_anon     : PostgREST's default anon role (Phase 2). No table
--                    grants — a request with no/short JWT gets nothing.
--
-- Per tenant (created at provision time by cloud-data-plane.js, NOT here):
--   schema  be_<backend_id>
--   role    trole_<backend_id>  (NOLOGIN) with USAGE on its schema only.
-- The per-tenant anon JWT carries { "role": "trole_<backend_id>" }, so a
-- request can only ever touch that tenant's schema.

CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'devpass';
CREATE ROLE cloud_anon NOLOGIN;
GRANT cloud_anon TO authenticator;

-- cloud_admin already owns the DB (initdb POSTGRES_USER). Make sure it can
-- hand tenant roles to PostgREST's authenticator.
GRANT authenticator TO cloud_admin;

-- pgvector for semantic search. Installed in a dedicated `extensions` schema
-- (USAGE granted to everyone) so tenants get the `vector` type + operators on
-- their search_path WITHOUT seeing anything else in public. Requires the
-- pgvector/pgvector image (see docker-compose.yml).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;

-- Observability: query stats. Needs shared_preload_libraries (set in
-- postgres-conf.d/20-observability.conf, loaded by the prod overlay). When that
-- preload isn't active (the bare dev compose), CREATE EXTENSION errors — so
-- swallow it here and let observability/obs-setup-db.sh create it post-restart.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements not preloaded yet — skipping (run obs-setup-db.sh after restart)';
END $$;
