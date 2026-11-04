-- Custom SQL migration: removed members stop receiving a group live.
--
-- Supabase checks a private channel when it is joined and remembers the answer for that connection
-- (until the access token is refreshed). Someone removed from a group with it open therefore kept
-- receiving new messages on the channel they had joined, although the API refused them everything.
--
-- Fix: the conversation's topics carry its channel_version (0012):
--   conversation:<id>:<version>   database events (messages, receipts, updates)
--   live:<id>:<version>           typing and presence
-- When anyone leaves or is removed, the version goes up, after one last conversation.updated on the
-- old topic (everyone there, the removed member included, refetches the conversation; members get
-- the new version and rejoin, the removed member gets 404). From then on the database publishes only
-- on the new topics, joining them needs current membership, and out-of-date topics admit nobody.
-- The removed member's old channel stays open but receives nothing from the database again.

-- Topic names. Plain lookups: the triggers that call them run as the table owner.
CREATE OR REPLACE FUNCTION private.conversation_topic(target_conversation_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 'conversation:' || c.id::text || ':' || c.channel_version::text FROM public.conversations AS c WHERE c.id = target_conversation_id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.live_topic(target_conversation_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 'live:' || c.id::text || ':' || c.channel_version::text FROM public.conversations AS c WHERE c.id = target_conversation_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.conversation_topic(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.live_topic(uuid) FROM PUBLIC;
--> statement-breakpoint
-- True when `topic` is "<prefix><uuid>:<version>", the version is the conversation's current one
-- and the caller is a member. Runs with the owner's rights (like is_conversation_member) so the
-- channel check does not depend on the conversations table's own policies. Malformed topics are
-- denied without cast errors.
CREATE OR REPLACE FUNCTION private.can_access_versioned_topic(topic text, prefix text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  parts text[];
BEGIN
  parts := regexp_match(
    topic,
    '^' || prefix || '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]{0,8})$'
  );
  IF parts IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.conversations AS c
    JOIN public.conversation_members AS m ON m.conversation_id = c.id
    WHERE c.id = parts[1]::uuid
      AND c.channel_version = parts[2]::integer
      AND m.user_id = (SELECT auth.uid())
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.can_access_versioned_topic(text, text) FROM PUBLIC;
--> statement-breakpoint
-- The existing policies call these two; only their rules change.
CREATE OR REPLACE FUNCTION private.can_access_conversation_topic(topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT private.can_access_versioned_topic(topic, 'conversation:')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.can_access_live_topic(topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT private.can_access_versioned_topic(topic, 'live:')
$$;
--> statement-breakpoint
-- Grant after the wrappers exist: they call the helper as the joining user.
GRANT EXECUTE ON FUNCTION private.can_access_versioned_topic(text, text) TO authenticated;
--> statement-breakpoint
-- Database events on the conversation's current topic (same payloads as before).
CREATE OR REPLACE FUNCTION private.broadcast_message_created()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(private.message_json(NEW), 'message.created', private.conversation_topic(NEW.conversation_id), true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting message % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
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
      private.conversation_topic(NEW.conversation_id),
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
-- Membership changes. After a removal (or leave), the version goes up. Publishing stays
-- best-effort, but the version bump is not: it is what cuts the removed member off, so it is outside
-- the error handler and a failure there undoes the removal.
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
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id), 'conversation.updated', private.conversation_topic(r.conversation_id), true);
      END LOOP;
      FOR r IN SELECT conversation_id, user_id FROM inserted LOOP
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id, 'change', change), 'conversation.changed', 'user:' || r.user_id::text, true);
      END LOOP;
    ELSE
      -- Still the old version: this is where everyone who has the conversation open listens.
      FOR r IN SELECT DISTINCT conversation_id FROM removed LOOP
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id), 'conversation.updated', private.conversation_topic(r.conversation_id), true);
      END LOOP;
      FOR r IN SELECT conversation_id, user_id FROM removed LOOP
        PERFORM realtime.send(jsonb_build_object('conversationId', r.conversation_id, 'change', change), 'conversation.changed', 'user:' || r.user_id::text, true);
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting membership change failed: %', SQLERRM;
  END;
  IF TG_OP = 'DELETE' THEN
    -- A conversation being deleted is already gone, so this updates nothing for it.
    UPDATE public.conversations AS c
    SET channel_version = c.channel_version + 1
    WHERE c.id IN (SELECT DISTINCT conversation_id FROM removed);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.broadcast_role_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(jsonb_build_object('conversationId', NEW.conversation_id), 'conversation.updated', private.conversation_topic(NEW.conversation_id), true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting role change in % failed: %', NEW.conversation_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.broadcast_conversation_renamed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  member_id uuid;
BEGIN
  BEGIN
    PERFORM realtime.send(jsonb_build_object('conversationId', NEW.id), 'conversation.updated', private.conversation_topic(NEW.id), true);
    FOR member_id IN SELECT m.user_id FROM public.conversation_members AS m WHERE m.conversation_id = NEW.id LOOP
      PERFORM realtime.send(jsonb_build_object('conversationId', NEW.id, 'change', 'updated'), 'conversation.changed', 'user:' || member_id::text, true);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting rename of conversation % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
