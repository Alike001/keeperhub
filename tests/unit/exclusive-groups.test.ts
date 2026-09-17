import { describe, expect, it } from "vitest";

import {
  type ExclusiveField,
  isFieldLocked,
  resolveExclusiveGroups,
} from "@/lib/integrations/exclusive-groups";

/**
 * PagerDuty's connection takes either a REST API token or a scoped OAuth app,
 * never both, and the run time prefers the token when both are present. A form
 * that simply lists all four fields reads as though it wants all four, so the
 * one not in use is held shut.
 */
const FIELDS: ExclusiveField[] = [
  {
    id: "apiToken",
    configKey: "apiToken",
    exclusiveGroup: "token",
    exclusiveGroupLabel: "Option A - API token",
  },
  {
    id: "oauthClientId",
    configKey: "oauthClientId",
    exclusiveGroup: "oauth",
    exclusiveGroupLabel: "Option B - Scoped OAuth",
  },
  {
    id: "oauthClientSecret",
    configKey: "oauthClientSecret",
    exclusiveGroup: "oauth",
  },
  { id: "subdomain", configKey: "subdomain", exclusiveGroup: "oauth" },
  { id: "fromEmail", configKey: "fromEmail" },
];

const tokenField = FIELDS[0];
const oauthField = FIELDS[1];
const ungrouped = FIELDS[4];

describe("resolveExclusiveGroups", () => {
  it("collects each alternative and the field that opens it", () => {
    const state = resolveExclusiveGroups(FIELDS, {});
    expect(state.groups.map((group) => group.id)).toEqual(["token", "oauth"]);
    expect(state.groups[0]).toMatchObject({
      label: "Option A - API token",
      firstFieldId: "apiToken",
      configKeys: ["apiToken"],
    });
    expect(state.groups[1].configKeys).toEqual([
      "oauthClientId",
      "oauthClientSecret",
      "subdomain",
    ]);
  });

  it("locks nothing while the form is empty, so either can be started", () => {
    const state = resolveExclusiveGroups(FIELDS, {});
    expect(state.activeGroupId).toBeUndefined();
    expect(isFieldLocked(tokenField, state)).toBe(false);
    expect(isFieldLocked(oauthField, state)).toBe(false);
  });

  it("locks the other option once one is started", () => {
    const state = resolveExclusiveGroups(FIELDS, { apiToken: "tok" });
    expect(state.activeGroupId).toBe("token");
    expect(isFieldLocked(tokenField, state)).toBe(false);
    expect(isFieldLocked(oauthField, state)).toBe(true);
  });

  it("locks the token once any one OAuth field is started", () => {
    const state = resolveExclusiveGroups(FIELDS, { subdomain: "acme" });
    expect(state.activeGroupId).toBe("oauth");
    expect(isFieldLocked(tokenField, state)).toBe(true);
  });

  it("never locks a field outside any group", () => {
    const state = resolveExclusiveGroups(FIELDS, { apiToken: "tok" });
    expect(isFieldLocked(ungrouped, state)).toBe(false);
  });

  it("treats blank and whitespace as unfilled", () => {
    for (const value of ["", "   "]) {
      const state = resolveExclusiveGroups(FIELDS, { apiToken: value });
      expect(state.activeGroupId).toBeUndefined();
      expect(isFieldLocked(oauthField, state)).toBe(false);
    }
  });

  /**
   * An existing connection can hold both, because nothing stopped that before.
   * Locking there would leave somebody unable to empty the one being ignored,
   * so nothing is locked and the form says which one actually wins - which is
   * the token, the same precedence the run time applies.
   */
  it("locks nothing when both are filled, and reports which one wins", () => {
    const state = resolveExclusiveGroups(FIELDS, {
      apiToken: "tok",
      oauthClientId: "PDABC12",
    });
    expect(state.ambiguous).toBe(true);
    expect(state.activeGroupId).toBe("token");
    expect(isFieldLocked(tokenField, state)).toBe(false);
    expect(isFieldLocked(oauthField, state)).toBe(false);
  });

  it("has nothing to say about a plugin with no alternatives", () => {
    const state = resolveExclusiveGroups(
      [{ id: "apiKey", configKey: "apiKey" }],
      { apiKey: "k" }
    );
    expect(state.groups).toEqual([]);
    expect(state.activeGroupId).toBeUndefined();
    expect(state.ambiguous).toBe(false);
  });
});
