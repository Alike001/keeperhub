/**
 * Action slugs that moved to a new contract key on specific chains, keyed by
 * the old `<protocol>/<slug>` action type.
 *
 * The bridged wstETH and sUSDS tokens implement the ERC-20 surface only, so
 * the full-ABI `wsteth`/`sUsds` contract keys stopped carrying an L2 address
 * and every action bound to them stopped resolving there. The two ERC-20
 * reads that did work on each L2 survive under the read-only `wstethL2` /
 * `sUsdsL2` keys with `-l2` slugs: same address, same selector, same 18
 * decimals. Without an alias a workflow saved against an old slug fails its
 * next run with `contract "sUsds" is not deployed on network "8453"`, which
 * is a break in the identifier rather than in the capability.
 *
 * Scoped per chain deliberately. The old slugs still exist and still work on
 * the chains where the full ABI is implemented (mainnet for both, plus
 * Sepolia for wstETH), so the alias must not shadow them there.
 *
 * The table lives here, not beside the step that first needed it, because
 * three layers have to agree on it: the runtime resolution in
 * plugins/protocol/steps/resolve-protocol-meta.ts, the Network field's chain
 * list in lib/protocol-registry.ts (a saved Base workflow that executes must
 * still validate and still render its chain), and the codegen context in
 * lib/workflow/codegen. A second copy of the redirect rule is a second
 * chance for them to disagree.
 */
export const L2_RENAMED_ACTIONS: Record<
  string,
  { slug: string; chainIds: readonly string[] }
> = {
  "sky/vault-balance": {
    slug: "get-susds-balance-l2",
    chainIds: ["8453", "42161"],
  },
  "sky/vault-total-supply": {
    slug: "get-susds-total-supply-l2",
    chainIds: ["8453", "42161"],
  },
  "lido/get-wsteth-balance": {
    slug: "get-wsteth-balance-l2",
    chainIds: ["8453"],
  },
  "lido/get-wsteth-total-supply": {
    slug: "get-wsteth-total-supply-l2",
    chainIds: ["8453"],
  },
};

// Structural on purpose: lib/protocol-registry.ts imports this module, so
// importing ProtocolDefinition/ProtocolAction back from it would close a
// cycle. These are the only fields the redirect rule reads.
type AliasContract = { addresses: Record<string, string> };
type AliasAction = { slug: string; contract: string };
type AliasProtocol<TAction extends AliasAction> = {
  contracts: Record<string, AliasContract>;
  actions: TAction[];
};

/**
 * Redirect a renamed action to its `-l2` replacement, or return it unchanged.
 *
 * The redirect is conditional on the originally bound contract having no
 * address on this chain, so the alias only fires where the old slug would
 * have failed. If a full-ABI `wsteth`/`sUsds` is ever deployed on one of
 * these chains the old slug starts resolving on its own and the alias steps
 * aside without needing to be deleted.
 *
 * Returns the argument by identity when nothing is redirected, so a caller
 * can test `resolved !== action` to detect that an alias fired.
 */
export function resolveRenamedAction<TAction extends AliasAction>(
  protocol: AliasProtocol<TAction>,
  actionType: string,
  action: TAction,
  network: string | undefined
): TAction {
  if (network === undefined) {
    return action;
  }
  const rename = L2_RENAMED_ACTIONS[actionType];
  if (!rename?.chainIds.includes(network)) {
    return action;
  }
  if (protocol.contracts[action.contract]?.addresses[network] !== undefined) {
    return action;
  }
  return protocol.actions.find((a) => a.slug === rename.slug) ?? action;
}

/**
 * The chains on which `actionType` redirects to a contract that does have an
 * address, i.e. the chains the old slug still executes on through the alias.
 *
 * The Network field's `allowedChainIds` is built from the declared contract's
 * addresses alone, which after the split lists mainnet only. That list gates
 * both the save-time config validation and the builder's chain dropdown, so
 * without this union a Base workflow that still executes correctly cannot be
 * saved and renders no chain. Derived from resolveRenamedAction rather than
 * from the table directly, so the offered chains are exactly the chains the
 * runtime redirect fires on.
 */
export function aliasedChainIds<TAction extends AliasAction>(
  protocol: AliasProtocol<TAction>,
  actionType: string,
  action: TAction
): string[] {
  const rename = L2_RENAMED_ACTIONS[actionType];
  if (!rename) {
    return [];
  }
  return rename.chainIds.filter((chainId) => {
    const resolved = resolveRenamedAction(
      protocol,
      actionType,
      action,
      chainId
    );
    return (
      resolved !== action &&
      protocol.contracts[resolved.contract]?.addresses[chainId] !== undefined
    );
  });
}
