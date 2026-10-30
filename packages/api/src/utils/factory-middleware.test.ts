import { expect, it } from "vitest";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "../trpc";

const route = protectedProcedure
  .input(z.object({ workspacePublicId: z.string() }))
  .query(() => "allowed");
const router = createTRPCRouter({
  factory: createTRPCRouter({ publish: route, list: route, byId: route }),
  user: createTRPCRouter({ getUser: route }),
});
it("dispatches factory scope through the shared procedure middleware", async () => {
  const api = router.createCaller({
    headers: new Headers({
      "x-formwork-sync-workspace": "factory:workspace123",
    }),
    user: { id: "owner" },
    db: {},
  } as never);
  const input = { workspacePublicId: "workspace123" };
  expect(await api.factory.publish(input)).toBe("allowed");
  expect(await api.factory.list(input)).toBe("allowed");
  expect(await api.factory.byId(input)).toBe("allowed");
  await expect(
    api.factory.publish({ workspacePublicId: "another12345" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(api.user.getUser(input)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
