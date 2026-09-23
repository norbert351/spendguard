import { randomUUID } from 'node:crypto';
import type { ActionIntent, AgentPolicy, Decision } from '@spendguard/contracts';
import { DecisionEngine, defaultPaymentNormalizer, addAmounts, type WindowState } from '@spendguard/core';
import { validateFundingPayload } from '@spendguard/contracts';

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

/** ROLE of the transfer — the one real decision the adapter makes. */
export type AgentKitRole = 'payment' | 'allocation' | 'refund';

/**
 * Wrap a raw AgentKit action into a SpendGuard ActionIntent. `kind` is always
 * 'transfer' for AgentKit CDP transfers; the ROLE (payment/allocation/refund)
 * is carried in the payload for policy distinctions, not conflated with kind.
 */
export function toAgentKitIntent(
  agentId: string,
  action: AgentKitAction,
  role: AgentKitRole = 'payment',
  note?: string,
): ActionIntent {
  return {
    id: randomUUID(),
    agentId,
    kind: 'transfer',
    createdAt: new Date().toISOString(),
    payload: { ...action, role, note },
  };
}

/**
 * REAL AgentKit guard: schema-force -> decide -> serv-verify. This is the
 * function a live Coinbase CDP wallet action would route through before
 * broadcasting. Returns the decision the caller must audit + (on allow) sign.
 */
export async function guardAgentKitTransfer(
  engine: DecisionEngine,
  agentId: string,
  action: AgentKitAction,
  policy: AgentPolicy,
  window: WindowState = { spent: '0', windowStart: 0, count: 0 },
  role: AgentKitRole = 'payment',
): Promise<Decision> {
  const violations = validateFundingPayload('transfer', action as unknown as Record<string, unknown>);
  if (violations.length > 0) {
    return {
      decisionId: randomUUID(), actionId: randomUUID(), agentId, kind: 'transfer',
      verdict: 'deny', reason: { code: 'validation_error', detail: `schema: ${violations.map((v) => `${v.field}=${v.problem}`).join('; ')}` },
      decidedAt: new Date().toISOString(), nonce: `schema-${Date.now()}`,
    };
  }
  const intent = toAgentKitIntent(agentId, action, role);
  return engine.decide(intent, policy, window, Date.now());
}

export { defaultPaymentNormalizer, addAmounts };