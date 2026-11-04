-- Custom SQL migration: every group keeps exactly one owner.
--
-- "At most one" has been enforced since Phase 3 (unique index conversation_members_one_owner_idx).
-- "At least one" was only checked by the API, before it wrote, so two requests racing (a transfer
-- to someone being removed at the same moment, or a member leaving while being made owner) could
-- commit a group without an owner. The API now does these changes in one locked transaction; this
-- deferred check is the database's own guarantee on top: a transaction that would leave a group
-- without an owner fails at commit and changes nothing.
--
-- Not covered on purpose: deleting a whole group (its members go with it), and deleting an owner's
-- account (their profile is gone; refusing would make the account impossible to delete). Such a
-- group stays without an owner, as before.

CREATE OR REPLACE FUNCTION private.check_group_has_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.conversations AS c WHERE c.id = OLD.conversation_id AND c.type = 'group')
     AND EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = OLD.user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.conversation_members AS m WHERE m.conversation_id = OLD.conversation_id AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'linka: group % must have an owner', OLD.conversation_id
      USING ERRCODE = '23514', CONSTRAINT = 'conversation_members_group_owner';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.check_group_has_owner() FROM PUBLIC;
--> statement-breakpoint
-- Runs at commit, once per changed owner row, so a transfer (old owner steps down, new owner steps
-- up) is checked only after both of its updates.
CREATE CONSTRAINT TRIGGER conversation_members_group_owner
AFTER UPDATE OF role OR DELETE ON public.conversation_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.role = 'owner')
EXECUTE FUNCTION private.check_group_has_owner();
