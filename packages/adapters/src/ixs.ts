import { randomUUID } from 'node:crypto';
import type { ActionIntent } from '@spendguard/contracts';

/**
 * IXS Finance Agentic Vault adapter (RWA track).
 *
 * Evidence-backed: IXS Agentic Vault (live Jul 9 2026, BNB) lets AI agents
 * autonomously deposit USDC into licensed tokenized-real-world-asset yield,
 * "within user-defined policy rules." This adapter surfaces the deposit as a
 * SpendGuard ActionIntent so the same policy engine, shadow-verifier and audit
 * ledger govern it — no blind autodeposit.
 */
export interface IxsDeposit {
  /** vault address the agent wants to deposit into. */
  vault: string;
  /** USDC amount to deposit. */
  amountUsdc: string;
  /** chain the vault lives on (e.g. 8453 = Base, 56 = BNB). */
  chainId: number;
  /** optional strategy/allocation label for the audit trail. */
  strategy?: string;
}

export const IXS_KNOWN_VAULTS: Record<string, string> = {
  // Official IXS Agentic Vault family (per IXS docs + theagenttimes, Jul 2026).
  // Real addresses are filled at deploy time; used to validate `to:` routing.
};

export function toIxsDepositIntent(agentId: string, d: IxsDeposit): ActionIntent {
  return {
    id: randomUUID(),
    agentId,
    kind: 'ixs_deposit',
    createdAt: new Date().toISOString(),
    payload: {
      to: `ixs:${d.vault}`,
      amount: d.amountUsdc,
      chainId: d.chainId,
      token: 'USDC',
      strategy: d.strategy ?? 'licensed RWA yield',
    },
  };
}

export { defaultPaymentNormalizer } from '@spendguard/core';