import { ethers } from "ethers";
import { checkSolidityValue } from "@/lib/web3/solidity-values";

/**
 * Turns the user's indexed-argument filter into the topic array
 * eth_getLogs takes, so the node filters at the RPC instead of fetching
 * every occurrence of the event and discarding most of it downstream.
 *
 * Topics are built here rather than through ethers' `contract.filters`
 * helper for two reasons. It refuses a negative value on a signed
 * parameter ("unsigned value cannot be negative") even though the topic is
 * well defined, and its errors name neither the parameter nor the step. A
 * topic for a value type is just that value ABI-encoded into one word, so
 * building it directly costs nothing and keeps both problems out.
 *
 * Every failure here is a configuration error, raised before any RPC call:
 * a filter the chain would silently never match is worse than one that
 * refuses to run.
 */

export type EventArgFilters = Record<string, string>;

export type EventArgFilterResult =
  | { success: true; topics: (string | null)[] | null; applied: string[] }
  | { success: false; error: string };

/** Indexed parameters ethers and eth_getLogs cannot filter on at all. */
function isUnfilterableType(type: string): boolean {
  return type.endsWith("]") || type.startsWith("tuple");
}

/** The parameters of `fragment` a filter may name, in topic order. */
export function indexedParams(
  fragment: ethers.EventFragment
): { name: string; type: string; filterable: boolean }[] {
  return fragment.inputs
    .filter((input) => input.indexed)
    .map((input) => ({
      name: input.name,
      type: input.type,
      filterable: !isUnfilterableType(input.type),
    }));
}

/**
 * The 32-byte topic for one indexed value.
 *
 * A dynamic `string` or `bytes` is stored as the keccak hash of its
 * contents, not the contents, so the filter is exact-equality on the whole
 * value: no substring match, and the original cannot be read back out of
 * the log. Every other type is the value in one ABI word, which is what
 * gives negative signed values their correct two's-complement topic.
 */
function encodeTopic(type: string, value: string): string {
  if (type === "string") {
    return ethers.keccak256(ethers.toUtf8Bytes(value));
  }
  if (type === "bytes") {
    return ethers.keccak256(value);
  }
  return ethers.AbiCoder.defaultAbiCoder().encode([type], [coerce(type, value)]);
}

function coerce(type: string, value: string): unknown {
  if (type === "bool") {
    return value === "true";
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return BigInt(value);
  }
  return value;
}

function parseFilterObject(
  raw: string
): { success: true; filters: EventArgFilters } | { success: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      success: false,
      error:
        "Event argument filter is not valid JSON. Expected an object of indexed parameter names to values.",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      success: false,
      error:
        "Event argument filter must be a JSON object keyed by indexed parameter name.",
    };
  }
  const filters: EventArgFilters = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value === "object") {
      return {
        success: false,
        error: `Filter for '${key}' must be a single value, not an object or array.`,
      };
    }
    filters[key] = String(value);
  }
  return { success: true, filters };
}

/**
 * Build the eth_getLogs topic array for `fragment` from the user's filter.
 *
 * Returns `topics: null` when nothing is being filtered, so the caller can
 * keep its existing unfiltered path rather than sending a topic array that
 * only carries the event signature.
 */
export function buildEventArgTopics(
  raw: string | undefined,
  fragment: ethers.EventFragment
): EventArgFilterResult {
  if (raw === undefined || raw.trim() === "") {
    return { success: true, topics: null, applied: [] };
  }

  const parsed = parseFilterObject(raw);
  if (!parsed.success) {
    return parsed;
  }
  const entries = Object.entries(parsed.filters);
  if (entries.length === 0) {
    return { success: true, topics: null, applied: [] };
  }

  const indexed = indexedParams(fragment);
  const byName = new Map(indexed.map((param) => [param.name, param]));
  const names = indexed
    .filter((param) => param.filterable)
    .map((param) => param.name);
  const nameList = names.length > 0 ? names.join(", ") : "none";

  for (const [key] of entries) {
    const param = byName.get(key);
    if (!param) {
      const known = fragment.inputs.find((input) => input.name === key);
      return {
        success: false,
        error: known
          ? `'${key}' is not an indexed parameter of ${fragment.name}, and only indexed parameters can be filtered at the RPC. Filterable here: ${nameList}.`
          : `'${key}' is not a parameter of ${fragment.name}. Filterable here: ${nameList}.`,
      };
    }
    if (!param.filterable) {
      return {
        success: false,
        error: `'${key}' is an indexed ${param.type}, whose topic is a hash of the encoded contents rather than a value that can be matched. Filterable here: ${nameList}.`,
      };
    }
    const check = checkSolidityValue(param.type, parsed.filters[key]);
    if (!check.valid) {
      return {
        success: false,
        error: `Filter for '${key}' (${param.type}) must be ${check.expected}.`,
      };
    }
  }

  const topics: (string | null)[] = [fragment.topicHash];
  for (const param of indexed) {
    const value = parsed.filters[param.name];
    if (value === undefined) {
      topics.push(null);
      continue;
    }
    try {
      topics.push(encodeTopic(param.type, value));
    } catch (error) {
      return {
        success: false,
        error: `Filter for '${param.name}' (${param.type}) could not be encoded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  // Trailing wildcards say nothing; dropping them keeps the topic array the
  // shortest one that expresses the same filter.
  while (topics.length > 0 && topics.at(-1) === null) {
    topics.pop();
  }

  return {
    success: true,
    topics,
    applied: entries.map(([key]) => key),
  };
}
