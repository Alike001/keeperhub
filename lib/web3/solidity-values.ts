/**
 * Shapes for Solidity scalar values typed into workflow configuration.
 *
 * These patterns were previously private to
 * lib/workflow/validation/action-config.ts, which validates a saved action's
 * config in the editor and the API. Event argument filters need the same
 * checks at execution time, on the server, so they live here and both sides
 * import them rather than keeping two copies that can drift.
 *
 * Kept free of ethers and of any server-only import so the editor can use it.
 */

export const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
export const INTEGER_PATTERN = /^-?\d+$/;
export const UNSIGNED_INTEGER_PATTERN = /^\d+$/;

const FIXED_BYTES_PATTERN = /^bytes([1-9]|[12]\d|3[0-2])$/;
const UINT_PATTERN = /^uint\d*$/;
const INT_PATTERN = /^int\d*$/;

export type SolidityValueCheck =
  | { valid: true }
  | { valid: false; expected: string };

/**
 * Whether `value`, as typed by a user, is a plausible value for
 * `solidityType`. Shape only: range and width are left to the ABI encoder,
 * which rejects an out-of-range number with its own message.
 *
 * `string` and dynamic `bytes` accept anything, because an indexed value of
 * either is keccak-hashed into the topic rather than stored, so there is no
 * shape to check beyond what the caller already has.
 */
export function checkSolidityValue(
  solidityType: string,
  value: string
): SolidityValueCheck {
  if (solidityType === "address") {
    return ETH_ADDRESS_PATTERN.test(value)
      ? { valid: true }
      : { valid: false, expected: "a 0x-prefixed 20-byte address" };
  }
  if (solidityType === "bool") {
    return value === "true" || value === "false"
      ? { valid: true }
      : { valid: false, expected: "true or false" };
  }
  if (UINT_PATTERN.test(solidityType)) {
    if (INTEGER_PATTERN.test(value) && !UNSIGNED_INTEGER_PATTERN.test(value)) {
      return {
        valid: false,
        expected: `a whole number that is not negative (${solidityType} is unsigned)`,
      };
    }
    return UNSIGNED_INTEGER_PATTERN.test(value)
      ? { valid: true }
      : { valid: false, expected: "a whole number" };
  }
  if (INT_PATTERN.test(solidityType)) {
    return INTEGER_PATTERN.test(value)
      ? { valid: true }
      : { valid: false, expected: "a whole number" };
  }
  if (FIXED_BYTES_PATTERN.test(solidityType)) {
    const width = Number(solidityType.slice("bytes".length));
    if (!HEX_BYTES_PATTERN.test(value)) {
      return { valid: false, expected: `0x-prefixed hex, ${width} bytes` };
    }
    return (value.length - 2) / 2 === width
      ? { valid: true }
      : {
          valid: false,
          expected: `exactly ${width} bytes of hex (${(value.length - 2) / 2} given)`,
        };
  }
  if (solidityType === "bytes" || solidityType === "string") {
    return { valid: true };
  }
  return { valid: false, expected: "a value this step can encode" };
}
