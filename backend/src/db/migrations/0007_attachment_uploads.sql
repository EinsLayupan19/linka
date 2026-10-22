CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'ready');--> statement-breakpoint
ALTER TYPE "public"."message_type" ADD VALUE 'attachment';--> statement-breakpoint
ALTER TABLE "message_attachments" DROP CONSTRAINT "message_attachments_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "message_attachments" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "conversation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "uploader_id" uuid;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "client_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "status" "attachment_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_uploader_id_profiles_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The composite key below needs this unique constraint first.
ALTER TABLE "messages" ADD CONSTRAINT "messages_id_conversation_unique" UNIQUE("id","conversation_id");--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_uploader_client_idx" ON "message_attachments" USING btree ("uploader_id","client_id");--> statement-breakpoint
CREATE INDEX "message_attachments_unattached_idx" ON "message_attachments" USING btree ("created_at") WHERE "message_attachments"."message_id" is null;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_size_limit" CHECK ("message_attachments"."size_bytes" <= 26214400);--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_content_type" CHECK ("message_attachments"."content_type" in ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'));--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_attached_ready" CHECK ("message_attachments"."message_id" is null or "message_attachments"."status" = 'ready');--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_path_shape" CHECK ("message_attachments"."storage_path" = "message_attachments"."conversation_id"::text || '/' || split_part("message_attachments"."storage_path", '/', 2) || '/' || "message_attachments"."id"::text || '.' || split_part(split_part("message_attachments"."storage_path", '/', 3), '.', 2)
        and split_part("message_attachments"."storage_path", '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and split_part(split_part("message_attachments"."storage_path", '/', 3), '.', 2) ~ '^[a-z0-9]{1,5}$'
        and ("message_attachments"."uploader_id" is null or split_part("message_attachments"."storage_path", '/', 2) = "message_attachments"."uploader_id"::text));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_content_length" CHECK ("messages"."content" is null or char_length("messages"."content") <= 4000);--> statement-breakpoint
ALTER POLICY "message_attachments_select_member" ON "message_attachments" TO authenticated USING (private.is_conversation_member("message_attachments"."conversation_id")
        and ("message_attachments"."message_id" is not null or "message_attachments"."uploader_id" = (select auth.uid())));