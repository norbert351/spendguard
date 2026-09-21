import type { ActionIntent, PaymentBinding } from '@spendguard/contracts';
import type { ActionNormalizer } from './engine.js';

/**
 * Default normalizer for x402-style payloads and agentkit transfers.
 * Expects payload to be `{ to, amount, chainId, token }`. Adaptors with other
 * shapes can implement their own ActionNormalizer and remain rail-agnostic.
 */
export const defaultPaymentNormalizer: ActionNormalizer = {
  isFunding(intent: ActionIntent): boolean {
    return intent.kind === 'transfer' || intent.kind === 'x402_payment' || intent.kind === 'ixs_deposit';
  },
  extractBinding(intent: ActionIntent): PaymentBinding {
    const p = (intent.payload ?? {}) as Record<string, unknown>;
    const amount = String(p.amount ?? '0');
    const payTo = String(p.to ?? '');
    const token = String(p.token ?? 'native');
    const chainId = typeof p.chainId === 'number' ? p.chainId : Number(p.chainId ?? 0);
    return { payTo, amount, chainId, token };
  },
};

export * from './engine.js';
export * from './decimal.js';