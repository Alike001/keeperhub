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
 * `unknownKeys` are keys whose value the caller cannot see - a form that is
 * never sent the credential it is editing. A group holding one is treated as
 * possibly filled: it locks nothing and names nothing as in use, while still
 * reporting the state as ambiguous when more than one group holds something.
 * Naming a group in use on a guess would contradict the run time, which
 * resolves the same question from the values.
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
    // values that would decide it are not here. `ambiguous` is still reported
    // though: it says only that more than one group holds something, which is
    // exactly what an unknown key establishes, and it drives the one warning
    // that does not need to know which group wins.
    return { groups, activeGroupId: undefined, ambiguous: filled.length > 1 };
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
