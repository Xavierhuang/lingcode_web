-- user-owns-row: each row of {{TABLE}} is owned by the user whose
-- auth.uid() matches the {{USER_COL}} column. Owner can do everything;
-- nobody else sees the row at all.

ALTER TABLE public.{{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "{{TABLE}}_owner_select" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_owner_select"
  ON public.{{TABLE}}
  FOR SELECT
  TO authenticated
  USING (auth.uid() = {{USER_COL}});

DROP POLICY IF EXISTS "{{TABLE}}_owner_insert" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_owner_insert"
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
