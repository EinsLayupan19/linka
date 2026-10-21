CREATE TYPE "public"."call_status" AS ENUM('ringing', 'active', 'ended', 'missed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."call_type" AS ENUM('voice', 'video');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text');--> statement-breakpoint
CREATE TABLE "call_participants" (
	"call_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	CONSTRAINT "call_participants_pkey" PRIMARY KEY("call_id","user_id"),
	CONSTRAINT "call_participants_leave_after_join" CHECK ("call_participants"."left_at" is null or ("call_participants"."joined_at" is not null and "call_participants"."left_at" >= "call_participants"."joined_at"))
);
--> statement-breakpoint
ALTER TABLE "call_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"initiator_id" uuid,
	"type" "call_type" NOT NULL,
	"status" "call_status" DEFAULT 'ringing' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_end_after_start" CHECK ("calls"."ended_at" is null or "calls"."started_at" is null or "calls"."ended_at" >= "calls"."started_at")
);
--> statement-breakpoint
ALTER TABLE "calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	CONSTRAINT "conversation_members_pkey" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "conversation_type" NOT NULL,
	"name" text,
	"created_by" uuid,
	"direct_low_user_id" uuid,
	"direct_high_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_direct_pair_unique" UNIQUE("direct_low_user_id","direct_high_user_id"),
	CONSTRAINT "conversations_direct_pair_order" CHECK ("conversations"."direct_low_user_id" < "conversations"."direct_high_user_id"),
	CONSTRAINT "conversations_direct_shape" CHECK ("conversations"."type" = 'direct' or ("conversations"."direct_low_user_id" is null and "conversations"."direct_high_user_id" is null)),
	CONSTRAINT "conversations_name_shape" CHECK (("conversations"."type" = 'group' and "conversations"."name" is not null and char_length("conversations"."name") <= 100 and btrim("conversations"."name") <> '')
        or ("conversations"."type" = 'direct' and "conversations"."name" is null))
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_storage_path_unique" UNIQUE("storage_path"),
	CONSTRAINT "message_attachments_size_positive" CHECK ("message_attachments"."size_bytes" > 0),
	CONSTRAINT "message_attachments_file_name_length" CHECK (char_length("message_attachments"."file_name") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid,
	"type" "message_type" DEFAULT 'text' NOT NULL,
	"content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "messages_text_content" CHECK ("messages"."type" <> 'text' or ("messages"."content" is not null and char_length("messages"."content") <= 4000 and btrim("messages"."content") <> ''))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_initiator_id_profiles_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_low_user_id_profiles_id_fk" FOREIGN KEY ("direct_low_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_high_user_id_profiles_id_fk" FOREIGN KEY ("direct_high_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_profiles_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_participants_user_id_idx" ON "call_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "calls_conversation_created_idx" ON "calls" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_one_ongoing_per_conversation_idx" ON "calls" USING btree ("conversation_id") WHERE "calls"."status" in ('ringing', 'active');--> statement-breakpoint
CREATE INDEX "conversation_members_user_id_idx" ON "conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_one_owner_idx" ON "conversation_members" USING btree ("conversation_id") WHERE "conversation_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_sender_id_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "profiles_username_prefix_idx" ON "profiles" USING btree ("username" text_pattern_ops);--> statement-breakpoint
CREATE POLICY "call_participants_select_member" ON "call_participants" AS PERMISSIVE FOR SELECT TO "authenticated" USING (exists (
        select 1 from public.calls c
        where c.id = "call_participants"."call_id" and private.is_conversation_member(c.conversation_id)
      ));--> statement-breakpoint
CREATE POLICY "calls_select_member" ON "calls" AS PERMISSIVE FOR SELECT TO "authenticated" USING (private.is_conversation_member("calls"."conversation_id"));--> statement-breakpoint
CREATE POLICY "conversation_members_select_member" ON "conversation_members" AS PERMISSIVE FOR SELECT TO "authenticated" USING (private.is_conversation_member("conversation_members"."conversation_id"));--> statement-breakpoint
CREATE POLICY "conversations_select_member" ON "conversations" AS PERMISSIVE FOR SELECT TO "authenticated" USING (private.is_conversation_member("conversations"."id"));--> statement-breakpoint
CREATE POLICY "message_attachments_select_member" ON "message_attachments" AS PERMISSIVE FOR SELECT TO "authenticated" USING (exists (
        select 1 from public.messages m
        where m.id = "message_attachments"."message_id" and private.is_conversation_member(m.conversation_id)
      ));--> statement-breakpoint
CREATE POLICY "messages_select_member" ON "messages" AS PERMISSIVE FOR SELECT TO "authenticated" USING (private.is_conversation_member("messages"."conversation_id"));