export type BoardSort = "default" | "recent" | "progress";

export interface BoardTile {
  tags: string[];
  lastActivity?: Date;
  done: number;
  total: number;
}

const progress = (tile: BoardTile) =>
  tile.total ? tile.done / tile.total : -1;

// Tags read "group:value". A tile matches when every group with a selection has one of its selected tags.
export function arrangeBoardTiles<T extends BoardTile>(
  tiles: T[],
  sort: BoardSort,
  selectedTags: string[],
): T[] {
  const groups = new Map<string, string[]>();
  for (const tag of selectedTags) {
    const group = tag.split(":")[0] ?? tag;
    groups.set(group, [...(groups.get(group) ?? []), tag]);
  }
  const shown = tiles.filter((tile) =>
    [...groups.values()].every((tags) =>
      tags.some((tag) => tile.tags.includes(tag)),
    ),
  );
  if (sort === "recent")
    return shown.sort(
      (a, b) =>
        (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0),
    );
  if (sort === "progress")
    return shown.sort((a, b) => progress(b) - progress(a));
  return shown;
}
