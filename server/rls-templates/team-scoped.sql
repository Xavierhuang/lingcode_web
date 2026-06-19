-- team-scoped: rows of {{TABLE}} belong to a team identified by the
-- {{TEAM_COL}} column. A user is a member of that team if there is a row
-- in {{MEMBERS_TABLE}} where {{MEMBERS_TEAM_COL}} matches the team and
-- {{MEMBERS_USER_COL}} matches auth.uid(). All members see and edit;
-- non-members see nothing.
--
-- Assumes {{MEMBERS_TABLE}} already has its own RLS protecting reads of
-- the membership rows themselves. Without that, a user could leak team
-- membership lists. Apply this template to the members table too, or use
-- a stricter pattern there.

ALTER TABLE public.{{TABLE}} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "{{TABLE}}_team_select" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_team_select"
  ON public.{{TABLE}}
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.{{MEMBERS_TABLE}} m
      WHERE m.{{MEMBERS_TEAM_COL}} = {{TABLE}}.{{TEAM_COL}}
        AND m.{{MEMBERS_USER_COL}} = auth.uid()
    )
  );

DROP POLICY IF EXISTS "{{TABLE}}_team_insert" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_team_insert"
  ON public.{{TABLE}}
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.{{MEMBERS_TABLE}} m
      WHERE m.{{MEMBERS_TEAM_COL}} = {{TEAM_COL}}
        AND m.{{MEMBERS_USER_COL}} = auth.uid()
    )
  );

DROP POLICY IF EXISTS "{{TABLE}}_team_update" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_team_update"
  ON public.{{TABLE}}
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.{{MEMBERS_TABLE}} m
      WHERE m.{{MEMBERS_TEAM_COL}} = {{TABLE}}.{{TEAM_COL}}
        AND m.{{MEMBERS_USER_COL}} = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.{{MEMBERS_TABLE}} m
      WHERE m.{{MEMBERS_TEAM_COL}} = {{TEAM_COL}}
        AND m.{{MEMBERS_USER_COL}} = auth.uid()
    )
  );

DROP POLICY IF EXISTS "{{TABLE}}_team_delete" ON public.{{TABLE}};
CREATE POLICY "{{TABLE}}_team_delete"
  ON public.{{TABLE}}
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.{{MEMBERS_TABLE}} m
      WHERE m.{{MEMBERS_TEAM_COL}} = {{TABLE}}.{{TEAM_COL}}
        AND m.{{MEMBERS_USER_COL}} = auth.uid()
    )
  );
