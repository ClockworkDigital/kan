import { APIError, createAuthMiddleware } from "better-auth/api";

import type { dbClient } from "@kan/db/client";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FORMWORK_IDENTITY_MISSING = "FORMWORK_IDENTITY_MISSING";

export function formworkHook(db: dbClient, tenantId: string) {
  if (!uuid.test(tenantId)) throw new Error("Invalid FORMWORK_TENANT_ID");

  return createAuthMiddleware(async (ctx) => {
    // Only the isolated, gateway-only deployment may enable this adapter.
    // Requests that never passed the gateway, such as the container
    // healthcheck, carry no identity; tag them so callers can stay quiet.
    // Throwing still matters: a null result would fall through to Kan's
    // cookie and API-key sessions.
    if (
      !Array.from(ctx.headers?.keys() ?? []).some((name) =>
        name.startsWith("x-formwork-"),
      )
    )
      throw new APIError("UNAUTHORIZED", { code: FORMWORK_IDENTITY_MISSING });

    const tenant = ctx.headers?.get("x-formwork-tenant");
    const userId = ctx.headers?.get("x-formwork-user");
    const issued = ctx.headers?.get("x-formwork-issued-at") ?? "";
    const age = Date.now() / 1000 - Number(issued);
    if (
      tenant?.toLowerCase() !== tenantId.toLowerCase() ||
      !userId ||
      !uuid.test(userId) ||
      !/^\d{10}$/.test(issued) ||
      age < -60 ||
      age >= 8 * 60 * 60
    )
      throw new APIError("UNAUTHORIZED");

    // Provision users explicitly by stable ID; email never selects an account.
    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, userId.toLowerCase()),
    });
    if (!user) throw new APIError("FORBIDDEN");
    if (ctx.path === "/sign-out") return ctx.json({ success: true });
    if (ctx.path !== "/get-session") {
      throw new APIError("FORBIDDEN", {
        message: "Manage sign-in through Formwork",
      });
    }

    // This is a view of the gateway session, not a reusable Kan login token.
    return ctx.json({
      user: { ...user, name: user.name ?? "Clockwork colleague" },
      session: {
        id: user.id,
        userId: user.id,
        token: "",
        createdAt: new Date(Number(issued) * 1000),
        updatedAt: new Date(Number(issued) * 1000),
        expiresAt: new Date((Number(issued) + 8 * 60 * 60) * 1000),
      },
    });
  });
}
