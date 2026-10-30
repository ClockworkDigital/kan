import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

export const factoryJobs = pgTable(
  "factory_jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    workspaceId: bigint("workspaceId", { mode: "number" })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: uuid("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    repository: varchar("repository", { length: 200 }).notNull(),
    runKey: varchar("runKey", { length: 128 }).notNull(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<FactorySnapshot>().notNull(),
    artifacts: jsonb("artifacts").$type<FactoryArtifact[]>().notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    deletedAt: timestamp("deletedAt"),
  },
  (table) => [
    uniqueIndex("factory_jobs_source_idx").on(
      table.workspaceId,
      table.repository,
      table.runKey,
    ),
    index("factory_jobs_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
  ],
).enableRLS();

export const factoryStages = [
  "queued",
  "intake",
  "spec",
  "building",
  "checks",
  "rework",
  "review",
  "publishing",
  "babysitting",
  "judging",
  "waiting",
  "needs_info",
  "needs_human",
  "failed",
  "completed",
] as const;

export const factoryResults = ["pending", "pass", "fail", "skipped"] as const;

export interface FactorySnapshot {
  title: string;
  stage: (typeof factoryStages)[number];
  issueNumber: number | null;
  prNumber: number | null;
  risk: "low" | "medium" | "high" | null;
  builderModel: string | null;
  estimatedCostUsd: number | null;
  elapsedSeconds: number | null;
  rounds: {
    round: number;
    gate: (typeof factoryResults)[number];
    reviews: {
      name: string;
      result: (typeof factoryResults)[number];
      summary: string;
    }[];
  }[];
}

export interface FactoryArtifact {
  name: string;
  content: string;
}
