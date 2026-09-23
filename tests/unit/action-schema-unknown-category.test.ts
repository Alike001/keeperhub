// A category filter that matches nothing used to return an empty action map
// with a 200, which reads as "this action does not exist" rather than "that
// is not a category". The response now names the valid categories instead.

import { describe, expect, it } from "vitest";

import { buildActionSchemasResponse } from "@/lib/action-schemas/builder";

async function build(category?: string): Promise<Record<string, unknown>> {
  return await buildActionSchemasResponse({
    category,
    includeChains: false,
    endpointLabel: "test",
  });
}

describe("action schemas unknown category filter", () => {
  it("names the valid categories when the filter matches nothing", async () => {
    const response = await build("datas");

    expect(Object.keys(response.actions as object)).toHaveLength(0);
    expect(response.availableCategories).toContain("data");
    expect(response.availableCategories).toContain("system");
    expect(response.availableCategories).toContain("triggers");
  });

  it("omits the hint when the filter matches actions", async () => {
    const response = await build("data");

    expect(Object.keys(response.actions as object).length).toBeGreaterThan(0);
    expect(response.availableCategories).toBeUndefined();
  });

  it("omits the hint when no filter is given", async () => {
    const response = await build();

    expect(response.availableCategories).toBeUndefined();
  });

  it("matches a category case-insensitively", async () => {
    const response = await build("Data");

    expect(response.actions).toHaveProperty("data/hash");
    expect(response.availableCategories).toBeUndefined();
  });

  it("lists every registered plugin type as a valid category", async () => {
    const response = await build("no-such-category");
    const categories = response.availableCategories as string[];

    expect(categories).toContain("web3");
    expect(categories).toEqual([...categories].sort());
  });
});
