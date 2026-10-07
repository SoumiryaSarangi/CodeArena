CREATE TABLE "validation_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"expected_verdict" "verdict",
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "problem_versions" ADD COLUMN "validator_uri" text;--> statement-breakpoint
ALTER TABLE "validation_items" ADD CONSTRAINT "validation_items_run_id_validation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."validation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "validation_items_run_id_index" ON "validation_items" USING btree ("run_id");