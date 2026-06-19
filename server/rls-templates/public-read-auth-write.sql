-- public-read-auth-write: anyone (including anon) can SELECT rows of
-- {{TABLE}}; only authenticated users can INSERT (and they must own what
-- they create); only the owner can UPDATE or DELETE. Use for content
-- like blog posts, comments, public listings.

ALTER TABLE public.{{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "{{TABLE}}_public_select" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_public_select"
  ON public.{{TABLE}}
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "{{TABLE}}_auth_insert" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_auth_insert"
  ON public.{{TABLE}}
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = {{USER_COL}});

DROP POLICY IF EXISTS "{{TABLE}}_owner_update" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_owner_update"
  ON public.{{TABLE}}
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = {{USER_COL}})
  WITH CHECK (auth.uid() = {{USER_COL}});

DROP POLICY IF EXISTS "{{TABLE}}_owner_delete" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_owner_delete"
  ON public.{{TABLE}}
  FOR DELETE
  TO authenticated
  USING (auth.uid() = {{USER_COL}});
