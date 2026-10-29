CREATE TYPE "public"."project_status" AS ENUM('not_yet', 'busy', 'done');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "board_project" (
	"boardId" bigint PRIMARY KEY NOT NULL,
	"status" "project_status" DEFAULT 'not_yet' NOT NULL,
	"details" varchar(600) DEFAULT '' NOT NULL,
	"clients" varchar(2000) DEFAULT '' NOT NULL,
	"shownToClient" boolean DEFAULT false NOT NULL,
	"internal" boolean DEFAULT true NOT NULL,
	"nextSteps" varchar(2000) DEFAULT '' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" uuid
);
--> statement-breakpoint
ALTER TABLE "board_project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_project" ADD CONSTRAINT "board_project_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_project" ADD CONSTRAINT "board_project_updatedBy_user_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
