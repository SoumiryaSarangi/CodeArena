ALTER TYPE "public"."user_role" ADD VALUE 'setter' BEFORE 'admin';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "handle" DROP NOT NULL;