import { describe, expect, it } from "vitest";
import {
  parseArrayValue,
  shouldMigrateLegacyArrayValue,
} from "@/components/workflow/config/array-input-field";

describe("parseArrayValue", () => {
  it("preserves legacy comma-separated scalar-array values", () => {
    let id = 0;
    expect(
      parseArrayValue("0xpool1, 0xpool2", () => {
        id += 1;
        return id;
      })
    ).toEqual([
      { id: 1, value: "0xpool1" },
      { id: 2, value: "0xpool2" },
    ]);
  });

  it("identifies every non-JSON legacy scalar-array value for migration", () => {
    expect(shouldMigrateLegacyArrayValue("0xpool1, 0xpool2")).toBe(true);
    expect(shouldMigrateLegacyArrayValue("{{a}}, {{b}}")).toBe(true);
    expect(shouldMigrateLegacyArrayValue("0xpool1")).toBe(false);
    expect(shouldMigrateLegacyArrayValue('["0xpool1","0xpool2"]')).toBe(false);
    expect(shouldMigrateLegacyArrayValue('{"a":1,"b":2}')).toBe(false);
    expect(shouldMigrateLegacyArrayValue("{{previous.items}}")).toBe(false);
  });

  it("renders a whole-field template as one array row", () => {
    let id = 0;
    expect(
      parseArrayValue("{{previous.items}}", () => {
        id += 1;
        return id;
      })
    ).toEqual([{ id: 1, value: "{{previous.items}}" }]);
  });

  it("does not greedily treat multiple templates as one whole-field template", () => {
    let id = 0;
    expect(
      parseArrayValue("{{a}}, {{b}}", () => {
        id += 1;
        return id;
      })
    ).toEqual([
      { id: 1, value: "{{a}}" },
      { id: 2, value: "{{b}}" },
    ]);
  });

  it("keeps a JSON scalar visible as one legacy row", () => {
    expect(parseArrayValue("1000", () => 1)).toEqual([
      { id: 1, value: "1000" },
    ]);
  });

  it("keeps an encoded empty array empty", () => {
    expect(parseArrayValue("[]", () => 1)).toEqual([]);
  });
});
