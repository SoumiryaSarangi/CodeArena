CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."contest_status" AS ENUM('draft', 'scheduled', 'running', 'ended', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('confirmed', 'dismissed', 'needs_more');--> statement-breakpoint
CREATE TYPE "public"."lane" AS ENUM('contest', 'interactive', 'practice', 'rejudge');--> statement-breakpoint
CREATE TYPE "public"."oauth_provider" AS ENUM('google', 'github');--> statement-breakpoint
CREATE TYPE "public"."problem_visibility" AS ENUM('public', 'contest', 'private');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."room_event_kind" AS ENUM('join', 'leave', 'run', 'snapshot', 'restore', 'timer');--> statement-breakpoint
CREATE TYPE "public"."room_role" AS ENUM('interviewer', 'candidate', 'observer');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('open', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."run_reason" AS ENUM('initial', 'retry', 'rejudge');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."signal_kind" AS ENUM('paste', 'blur', 'focus', 'tab_hidden');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('queued', 'judging', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."validation_status" AS ENUM('pending', 'running', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('AC', 'WA', 'TLE', 'MLE', 'OLE', 'RE', 'CE', 'SE');--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"provider_user_id" text NOT NULL,
	CONSTRAINT "oauth_accounts_provider_provider_user_id_unique" UNIQUE("provider","provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"user_agent" text,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" "citext" NOT NULL,
	"name" text,
	"email" "citext" NOT NULL,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"rating" integer DEFAULT 1400 NOT NULL,
	"default_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "package_solutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"expected_verdict" "verdict" NOT NULL,
	"source_uri" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_tags" (
	"problem_id" uuid NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "problem_tags_problem_id_tag_pk" PRIMARY KEY("problem_id","tag")
);
--> statement-breakpoint
CREATE TABLE "problem_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"problem_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"statement_md" text NOT NULL,
	"editorial_md" text,
	"limits" jsonb NOT NULL,
	"checker" jsonb NOT NULL,
	"testset_hash" text,
	"testset_uri" text,
	"tests_count" integer DEFAULT 0 NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_status" "validation_status" DEFAULT 'pending' NOT NULL,
	"validated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "problem_versions_problem_id_version_unique" UNIQUE("problem_id","version")
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"difficulty" integer NOT NULL,
	"visibility" "problem_visibility" DEFAULT 'private' NOT NULL,
	"current_version_id" uuid,
	"author_id" uuid,
	"practice_points" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "problems_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "validation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"room_id" uuid,
	"problem_version_id" uuid,
	"language" text NOT NULL,
	"source" text NOT NULL,
	"input" text,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"run_version" integer NOT NULL,
	"reason" "run_reason" DEFAULT 'initial' NOT NULL,
	"worker_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"verdict" "verdict",
	"time_ms" integer,
	"mem_kb" integer,
	"compile_log" text,
	CONSTRAINT "judge_runs_submission_run_version_uq" UNIQUE("submission_id","run_version")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"problem_version_id" uuid NOT NULL,
	"contest_id" uuid,
	"language" text NOT NULL,
	"source" text NOT NULL,
	"source_bytes" integer NOT NULL,
	"lane" "lane" NOT NULL,
	"status" "submission_status" DEFAULT 'queued' NOT NULL,
	"verdict" "verdict",
	"time_ms" integer,
	"mem_kb" integer,
	"failed_test" integer,
	"current_run_version" integer DEFAULT 1 NOT NULL,
	"contest_minute" integer,
	"after_freeze" boolean DEFAULT false NOT NULL,
	"disqualified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"judged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "test_results" (
	"judge_run_id" uuid NOT NULL,
	"test_no" integer NOT NULL,
	"verdict" "verdict" NOT NULL,
	"time_ms" integer,
	"mem_kb" integer,
	"checker_msg" varchar(256),
	CONSTRAINT "test_results_judge_run_id_test_no_pk" PRIMARY KEY("judge_run_id","test_no")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contest_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contest_id" uuid NOT NULL,
	"problem_label" char(1),
	"asker_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"answered_by" uuid,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contest_problems" (
	"contest_id" uuid NOT NULL,
	"label" char(1) NOT NULL,
	"problem_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "contest_problems_contest_id_label_pk" PRIMARY KEY("contest_id","label")
);
--> statement-breakpoint
CREATE TABLE "contests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"freeze_at" timestamp with time zone,
	"rules" jsonb NOT NULL,
	"status" "contest_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "contests_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"contest_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"final_rank" integer,
	CONSTRAINT "participants_contest_id_user_id_pk" PRIMARY KEY("contest_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rating_changes" (
	"contest_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"old_rating" integer NOT NULL,
	"new_rating" integer NOT NULL,
	"delta" integer NOT NULL,
	"seed" numeric,
	"rank" integer NOT NULL,
	CONSTRAINT "rating_changes_contest_id_user_id_pk" PRIMARY KEY("contest_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "hint_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"submission_id" uuid,
	"prompt_version" text,
	"models" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"response" text,
	"leak_flag" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"helpful" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"contest_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"content_md" text,
	"prompt_version" text,
	"model" text,
	"tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "reviews_submission_id_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
CREATE TABLE "editor_signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"contest_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"kind" "signal_kind" NOT NULL,
	"size" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plag_clusters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"submission_ids" uuid[] NOT NULL,
	"max_score" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plag_pairs" (
	"run_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"sub_a" uuid NOT NULL,
	"sub_b" uuid NOT NULL,
	"fp_score" real,
	"emb_score" real,
	"combined" real NOT NULL,
	CONSTRAINT "plag_pairs_run_id_sub_a_sub_b_pk" PRIMARY KEY("run_id","sub_a","sub_b")
);
--> statement-breakpoint
CREATE TABLE "plag_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contest_id" uuid NOT NULL,
	"params" jsonb,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"metrics" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cluster_id" uuid NOT NULL,
	"decision" "decision_kind" NOT NULL,
	"note" text NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviewer_notes" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"author_id" uuid NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_checkpoints" (
	"room_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"state" "bytea" NOT NULL,
	CONSTRAINT "room_checkpoints_room_id_seq_pk" PRIMARY KEY("room_id","seq")
);
--> statement-breakpoint
CREATE TABLE "room_docs" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_events" (
	"room_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"kind" "room_event_kind" NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "room_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"role" "room_role" NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "room_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "room_role" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "room_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"label" text,
	"snapshot" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_summaries" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"content_md" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_updates" (
	"room_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"update" "bytea" NOT NULL,
	CONSTRAINT "room_updates_room_id_seq_pk" PRIMARY KEY("room_id","seq")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"problem_id" uuid,
	"language" text NOT NULL,
	"duration_min" integer,
	"status" "room_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"doc_bytes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"meta" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"props" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_solutions" ADD CONSTRAINT "package_solutions_version_id_problem_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."problem_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_tags" ADD CONSTRAINT "problem_tags_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_version_id_problem_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."problem_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_runs" ADD CONSTRAINT "custom_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_runs" ADD CONSTRAINT "custom_runs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_runs" ADD CONSTRAINT "custom_runs_problem_version_id_problem_versions_id_fk" FOREIGN KEY ("problem_version_id") REFERENCES "public"."problem_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_runs" ADD CONSTRAINT "judge_runs_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_version_id_problem_versions_id_fk" FOREIGN KEY ("problem_version_id") REFERENCES "public"."problem_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_judge_run_id_judge_runs_id_fk" FOREIGN KEY ("judge_run_id") REFERENCES "public"."judge_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_asker_id_users_id_fk" FOREIGN KEY ("asker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_version_id_problem_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."problem_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_changes" ADD CONSTRAINT "rating_changes_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_changes" ADD CONSTRAINT "rating_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hint_requests" ADD CONSTRAINT "hint_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hint_requests" ADD CONSTRAINT "hint_requests_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hint_requests" ADD CONSTRAINT "hint_requests_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editor_signals" ADD CONSTRAINT "editor_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editor_signals" ADD CONSTRAINT "editor_signals_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editor_signals" ADD CONSTRAINT "editor_signals_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plag_clusters" ADD CONSTRAINT "plag_clusters_run_id_plag_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."plag_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plag_clusters" ADD CONSTRAINT "plag_clusters_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plag_pairs" ADD CONSTRAINT "plag_pairs_run_id_plag_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."plag_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plag_pairs" ADD CONSTRAINT "plag_pairs_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plag_runs" ADD CONSTRAINT "plag_runs_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_cluster_id_plag_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."plag_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviewer_notes" ADD CONSTRAINT "interviewer_notes_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviewer_notes" ADD CONSTRAINT "interviewer_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_checkpoints" ADD CONSTRAINT "room_checkpoints_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_docs" ADD CONSTRAINT "room_docs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invites" ADD CONSTRAINT "room_invites_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_snapshots" ADD CONSTRAINT "room_snapshots_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_summaries" ADD CONSTRAINT "room_summaries_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_updates" ADD CONSTRAINT "room_updates_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_updates" ADD CONSTRAINT "room_updates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_index" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_index" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "validation_runs_version_id_index" ON "validation_runs" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "submissions_user_created_idx" ON "submissions" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "submissions_contest_id_created_at_index" ON "submissions" USING btree ("contest_id","created_at");--> statement-breakpoint
CREATE INDEX "submissions_problem_version_id_verdict_index" ON "submissions" USING btree ("problem_version_id","verdict");--> statement-breakpoint
CREATE INDEX "room_events_room_id_seq_index" ON "room_events" USING btree ("room_id","seq");--> statement-breakpoint
CREATE INDEX "product_events_name_at_index" ON "product_events" USING btree ("name","at");