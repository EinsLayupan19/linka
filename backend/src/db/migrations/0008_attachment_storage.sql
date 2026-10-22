-- Custom SQL migration: Phase 6 files and media.
--
-- 1. Message events now carry attachment metadata. Attachments are linked to a message in the
--    same transaction that inserts it, but after the INSERT. The message broadcast triggers are
--    therefore DEFERRED constraint triggers: they run at commit, when the attachments are linked,
--    so message.created / conversation.activity always include them. A rolled-back message is
--    still never broadcast, and errors are still caught so realtime never blocks the commit.
-- 2. The private Storage buckets. Both stay private (public = false); there are no policies on
--    storage.objects for browser roles, so the only way in or out is a short-lived signed URL
--    issued by the API.

-- Attachment metadata for a message, oldest first. No storage paths, no URLs.
CREATE OR REPLACE FUNCTION private.attachments_json(message_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'fileName', a.file_name,
        'contentType', a.content_type,
        'sizeBytes', a.size_bytes
      )
      ORDER BY a.created_at, a.id
    ),
    '[]'::jsonb
  )
  FROM public.message_attachments AS a
  WHERE a.message_id = attachments_json.message_id
$$;
--> statement-breakpoint
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
    'deletedAt', private.iso(m.deleted_at),
    'attachments', private.attachments_json(m.id)
  )
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_broadcast_created ON public.messages;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_broadcast_activity ON public.messages;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER messages_broadcast_created
AFTER INSERT ON public.messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.broadcast_message_created();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER messages_broadcast_activity
AFTER INSERT ON public.messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.broadcast_conversation_activity();
--> statement-breakpoint
-- Private buckets. Limits match @linka/shared (MAX_FILE_BYTES, MAX_AVATAR_BYTES and the type
-- allowlists); Storage enforces them on upload in addition to the API's own checks.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'attachments',
    'attachments',
    false,
    26214400,
    ARRAY[
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]
  ),
  ('avatars', 'avatars', false, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
