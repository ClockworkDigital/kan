import { and, eq, gte, inArray } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { integrations } from "@kan/db/schema";

export const isProviderAvailableForUser = async (
  db: dbClient,
  userId: string,
  provider: string,
) => {
  const integration = await db.query.integrations.findFirst({
    where: and(
      eq(integrations.userId, userId),
      eq(integrations.provider, provider),
      gte(integrations.expiresAt, new Date()),
    ),
  });

  return !!integration;
};

export const getProviderForUser = async (
  db: dbClient,
  userId: string,
  provider: string,
) => {
  const integration = await db.query.integrations.findFirst({
    where: and(
      eq(integrations.userId, userId),
      eq(integrations.provider, provider),
      gte(integrations.expiresAt, new Date()),
    ),
  });

  return integration;
};

export const getProvidersForUser = async (db: dbClient, userId: string) => {
  const integration = await db.query.integrations.findMany({
    columns: {
      createdAt: true,
      expiresAt: true,
      provider: true,
      updatedAt: true,
      userId: true,
    },
    where: and(
      eq(integrations.userId, userId),
      inArray(integrations.provider, ["github", "trello"]),
      gte(integrations.expiresAt, new Date()),
    ),
  });

  return integration;
};

export const createOrUpdateProvider = async (
  db: dbClient,
  data: {
    userId: string;
    provider: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt: Date;
  },
) => {
  if (data.provider === "github")
    await deleteProviderForUser(db, data.userId, "github-oauth-state");
  await db
    .insert(integrations)
    .values({
      provider: data.provider,
      userId: data.userId,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? null,
      expiresAt: data.expiresAt,
    })
    .onConflictDoUpdate({
      target: [integrations.userId, integrations.provider],
      set: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt,
      },
    });
};

export const updateAccessTokenIfCurrent = async (
  db: dbClient,
  data: {
    userId: string;
    provider: string;
    currentAccessToken: string;
    accessToken: string;
  },
) => {
  await db
    .update(integrations)
    .set({ accessToken: data.accessToken })
    .where(
      and(
        eq(integrations.userId, data.userId),
        eq(integrations.provider, data.provider),
        eq(integrations.accessToken, data.currentAccessToken),
      ),
    );
};

export const deleteProviderForUser = async (
  db: dbClient,
  userId: string,
  provider: string,
) => {
  if (provider === "github")
    await deleteProviderForUser(db, userId, "github-oauth-state");
  await db
    .delete(integrations)
    .where(
      and(eq(integrations.userId, userId), eq(integrations.provider, provider)),
    );
};

// The pending credential is private, encrypted, and never returned by providers.
export async function claimGitHubState(
  db: dbClient,
  userId: string,
  current: string,
  claimed: string,
) {
  const rows = await db
    .update(integrations)
    .set({ accessToken: claimed })
    .where(
      and(
        eq(integrations.userId, userId),
        eq(integrations.provider, "github-oauth-state"),
        eq(integrations.accessToken, current),
        gte(integrations.expiresAt, new Date()),
      ),
    )
    .returning({ userId: integrations.userId });
  return rows.length === 1;
}

export async function finishGitHubState(
  db: dbClient,
  userId: string,
  claimed: string,
  accessToken: string,
  expiresAt: Date,
  identity: string,
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(integrations)
      .where(
        and(
          eq(integrations.userId, userId),
          eq(integrations.provider, "github-oauth-state"),
          eq(integrations.accessToken, claimed),
          gte(integrations.expiresAt, new Date()),
        ),
      )
      .returning({ userId: integrations.userId });
    if (!rows.length) return false;
    await tx
      .insert(integrations)
      .values({
        userId,
        provider: "github",
        accessToken,
        expiresAt,
        refreshToken: identity,
      })
      .onConflictDoUpdate({
        target: [integrations.userId, integrations.provider],
        set: { accessToken, expiresAt, refreshToken: identity },
      });
    return true;
  });
}

// Status may describe an expired connection without exposing its access token.
export const getGitHubConnectionMetadata = (db: dbClient, userId: string) =>
  db.query.integrations.findFirst({
    columns: { expiresAt: true, refreshToken: true },
    where: and(
      eq(integrations.userId, userId),
      eq(integrations.provider, "github"),
    ),
  });
