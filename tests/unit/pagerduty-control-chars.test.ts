import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildTriggerEvent,
  cleanDisplayField,
  describeTrims,
  type Trim,
} from "@/plugins/pagerduty/event-payload";

function summaryFor(value: string): string {
  const { body } = buildTriggerEvent({
    routingKey: "R",
    dedupKey: "k",
    timestamp: "T",
    input: { summary: value, severity: "error", source: "s" },
  });
  return body.payload?.summary ?? "";
}

/**
 * A templated field carries whatever an upstream step produced. A bidi
 * override reorders the text around it, so an alert can render in PagerDuty
 * and on a phone as something other than what its author wrote, and
 * zero-width characters make two different values look identical.
 */
describe("characters that must not reach an alert", () => {
  it.each([
    ["right-to-left override", "vault\u202E down", "vault down"],
    ["zero-width space", "a\u200Bb", "ab"],
    ["null byte", "a\u0000b", "ab"],
    ["C1 control", "a\u0085b", "ab"],
    ["line separator", "a\u2028b", "ab"],
    ["byte order mark", "a\ufeffb", "ab"],
    ["soft hyphen", "a\u00ADb", "ab"],
  ])("removes a %s from the summary", (_name, value, expected) => {
    expect(summaryFor(value)).toBe(expected);
  });

  it("keeps tabs and newlines, which a description is allowed", () => {
    const trims: Trim[] = [];
    const value = "line one\nline two\tindented";
    expect(cleanDisplayField(value, "Summary", trims)).toBe(value);
    expect(trims).toEqual([]);
  });

  it("leaves ordinary punctuation, markdown and urls alone", () => {
    const value = "**vault** down: see https://ex.com/a?b=1&c=2 (C:\\\\logs)";
    expect(summaryFor(value)).toBe(value);
  });

  it("says so rather than changing the text silently", () => {
    const trims: Trim[] = [];
    cleanDisplayField("a\u202Eb", "Summary", trims);
    expect(trims).toHaveLength(1);
    expect(trims[0].kind).toBe("control");
    expect(describeTrims(trims)).toContain("cannot go in an alert");
  });

  /**
   * The dedup key is matched by equality between a trigger and the resolve
   * that closes it, so cleaning it would orphan every alert already open
   * under the old value. It is never displayed where a reordering misleads.
   */
  it("leaves the dedup key exactly as it was derived", () => {
    const dirty = "key\u200Bwith\u202Emarks";
    const { body } = buildTriggerEvent({
      routingKey: "R",
      dedupKey: dirty,
      timestamp: "T",
      input: { summary: "s", severity: "error", source: "s" },
    });
    expect(body.dedup_key).toBe(dirty);
  });
});
