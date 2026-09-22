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
const BASE_PLACEHOLDER_PREFIX = "__KH_TPL_";
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
  prefix: string;
};

/**
 * Build a placeholder prefix that does not already occur in the source, so a
 * value that legitimately contains `__KH_TPL_0__` cannot be corrupted when the
 * placeholders are swapped back out.
 */
function resolvePrefix(source: string): string {
  let prefix = BASE_PLACEHOLDER_PREFIX;
  while (source.includes(prefix)) {
    prefix = `_${prefix}`;
  }
  return prefix;
}

function placeholderAt(prefix: string, index: number): string {
  return `${prefix}${index}__`;
}

/**
 * Mask templates for JavaScript.
 *
 * A bare identifier is valid everywhere a template can appear in JS - in
 * expression position (`const c = {{Setup.result}}`), inside a string literal,
 * inside a comment - so no string tracking is needed.
 */
function maskJavaScript(source: string): MaskResult {
  const prefix = resolvePrefix(source);
  const templates: string[] = [];
  let masked = "";
  let index = 0;

  while (index < source.length) {
    if (source.startsWith(TEMPLATE_OPEN, index)) {
      const end = source.indexOf(TEMPLATE_CLOSE, index + TEMPLATE_OPEN.length);
      if (end !== -1) {
        masked += placeholderAt(prefix, templates.length);
        templates.push(source.slice(index, end + TEMPLATE_CLOSE.length));
        index = end + TEMPLATE_CLOSE.length;
        continue;
      }
    }
    masked += source[index];
    index += 1;
  }

  return { masked, templates, prefix };
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

    if (source.startsWith(TEMPLATE_OPEN, index)) {
      const end = source.indexOf(TEMPLATE_CLOSE, index + TEMPLATE_OPEN.length);
      if (end !== -1) {
        const placeholder = placeholderAt(prefix, templates.length);
        masked += inString ? placeholder : `"${placeholder}"`;
        templates.push(source.slice(index, end + TEMPLATE_CLOSE.length));
        index = end + TEMPLATE_CLOSE.length;
        continue;
      }
    }

    masked += char;
    index += 1;
  }

  return { masked, templates, prefix };
}

/**
 * Swap placeholders back for their original template text.
 *
 * The quoted form is restored first: a template that was masked into value
 * position comes back out of the formatter still wrapped in quotes, and those
 * quotes were ours, not the user's. `split`/`join` is used rather than
 * `String.replace` so that `$&` and friends inside a template are treated as
 * literal text.
 */
function restoreTemplates(formatted: string, mask: MaskResult): string {
  if (mask.templates.length === 0) {
    return formatted;
  }
  const prefix = mask.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The quoted alternative is first so it wins: a template masked into value
  // position comes back still wrapped in quotes that were ours, not the
  // user's. One pass keeps this linear in the field's size - replacing each
  // placeholder in turn walked the whole document once per template, which on
  // a field carrying thousands of references stalled the tab for seconds.
  const pattern = new RegExp(`"${prefix}(\\d+)__"|${prefix}(\\d+)__`, "g");
  return formatted.replace(pattern, (match, quoted, bare) => {
    const index = Number(quoted ?? bare);
    return mask.templates[index] ?? match;
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
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
      parser: "babel",
      plugins: [babel, estree],
      semi: true,
      singleQuote: true,
      tabWidth: INDENT_WIDTH,
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
