-- soft-delete-aware: like user-owns-row, but {{TABLE}} has a
-- {{DELETED_COL}} timestamptz column for soft-delete. Owner can SELECT
-- only undeleted rows; UPDATE permission is required for soft-delete
-- (set {{DELETED_COL}} = now()) — the FOR DELETE policy is intentionally
-- narrow because real DELETEs should be done by the service role only.
--
-- Apps should set {{DELETED_COL}} = now() instead of issuing DELETE.
-- A nightly job using the service role can hard-delete rows past a
-- retention window.

ALTER TABLE public.{{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "{{TABLE}}_owner_select_alive" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_owner_select_alive"
  ON public.{{TABLE}}
  FOR SELECT
  TO authenticated
  USING (auth.uid() = {{USER_COL}} AND {{DELETED_COL}} IS NULL);

DROP POLICY IF EXISTS "{{TABLE}}_owner_insert" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_owner_insert"
  ON public.{{TABLE}}
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = {{USER_COL}} AND {{DELETED_COL}} IS NULL);

DROP POLICY IF EXISTS "{{TABLE}}_owner_update" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_owner_update"
  ON public.{{TABLE}}
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = {{USER_COL}})
  WITH CHECK (auth.uid() = {{USER_COL}});
-- No DELETE policy — apps should set {{DELETED_COL}} = now() instead.
-- Hard deletes are reserved for the service role (which bypasses RLS).
