/**
 * Formatting helpers for the Monaco-backed config editors.
 *
 * Config values are not plain JSON or plain JavaScript: they carry template
 * references such as `{{Read Hat.result}}`, which a JSON parser or a JS parser
 * would both reject. Every entry point here therefore masks templates into
 * inert placeholders, formats the masked source, then puts the original
 * template text back verbatim.
 *
 * The editors show templates in their display form (`{{Label.field}}`) rather
 * than the stored form (`{{@nodeId:Label.field}}`), so these functions operate
 * on whichever form they are given and preserve it byte for byte - callers can
 * round-trip the result through the editor's normal display-to-stored mapping.
 */

const TEMPLATE_OPEN = "{{";
const TEMPLATE_CLOSE = "}}";
const PLACEHOLDER_STEM = "KH_TPL_";
const MIN_PLACEHOLDER_UNDERSCORES = 2;
/**
 * Two spaces, matching the repository's own sources and the `tabSize` the
 * Monaco options already set, so a formatted field looks like what pressing
 * Tab in the same editor produces.
 */
const INDENT_WIDTH = 2;

export type BeautifyOutcome =
  | { ok: true; value: string }
  | { ok: false; error: string };

type MaskResult = {
  masked: string;
  templates: string[];
  /**
   * Per template, whether the placeholder we substituted supplied its own
   * quotes. Restoring cannot infer this from the formatted text: a template
   * that filled a user's string entirely (`"{{A.b}}"`) and one that stood in
   * value position (`{"n": {{A.b}}}`) both read back as a quoted placeholder,
   * and stripping the quotes off the first would turn a string into a bare
   * reference.
   */
  quoted: boolean[];
  prefix: string;
};

/**
 * Build a placeholder prefix that does not already occur in the source, so a
 * value that legitimately contains `__KH_TPL_0__` cannot be corrupted when the
 * placeholders are swapped back out.
 */
function resolvePrefix(source: string): string {
  // One scan for every `KH_TPL_` already in the field, taking the longest run
  // of underscores in front of any of them: one more than that cannot occur.
  // Escalating by re-scanning the whole source per attempt was quadratic, and
  // a pasted blob of underscores could hold the UI thread for a second.
  let longestRun = 1;
  for (const match of source.matchAll(/_*KH_TPL_/g)) {
    const run = match[0].length - PLACEHOLDER_STEM.length;
    if (run >= longestRun) {
      longestRun = run + 1;
    }
  }
  return `${"_".repeat(Math.max(MIN_PLACEHOLDER_UNDERSCORES, longestRun))}${PLACEHOLDER_STEM}`;
}

function placeholderAt(prefix: string, index: number): string {
  return `${prefix}${index}__`;
}

/**
 * The index just past a well-formed reference starting at `index`, or -1.
 *
 * A reference's body is a label and a field path: `Label.field` or
 * `@nodeId:Label.field`. It carries no brace, no quote and no line break, and
 * the resolver's own `\{\{([^}]+)\}\}` already forbids `}`. Bounding the
 * search on all four is what keeps a stray `{{` in prose - a comment about
 * another templating syntax, an unbalanced brace inside a string - from
 * swallowing everything up to the next unrelated `}}` and silently leaving
 * that whole span unformatted. Bounding on `{` alone was not enough: a gap
 * with no brace in it, `"{{ oops", "b": "x}}y"`, still swallowed.
 */
function referenceEndAt(source: string, index: number): number {
  if (!source.startsWith(TEMPLATE_OPEN, index)) {
    return -1;
  }
  let cursor = index + TEMPLATE_OPEN.length;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "{" || char === '"' || char === "\n" || char === "\r") {
      return -1;
    }
    if (char === "}") {
      return source[cursor + 1] === "}" ? cursor + TEMPLATE_CLOSE.length : -1;
    }
    cursor += 1;
  }
  return -1;
}

/**
 * Mask templates for JavaScript.
 *
 * A bare identifier is valid everywhere a template can appear in JS - in
 * expression position (`const c = {{Setup.result}}`), inside a string literal,
 * inside a comment - so no string tracking is needed here. What a reference IS
 * still has to be bounded, which `referenceEndAt` does.
 */
function maskJavaScript(source: string): MaskResult {
  const prefix = resolvePrefix(source);
  const templates: string[] = [];
  const quoted: boolean[] = [];
  let masked = "";
  let index = 0;

  while (index < source.length) {
    const jsEnd = referenceEndAt(source, index);
    if (jsEnd !== -1) {
      masked += placeholderAt(prefix, templates.length);
      quoted.push(false);
      templates.push(source.slice(index, jsEnd));
      index = jsEnd;
      continue;
    }
    masked += source[index];
    index += 1;
  }

  return { masked, quoted, templates, prefix };
}

/**
 * Mask templates for JSON.
 *
 * Position matters here. A template inside a string (`"Bearer {{A.key}}"`) is
 * already in a legal spot and only needs its text swapped, but a template in
 * value position (`{"n": {{A.count}}}`) is not valid JSON at all and has to be
 * masked as a quoted string so the document parses. The two cases are told
 * apart by tracking string state, and unmasking reverses each accordingly.
 */
function maskJson(source: string): MaskResult {
  const prefix = resolvePrefix(source);
  const templates: string[] = [];
  const quoted: boolean[] = [];
  let masked = "";
  let index = 0;
  let inString = false;

  while (index < source.length) {
    const char = source[index];

    if (inString) {
      if (char === "\\") {
        masked += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
        masked += char;
        index += 1;
        continue;
      }
    } else if (char === '"') {
      inString = true;
      masked += char;
      index += 1;
      continue;
    }

    const jsonEnd = referenceEndAt(source, index);
    if (jsonEnd !== -1) {
      const placeholder = placeholderAt(prefix, templates.length);
      masked += inString ? placeholder : `"${placeholder}"`;
      quoted.push(!inString);
      templates.push(source.slice(index, jsonEnd));
      index = jsonEnd;
      continue;
    }

    masked += char;
    index += 1;
  }

  return { masked, quoted, templates, prefix };
}

/**
 * Swap placeholders back for their original template text.
 *
 * Whether a quoted placeholder gives its quotes back is decided by the mask,
 * not by the formatted text, because the two cases are indistinguishable
 * there. A replacer function is used rather than a replacement string so that
 * `$&` and friends inside a template stay literal.
 */
function restoreTemplates(formatted: string, mask: MaskResult): string {
  if (mask.templates.length === 0) {
    return formatted;
  }
  const prefix = mask.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // One pass keeps this linear in the field's size: replacing each placeholder
  // in turn walked the whole document once per template, which on a field
  // carrying thousands of references stalled the tab for seconds.
  const pattern = new RegExp(`"${prefix}(\\d+)__"|${prefix}(\\d+)__`, "g");
  return formatted.replace(pattern, (match, quotedHit, bare) => {
    const index = Number(quotedHit ?? bare);
    const template = mask.templates[index];
    if (template === undefined) {
      return match;
    }
    if (quotedHit === undefined) {
      return template;
    }
    // The quotes around this one are ours only if we added them.
    return mask.quoted[index] ? template : `"${template}"`;
  });
}

/**
 * The first line only. Prettier attaches a code frame to a syntax error, which
 * would put a slice of the user's own field - a key, a token, whatever sat on
 * that line - into a toast, and show it in its masked form with our
 * placeholders where their references were.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return (
      error.message.split("\n")[0].trim() || "Could not format this value."
    );
  }
  return "Could not format this value.";
}

const JSON_STRUCTURAL = new Set(["{", "}", "[", "]", ",", ":"]);

/**
 * Split JSON into structural characters and verbatim literals.
 *
 * Literals are carried as the exact source text, never as parsed values. That
 * is the whole point: `JSON.parse` turns `12345678901234567890` into a double
 * and hands back `12345678901234567000`, which would silently corrupt a wei
 * amount the moment someone pressed Beautify. A formatter must change
 * whitespace and nothing else.
 */
function tokenizeJson(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (JSON_STRUCTURAL.has(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }

    // A number, true, false or null: copied exactly as written.
    let end = index;
    while (end < source.length) {
      const next = source[end];
      if (
        JSON_STRUCTURAL.has(next) ||
        next === " " ||
        next === "\t" ||
        next === "\n" ||
        next === "\r"
      ) {
        break;
      }
      end += 1;
    }
    tokens.push(source.slice(index, end));
    index = end;
  }

  return tokens;
}

function indentOf(depth: number): string {
  return " ".repeat(depth * INDENT_WIDTH);
}

/** Re-emit the token stream one value per line. */
function printJsonTokens(tokens: string[]): string {
  let out = "";
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (token === "{" || token === "[") {
      const closer = token === "{" ? "}" : "]";
      if (next === closer) {
        out += token + closer;
        i += 1;
        continue;
      }
      depth += 1;
      out += `${token}\n${indentOf(depth)}`;
      continue;
    }

    if (token === "}" || token === "]") {
      depth -= 1;
      out += `\n${indentOf(depth)}${token}`;
      continue;
    }

    if (token === ",") {
      out += `,\n${indentOf(depth)}`;
      continue;
    }

    if (token === ":") {
      out += ": ";
      continue;
    }

    out += token;
  }

  return out;
}

/**
 * Re-indent JSON with two spaces, preserving templates and every literal.
 *
 * `JSON.parse` runs for validation only and its result is discarded: a field
 * that cannot be formatted is a field that will not parse at execution time
 * either, so the caller gets a message worth surfacing rather than a silent
 * no-op. The output is built from the source text instead, so numbers, string
 * escapes and duplicate keys come through exactly as the user wrote them.
 */
export function beautifyJson(source: string): BeautifyOutcome {
  if (source.trim() === "") {
    return { ok: true, value: source };
  }

  const mask = maskJson(source);

  try {
    JSON.parse(mask.masked);
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  const formatted = printJsonTokens(tokenizeJson(mask.masked));
  return { ok: true, value: restoreTemplates(formatted, mask) };
}

/**
 * Re-print JavaScript with Prettier, preserving templates.
 *
 * Prettier is imported on demand so its parser and printer stay out of the
 * editor bundle until someone actually presses the button.
 */
export async function beautifyJavaScript(
  source: string
): Promise<BeautifyOutcome> {
  if (source.trim() === "") {
    return { ok: true, value: source };
  }

  const mask = maskJavaScript(source);

  try {
    const [standalone, babel, estree] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);

    const formatted = await standalone.format(mask.masked, {
      // babel-ts is a superset of babel, so a field declared as typescript
      // formats rather than failing on its first annotation.
      parser: "babel-ts",
      plugins: [babel, estree],
      semi: true,
      singleQuote: true,
      tabWidth: INDENT_WIDTH,
      // A placeholder is a valid identifier, so the default "as-needed" would
      // unquote an object key that is nothing but a reference - putting back
      // `{ {{A.k}}: 1 }` where the user wrote `{ "{{A.k}}": 1 }`. That is the
      // same class of change as stripping a reference's quotes in JSON.
      quoteProps: "preserve",
    });

    return { ok: true, value: restoreTemplates(formatted, mask) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

const JSON_LANGUAGES = new Set(["json", "jsonc"]);
const JAVASCRIPT_LANGUAGES = new Set(["javascript", "js", "typescript", "ts"]);

/**
 * Languages the button is offered for. SQL and the plain-text variants are
 * deliberately absent - there is no formatter behind them, and a button that
 * does nothing is worse than no button.
 */
export function canBeautifyLanguage(language: string): boolean {
  const normalized = language.toLowerCase();
  return JSON_LANGUAGES.has(normalized) || JAVASCRIPT_LANGUAGES.has(normalized);
}

/**
 * One line naming what the action will produce, for the control's tooltip.
 * Says the target format and the indent, which is the part a user cannot
 * guess from the label alone.
 */
export function describeBeautifyTarget(language: string): string {
  const normalized = language.toLowerCase();
  if (JSON_LANGUAGES.has(normalized)) {
    return `Reformat as JSON, ${INDENT_WIDTH}-space indent. Workflow references are kept as they are.`;
  }
  if (JAVASCRIPT_LANGUAGES.has(normalized)) {
    return `Reformat as JavaScript, ${INDENT_WIDTH}-space indent. Workflow references are kept as they are.`;
  }
  return "No formatter is available for this field.";
}

export function beautifySource(
  source: string,
  language: string
): Promise<BeautifyOutcome> {
  const normalized = language.toLowerCase();
  if (JSON_LANGUAGES.has(normalized)) {
    return Promise.resolve(beautifyJson(source));
  }
  if (JAVASCRIPT_LANGUAGES.has(normalized)) {
    return beautifyJavaScript(source);
  }
  return Promise.resolve({
    ok: false,
    error: `No formatter is available for ${language}.`,
  });
}
