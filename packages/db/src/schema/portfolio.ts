import {
  bigint,
  boolean,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { boards } from "./boards";
import { users } from "./users";

export const projectStatuses = ["not_yet", "busy", "beta_testing", "done"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
export const projectStatusEnum = pgEnum("project_status", projectStatuses);

// A board with a row here is a project on the workspace Portfolio page.
export const boardProjects = pgTable("board_project", {
  boardId: bigint("boardId", { mode: "number" })
    .primaryKey()
    .references(() => boards.id, { onDelete: "cascade" }),
  status: projectStatusEnum("status").notNull().default("not_yet"),
  details: varchar("details", { length: 600 }).notNull().default(""),
  clients: varchar("clients", { length: 2000 }).notNull().default(""),
  shownToClient: boolean("shownToClient").notNull().default(false),
  internal: boolean("internal").notNull().default(true),
  nextSteps: varchar("nextSteps", { length: 2000 }).notNull().default(""),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  updatedBy: uuid("updatedBy").references(() => users.id, {
    onDelete: "set null",
  }),
}).enableRLS();
