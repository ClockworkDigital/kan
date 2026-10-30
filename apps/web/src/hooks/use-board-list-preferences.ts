import { useEffect, useState } from "react";
import { z } from "zod";

const preferencesSchema = z.object({
  sort: z.enum(["default", "recent", "progress"]),
  selectedTags: z.array(z.string()),
});
const defaults: z.infer<typeof preferencesSchema> = {
  sort: "default",
  selectedTags: [],
};

export function useBoardListPreferences(workspacePublicId: string) {
  const key = `kan:board-list:${workspacePublicId}`;
  const [state, setState] = useState({ key: "", ...defaults });

  useEffect(() => {
    let preferences = defaults;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      const parsed = preferencesSchema.safeParse(stored);
      if (parsed.success) preferences = parsed.data;
    } catch {
      // Storage may be unavailable or contain invalid JSON.
    }
    setState({ key, ...preferences });
  }, [key]);

  useEffect(() => {
    // Wait for this workspace's saved preferences before writing defaults.
    if (!workspacePublicId || state.key !== key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ sort: state.sort, selectedTags: state.selectedTags }),
      );
    } catch {
      // Filters still work in memory when browser storage is unavailable.
    }
  }, [key, state, workspacePublicId]);

  const preferences = state.key === key ? state : defaults;
  return {
    ...preferences,
    setSort: (sort: z.infer<typeof preferencesSchema>["sort"]) =>
      setState((previous) => ({ ...previous, sort })),
    setSelectedTags: (update: string[] | ((previous: string[]) => string[])) =>
      setState((previous) => ({
        ...previous,
        selectedTags:
          typeof update === "function" ? update(previous.selectedTags) : update,
      })),
  };
}
