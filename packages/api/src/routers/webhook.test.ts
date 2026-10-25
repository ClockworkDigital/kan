import assert from "node:assert/strict";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

import { webhookRouter } from "./webhook";

vi.mock("@kan/db/repository/webhook.repo", () => ({
  getAllByWorkspaceId: vi.fn(),
  getByPublicId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  hardDelete: vi.fn(),
}));

vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));

vi.mock("../utils/permissions", () => ({
  assertPermission: vi.fn(),
}));

import * as webhookRepo from "@kan/db/repository/webhook.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { assertPermission } from "../utils/permissions";

const mockGetAllByWorkspaceId = webhookRepo.getAllByWorkspaceId as ReturnType<typeof vi.fn>;
const mockGetByPublicId = webhookRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockCreate = webhookRepo.create as ReturnType<typeof vi.fn>;
const mockUpdate = webhookRepo.update as ReturnType<typeof vi.fn>;
const mockHardDelete = webhookRepo.hardDelete as ReturnType<typeof vi.fn>;
const mockWorkspaceGetByPublicId = workspaceRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockAssertPermission = assertPermission as ReturnType<typeof vi.fn>;

describe("webhook router", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-123", name: "Test User", email: "test@example.com" };
  const mockWorkspace = { id: 1, publicId: "ws-123456789" };
  const mockWebhook = {
    id: 1,
    publicId: "wh-123456789",
    workspaceId: 1,
    name: "My Webhook",
    url: "https://example.com/webhook",
    secret: "secret123",
    events: ["card.created", "card.updated"] as const,
    active: true,
    createdAt: new Date("2024-01-15"),
    updatedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertPermission.mockResolvedValue(undefined);
  });

  describe("authorization", () => {
    it("throws UNAUTHORIZED when user is not authenticated", async () => {
      const ctx = {
        headers: new Headers(),
        user: null,
        db: mockDb,
      } as never;

      await expect(
        webhookRouter.createCaller(ctx).list({ workspacePublicId: "ws-123456789" }),
      ).rejects.toThrow(TRPCError);
    });

    it("throws NOT_FOUND when workspace does not exist", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(null);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      await expect(
        webhookRouter.createCaller(ctx).list({ workspacePublicId: "ws-nonexistent" }),
      ).rejects.toThrow(TRPCError);
    });

    it("checks workspace:manage permission via assertPermission", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetAllByWorkspaceId.mockResolvedValueOnce([]);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      await webhookRouter.createCaller(ctx).list({ workspacePublicId: "ws-123456789" });

      expect(mockAssertPermission).toHaveBeenCalledWith(
        mockDb,
        mockUser.id,
        mockWorkspace.id,
        "workspace:manage",
      );
    });
  });

  describe("list", () => {
    it("returns all webhooks for workspace", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetAllByWorkspaceId.mockResolvedValueOnce([mockWebhook]);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      const result = await webhookRouter.createCaller(ctx).list({
        workspacePublicId: "ws-123456789",
      });

      expect(result).toHaveLength(1);
      assert.ok(result[0]);
      expect(result[0].name).toBe("My Webhook");
      expect(mockGetAllByWorkspaceId).toHaveBeenCalledWith(mockDb, mockWorkspace.id);
    });

    it("returns empty array when no webhooks exist", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetAllByWorkspaceId.mockResolvedValueOnce([]);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      const result = await webhookRouter.createCaller(ctx).list({
        workspacePublicId: "ws-123456789",
      });

      expect(result).toEqual([]);
    });
  });

  describe("create", () => {
    it("creates a webhook with valid input", async () => {
      const newWebhook = {
        publicId: "wh-new123456",
        name: "New Webhook",
        url: "https://example.com/new",
        events: ["card.created"] as const,
        active: true,
        createdAt: new Date(),
      };

      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockCreate.mockResolvedValueOnce(newWebhook);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      const result = await webhookRouter.createCaller(ctx).create({
        workspacePublicId: "ws-123456789",
        name: "New Webhook",
        url: "https://example.com/new",
        events: ["card.created"],
      });

      expect(result.name).toBe("New Webhook");
      expect(mockCreate).toHaveBeenCalledWith(mockDb, {
        workspaceId: mockWorkspace.id,
        name: "New Webhook",
        url: "https://example.com/new",
        secret: undefined,
        events: ["card.created"],
        createdBy: mockUser.id,
      });
    });

    it("creates a webhook with secret", async () => {
      const newWebhook = {
        publicId: "wh-new123456",
        name: "Secure Webhook",
        url: "https://example.com/secure",
        events: ["card.created"] as const,
        active: true,
        createdAt: new Date(),
      };

      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockCreate.mockResolvedValueOnce(newWebhook);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      await webhookRouter.createCaller(ctx).create({
        workspacePublicId: "ws-123456789",
        name: "Secure Webhook",
        url: "https://example.com/secure",
        secret: "my-secret-key",
        events: ["card.created"],
      });

      expect(mockCreate).toHaveBeenCalledWith(mockDb, expect.objectContaining({
        secret: "my-secret-key",
      }));
    });

    it("throws INTERNAL_SERVER_ERROR when create fails", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockCreate.mockResolvedValueOnce(null);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      await expect(
        webhookRouter.createCaller(ctx).create({
          workspacePublicId: "ws-123456789",
          name: "New Webhook",
          url: "https://example.com/new",
          events: ["card.created"],
        }),
      ).rejects.toThrow(TRPCError);
    });
  });

  describe("update", () => {
    it("updates webhook name", async () => {
      const updatedWebhook = { ...mockWebhook, name: "Updated Name" };

      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetByPublicId.mockResolvedValueOnce(mockWebhook);
      mockUpdate.mockResolvedValueOnce(updatedWebhook);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      const result = await webhookRouter.createCaller(ctx).update({
        workspacePublicId: "ws-123456789",
        webhookPublicId: "wh-123456789",
        name: "Updated Name",
      });

      expect(result.name).toBe("Updated Name");
      expect(mockUpdate).toHaveBeenCalledWith(mockDb, "wh-123456789", {
        name: "Updated Name",
        url: undefined,
        secret: undefined,
        events: undefined,
        active: undefined,
      });
    });

    it("throws NOT_FOUND when webhook does not exist", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetByPublicId.mockResolvedValueOnce(null);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      await expect(
        webhookRouter.createCaller(ctx).update({
          workspacePublicId: "ws-123456789",
          webhookPublicId: "wh-nonexistent",
          name: "Updated Name",
        }),
      ).rejects.toThrow(TRPCError);
    });

    it("throws NOT_FOUND when webhook belongs to different workspace", async () => {
      const webhookFromDifferentWorkspace = { ...mockWebhook, workspaceId: 999 };

      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetByPublicId.mockResolvedValueOnce(webhookFromDifferentWorkspace);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      await expect(
        webhookRouter.createCaller(ctx).update({
          workspacePublicId: "ws-123456789",
          webhookPublicId: "wh-123456789",
          name: "Updated Name",
        }),
      ).rejects.toThrow(TRPCError);
    });
  });

  describe("delete", () => {
    it("deletes webhook successfully", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetByPublicId.mockResolvedValueOnce(mockWebhook);
      mockHardDelete.mockResolvedValueOnce(undefined);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      const result = await webhookRouter.createCaller(ctx).delete({
        workspacePublicId: "ws-123456789",
        webhookPublicId: "wh-123456789",
      });

      expect(result).toEqual({ success: true });
      expect(mockHardDelete).toHaveBeenCalledWith(mockDb, "wh-123456789");
    });

    it("throws NOT_FOUND when webhook does not exist", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetByPublicId.mockResolvedValueOnce(null);

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      await expect(
        webhookRouter.createCaller(ctx).delete({
          workspacePublicId: "ws-123456789",
          webhookPublicId: "wh-nonexistent",
        }),
      ).rejects.toThrow(TRPCError);
    });
  });

  describe("test", () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("sends test payload to webhook URL", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetByPublicId.mockResolvedValueOnce(mockWebhook);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      const result = await webhookRouter.createCaller(ctx).test({
        workspacePublicId: "ws-123456789",
        webhookPublicId: "wh-123456789",
      });

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      const expectedHeaders: unknown = expect.objectContaining({
        "Content-Type": "application/json",
        "X-Webhook-Event": "card.created",
      });
      expect(global.fetch).toHaveBeenCalledWith(
        mockWebhook.url,
        expect.objectContaining({
          method: "POST",
          headers: expectedHeaders,
        }),
      );
    });

    it("returns error when test fails", async () => {
      mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
      mockGetByPublicId.mockResolvedValueOnce(mockWebhook);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const ctx = {
        headers: new Headers(),
        user: mockUser,
        db: mockDb,
      } as never;

      const result = await webhookRouter.createCaller(ctx).test({
        workspacePublicId: "ws-123456789",
        webhookPublicId: "wh-123456789",
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.error).toContain("500");
    });
  });
});
