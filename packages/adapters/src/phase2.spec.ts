import { describe, expect, it } from 'vitest';
import { DecisionEngine, defaultPaymentNormalizer } from '@spendguard/core';
import {
  guardRobinhoodOrder,
  enumerateRobinhoodTools,
  ROBINHOOD_TOTAL_TOOLS,
  ROBINHOOD_ORDER_TOOLS,
  toRobinhoodOrderIntent,
  type RobinhoodOrder,
} from './robinhood.js';
import { guardAgentKitTransfer, toAgentKitIntent } from './agentkit.js';
import { replayDrainAttack, CANNED_ATTACKS } from './drain-demo.js';
import type { AgentPolicy } from '@spendguard/contracts';

const engine = new DecisionEngine(defaultPaymentNormalizer);
const gate = { allowedAgenticAccount: 'acct-AGENTIC' };
const policy = {
  agentId: 'rh-agent',
  spend: {
    maxAmountPerAction: '1000.00',
    allowedPayees: ['robinhood:crypto'],
    allowedKinds: ['robinhood_order'] as const,
    humanInLoopThreshold: '500.00',
  },
} as unknown as AgentPolicy;

function order(o: Partial<RobinhoodOrder> = {}): RobinhoodOrder {
  return {
    kind: 'crypto',
    side: 'buy',
    symbol: 'BTCUSD',
    notionalUsd: '250.00',
    agenticAccount: 'acct-AGENTIC',
    ...o,
  };
}

describe('Robinhood MCP gating (verified 57-tool surface)', () => {
  it('tool inventory counts are consistent (57 total, 9 order tools)', () => {
    expect(ROBINHOOD_TOTAL_TOOLS).toBe(57);
    expect(ROBINHOOD_ORDER_TOOLS).toHaveLength(9);
  });

  it('enumerates crypto order tools only when crypto eligible', () => {
    const withCrypto = enumerateRobinhoodTools({ equity: true, option: true, crypto: true });
    const without = enumerateRobinhoodTools({ equity: true, option: true, crypto: false });
    expect(withCrypto).toContain('place_crypto_order');
    expect(without).not.toContain('place_crypto_order');
  });

  it('DENIES a crypto order aimed at a NON-Agentic account (account-boundary defence)', async () => {
    const d = await guardRobinhoodOrder(engine, 'rh-agent', order({ agenticAccount: 'acct-growth' }), gate, policy);
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('account_boundary_breach');
    expect(d.reason.detail).toContain('agent_aimed_non_agentic_account');
  });

  it('ALLOWS a crypto order within the Agentic account under the cap', async () => {
    const d = await guardRobinhoodOrder(engine, 'rh-agent', order({ notionalUsd: '250.00' }), gate, policy);
    expect(d.verdict).toBe('allow');
  });

  it('DENIES a crypto order over the per-action cap', async () => {
    const d = await guardRobinhoodOrder(engine, 'rh-agent', order({ notionalUsd: '5000.00' }), gate, policy);
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('over_spend_limit');
  });

  it('sets require_human for a large but under-cap order', async () => {
    const d = await guardRobinhoodOrder(engine, 'rh-agent', order({ notionalUsd: '600.00' }), gate, policy);
    expect(d.verdict).toBe('require_human');
  });

  it('normalizes to an intent carrying the RH order routing as payee', () => {
    const intent = toRobinhoodOrderIntent('rh-agent', order(), gate);
    const payload = intent.payload as Record<string, unknown>;
    expect(payload.to).toBe('robinhood:crypto');
    expect(payload.amount).toBe('250.00');
  });
});

describe('Replayable injection-drain demo (counterfactual)', () => {
  it('bill-swap attack is fully contained', async () => {
    const a = CANNED_ATTACKS.find((x) => x.id === 'bill-swap')!;
    const r = await replayDrainAttack(a);
    expect(r.contained).toBe(true);
    expect(r.notionalSaved).toBe('5900.00');
    // engine allowed it but the x402 binder caught the drift
    expect(r.steps.some((s) => s.layer === 'x402-binder' && s.outcome === 'blocked')).toBe(true);
  });

  it('"ignore previous instructions" exfil is blocked at the injection screen', async () => {
    const a = CANNED_ATTACKS.find((x) => x.id === 'exfil-ignore-prev')!;
    const r = await replayDrainAttack(a);
    expect(r.contained).toBe(true);
    expect(r.steps[0]?.layer).toBe('injection-screen');
    expect(r.steps[0]?.outcome).toBe('blocked');
    expect(r.loopsStopped).toBe(a.loopIterations);
  });

  it('the overnight-loop ($600-bill) attack is contained and the burn stopped', async () => {
    const a = CANNED_ATTACKS.find((x) => x.id === 'overnight-loop')!;
    const r = await replayDrainAttack(a);
    expect(r.contained).toBe(true);
    expect(r.loopsStopped).toBe(a.loopIterations); // 120 loop-burn iterations halted
  });

  it('every canned attack is contained (the counterfactual always holds)', async () => {
    for (const a of CANNED_ATTACKS) {
      const r = await replayDrainAttack(a);
      expect(r.contained).toBe(true);
      expect(r.notionalSaved !== '0.00' || r.loopsStopped > 0).toBe(true);
    }
  });
});
describe('AgentKit guard + schema-forced execution', () => {
  const akPolicy = {
    agentId: 'cdp-wallet',
    spend: { maxAmountPerAction: '500.00', allowedPayees: ['0xMerchant'], allowedKinds: ['transfer'] as const, humanInLoopThreshold: '100.00' },
  } as unknown as AgentPolicy;

  it('guardAgentKitTransfer ALLOWS a valid, in-policy transfer', async () => {
    const d = await guardAgentKitTransfer(engine, 'cdp-wallet', { to: '0xMerchant', amount: '50.00', chainId: 1, token: 'USDC' }, akPolicy);
    expect(d.verdict).toBe('allow');
    expect(d.kind).toBe('transfer');
  });

  it('guardAgentKitTransfer DENIES a malformed intent (schema-forced)', async () => {
    const d = await guardAgentKitTransfer(engine, 'cdp-wallet', { to: '', amount: 'abc', chainId: 1, token: '' }, akPolicy);
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('validation_error');
  });

  it('guardAgentKitTransfer DENIES an over-cap transfer', async () => {
    const d = await guardAgentKitTransfer(engine, 'cdp-wallet', { to: '0xMerchant', amount: '9999.00', chainId: 1, token: 'USDC' }, akPolicy);
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('over_spend_limit');
  });

  it('toAgentKitIntent always yields kind=transfer with role in payload', () => {
    const i = toAgentKitIntent('cdp-wallet', { to: '0xY', amount: '10', chainId: 1, token: 'native' }, 'payment');
    expect(i.kind).toBe('transfer');
    expect((i.payload as Record<string, unknown>).role).toBe('payment');
  });
});
