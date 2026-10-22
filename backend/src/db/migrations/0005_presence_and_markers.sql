ALTER TABLE "conversation_members" ALTER COLUMN "last_delivered_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "conversation_members" ALTER COLUMN "last_read_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "last_seen_at" timestamp (3) with time zone;