import { createHash } from 'node:crypto';
import type { Decision, PaymentBinding, SignableBundle } from '@spendguard/contracts';
import { decimal } from '@spendguard/core';

export interface BindResultOk {
  ok: true;
  /** The payload that MAY be signed (binding frozen). */
  signPayload: string;
  /** Proof hash binding decision + payload. */
  proofHash: string;
}

export interface BindResultFail {
  ok: false;
  code: 'amount_mismatch' | 'payee_mismatch' | 'chain_mismatch' | 'token_mismatch' | 'no_approved_binding';
  detail: string;
}

export type BindResult = BindResultOk | BindResultFail;

/**
 * THE x402 #1404 bill-swap fix.
 *
 * In the vulnerability, a service presents a cheap option at confirmation time
 * (`$5 @ 0xA`) then retries a 402 demanding a larger amount / different payee.
 * `maxPaymentUsdc` only gives a ceiling — nothing BINDS the signed payload to
 * what was approved.
 *
 * We bind it: the guardrail refuses to sign unless the presented bundle's
 * amount/payee/chain/token EXACTLY match the decision's approved binding.
 * `ok=false` on ANY drift => the retry can never silently change the bill.
 */
export function bindToApproved(
  decision: Decision,
  presentedBundle: SignableBundle,
): BindResult {
  const approved = decision.approvedBinding;
  if (!approved) {
    return { ok: false, code: 'no_approved_binding', detail: 'decision carries no approved binding (was it denied?)' };
  }
  return bindToBinding(decision.decisionId, decision.actionId, approved, presentedBundle);
}

export function bindToBinding(
  decisionId: string,
  actionId: string,
  approved: PaymentBinding,
  presented: SignableBundle,
): BindResult {
  const b = presented.binding;
  const problems: Array<{ code: BindResultFail['code']; detail: string }> = [];

  // Amount: exact decimal-string equality (never float).
  if (!decimal.eq(b.amount, approved.amount)) {
    problems.push({ code: 'amount_mismatch', detail: `approved ${approved.amount} != presented ${b.amount}` });
  }
  // Payee, chain, token: strict string/number equality.
  if (b.payTo !== approved.payTo) {
    problems.push({ code: 'payee_mismatch', detail: `approved ${approved.payTo} != presented ${b.payTo}` });
  }
  if (b.chainId !== approved.chainId) {
    problems.push({ code: 'chain_mismatch', detail: `approved chain ${approved.chainId} != presented ${b.chainId}` });
  }
  if (b.token !== approved.token) {
    problems.push({ code: 'token_mismatch', detail: `approved token ${approved.token} != presented ${b.token}` });
  }

  if (problems.length > 0) {
    return { ok: false, ...problems[0]! };
  }

  // Freeze the binding into the signable payload + a proof hash.
  const frozen = JSON.stringify({ ...approved, frozen: true, requestId: presented.requestId });
  const proofHash = createHash('sha256')
    .update([decisionId, presented.requestId, frozen].join('|'))
    .digest('hex')
    .slice(0, 40);

  return { ok: true, signPayload: frozen, proofHash };
}