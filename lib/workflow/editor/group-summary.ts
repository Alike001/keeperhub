/**
 * What a collapsed config group should say about itself.
 *
 * A group collapses to one line, so the values inside it are out of sight and
 * stay that way - somebody reopening a node sees "Delivery" and cannot tell
 * whether it holds a carefully tuned backup channel or nothing at all. The
 * usual outcome is opening every group in turn to find out, and the worse one
 * is not opening them and missing a setting that is doing something.
 *
 * "Filled in" here means somebody chose it, not merely that the field has a
 * value: a group whose fields all sit at their declared defaults is the same
 * group as an untouched one, and counting those would put a badge on every
 * group on every node and say nothing.
 */

import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import {
  type ActionConfigFieldBase,
  isDisplayOnlyField,
} from "@/plugins/registry";

/** The stored value, as the form would have written it. */
function storedValue(config: Record<string, unknown>, key: string): unknown {
  return config[key];
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

/**
 * Whether this field carries a choice somebody made.
 *
 * A value equal to the field's own `defaultValue` does not, and the
 * comparison is done as strings because a select writes "true" where a
 * default may be declared as `true` - the form stores what the control
 * produced, not what the plugin declared.
 */
export function fieldIsSet(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>
): boolean {
  if (isDisplayOnlyField(field.type)) {
    return false;
  }
  // A field the form is not showing is not something somebody filled in, even
  // when a stored value survives from before its condition stopped holding.
  if (!evaluateShowWhen(field.showWhen, config)) {
    return false;
  }
  const value = storedValue(config, field.key);
  if (isEmpty(value)) {
    return false;
  }
  if (field.defaultValue !== undefined) {
    return String(value) !== String(field.defaultValue);
  }
  return true;
}

/**
 * How many fields in this group somebody has set, and their labels.
 *
 * The labels are for the collapsed group's tooltip: a count answers "is there
 * anything in here", and the names answer "is it the thing I am looking for"
 * without opening it.
 */
export function summariseGroup(
  fields: readonly ActionConfigFieldBase[],
  config: Record<string, unknown>
): { count: number; labels: string[] } {
  const labels: string[] = [];
  for (const field of fields) {
    if (fieldIsSet(field, config)) {
      labels.push(field.label);
    }
  }
  return { count: labels.length, labels };
}
