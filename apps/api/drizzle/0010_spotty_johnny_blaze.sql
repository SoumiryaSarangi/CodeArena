ALTER TABLE "contest_problems" ADD COLUMN "canary_token" text;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD COLUMN "canary_on" boolean DEFAULT false NOT NULL;