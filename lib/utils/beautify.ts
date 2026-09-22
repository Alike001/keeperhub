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
  let restored = formatted;
  for (let i = 0; i < mask.templates.length; i += 1) {
    const placeholder = placeholderAt(mask.prefix, i);
    const template = mask.templates[i];
    restored = restored.split(`"${placeholder}"`).join(template);
    restored = restored.split(placeholder).join(template);
  }
  return restored;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Could not format this value.";
}

/**
 * Re-indent JSON with two spaces, preserving templates.
 *
 * `JSON.parse` doubles as validation, which is the point: a field that cannot
 * be formatted is a field that will not parse at execution time either, so the
 * caller gets a message worth surfacing rather than a silent no-op.
 */
export function beautifyJson(source: string): BeautifyOutcome {
  if (source.trim() === "") {
    return { ok: true, value: source };
  }

  const mask = maskJson(source);

  try {
    const parsed: unknown = JSON.parse(mask.masked);
    const formatted = JSON.stringify(parsed, null, INDENT_WIDTH);
    return { ok: true, value: restoreTemplates(formatted, mask) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
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
