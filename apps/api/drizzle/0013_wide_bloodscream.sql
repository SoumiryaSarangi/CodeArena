ALTER TABLE "room_summaries" ADD COLUMN "prompt_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_summaries" ADD COLUMN "tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_summaries" ADD COLUMN "used_notes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "room_summaries" ADD COLUMN "input_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_summaries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;