-- service-role-only: lock {{TABLE}} down. RLS is enabled and no policies
-- are added, so anon and authenticated roles see nothing. Only the
-- service_role key (which bypasses RLS by design) can read or write.
--
-- Use for: webhook payloads, audit logs, billing records, admin-only
-- tables, anything that must never be touched from the browser.
--
-- WARNING: this is the safest pattern but also the most restrictive —
-- if you call this table with the anon/authenticated key, every query
-- will return zero rows (and look like an empty table to your app code).
-- Either query it from server-side code with the service_role key or
-- expose specific reads via a SECURITY DEFINER function.

ALTER TABLE public.{{TABLE}} ENABLE ROW LEVEL SECURITY;

-- Belt-and-braces: drop any pre-existing permissive policies the table
-- may have inherited so this template's "lock-down" intent is unambiguous.
DROP POLICY IF EXISTS "{{TABLE}}_public_select" ON public.{{TABLE}};
DROP POLICY IF EXISTS "{{TABLE}}_public_insert" ON public.{{TABLE}};
DROP POLICY IF EXISTS "{{TABLE}}_public_update" ON public.{{TABLE}};
DROP POLICY IF EXISTS "{{TABLE}}_public_delete" ON public.{{TABLE}};
