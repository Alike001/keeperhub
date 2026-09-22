// The Beautify action on a textarea field is opt-in per field, because
// `template-textarea` carries both JSON and prose: a webhook payload and a
// Discord message are the same field type. Marking the wrong one gives the
// user a control that can only ever report a parse error on their message
// body, so these tests pin both directions - what must be marked, and what
// must never be.

import { describe, expect, it } from "vitest";

import { beautifyJson } from "@/lib/utils/beautify";
import {
  type ActionConfigFieldBase,
  flattenConfigFields,
  getAllIntegrations,
} from "@/plugins/registry";

type FoundField = {
  plugin: string;
  actionType: string;
  field: ActionConfigFieldBase;
};

function allConfigFields(): FoundField[] {
  const found: FoundField[] = [];
  for (const plugin of getAllIntegrations()) {
    for (const action of plugin.actions) {
      for (const field of flattenConfigFields(action.configFields ?? [])) {
        found.push({
          plugin: plugin.type,
          actionType: `${plugin.type}/${action.slug}`,
          field,
        });
      }
    }
  }
  return found;
}

/** Fields whose value is prose or a line-oriented format, never JSON. */
const NEVER_JSON = new Set([
  "discordMessage",
  "slackMessage",
  "message",
  "emailBody",
  "system",
  "details",
  "links",
  "paths",
  "explicitValues",
]);

/**
 * Fields whose value is always JSON and should offer the action.
 *
 * Clerk's publicMetadata and privateMetadata are marked in the source too, but
 * clerk is absent from plugins/plugin-allowlist.json so it never registers -
 * asserting on it here would pin a plugin this deployment does not load.
 */
const ALWAYS_JSON = [
  "webhookHeaders",
  "webhookPayload",
  "customDetails",
  "payouts",
  "sources",
];

describe("format: json marking", () => {
  it("is only ever set on template-textarea fields", () => {
    const wrong = allConfigFields()
      .filter(({ field }) => field.format === "json")
      .filter(({ field }) => field.type !== "template-textarea")
      .map(({ actionType, field }) => `${actionType}.${field.key}`);

    expect(wrong).toEqual([]);
  });

  it("is never set on a prose or line-oriented field", () => {
    const wrong = allConfigFields()
      .filter(({ field }) => field.format === "json")
      .filter(({ field }) => NEVER_JSON.has(field.key))
      .map(({ actionType, field }) => `${actionType}.${field.key}`);

    expect(wrong).toEqual([]);
  });

  it.each(ALWAYS_JSON)("marks %s", (key) => {
    const matches = allConfigFields().filter(({ field }) => field.key === key);
    expect(matches.length).toBeGreaterThan(0);
    for (const { actionType, field } of matches) {
      expect(
        field.format,
        `${actionType}.${field.key} should be marked format: "json"`
      ).toBe("json");
    }
  });
});

describe("the marked fields' own placeholders format cleanly", () => {
  it("formats a webhook payload with a template in value position", () => {
    const outcome = beautifyJson('{"key": "value", "data": {{Node.field}}}');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toBe(
        '{\n  "key": "value",\n  "data": {{Node.field}}\n}'
      );
    }
  });

  it("formats a tempo payouts array", () => {
    const outcome = beautifyJson(
      '[{"recipient":"0xabc","amount":"100.50","memo":"INV-1042"}]'
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toContain('\n    "recipient": "0xabc"');
    }
  });

  it("formats a flatten-findings sources array holding templates", () => {
    const outcome = beautifyJson(
      '[{"label":"File changed","value":{{File Events.result}}}]'
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toContain('"value": {{File Events.result}}');
    }
  });

  it("formats an ABI that arrived as one line", () => {
    const outcome = beautifyJson(
      '[{"inputs":[],"name":"hat","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"}]'
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.split("\n").length).toBeGreaterThan(5);
    }
  });
});
