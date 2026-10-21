-- Custom SQL migration: realtime delivery of new messages (Supabase Broadcast from Database).
--
-- Flow: the API inserts a message -> this AFTER INSERT trigger calls realtime.send() in the same
-- transaction -> Supabase Realtime delivers event "message.created" on the private channel
-- "conversation:<conversation_id>" to clients that are allowed to join that channel.
--
-- Authorization: Supabase checks private channel joins against RLS on realtime.messages.
-- The policy below lets a signed-in user receive only on topics of conversations they belong to.
-- There is deliberately no INSERT policy, so browser clients cannot publish on these channels:
-- every message.created event comes from this trigger.

-- The event payload has exactly the shape of the shared `Message` contract (@linka/shared).
CREATE OR REPLACE FUNCTION private.broadcast_message_created()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object(
        'id', NEW.id,
        'conversationId', NEW.conversation_id,
        'senderId', NEW.sender_id,
        'clientId', NEW.client_id,
        'type', NEW.type,
        'content', NEW.content,
        -- Same format as JavaScript's toISOString(), which the API uses.
        'createdAt', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'editedAt', NULL,
        'deletedAt', NULL
      ),
      'message.created',
      'conversation:' || NEW.conversation_id::text,
      true
    );
  EXCEPTION WHEN OTHERS THEN
    -- Realtime is best-effort: a broadcast problem must never block storing the message.
    -- Clients catch up by refetching after reconnecting.
    RAISE WARNING 'linka: broadcasting message % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.broadcast_message_created() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER messages_broadcast_created
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION private.broadcast_message_created();
--> statement-breakpoint
-- True when `topic` is "conversation:<uuid>" and the current user is a member of that conversation.
-- Malformed topics are simply denied (no cast errors).
CREATE OR REPLACE FUNCTION private.can_access_conversation_topic(topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF topic IS NULL
     OR topic !~ '^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN private.is_conversation_member(substring(topic FROM 14)::uuid);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.can_access_conversation_topic(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.can_access_conversation_topic(text) TO authenticated;
--> statement-breakpoint
CREATE POLICY "linka_conversation_members_receive_broadcasts"
ON realtime.messages
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND private.can_access_conversation_topic((SELECT realtime.topic()))
);
