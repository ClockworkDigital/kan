CREATE TABLE IF NOT EXISTS "board_priority_change" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspaceId" bigint NOT NULL,
	"boardId" bigint NOT NULL,
	"fromRank" integer,
	"toRank" integer NOT NULL,
	"changedBy" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_priority_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_priority_change" ADD CONSTRAINT "board_priority_change_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_priority_change" ADD CONSTRAINT "board_priority_change_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_priority_change" ADD CONSTRAINT "board_priority_change_changedBy_user_id_fk" FOREIGN KEY ("changedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_priority_change_workspace_idx" ON "board_priority_change" USING btree ("workspaceId","createdAt");