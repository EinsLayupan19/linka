-- Custom SQL migration: Phase 7 calls.
--
-- 1. call.updated: every state change of a call (started, answered, declined, missed, ended) is
--    published to each participant's own user:<userId> channel, so an incoming call rings and a
--    call answered or ended elsewhere stops everywhere. Only the database publishes there.
-- 2. call:<callId>: the WebRTC signaling channel (offer, answer, ICE candidates). Only that
--    call's participants may join or publish, and only while the call rings or is active.
--    Audio never passes through here: it flows browser to browser over WebRTC.
--
-- Publishing is best-effort and never blocks the call write (clients refetch on reconnect).

-- A call in the shape of the shared `Call` contract (participants included).
CREATE OR REPLACE FUNCTION private.call_json(target_call_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', c.id,
    'conversationId', c.conversation_id,
    'initiatorId', c.initiator_id,
    'type', c.type,
    'status', c.status,
    'startedAt', private.iso(c.started_at),
    'endedAt', private.iso(c.ended_at),
    'createdAt', private.iso(c.created_at),
    'participants', coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object('userId', p.user_id, 'joinedAt', private.iso(p.joined_at), 'leftAt', private.iso(p.left_at))
          ORDER BY p.user_id
        )
        FROM public.call_participants AS p
        WHERE p.call_id = c.id
      ),
      '[]'::jsonb
    )
  )
  FROM public.calls AS c
  WHERE c.id = target_call_id
$$;
--> statement-breakpoint
-- Deferred to commit, so the payload has the participants inserted in the same transaction and
-- the call's final state (heartbeats do not change the status and do not publish).
CREATE OR REPLACE FUNCTION private.broadcast_call_updated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  payload jsonb;
  participant_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  BEGIN
    payload := private.call_json(NEW.id);
    IF payload IS NULL THEN
      RETURN NULL; -- deleted in the same transaction
    END IF;
    FOR participant_id IN
      SELECT p.user_id FROM public.call_participants AS p WHERE p.call_id = NEW.id
    LOOP
      PERFORM realtime.send(payload, 'call.updated', 'user:' || participant_id::text, true);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'linka: broadcasting call % failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER calls_broadcast_updated
AFTER INSERT OR UPDATE OF status ON public.calls
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.broadcast_call_updated();
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.call_json(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.broadcast_call_updated() FROM PUBLIC;
--> statement-breakpoint
-- call:<callId>: the caller is a participant of that call, it is still ringing or active, and
-- they still belong to its conversation. Malformed topics are denied.
CREATE OR REPLACE FUNCTION private.can_access_call_topic(topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF topic IS NULL
     OR topic !~ '^call:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.calls AS c
    JOIN public.call_participants AS p ON p.call_id = c.id
    JOIN public.conversation_members AS m ON m.conversation_id = c.conversation_id AND m.user_id = p.user_id
    WHERE c.id = substring(topic FROM 6)::uuid
      AND c.status IN ('ringing', 'active')
      AND p.user_id = (SELECT auth.uid())
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.can_access_call_topic(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.can_access_call_topic(text) TO authenticated;
--> statement-breakpoint
-- Participants receive signaling on their call's channel...
CREATE POLICY "linka_call_participants_receive_signals"
ON realtime.messages
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension = 'broadcast'
  AND private.can_access_call_topic((SELECT realtime.topic()))
);
--> statement-breakpoint
-- ...and may publish signaling there (broadcast only; no presence on call channels).
CREATE POLICY "linka_call_participants_publish_signals"
ON realtime.messages
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension = 'broadcast'
  AND private.can_access_call_topic((SELECT realtime.topic()))
);
