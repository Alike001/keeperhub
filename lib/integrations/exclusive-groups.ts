/**
 * Alternative credentials on one connection form.
 *
 * Some services take either of two credentials and never both. PagerDuty is
 * the first here: a REST API token, or a scoped OAuth app's client id, secret
 * and subdomain. A form that simply lists all four reads as though it wants
 * all four, and the run time quietly prefers the token when both are present -
 * so somebody who filled in the OAuth app as well would never learn it was
 * ignored.
 *
 * A plugin marks each alternative with `exclusiveGroup`, and this decides
 * which one is in use and which the form should hold shut. It is kept pure and
 * out of the overlays so the rule is one thing rather than a copy in the add
 * form and another in the edit form.
 */

export type ExclusiveField = {
  id: string;
  configKey: string;
  exclusiveGroup?: string;
  exclusiveGroupLabel?: string;
};

export type ExclusiveGroup = {
  id: string;
  label: string;
  /** The field that opens the group, so the form knows where to put its heading. */
  firstFieldId: string;
  configKeys: string[];
  filled: boolean;
};

export type ExclusiveGroupState = {
  groups: ExclusiveGroup[];
  /**
   * The group the run time will actually use: the only one filled in, or the
   * first filled one when somebody has filled in more than one.
   */
  activeGroupId?: string;
  /** True when more than one is filled, which the form should say out loud. */
  ambiguous: boolean;
};

function hasValue(value: unknown): boolean {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null && value !== false;
}

/**
 * Resolve which alternative is in use.
 *
 * `unknownKeys` are keys whose value the caller cannot see. The edit form is
 * the case: credential values are never sent to the browser, so a stored API
 * token reads as blank there. Without this, typing an OAuth client id on a
 * connection that already holds a token made the OAuth group the only filled
 * one - the form then announced the scoped app as in use and held the token
 * field shut, while at run time `resolveAuthHeader` still preferred the token
 * and authorised every call with it. The screen said the opposite of what
 * would happen, and "Use this instead" could not correct it, because an empty
 * value is stripped before the update and never clears a stored secret.
 *
 * A group holding an unknown key is therefore treated as possibly filled,
 * which makes the state ambiguous and locks nothing.
 */
export function resolveExclusiveGroups(
  fields: readonly ExclusiveField[],
  config: Record<string, unknown>,
  unknownKeys: ReadonlySet<string> = new Set()
): ExclusiveGroupState {
  const groups: ExclusiveGroup[] = [];

  for (const field of fields) {
    if (!field.exclusiveGroup) {
      continue;
    }
    const existing = groups.find((group) => group.id === field.exclusiveGroup);
    if (existing) {
      existing.configKeys.push(field.configKey);
      continue;
    }
    groups.push({
      id: field.exclusiveGroup,
      label: field.exclusiveGroupLabel ?? field.exclusiveGroup,
      firstFieldId: field.id,
      configKeys: [field.configKey],
      filled: false,
    });
  }

  let anyUnknown = false;
  for (const group of groups) {
    const unknown = group.configKeys.some((key) => unknownKeys.has(key));
    anyUnknown = anyUnknown || unknown;
    group.filled =
      unknown || group.configKeys.some((key) => hasValue(config[key]));
  }

  const filled = groups.filter((group) => group.filled);
  if (anyUnknown) {
    // Nothing can be locked and nothing can be declared in use, because the
    // values that would decide it are not here.
    return { groups, activeGroupId: undefined, ambiguous: false };
  }
  return {
    groups,
    // Field order is the precedence the run time applies, so the first filled
    // group is the one that wins. Saying which is the point of reporting it.
    activeGroupId: filled[0]?.id,
    ambiguous: filled.length > 1,
  };
}

/**
 * Whether this field should be held shut: another alternative is in use, and
 * filling this one in as well would do nothing.
 *
 * Nothing is held shut while more than one group is filled. That state is
 * somebody's existing connection, or a form somebody is halfway through
 * rearranging, and locking fields there would leave them unable to empty the
 * one being ignored.
 */
export function isFieldLocked(
  field: ExclusiveField,
  state: ExclusiveGroupState
): boolean {
  if (!(field.exclusiveGroup && state.activeGroupId) || state.ambiguous) {
    return false;
  }
  return field.exclusiveGroup !== state.activeGroupId;
}
