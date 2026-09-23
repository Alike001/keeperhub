import { describe, expect, it } from "vitest";
import {
  appendPage,
  EMPTY_EXECUTION_PAGE,
  type ExecutionPage,
  mergeFirstPage,
} from "@/lib/workflow/execution-page-merge";

type Run = { id: string; status: string };

function page(
  executions: Run[],
  nextCursor: string | null,
  total: number
): ExecutionPage<Run> {
  return { executions, nextCursor, total };
}

describe("mergeFirstPage", () => {
  it("is the page itself on a fresh load", () => {
    const first = page([{ id: "b", status: "running" }], "after-b", 5);
    expect(mergeFirstPage(EMPTY_EXECUTION_PAGE, first)).toEqual(first);
  });

  it("replaces covered rows in place so status changes show", () => {
    const loaded = page(
      [
        { id: "b", status: "running" },
        { id: "a", status: "success" },
      ],
      null,
      2
    );
    const refreshed = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      "after-a",
      2
    );
    expect(mergeFirstPage(loaded, refreshed).executions).toEqual(
      refreshed.executions
    );
  });

  it("prepends new runs and keeps the row they pushed out, with the loaded cursor", () => {
    // Page size 2: the viewer has page one loaded, then run c starts.
    const loaded = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      "after-a",
      2
    );
    const refreshed = page(
      [
        { id: "c", status: "running" },
        { id: "b", status: "success" },
      ],
      "after-b",
      3
    );
    expect(mergeFirstPage(loaded, refreshed)).toEqual({
      executions: [
        { id: "c", status: "running" },
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      // a is still the tail of what is on screen.
      nextCursor: "after-a",
      total: 3,
    });
  });

  it("keeps a null cursor when every page was already loaded and a run arrives", () => {
    const loaded = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      null,
      2
    );
    const refreshed = page(
      [
        { id: "c", status: "running" },
        { id: "b", status: "success" },
      ],
      "after-b",
      3
    );
    const merged = mergeFirstPage(loaded, refreshed);
    expect(merged.executions.map((run) => run.id)).toEqual(["c", "b", "a"]);
    expect(merged.nextCursor).toBeNull();
  });

  it("keeps older loaded pages below a refreshed first page", () => {
    const loaded = page(
      [
        { id: "d", status: "running" },
        { id: "c", status: "success" },
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      null,
      4
    );
    const refreshed = page(
      [
        { id: "d", status: "success" },
        { id: "c", status: "success" },
      ],
      "after-c",
      4
    );
    const merged = mergeFirstPage(loaded, refreshed);
    expect(merged.executions.map((run) => run.id)).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
    expect(merged.executions[0]?.status).toBe("success");
    expect(merged.nextCursor).toBeNull();
  });

  it("drops everything outside a complete page, which empties the panel after a purge", () => {
    const loaded = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      "after-a",
      40
    );
    expect(mergeFirstPage(loaded, page([], null, 0))).toEqual(
      page([], null, 0)
    );
  });
});

describe("appendPage", () => {
  it("appends older rows, skips duplicates and advances the cursor", () => {
    const loaded = page(
      [
        { id: "c", status: "success" },
        { id: "b", status: "success" },
      ],
      "after-b",
      4
    );
    const older = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      null,
      4
    );
    expect(appendPage(loaded, older)).toEqual({
      executions: [
        { id: "c", status: "success" },
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      nextCursor: null,
      total: 4,
    });
  });
});
