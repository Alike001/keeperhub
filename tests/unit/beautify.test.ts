import { describe, expect, it } from "vitest";
import {
  beautifyJavaScript,
  beautifyJson,
  beautifySource,
  canBeautifyLanguage,
  describeBeautifyTarget,
} from "@/lib/utils/beautify";

function expectOk(outcome: { ok: boolean }): asserts outcome is {
  ok: true;
  value: string;
} {
  expect(outcome.ok).toBe(true);
}

describe("beautifyJson", () => {
  it("indents a minified object", () => {
    const outcome = beautifyJson('{"a":1,"b":[2,3]}');
    expectOk(outcome);
    expect(outcome.value).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it("keeps a template that sits inside a string", () => {
    const outcome = beautifyJson(
      '{"Authorization":"Bearer {{Set constants.result.KH_API_KEY}}"}'
    );
    expectOk(outcome);
    expect(outcome.value).toBe(
      '{\n  "Authorization": "Bearer {{Set constants.result.KH_API_KEY}}"\n}'
    );
  });

  it("keeps a template used as a bare value unquoted", () => {
    const outcome = beautifyJson('{"items":{{Fetch.data}},"n":1}');
    expectOk(outcome);
    expect(outcome.value).toBe('{\n  "items": {{Fetch.data}},\n  "n": 1\n}');
  });

  it("handles a document that is only a template", () => {
    const outcome = beautifyJson("{{Fetch.headers}}");
    expectOk(outcome);
    expect(outcome.value).toBe("{{Fetch.headers}}");
  });

  it("preserves the stored node-id template form", () => {
    const source = '{"k":"{{@diPCc:Set constants.result.KH_BASE_URL}}"}';
    const outcome = beautifyJson(source);
    expectOk(outcome);
    expect(outcome.value).toContain(
      "{{@diPCc:Set constants.result.KH_BASE_URL}}"
    );
  });

  it("does not corrupt a value that already contains the placeholder text", () => {
    const outcome = beautifyJson('{"note":"__KH_TPL_0__","v":{{A.b}}}');
    expectOk(outcome);
    expect(outcome.value).toContain('"note": "__KH_TPL_0__"');
    expect(outcome.value).toContain('"v": {{A.b}}');
  });

  it("leaves regex-special characters in a template intact", () => {
    const outcome = beautifyJson('{"a":"{{Node.$&value}}"}');
    expectOk(outcome);
    expect(outcome.value).toContain("{{Node.$&value}}");
  });

  it("reports invalid JSON instead of silently passing it through", () => {
    const outcome = beautifyJson('{"a":}');
    expect(outcome.ok).toBe(false);
  });

  it("returns blank input unchanged", () => {
    const outcome = beautifyJson("   ");
    expectOk(outcome);
    expect(outcome.value).toBe("   ");
  });

  it("is idempotent", () => {
    const once = beautifyJson('{"a":{{X.y}},"b":"c {{Z.w}}"}');
    expectOk(once);
    const twice = beautifyJson(once.value);
    expectOk(twice);
    expect(twice.value).toBe(once.value);
  });
});

describe("beautifyJavaScript", () => {
  it("reprints a collapsed statement list", async () => {
    const outcome = await beautifyJavaScript("const a=1;const b=2;");
    expectOk(outcome);
    expect(outcome.value).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("keeps a template in expression position", async () => {
    const outcome = await beautifyJavaScript(
      "const C={{Set constants.result}};return C.KH_API_KEY;"
    );
    expectOk(outcome);
    expect(outcome.value).toContain("const C = {{Set constants.result}};");
  });

  it("keeps a template inside a string literal", async () => {
    const outcome = await beautifyJavaScript(
      "const u='https://x/{{Setup.result.id}}/logs';"
    );
    expectOk(outcome);
    expect(outcome.value).toContain("{{Setup.result.id}}");
  });

  it("reports a syntax error rather than mangling the source", async () => {
    const outcome = await beautifyJavaScript("const = ;;;");
    expect(outcome.ok).toBe(false);
  });
});

describe("canBeautifyLanguage", () => {
  it("covers the formattable languages", () => {
    expect(canBeautifyLanguage("json")).toBe(true);
    expect(canBeautifyLanguage("JSON")).toBe(true);
    expect(canBeautifyLanguage("javascript")).toBe(true);
    expect(canBeautifyLanguage("typescript")).toBe(true);
  });

  it("excludes languages with no formatter behind them", () => {
    expect(canBeautifyLanguage("sql")).toBe(false);
    expect(canBeautifyLanguage("plaintext")).toBe(false);
  });
});

describe("beautifySource", () => {
  it("routes json through the json formatter", async () => {
    const outcome = await beautifySource('{"a":1}', "json");
    expectOk(outcome);
    expect(outcome.value).toBe('{\n  "a": 1\n}');
  });

  it("refuses a language it cannot format", async () => {
    const outcome = await beautifySource("select 1", "sql");
    expect(outcome.ok).toBe(false);
  });
});

describe("describeBeautifyTarget", () => {
  it("names JSON and the indent", () => {
    expect(describeBeautifyTarget("json")).toContain("JSON");
    expect(describeBeautifyTarget("json")).toContain("2-space");
  });

  it("names JavaScript for the code fields", () => {
    expect(describeBeautifyTarget("javascript")).toContain("JavaScript");
  });

  it("says so when no formatter applies", () => {
    expect(describeBeautifyTarget("sql")).toContain("No formatter");
  });
});

// Formatting must be a whitespace-only change. An earlier cut round-tripped
// through JSON.parse/JSON.stringify, which turned a wei-scale integer into a
// double and handed back a different number - a silent corruption triggered by
// a button whose whole promise is that it only reindents.
describe("beautifyJson preserves literals exactly", () => {
  it("keeps a wei-scale integer", () => {
    const outcome = beautifyJson('{"amount":12345678901234567890}');
    expectOk(outcome);
    expect(outcome.value).toContain("12345678901234567890");
  });

  it("keeps a uint256 without switching to exponent notation", () => {
    const max =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const outcome = beautifyJson(`{"v":${max}}`);
    expectOk(outcome);
    expect(outcome.value).toContain(max);
    expect(outcome.value).not.toContain("e+");
  });

  it("does not rewrite 1.0 or 1e3", () => {
    const outcome = beautifyJson('{"a":1.0,"b":1e3}');
    expectOk(outcome);
    expect(outcome.value).toContain("1.0");
    expect(outcome.value).toContain("1e3");
  });

  it("keeps string escapes as written", () => {
    const outcome = beautifyJson('{"a":"line\\nbreak \\u00e9"}');
    expectOk(outcome);
    expect(outcome.value).toContain('"line\\nbreak \\u00e9"');
  });

  it("keeps both of a duplicated key rather than silently dropping one", () => {
    const outcome = beautifyJson('{"a":1,"a":2}');
    expectOk(outcome);
    expect(outcome.value).toContain('"a": 1');
    expect(outcome.value).toContain('"a": 2');
  });

  it("expands a minified object rather than leaving it on one line", () => {
    const outcome = beautifyJson('{"a":1}');
    expectOk(outcome);
    expect(outcome.value).toBe('{\n  "a": 1\n}');
  });

  it("keeps empty containers compact", () => {
    const outcome = beautifyJson('{"a":{},"b":[]}');
    expectOk(outcome);
    expect(outcome.value).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  it("does not pollute Object.prototype via a __proto__ key", () => {
    const outcome = beautifyJson('{"__proto__":{"polluted":true}}');
    expectOk(outcome);
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
  });
});
