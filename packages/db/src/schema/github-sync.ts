import {
  bigint,
  boolean,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

export const githubSyncSettings = pgTable("github_sync_settings", {
  workspaceId: bigint("workspaceId", { mode: "number" })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  repositories: jsonb("repositories").$type<string[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(false),
  status: jsonb("status").$type<{
    checkedAt: string;
    created: number;
    updatedGitHub: number;
    updatedKan: number;
    conflicts: number;
    errors: number;
  }>(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
}).enableRLS();
