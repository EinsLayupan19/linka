-- Custom SQL migration: helpers used by Row Level Security policies.
--
-- Policies on conversation tables need to ask "is the current user a member of this
-- conversation?". Asking that with a subquery on conversation_members from inside
-- conversation_members' own policy would recurse, so the check lives in a
-- SECURITY DEFINER function (runs with the owner's rights, bypassing RLS for this one
-- lookup) with an empty search_path, as Supabase recommends.
--
-- The function lives in a "private" schema that is not exposed through Supabase's API,
-- so it cannot be called as an RPC. plpgsql is used because its body is only checked
-- when it first runs: conversation_members is created by the next migration.

CREATE SCHEMA IF NOT EXISTS private;
--> statement-breakpoint
REVOKE ALL ON SCHEMA private FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA private TO authenticated;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.is_conversation_member(target_conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.conversation_members AS m
    WHERE m.conversation_id = target_conversation_id
      AND m.user_id = (SELECT auth.uid())
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.is_conversation_member(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.is_conversation_member(uuid) TO authenticated;
