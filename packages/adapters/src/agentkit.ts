import type { ActionIntent } from '@spendguard/contracts';
import { defaultPaymentNormalizer, addAmounts } from '@spendguard/core';

/**
 * AgentKit (Coinbase CDP) wallet adapter. AgentKit ships "no built-in spending
 * limits — you add them through the application layer" (OpenFort scan,
 * 09/13/2026). This adapter plugs SpendGuard's policy engine in FRONT of any
 * AgentKit CDP wallet action so every transfer goes through decide -> verify ->
 * bind -> log before it touches the signing key.
 */
export interface AgentKitAction {
  to: string;
  amount: string;
  chainId: number;
  token: string;
}

/**
 * Wrap a raw AgentKit action into a SpendGuard ActionIntent. The normalizer
 * (defaultPaymentNormalizer) understands exactly this shape, so the same
 * decision engine + binder protect AgencyKit transfers.
 */
export function toAgentKitIntent(id: string, agentId: string, action: AgentKitAction, note?: string): ActionIntent {
  return {
    id,
    agentId,
    kind: action.token === 'native' ? 'transfer' : 'transfer',
    createdAt: new Date().toISOString(),
    payload: { ...action, note },
  };
}

export { defaultPaymentNormalizer, addAmounts };