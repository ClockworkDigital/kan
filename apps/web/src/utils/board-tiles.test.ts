import { describe, expect, it } from "vitest";

import { arrangeBoardTiles } from "./board-tiles";

const tile = (
  name: string,
  tags: string[],
  done: number,
  total: number,
  lastActivity?: Date,
) => ({ name, tags, done, total, lastActivity });

const tiles = [
  tile("a", ["status:busy", "type:client"], 1, 4, new Date("2026-10-01")),
  tile("b", ["status:done", "type:internal"], 3, 3),
  tile("c", ["status:busy", "type:internal"], 0, 0, new Date("2026-10-20")),
];
const names = (list: { name: string }[]) => list.map((item) => item.name);

describe("arrangeBoardTiles", () => {
  it("keeps the original order by default", () => {
    expect(names(arrangeBoardTiles(tiles, "default", []))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("sorts by most recent activity, undated last", () => {
    expect(names(arrangeBoardTiles(tiles, "recent", []))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("sorts by progress, boards without cards last", () => {
    expect(names(arrangeBoardTiles(tiles, "progress", []))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("matches any tag within a group and every selected group", () => {
    expect(
      names(
        arrangeBoardTiles(tiles, "default", ["status:busy", "status:done"]),
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      names(
        arrangeBoardTiles(tiles, "default", ["status:busy", "type:internal"]),
      ),
    ).toEqual(["c"]);
  });

  it("does not reorder the input array", () => {
    arrangeBoardTiles(tiles, "recent", []);
    expect(names(tiles)).toEqual(["a", "b", "c"]);
  });
});
