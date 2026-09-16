import { describe, expect, it } from "vitest";
import "@/protocols";
import {
  getRegisteredProtocols,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import { structureAbiOutputs } from "@/plugins/web3/steps/structure-abi-result";

/**
 * Every template path a protocol read suggests has to resolve against the
 * shape that read actually returns.
 *
 * The instance this was written for: an action declaring an `outputs`
 * override on a function whose ABI output is unnamed used to suggest
 * `{{steps.X.<overrideName>}}`, while the value sits at `{{steps.X.result}}`.
 * The suggestion resolved to undefined and the workflow saved, ran and read
 * empty. Asserting the class rather than the instance is what stops the next
 * one: the suggestions are built from the ABI here, and the value is built
 * from the same ABI by the same function the step calls.
 */

type AbiOutput = { name?: string; type: string; components?: AbiOutput[] };

/** A decoded value of roughly the right shape for an ABI output type. */
function sampleValue(output: AbiOutput): unknown {
  if (output.type.endsWith("[]")) {
    return [];
  }
  if (output.type.startsWith("tuple")) {
    return (output.components ?? []).map((component) => sampleValue(component));
  }
  if (output.type === "bool") {
    return true;
  }
  if (output.type === "address") {
    return "0x0000000000000000000000000000000000000001";
  }
  if (output.type.startsWith("uint") || output.type.startsWith("int")) {
    return "1";
  }
  return "0x00";
}

/** Walk a dotted path, treating every missing hop as a failure. */
function resolvePath(root: unknown, path: string): { ok: boolean } {
  let current = root;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) {
      return { ok: false };
    }
    if (typeof current !== "object") {
      return { ok: false };
    }
    if (!(segment in (current as Record<string, unknown>))) {
      return { ok: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { ok: current !== undefined };
}

function abiOutputsFor(
  abi: string,
  functionName: string
): AbiOutput[] | undefined {
  const parsed = JSON.parse(abi) as Array<{
    type?: string;
    name?: string;
    outputs?: AbiOutput[];
  }>;
  return parsed.find(
    (entry) => entry.type === "function" && entry.name === functionName
  )?.outputs;
}

describe("protocol read output template paths", () => {
  const protocols = getRegisteredProtocols();

  it("covers every registered protocol", () => {
    expect(protocols.length).toBeGreaterThan(0);
  });

  for (const def of protocols) {
    const reads = def.actions.filter((action) => action.type === "read");
    for (const action of reads) {
      it(`${def.slug}/${action.slug} suggests paths that exist in its result`, () => {
        const contract = def.contracts?.[action.contract];
        if (!contract?.abi) {
          return;
        }
        const abiOutputs = abiOutputsFor(contract.abi, action.function);
        if (!abiOutputs || abiOutputs.length === 0) {
          return;
        }

        // The value the step returns, built by the same function it calls.
        const values = abiOutputs.map((output) => sampleValue(output));
        const result = structureAbiOutputs(values, abiOutputs as never);
        const stepOutput = { success: true, result };

        // Only the value paths are under test. success, error and the
        // write-only transaction fields belong to the step envelope and are
        // always present regardless of the ABI.
        const suggested = (
          protocolActionToPluginAction(def, action).outputFields ?? []
        )
          .map((field) => field.field)
          .filter((field) => field === "result" || field.startsWith("result."));

        expect(
          suggested.length,
          "a read should suggest something"
        ).toBeGreaterThan(0);
        for (const path of suggested) {
          expect(
            resolvePath(stepOutput, path).ok,
            `${def.slug}/${action.slug}: '${path}' does not resolve against the returned value`
          ).toBe(true);
        }
      });
    }
  }
});

describe("the instances named in the report", () => {
  // LayerZero's OFT reads declare an outputs override on functions whose
  // ABI names nothing, which is the exact shape that used to suggest a
  // path resolving to undefined.
  const layerzero = getRegisteredProtocols().find(
    (def) => def.slug === "layerzero"
  );

  for (const slug of [
    "oft-token",
    "oft-shared-decimals",
    "oft-approval-required",
  ]) {
    it(`${slug} suggests result, not its override name`, () => {
      expect(layerzero, "layerzero protocol is registered").toBeDefined();
      const action = layerzero?.actions.find((a) => a.slug === slug);
      expect(action, `${slug} exists`).toBeDefined();
      if (!(layerzero && action)) {
        return;
      }

      const valuePaths = (
        protocolActionToPluginAction(layerzero, action).outputFields ?? []
      )
        .map((field) => field.field)
        .filter((field) => field === "result" || field.startsWith("result."));

      expect(valuePaths).toEqual(["result"]);

      // The override still supplies the wording, which is why it exists.
      const described = (
        protocolActionToPluginAction(layerzero, action).outputFields ?? []
      ).find((field) => field.field === "result");
      expect(described?.description).toBe(action.outputs?.[0]?.label);
    });
  }

  it("keeps the ABI name when the ABI supplies one", () => {
    // A counter-case, so the fix is not just "always result": a named
    // single output is keyed by its ABI name at runtime and the suggestion
    // has to follow it.
    const named = getRegisteredProtocols()
      .flatMap((def) => def.actions.map((action) => ({ def, action })))
      .find(({ def, action }) => {
        if (action.type !== "read") {
          return false;
        }
        const abi = def.contracts?.[action.contract]?.abi;
        if (!abi) {
          return false;
        }
        const outputs = abiOutputsFor(abi, action.function);
        return outputs?.length === 1 && Boolean(outputs[0].name?.trim());
      });

    expect(
      named,
      "a named single-output read exists to compare against"
    ).toBeDefined();
    if (!named) {
      return;
    }
    const namedAbi = named.def.contracts?.[named.action.contract]?.abi ?? "[]";
    const abiName = abiOutputsFor(namedAbi, named.action.function)?.[0]?.name;
    const valuePaths = (
      protocolActionToPluginAction(named.def, named.action).outputFields ?? []
    )
      .map((field) => field.field)
      .filter((field) => field === "result" || field.startsWith("result."));
    expect(valuePaths).toEqual([`result.${abiName}`]);
  });
});
