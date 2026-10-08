ALTER TABLE "participants" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "finish_reason" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "leave_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "last_leave_at" timestamp with time zone;