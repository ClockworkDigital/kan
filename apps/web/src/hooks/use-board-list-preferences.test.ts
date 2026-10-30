import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBoardListPreferences } from "./use-board-list-preferences";

const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  effects: [] as { dependencies: unknown[]; run: () => void }[],
  pending: [] as (() => void)[],
  index: 0,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    hooks.state ??= initial;
    return [
      hooks.state,
      (update: unknown) => {
        hooks.state =
          typeof update === "function"
            ? (update as (previous: unknown) => unknown)(hooks.state)
            : update;
      },
    ];
  },
  useEffect: (run: () => void, dependencies: unknown[]) => {
    const previous = hooks.effects[hooks.index];
    if (
      !previous ||
      dependencies.some((dep, i) => dep !== previous.dependencies[i])
    )
      hooks.pending.push(run);
    hooks.effects[hooks.index++] = { run, dependencies };
  },
}));

function unmount() {
  hooks.state = undefined;
  hooks.effects = [];
  hooks.pending = [];
}
function render(workspace = "workspace001") {
  hooks.index = 0;
  // This harness runs hooks and flushes effects without a browser.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const result = useBoardListPreferences(workspace);
  const effects = hooks.pending.splice(0);
  effects.forEach((run) => run());
  return result;
}

beforeEach(() => {
  unmount();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("board list preferences", () => {
  it("keeps filters and sort across remounts, and persists clearing filters", () => {
    render();
    let preferences = render();
    preferences.setSort("recent");
    preferences.setSelectedTags((tags) => [
      ...tags,
      "status:busy",
      "type:internal",
    ]);
    render();
    unmount();
    render();
    preferences = render();
    expect(preferences.sort).toBe("recent");
    expect(preferences.selectedTags).toEqual(["status:busy", "type:internal"]);
    preferences.setSelectedTags([]);
    render();
    unmount();
    render();
    expect(render().selectedTags).toEqual([]);
  });

  it("isolates workspaces without overwriting their saved preferences", () => {
    render();
    render().setSelectedTags(["status:busy"]);
    render();
    expect(render("workspace002").selectedTags).toEqual([]);
    render("workspace002").setSort("progress");
    render("workspace002");
    render();
    expect(render().selectedTags).toEqual(["status:busy"]);
    expect(render().sort).toBe("default");
    render("workspace002");
    expect(render("workspace002").sort).toBe("progress");
  });

  it.each(["{broken", '{"sort":"invalid","selectedTags":[]}', "null"])(
    "falls back safely for invalid storage: %s",
    (stored) => {
      localStorage.setItem("kan:board-list:workspace001", stored);
      render();
      expect(render().sort).toBe("default");
      expect(render().selectedTags).toEqual([]);
    },
  );

  it("still allows filtering when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Blocked");
      },
      setItem: () => {
        throw new Error("Blocked");
      },
    });
    render();
    render().setSelectedTags(["type:client"]);
    expect(render().selectedTags).toEqual(["type:client"]);
  });
});
