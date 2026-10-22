-- Custom SQL migration: Phase 5 realtime (live chat list, read/delivery receipts, membership
-- changes) and channel authorization for the user channel and the live (typing/presence) channel.
--
-- Topics (all private; see @linka/shared realtime/events.ts):
--   conversation:<id>  members receive; only the database publishes
--   user:<userId>      only that user receives; only the database publishes
--   live:<id>          members receive and publish (typing broadcasts, presence)
--
-- Every function that publishes catches its own errors: realtime is best-effort and must never
-- block the write that triggered it. Clients refetch authoritative data after reconnecting.

-- ISO 8601 in UTC with milliseconds, exactly like JavaScript's toISOString().
CREATE OR REPLACE FUNCTION private.iso(ts timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
--> statement-breakpoint
-- A message in the shape of the shared `Message` contract.
CREATE OR REPLACE FUNCTION private.message_json(m public.messages)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', m.id,
    'conversationId', m.conversation_id,
    'senderId', m.sender_id,
    'clientId', m.client_id,
    'type', m.type,
    'content', m.content,
    'createdAt', private.iso(m.created_at),
    'editedAt', private.iso(m.edited_at),
    'deletedAt', private.iso(m.deleted_at)
  )
$$;
--> statement-breakpoint
-- Phase 4's message.created now uses the shared JSON builder (same payload as before).
CREATE OR REPLACE FUNCTION private.broadcast_message_created()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(private.message_json(NEW), 'message.created', 'conversation:' || NEW.conversation_id::text, true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting message % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Live chat list: tell every member (on their own user channel) about the new message.
-- Fan-out is bounded by the group size (at most 100). The sender is included so their other
-- tabs update too.
CREATE OR REPLACE FUNCTION private.broadcast_conversation_activity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  payload jsonb;
  member_id uuid;
BEGIN
  BEGIN
    payload := jsonb_build_object('conversationId', NEW.conversation_id, 'lastMessage', private.message_json(NEW));
    FOR member_id IN
      SELECT m.user_id FROM public.conversation_members AS m WHERE m.conversation_id = NEW.conversation_id
    LOOP
      PERFORM realtime.send(payload, 'conversation.activity', 'user:' || member_id::text, true);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting activity for message % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_broadcast_activity
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION private.broadcast_conversation_activity();
--> statement-breakpoint
-- Read receipts: a member's markers moved. Fellow members see it on the conversation channel;
-- the member's other tabs learn about their own read marker on their user channel.
CREATE OR REPLACE FUNCTION private.broadcast_marker_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object(
        'conversationId', NEW.conversation_id,
        'userId', NEW.user_id,
        'lastDeliveredAt', private.iso(NEW.last_delivered_at),
        'lastReadAt', private.iso(NEW.last_read_at)
      ),
      'receipt.updated',
      'conversation:' || NEW.conversation_id::text,
      true
    );
    IF NEW.last_read_at IS NOT NULL AND NEW.last_read_at IS DISTINCT FROM OLD.last_read_at THEN
      PERFORM realtime.send(
        jsonb_build_object('conversationId', NEW.conversation_id, 'lastReadAt', private.iso(NEW.last_read_at)),
        'conversation.read',
        'user:' || NEW.user_id::text,
        true
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting markers of % in % failed: %', NEW.user_id, NEW.conversation_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_members_broadcast_markers
AFTER UPDATE OF last_read_at, last_delivered_at ON public.conversation_members
FOR EACH ROW
WHEN (OLD.last_read_at IS DISTINCT FROM NEW.last_read_at OR OLD.last_delivered_at IS DISTINCT FROM NEW.last_delivered_at)
EXECUTE FUNCTION private.broadcast_marker_change();
--> statement-breakpoint
-- Membership changes, per statement (creating a 100-member group is one statement, so it sends
-- one conversation.updated, not 100): the affected users' lists, and anyone viewing it.
CREATE OR REPLACE FUNCTION private.broadcast_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  change text := CASE WHEN TG_OP = 'INSERT' THEN 'added' ELSE 'removed' END;
  r record;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      FOR r IN SELECT DISTINCT conversation_id FROM inserted LOOP
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id), 'conversation.updated', 'conversation:' || r.conversation_id::text, true);
      END LOOP;
      FOR r IN SELECT conversation_id, user_id FROM inserted LOOP
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id, 'change', change), 'conversation.changed', 'user:' || r.user_id::text, true);
      END LOOP;
    ELSE
      FOR r IN SELECT DISTINCT conversation_id FROM removed LOOP
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id), 'conversation.updated', 'conversation:' || r.conversation_id::text, true);
      END LOOP;
      FOR r IN SELECT conversation_id, user_id FROM removed LOOP
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id, 'change', change), 'conversation.changed', 'user:' || r.user_id::text, true);
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting membership change failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_members_broadcast_added
AFTER INSERT ON public.conversation_members
REFERENCING NEW TABLE AS inserted
FOR EACH STATEMENT
EXECUTE FUNCTION private.broadcast_membership_change();
--> statement-breakpoint
CREATE TRIGGER conversation_members_broadcast_removed
AFTER DELETE ON public.conversation_members
REFERENCING OLD TABLE AS removed
FOR EACH STATEMENT
EXECUTE FUNCTION private.broadcast_membership_change();
--> statement-breakpoint
-- Role changes (promote, demote, transfer): anyone viewing the conversation refetches it.
CREATE OR REPLACE FUNCTION private.broadcast_role_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(jsonb_build_object('conversationId', NEW.conversation_id), 'conversation.updated', 'conversation:' || NEW.conversation_id::text, true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting role change in % failed: %', NEW.conversation_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_members_broadcast_role
AFTER UPDATE OF role ON public.conversation_members
FOR EACH ROW
WHEN (OLD.role IS DISTINCT FROM NEW.role)
EXECUTE FUNCTION private.broadcast_role_change();
--> statement-breakpoint
-- Renames: anyone viewing refetches, and every member's list title changes.
CREATE OR REPLACE FUNCTION private.broadcast_conversation_renamed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  member_id uuid;
BEGIN
  BEGIN
    PERFORM realtime.send(jsonb_build_object('conversationId', NEW.id), 'conversation.updated', 'conversation:' || NEW.id::text, true);
    FOR member_id IN SELECT m.user_id FROM public.conversation_members AS m WHERE m.conversation_id = NEW.id LOOP
      PERFORM realtime.send(jsonb_build_object('conversationId', NEW.id, 'change', 'updated'), 'conversation.changed', 'user:' || member_id::text, true);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting rename of conversation % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversations_broadcast_renamed
AFTER UPDATE OF name ON public.conversations
FOR EACH ROW
WHEN (OLD.name IS DISTINCT FROM NEW.name)
EXECUTE FUNCTION private.broadcast_conversation_renamed();
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.broadcast_conversation_activity() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.broadcast_marker_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.broadcast_membership_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.broadcast_role_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.broadcast_conversation_renamed() FROM PUBLIC;
--> statement-breakpoint
-- user:<userId>: exactly the caller's own id. There is no pattern that admits other users.
CREATE OR REPLACE FUNCTION private.can_access_user_topic(topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(topic = 'user:' || (SELECT auth.uid())::text, false)
$$;
--> statement-breakpoint
-- live:<conversationId>: members of that conversation. Malformed topics are denied.
CREATE OR REPLACE FUNCTION private.can_access_live_topic(topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF topic IS NULL
     OR topic !~ '^live:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN private.is_conversation_member(substring(topic FROM 6)::uuid);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.can_access_user_topic(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.can_access_user_topic(text) TO authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.can_access_live_topic(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.can_access_live_topic(text) TO authenticated;
--> statement-breakpoint
-- Receive own user-channel events (database-published broadcasts only).
CREATE POLICY "linka_users_receive_own_events"
ON realtime.messages
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND private.can_access_user_topic((SELECT realtime.topic()))
);
--> statement-breakpoint
-- Members receive typing broadcasts and presence on the live channel...
CREATE POLICY "linka_conversation_members_receive_live"
ON realtime.messages
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND private.can_access_live_topic((SELECT realtime.topic()))
);
--> statement-breakpoint
-- ...and may publish there. This is the only topic clients may publish on.
CREATE POLICY "linka_conversation_members_publish_live"
ON realtime.messages
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND private.can_access_live_topic((SELECT realtime.topic()))
);
