import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DecisionEngine, defaultPaymentNormalizer } from '@spendguard/core';
import { AuditLedger } from '@spendguard/ledger';
import { ServClient } from '@spendguard/serv';
import { bindToApproved } from './x402-binder.js';
import type { AgentPolicy, ActionIntent, SignableBundle } from '@spendguard/contracts';

/**
 * THE counterfactual: the #1404 bill-swap attack against a SpendGuard rail.
 *
 * Attack (AgentKit #1404, 08/06/2026): a service presents a cheap option at
 * confirmation time ($5 @ 0xGood), the guardrail approves it, then the retry
 * 402 demands a larger amount / different recipient ($5900 @ 0xEvil).
 * `maxPaymentUsdc` gives only a ceiling — nothing BINDS the signed payload to
 * the approved option.
 *
 * Here we prove SpendGuard stops it: the binder refuses to sign unless the
 * retry's amount/payee/chain/token EXACTLY match the approved decision.
 */
describe('Counterfactual — bill-swap (#1404) is defeated', () => {
  const engine = new DecisionEngine(defaultPaymentNormalizer);
  const ledger = new AuditLedger(':memory:');
  const guard = new ServClient();

  function policy(over: Partial<AgentPolicy['spend']> = {}): AgentPolicy {
    return {
      agentId: 'paybot-1',
      spend: {
        maxAmountPerAction: '1000.00', // $1000 ceiling, allowedPayees open (min merchant whitelist OFF)
        ...over,
      },
    } as unknown as AgentPolicy;
  }

  function action(amount: string, to: string, id = randomUUID()): ActionIntent {
    return {
      id,
      agentId: 'paybot-1',
      kind: 'x402_payment',
      createdAt: new Date().toISOString(),
      payload: { to, amount, chainId: 1, token: 'USDC' },
    } as unknown as ActionIntent;
  }

  function retry(amount: string, to: string, requestId: string): SignableBundle {
    return { binding: { payTo: to, amount, chainId: 1, token: 'USDC' }, signPayload: '', requestId };
  }

  it('Stage 1 — agent wants to pay $5 to a merchant: engine approves it', async () => {
    const d = await engine.decide(action('5.00', '0xMerchant'), policy({ humanInLoopThreshold: '100.00' }), { spent: '0', windowStart: 0 }, 1000);
    // $5 is well under the $100 HITL threshold and under the $1000/action cap,
    // so it clears to allow (the small-payment case that should auto-approve).
    expect(d.verdict).toBe('allow');

    // Guardian approves it (HITL signed).
    const approved = { ...d, verdict: 'allow' as const, reason: { code: 'ok' as const, detail: 'human approved' }, approvedBinding: { payTo: '0xMerchant', amount: '5.00', chainId: 1, token: 'USDC' } };
    const bound = bindToApproved(approved, retry('5.00', '0xMerchant', 'req-1'));
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.signPayload).toContain('0xMerchant');
      expect(bound.signPayload).toContain('5.00');
    }
  });

  it('Stage 2 — the retry BILL-SWAPS to $5900: binder REFUSES to sign (amount)', async () => {
    const d = await engine.decide(action('5.00', '0xMerchant'), policy({ humanInLoopThreshold: '100.00' }), { spent: '0', windowStart: 0 }, 1000);
    const approved = { ...d, verdict: 'allow' as const, reason: { code: 'ok' as const, detail: 'approved' }, approvedBinding: { payTo: '0xMerchant', amount: '5.00', chainId: 1, token: 'USDC' } };
    // Attacker retries at 402 with $5900 — the exact #1404 vector.
    const r = bindToApproved(approved, retry('5900.00', '0xMerchant', 'req-1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('amount_mismatch');
  });

  it('Stage 3 — retry swaps the RECIPIENT to 0xEvil: binder REFUSES (payee)', async () => {
    const d = await engine.decide(action('5.00', '0xMerchant'), policy({ humanInLoopThreshold: '100.00' }), { spent: '0', windowStart: 0 }, 1000);
    const approved = { ...d, verdict: 'allow' as const, reason: { code: 'ok' as const, detail: 'approved' }, approvedBinding: { payTo: '0xMerchant', amount: '5.00', chainId: 1, token: 'USDC' } };
    const r = bindToApproved(approved, retry('5.00', '0xEvil', 'req-1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('payee_mismatch');
  });

  it('full rail: decide -> verify -> bind -> ledger, then a swapped retry is caught', async () => {
    const intent = action('5.00', '0xMerchant');
    const d = await engine.decide(intent, policy({ humanInLoopThreshold: '100.00' }), { spent: '0', windowStart: 0 }, 1000);
    // human approves:
    const approved = { ...d, verdict: 'allow' as const, reason: { code: 'ok' as const, detail: 'human approved' }, approvedBinding: { payTo: '0xMerchant', amount: '5.00', chainId: 1, token: 'USDC' } };

    const v = await guard.verify(intent, approved.approvedBinding!);
    expect(v.passed).toBe(true);

    const bound = bindToApproved(approved, retry('5.00', '0xMerchant', 'req-2'));
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      ledger.append(approved, `proof:${bound.proofHash}`);
      expect(ledger.count()).toBe(1);
      expect(ledger.verify().valid).toBe(true);
      // Now the retry tries the swap:
      const evilRetry = bindToApproved(approved, retry('5.00', '0xEvil', 'req-2'));
      expect(evilRetry.ok).toBe(false);
      ledger.append({ ...approved, verdict: 'deny', reason: { code: 'payee_mismatch', detail: 'retry swapped to 0xEvil' } });
      expect(ledger.count()).toBe(2);
      expect(ledger.verify().valid).toBe(true);
    }
  });

  it('binder refuses to bind a denied decision (no approved binding)', () => {
    const denied = {
      decisionId: randomUUID(),
      actionId: randomUUID(),
      agentId: 'paybot-1',
      verdict: 'deny' as const,
      reason: { code: 'over_spend_limit' as const, detail: 'too big' },
      decidedAt: new Date().toISOString(),
      nonce: 'n',
    };
    const r = bindToApproved(denied as never, retry('5.00', '0xMerchant', 'req-3'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_approved_binding');
  });
});