import { TRPCError } from "@trpc/server";
import { z } from "zod";

export function assertFactoryScope(
  userId: string | undefined,
  scope: string,
  path: string,
  raw: unknown,
) {
  const input = z
    .object({ workspacePublicId: z.string().length(12) })
    .safeParse(raw);
  if (
    !userId ||
    !scope.startsWith("factory:") ||
    !["factory.publish", "factory.list", "factory.byId"].includes(path) ||
    !input.success ||
    scope !== `factory:${input.data.workspacePublicId}`
  )
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Outside factory delegation.",
    });
}
