ALTER TABLE "factory_jobs" DROP CONSTRAINT "factory_jobs_createdBy_user_id_fk";
--> statement-breakpoint
ALTER TABLE "factory_jobs" ALTER COLUMN "createdBy" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factory_jobs" ADD CONSTRAINT "factory_jobs_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
