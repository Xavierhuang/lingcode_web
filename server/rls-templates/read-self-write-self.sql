-- read-self-write-self: {{TABLE}} is a per-user record (profiles,
-- settings, preferences) where the row's {{ID_COL}} column equals
-- auth.uid(). The user can read and update their own row; INSERT is
-- usually wired to a trigger on auth.users so we don't expose it here.
--
-- DELETE is intentionally service-role-only: deleting a profile usually
-- means deleting the user, which should go through Supabase's user
-- management (auth.admin.deleteUser) on the server, not from the client.

ALTER TABLE public.{{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "{{TABLE}}_self_select" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_self_select"
  ON public.{{TABLE}}
  FOR SELECT
  TO authenticated
  USING (auth.uid() = {{ID_COL}});

DROP POLICY IF EXISTS "{{TABLE}}_self_update" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_self_update"
  ON public.{{TABLE}}
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = {{ID_COL}})
  WITH CHECK (auth.uid() = {{ID_COL}});
