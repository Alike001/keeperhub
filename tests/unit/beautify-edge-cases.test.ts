// Config fields carry upstream references in every position a user can put
// them, and the masking has to survive all of them. Each case here was run
// against the real implementation first; they are pinned so a change to the
// scanner cannot quietly start eating someone's field.
//
// The invariant under test is the same throughout: the set of `{{...}}` runs
// in the output equals the set in the input, in order, byte for byte.

import { describe, expect, it } from "vitest";

import { beautifyJavaScript, beautifyJson } from "@/lib/utils/beautify";

const REFERENCE = /\{\{[^}]*\}\}/g;

function referencesIn(text: string): string[] {
  return text.match(REFERENCE) ?? [];
}

function expectValue(outcome: {
  ok: boolean;
  value?: string;
  error?: string;
}): string {
  expect(outcome.error ?? null).toBeNull();
  expect(outcome.ok).toBe(true);
  return outcome.value as string;
}

const JSON_CASES: [name: string, source: string][] = [
  ["reference inside a string", '{"a":"Bearer {{A.k}}"}'],
  ["reference is the whole string", '{"a":"{{A.k}}"}'],
  ["reference in value position", '{"a":{{A.k}}}'],
  ["two references in one string", '{"a":"{{A.x}}/{{A.y}}"}'],
  ["adjacent references", '{"a":"{{A.x}}{{A.y}}"}'],
  ["reference inside a key", '{"pre{{A.k}}":1}'],
  ["stored node-id form, quoted", '{"a":"{{@n1:Read Hat.result}}"}'],
  ["stored node-id form, bare", '{"a":{{@n1:Read Hat.result}}}'],
  ["references in an array", '[{{A.x}},1,"{{A.y}}"]'],
  ["the whole document is a reference", "{{A.all}}"],
  ["regex metacharacters in a reference", '{"a":"{{A.$&b}}"}'],
  ["escaped quotes around a reference", '{"a":"x\\"{{A.k}}\\"y"}'],
  ["escaped backslash before a reference", '{"a":"x\\\\","b":{{A.k}}}'],
  ["unicode escape beside a reference", '{"a":"\\u00e9 {{A.k}}"}'],
  ["escaped braces are not a reference", '{"re":"^\\\\{\\\\{x"}'],
  ["prose braces round-trip unchanged", '{"note":"use {{ and }} carefully"}'],
  [
    "the same reference several times",
    '{"a":{{X.y}},"b":{{X.y}},"c":"{{X.y}}"}',
  ],
  ["placeholder text already in the data", '{"a":"__KH_TPL_0__","b":{{X.y}}}'],
  ["a wider placeholder collision", '{"a":"___KH_TPL_0__","b":{{X.y}}}'],
  ["deep nesting", '{"a":{"b":{"c":[{"d":{{A.k}}}]}}}'],
];

describe("beautifyJson keeps every reference byte for byte", () => {
  it.each(JSON_CASES)("%s", (_name, source) => {
    const value = expectValue(beautifyJson(source));
    expect(referencesIn(value)).toEqual(referencesIn(source));
  });

  it.each(JSON_CASES)("%s is idempotent", (_name, source) => {
    const once = expectValue(beautifyJson(source));
    expect(expectValue(beautifyJson(once))).toBe(once);
  });
});

describe("beautifyJson accepts the shapes a config field really holds", () => {
  it("normalises CRLF and stray outer whitespace", () => {
    expect(expectValue(beautifyJson('  {\r\n"a":1\r\n}  '))).toBe(
      '{\n  "a": 1\n}'
    );
  });

  it("keeps every numeric spelling", () => {
    const value = expectValue(
      beautifyJson('{"a":-0,"b":1E+5,"c":0.0,"d":1e-7}')
    );
    expect(value).toContain("-0");
    expect(value).toContain("1E+5");
    expect(value).toContain("0.0");
    expect(value).toContain("1e-7");
  });

  it("survives sixty levels of nesting without recursing", () => {
    const deep = `${"[".repeat(60)}1${"]".repeat(60)}`;
    expect(expectValue(beautifyJson(deep))).toContain("1");
  });

  it("leaves an unterminated reference alone", () => {
    const value = expectValue(beautifyJson('{"a":"{{A.k"}'));
    expect(value).toContain('"{{A.k"');
  });
});

const JS_CASES: [name: string, source: string][] = [
  ["expression position", "const C={{A.result}};"],
  ["inside a single-quoted string", "const u='x/{{A.id}}/y';"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate test data - a JS template literal the masking must leave alone
  ["inside a template literal", "const u=`x/{{A.id}}/${n}`;"],
  ["inside a line comment", "// see {{A.id}}\nconst a=1;"],
  ["inside a block comment", "/* {{A.id}} */ const a=1;"],
  ["as an object value", "const o={k:{{A.v}},j:2};"],
  ["as an object key", "const o={ {{A.k}}: 1 };"],
  ["as a call argument", "f({{A.v}}, 2);"],
  ["with member access", "const x={{A.v}}.field;"],
  ["with optional chaining", "const v={{A.k}}?.x;"],
  ["inside a regex literal", "const re=/{{A.k}}/;"],
  ["two references", "const a={{A.x}}+{{A.y}};"],
  ["stored node-id form", "const C={{@n1:Set constants.result}};"],
  [
    "placeholder text already in the code",
    "const __KH_TPL_0__=1;const C={{A.k}};",
  ],
];

describe("beautifyJavaScript keeps every reference byte for byte", () => {
  it.each(JS_CASES)("%s", async (_name, source) => {
    const value = expectValue(await beautifyJavaScript(source));
    expect(referencesIn(value)).toEqual(referencesIn(source));
  });

  it.each(JS_CASES)("%s is idempotent", async (_name, source) => {
    const once = expectValue(await beautifyJavaScript(source));
    expect(expectValue(await beautifyJavaScript(once))).toBe(once);
  });
});

describe("beautifyJavaScript accepts a code node's own dialect", () => {
  it("allows a top-level return", async () => {
    expect(expectValue(await beautifyJavaScript("return {ids:[1,2]};"))).toBe(
      "return { ids: [1, 2] };\n"
    );
  });

  it("allows a top-level await", async () => {
    const value = expectValue(
      await beautifyJavaScript("const r=await fetch(u);return r;")
    );
    expect(value).toContain("await fetch(u)");
  });

  it("leaves blank input alone", async () => {
    expect(expectValue(await beautifyJavaScript("   \n  "))).toBe("   \n  ");
  });
});
