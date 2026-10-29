import assert from "node:assert/strict";
import type * as ReactModule from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTRPCReact, getQueryKey } from "@trpc/react-query";
import { Children, createElement, Fragment, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRouter } from "@kan/api/root";
import type { UpdateBoardInput } from "@kan/api/types";

import type { RouterInputs } from "~/utils/api";
import BoardPage from "./index";

type BoardQuery = RouterInputs["board"]["byId"];
interface RenameCallbacks {
  onSuccess?: (data: unknown, variables: UpdateBoardInput) => Promise<void>;
  onError?: () => void;
}

const state = vi.hoisted(() => ({
  canEditBoard: true,
  query: {} as Partial<
    Record<"members" | "labels" | "lists" | "dueDate", string[]>
  >,
  form: undefined as UpdateBoardInput | undefined,
  callbacks: {} as RenameCallbacks,
  effectIndex: 0,
  effects: [] as { dependencies: readonly unknown[]; run: () => void }[],
  pendingEffects: [] as (() => void)[],
  mutate: vi.fn<(input: UpdateBoardInput) => void>(),
  showPopup: vi.fn(),
  invalidate: vi.fn<(input: Partial<BoardQuery>) => Promise<void>>(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useState: (initial: unknown) => [initial === true ? false : initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (run: () => void, dependencies: readonly unknown[]) => {
    const index = state.effectIndex++;
    const previous = state.effects[index];
    if (
      !previous ||
      dependencies.some((value, i) => value !== previous.dependencies[i])
    ) {
      state.pendingEffects.push(run);
    }
    state.effects[index] = { dependencies, run };
  },
}));
vi.mock("react-hook-form", () => ({
  useForm: (options: { values: UpdateBoardInput }) => {
    state.form ??= { ...options.values };
    return {
      register: () => ({
        name: "name",
        onChange: (event: { target: { value: string } }) => {
          assert(state.form);
          state.form.name = event.target.value;
        },
      }),
      handleSubmit: (submit: (values: UpdateBoardInput) => void) => () => {
        assert(state.form);
        submit({ ...state.form });
      },
      setValue,
    };
  },
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: string[]) =>
    strings.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ boardId: "board0000001" }),
}));
vi.mock("next/router", () => ({
  useRouter: () => ({ query: state.query, asPath: "/boards/board0000001" }),
}));
vi.mock("next-runtime-env", () => ({ env: () => "self-hosted" }));
vi.mock("~/utils/helpers", () => import("../../utils/helpers"));
vi.mock("~/utils/github-board-name", () =>
  import("../../utils/github-board-name"),
);
vi.mock("./dnd/collision", () => ({ createBoardCollisionDetection: vi.fn() }));
vi.mock("~/hooks/usePermissions", () => ({
  usePermissions: () => ({ canEditBoard: state.canEditBoard }),
}));
vi.mock("~/hooks/useDragToScroll", () => ({
  useDragToScroll: () => ({ ref: { current: null } }),
}));
vi.mock("~/hooks/useScrollRestore", () => ({ useScrollRestore: vi.fn() }));
vi.mock("~/providers/keyboard-shortcuts", () => ({
  useKeyboardShortcut: () => ({}),
}));
vi.mock("~/providers/modal", () => ({ useModal: () => ({}) }));
vi.mock("~/providers/popup", () => ({
  usePopup: () => ({ showPopup: state.showPopup }),
}));
vi.mock("~/providers/workspace", () => ({
  useWorkspace: () => ({ workspace: { publicId: "workspace001" } }),
}));
vi.mock("@dnd-kit/core", () => ({
  useSensor: vi.fn(),
  useSensors: vi.fn(),
  PointerSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  DndContext: vi.fn(),
  DragOverlay: vi.fn(),
}));
vi.mock("~/utils/api", () => ({
  api: {
    useUtils: () => ({ board: { byId: { invalidate: state.invalidate } } }),
    board: {
      byId: {
        useQuery: (input: BoardQuery) => {
          activeQuery = input;
          return {
            data: client.getQueryData(boardKey(input)),
            isSuccess: true,
          };
        },
      },
      update: {
        useMutation: (callbacks: RenameCallbacks = {}) => {
          state.callbacks = callbacks;
          return { mutate: state.mutate };
        },
      },
    },
    list: { update: { useMutation: () => ({}) } },
    card: { update: { useMutation: () => ({}) } },
  },
}));
vi.mock("~/components/Button", () => ({ default: () => null }));
vi.mock("~/components/DeleteLabelConfirmation", () => ({
  DeleteLabelConfirmation: () => null,
}));
vi.mock("~/components/LabelForm", () => ({ LabelForm: () => null }));
vi.mock("~/components/modal", () => ({ default: () => null }));
vi.mock("~/components/NewWorkspaceForm", () => ({
  NewWorkspaceForm: () => null,
}));
vi.mock("~/components/PageHead", () => ({ PageHead: () => null }));
vi.mock("~/components/PatternedBackground", () => ({ default: () => null }));
vi.mock("~/components/Tooltip", () => ({ Tooltip: () => null }));
vi.mock("~/components/YouTubeEmbed/EditYouTubeModal", () => ({
  EditYouTubeModal: () => null,
}));
vi.mock("~/views/card/components/DeleteCardConfirmation", () => ({
  DeleteCardConfirmation: () => null,
}));
vi.mock("./components/BoardDropdown", () => ({ default: () => null }));
vi.mock("./components/CalendarView", () => ({ default: () => null }));
vi.mock("./components/CardContextDueDateModal", () => ({
  CardContextDueDateModal: () => null,
}));
vi.mock("./components/CardContextDuplicateModal", () => ({
  CardContextDuplicateModal: () => null,
}));
vi.mock("./components/CardContextLabelsModal", () => ({
  CardContextLabelsModal: () => null,
}));
vi.mock("./components/CardContextMembersModal", () => ({
  CardContextMembersModal: () => null,
}));
vi.mock("./components/CardContextMenu", () => ({
  CardContextMenu: () => null,
}));
vi.mock("./components/CardContextMoveListModal", () => ({
  CardContextMoveListModal: () => null,
}));
vi.mock("./components/CardList", () => ({ default: () => null }));
vi.mock("./components/CardPreview", () => ({ default: () => null }));
vi.mock("./components/DeleteBoardConfirmation", () => ({
  DeleteBoardConfirmation: () => null,
}));
vi.mock("./components/DeleteListConfirmation", () => ({
  DeleteListConfirmation: () => null,
}));
vi.mock("./components/Filters", () => ({ default: () => null }));
vi.mock("./components/List", () => ({ default: () => null }));
vi.mock("./components/MoveBoardForm", () => ({ MoveBoardForm: () => null }));
vi.mock("./components/NewCardForm", () => ({ NewCardForm: () => null }));
vi.mock("./components/NewListForm", () => ({ NewListForm: () => null }));
vi.mock("./components/NewTemplateForm", () => ({
  NewTemplateForm: () => null,
}));
vi.mock("./components/ProjectDetailsForm", () => ({
  ProjectDetailsForm: () => null,
}));
vi.mock("./components/UpdateBoardSlugForm", () => ({
  UpdateBoardSlugForm: () => null,
}));
vi.mock("./components/ViewToggle", () => ({ default: () => null }));
vi.mock("./components/VisibilityButton", () => ({ default: () => null }));

const testApi = createTRPCReact<AppRouter>();
const boardKey = (input: Partial<BoardQuery>) =>
  getQueryKey(testApi.board.byId, input, "query");
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const unfilteredQuery: BoardQuery = {
  boardPublicId: "board0000001",
  members: [],
  labels: [],
  lists: [],
  type: "regular",
};
const fixture = (name: string) => ({
  publicId: "board0000001",
  name,
  visibility: "private",
  lists: [],
  labels: [],
  allLists: [],
  workspace: { members: [] },
});
let persisted = fixture("");
let activeQuery: BoardQuery = unfilteredQuery;
let unsubscribe: (() => void) | undefined;
const refetch = vi.fn(() => Promise.resolve(persisted));

function setValue(field: keyof UpdateBoardInput, value: string) {
  assert(state.form);
  assert.equal(field, "name");
  state.form.name = value;
}

function elements<Props>(tree: ReactNode, type: string): ReactElement<Props>[] {
  return Children.toArray(tree).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [
      ...(child.type === type ? [child as ReactElement<Props>] : []),
      ...elements<Props>(child.props.children, type),
    ];
  });
}

function renderBoard() {
  state.effectIndex = 0;
  const tree = BoardPage({});
  state.pendingEffects.splice(0).forEach((run) => run());
  const input = elements<ComponentProps<"input">>(tree, "input")[0];
  const form = elements<{ onSubmit: () => void }>(tree, "form")[0];
  assert(input && form);
  return {
    input: input.props,
    submit: form.props.onSubmit,
    name: state.form?.name,
  };
}

function start(name: string) {
  persisted = fixture(name);
  const query: BoardQuery = {
    ...unfilteredQuery,
    members: state.query.members ?? [],
    labels: state.query.labels ?? [],
    lists: state.query.lists ?? [],
    ...(state.query.dueDate ? { dueDateFilters: ["today" as const] } : {}),
  };
  client.setQueryData(boardKey(query), persisted);
  // Keep this query active, just as useQuery does, so invalidation must refetch it.
  const observer = new QueryObserver(client, {
    queryKey: boardKey(query),
    queryFn: refetch,
    staleTime: Infinity,
  });
  unsubscribe = observer.subscribe(() => undefined);
  return renderBoard();
}

function blurRename(name: string) {
  const board = renderBoard();
  assert(board.input.onChange && board.input.onBlur);
  board.input.onChange({
    target: { value: name },
  } as ReactModule.ChangeEvent<HTMLInputElement>);
  board.input.onBlur({} as ReactModule.FocusEvent<HTMLInputElement>);
  expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
    boardPublicId: "board0000001",
    name,
  });
}

async function succeed(name: string) {
  persisted = { ...persisted, name };
  const variables = state.mutate.mock.calls[0]?.[0];
  assert(variables);
  await state.callbacks.onSuccess?.({}, variables);
  return renderBoard();
}

beforeEach(() => {
  // Match the existing web tests' JSX and hook harness; child views stay mocked.
  vi.stubGlobal("React", { createElement, Fragment });
  state.canEditBoard = true;
  state.query = {};
  state.form = undefined;
  state.effects = [];
  state.pendingEffects = [];
  state.callbacks = {};
  vi.clearAllMocks();
  state.invalidate.mockImplementation((input) =>
    client.invalidateQueries({ queryKey: boardKey(input) }),
  );
});
afterEach(() => {
  unsubscribe?.();
  client.clear();
  vi.unstubAllGlobals();
});

describe("board name rename", () => {
  it.each([
    ["GitHub: review-example/before", "GitHub: review-example/after"],
    ["GitHub: review-example/before", "Ordinary after"],
    ["Ordinary before", "GitHub: another-example/after"],
    ["Ordinary before", "Ordinary after"],
  ])("refreshes %s to %s after saving", async (before, after) => {
    start(before);
    blurRename(after);
    expect(client.getQueryData(boardKey(activeQuery))).toEqual(fixture(before));
    const board = await succeed(after);
    expect(refetch).toHaveBeenCalledOnce();
    expect(board.name).toBe(after);
    expect(client.getQueryData(boardKey(activeQuery))).toEqual(fixture(after));
    expect(state.showPopup).not.toHaveBeenCalled();
  });

  it("refreshes the filtered board without changing filters or unrelated cache data", async () => {
    state.query = {
      members: ["member000001"],
      labels: ["label0000001"],
      lists: ["list00000001"],
      dueDate: ["today"],
    };
    start("GitHub: review-example/before");
    const originalQuery = { ...activeQuery };
    const otherQuery = { ...unfilteredQuery, boardPublicId: "board0000002" };
    const otherBoard = fixture("Unrelated synthetic board");
    client.setQueryData(boardKey(otherQuery), otherBoard);
    client.setQueryData(boardKey(unfilteredQuery), persisted);
    blurRename("GitHub: review-example/after");
    expect((await succeed("GitHub: review-example/after")).name).toBe(
      "GitHub: review-example/after",
    );
    expect(state.invalidate).toHaveBeenCalledExactlyOnceWith({
      boardPublicId: "board0000001",
    });
    expect(refetch).toHaveBeenCalledOnce();
    expect(activeQuery).toEqual(originalQuery);
    expect(client.getQueryData(boardKey(activeQuery))).toEqual(
      fixture("GitHub: review-example/after"),
    );
    expect(client.getQueryState(boardKey(unfilteredQuery))?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryData(boardKey(otherQuery))).toBe(otherBoard);
    expect(client.getQueryState(boardKey(otherQuery))?.isInvalidated).toBe(
      false,
    );
  });

  it.each([
    ["GitHub: review-example/before", "GitHub: review-example/rejected"],
    ["GitHub: review-example/before", "Rejected ordinary name"],
    ["Ordinary before", "GitHub: review-example/rejected"],
    ["Ordinary before", "Rejected ordinary name"],
  ])("restores %s when saving %s fails", (before, rejected) => {
    start(before);
    blurRename(rejected);
    state.callbacks.onError?.();
    const board = renderBoard();
    expect(state.showPopup).toHaveBeenCalledExactlyOnceWith({
      header: "Unable to update board",
      message: "Please try again later, or contact customer support.",
      icon: "error",
    });
    expect(board.name).toBe(before);
    expect(client.getQueryData(boardKey(activeQuery))).toEqual(fixture(before));
    expect(state.invalidate).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
    // Refocusing uses the same registered input, which must contain the persisted full name.
    expect(board.input["aria-label"]).toBe("Board name");
    if (board.input.className?.split(" ").includes("opacity-0")) {
      expect(board.input.className).toContain("focus:opacity-100");
    }
    expect(renderBoard().name).toBe(before);
  });

  it.each(["GitHub: review-example/before", "Ordinary before"])(
    "keeps %s read-only for viewers, including keyboard submission",
    (name) => {
      state.canEditBoard = false;
      const board = start(name);
      expect(board.input.readOnly).toBe(true);
      expect(board.input.onBlur).toBeUndefined();
      board.submit();
      expect(renderBoard().name).toBe(name);
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );
});
