import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import pagerDutyPlugin from "@/plugins/pagerduty";
import { flattenConfigFields, isDisplayOnlyField } from "@/plugins/registry";

/**
 * What an AI-generated PagerDuty node is seeded with.
 *
 * `generateAIActionPrompts` builds one example config per action and puts it
 * in the workflow-generation system prompt, preferring `example`, then
 * `defaultValue`, then a type default. That makes `example` a behavioural
 * setting for every generated node, not documentation - so a field whose
 * example differs from its real default silently changes what those nodes do.
 *
 * This mirrors that resolution rather than calling it, because the real one
 * walks every registered plugin and needs the whole registry loaded.
 */
function seededConfig(slug: string): Record<string, unknown> {
  const action = pagerDutyPlugin.actions.find((one) => one.slug === slug);
  if (!action) {
    throw new Error(`no action ${slug}`);
  }
  const config: Record<string, unknown> = {};
  for (const field of flattenConfigFields(action.configFields ?? [])) {
    if (isDisplayOnlyField(field.type)) {
      continue;
    }
    if (field.example !== undefined) {
      config[field.key] = field.example;
    } else if (field.defaultValue !== undefined) {
      config[field.key] = field.defaultValue;
    } else if (field.type === "number") {
      config[field.key] = 10;
    } else if (field.type === "select" && field.options?.[0]) {
      config[field.key] = field.options[0].value;
    } else {
      config[field.key] = `Your ${field.label.toLowerCase()}`;
    }
  }
  return config;
}

describe("what an AI-generated PagerDuty node carries", () => {
  /**
   * The field that decides whether the node pages at all on the first
   * failure. An `example` of 2 here had every generated node sit out the
   * first failure - on an hourly check, an hour of silence nobody asked for.
   * Blank resolves to 1, which is "page now"; dropping it entirely would be
   * worse, since a number field with neither example nor default seeds 10.
   */
  it("does not seed a consecutive-runs threshold", () => {
    expect(seededConfig("trigger-incident").consecutiveRuns).toBe("");
  });

  /** Same shape: the documented default is 0, so an example of 2 is a change. */
  it.each(["resolve-incident", "acknowledge-incident"])(
    "does not seed a send delay on %s",
    (slug) => {
      expect(seededConfig(slug).sendDelaySeconds).toBe("");
    }
  );

  /**
   * A `fail-on-error-switch` with no declared default fell through to the
   * string branch and seeded the field's own label as its value. It happened
   * to be truthy, so it behaved correctly by accident; web3 declares "true".
   */
  it.each([
    "trigger-incident",
    "resolve-incident",
    "acknowledge-incident",
    "send-change-event",
    "create-incident",
  ])("seeds failOnError as a boolean string on %s", (slug) => {
    expect(seededConfig(slug).failOnError).toBe("true");
  });

  /**
   * The preview panel and the test button render; they collect nothing. Left
   * in, the prompt told the model to emit `"pagerdutyPreview":"Your preview"`
   * in every generated node, and the MCP pin schema offered them as settable
   * properties under `additionalProperties: false`.
   */
  it("carries no key for a field that only renders", () => {
    for (const action of pagerDutyPlugin.actions) {
      const config = seededConfig(action.slug);
      expect(Object.keys(config)).not.toContain("pagerdutyPreview");
      expect(Object.keys(config)).not.toContain("pagerdutyTestNode");
      expect(Object.keys(config)).not.toContain("pagerdutyFromEmailNotice");
    }
  });

  /**
   * Every value the model is handed has to be one the step would accept. A
   * seeded value that the runtime rejects is a generated workflow that fails
   * on its first run.
   */
  it("seeds nothing that its own field would reject", () => {
    const trigger = seededConfig("trigger-incident");
    expect(["critical", "error", "warning", "info"]).toContain(
      trigger.severity
    );
    expect(["true", "false"]).toContain(trigger.treatMaintenanceAsUndelivered);
    expect(["true", "false"]).toContain(
      seededConfig("resolve-incident").verifyWithPagerDuty
    );
    expect(["service-default", "high", "low"]).toContain(
      seededConfig("create-incident").urgency
    );
  });
});
