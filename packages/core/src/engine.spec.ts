import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DecisionEngine, defaultPaymentNormalizer } from './index.js';
import type { AgentPolicy, ActionIntent } from '@spendguard/contracts';

function intent(partial: Partial<ActionIntent> & { payload: Record<string, unknown> }): ActionIntent {
  return {
    id: randomUUID(),
    agentId: 'trader-1',
    kind: 'transfer',
    createdAt: new Date().toISOString(),
    ...partial,
  } as ActionIntent;
}

function policy(over: Partial<AgentPolicy['spend'] & { allowedKinds?: string[] }> = {}): AgentPolicy {
  return {
    agentId: 'trader-1',
    spend: {
      maxAmountPerAction: '100.00',
      ...over,
    },
  } as unknown as AgentPolicy;
}

const eng = new DecisionEngine(defaultPaymentNormalizer);

describe('DecisionEngine — every guard', () => {
  it('allows a normal transfer under cap, payee allowed', async () => {
    const p = policy({ allowedPayees: ['0xA'] });
    const d = await eng.decide(
      intent({ payload: { to: '0xA', amount: '50.00', chainId: 1, token: 'USDC' } }),
      p,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.verdict).toBe('allow');
    expect(d.reason.code).toBe('ok');
    expect(d.approvedBinding?.amount).toBe('50.00');
  });

  it('denies over per-action cap', async () => {
    const p = policy({ allowedPayees: ['0xA'] });
    const d = await eng.decide(
      intent({ payload: { to: '0xA', amount: '150.00', chainId: 1, token: 'USDC' } }),
      p,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('over_spend_limit');
  });

  it('denies a payee not on the allowlist', async () => {
    const p = policy({ allowedPayees: ['0xA'] });
    const d = await eng.decide(
      intent({ payload: { to: '0xB', amount: '10.00', chainId: 1, token: 'USDC' } }),
      p,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('payee_not_allowed');
  });

  it('denies when window spend would exceed the cap', async () => {
    const p = policy({
      allowedPayees: ['0xA'],
      maxAmountPerWindow: '100.00',
      windowMs: 86400000,
    });
    const d = await eng.decide(
      intent({ payload: { to: '0xA', amount: '50.00', chainId: 1, token: 'USDC' } }),
      p,
      { spent: '70.00', windowStart: 1000 },
      5000,
    );
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('over_window_limit');
  });

  it('sets require_human above HITL threshold but still binds approved amount', async () => {
    const p = policy({ allowedPayees: ['0xA'], maxAmountPerAction: '1000.00', humanInLoopThreshold: '100.00' });
    const d = await eng.decide(
      intent({ payload: { to: '0xA', amount: '250.00', chainId: 1, token: 'USDC' } }),
      p,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.verdict).toBe('require_human');
    expect(d.reason.code).toBe('human_required');
    expect(d.approvedBinding?.amount).toBe('250.00');
  });

  it('denies a kind not on the allowlist', async () => {
    const p = policy({ allowedKinds: ['transfer'] });
    const d = await eng.decide(
      intent({ kind: 'robinhood_order', payload: { to: '0xA', amount: '10.00', chainId: 1, token: 'USDC' } }),
      p as unknown as AgentPolicy,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('kind_not_allowed');
  });

  it('allows a non-funding action with an ok reason', async () => {
    const p = policy();
    const d = await eng.decide(
      intent({ kind: 'contract_call', payload: { read: true } }),
      p,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.verdict).toBe('allow');
    expect(d.reason.code).toBe('ok');
  });

  it('DENIES ALL funding actions when the policy is frozen', async () => {
    const p = policy({ allowedPayees: ['0xA'], frozen: true });
    const d = await eng.decide(
      intent({ payload: { to: '0xA', amount: '10.00', chainId: 1, token: 'USDC' } }),
      p,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('frozen');
  });

  it('velocity guard denies once window action count hits the cap', async () => {
    const p = policy({ allowedPayees: ['0xA'], maxAmountPerWindow: '500.00', windowMs: 86400000, maxActionsPerWindow: 2 });
    const w = { spent: '40.00', count: 2, windowStart: 1000 };
    const d = await eng.decide(
      intent({ payload: { to: '0xA', amount: '10.00', chainId: 1, token: 'USDC' } }),
      p,
      w,
      5000,
    );
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('rate_limited');
  });

  it('velocity guard allows when under the action cap', async () => {
    const p = policy({ allowedPayees: ['0xA'], maxAmountPerWindow: '500.00', windowMs: 86400000, maxActionsPerWindow: 3 });
    const w = { spent: '40.00', count: 1, windowStart: 1000 };
    const d = await eng.decide(
      intent({ payload: { to: '0xA', amount: '10.00', chainId: 1, token: 'USDC' } }),
      p,
      w,
      5000,
    );
    expect(d.verdict).toBe('allow');
  });

  it('records the action kind on the decision (audit ledger fix)', async () => {
    const p = policy({ allowedPayees: ['0xA'] });
    const d = await eng.decide(
      intent({ kind: 'robinhood_order', payload: { to: '0xA', amount: '10.00', chainId: 1, token: 'USDC' } }),
      p,
      { spent: '0', windowStart: 0 },
      1000,
    );
    expect(d.kind).toBe('robinhood_order');
  });
});