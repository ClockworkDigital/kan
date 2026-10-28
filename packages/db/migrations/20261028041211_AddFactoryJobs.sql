CREATE TABLE IF NOT EXISTS "factory_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"workspaceId" bigint NOT NULL,
	"createdBy" uuid NOT NULL,
	"repository" varchar(200) NOT NULL,
	"runKey" varchar(128) NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"artifacts" jsonb NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "factory_jobs_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "factory_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "factory_jobs_source_idx" ON "factory_jobs" USING btree ("workspaceId","repository","runKey");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "factory_jobs_workspace_updated_idx" ON "factory_jobs" USING btree ("workspaceId","updatedAt");