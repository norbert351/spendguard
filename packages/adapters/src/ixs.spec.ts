import { describe, expect, it } from 'vitest';
import { DecisionEngine, defaultPaymentNormalizer } from '@spendguard/core';
import { toIxsDepositIntent } from './ixs.js';
import type { AgentPolicy } from '@spendguard/contracts';

const engine = new DecisionEngine(defaultPaymentNormalizer);

describe('IXS RWA deposit adapter', () => {
  it('normalizes a vault deposit into a funding intent carrying the vault route', () => {
    const intent = toIxsDepositIntent('yield-agent', { vault: '0xvault', amountUsdc: '250.00', chainId: 8453 });
    expect(intent.kind).toBe('ixs_deposit');
    const p = intent.payload as Record<string, unknown>;
    expect(p.to).toBe('ixs:0xvault');
    expect(p.amount).toBe('250.00');
    expect(p.chainId).toBe(8453);
  });

  it('is recognized by the normalizer as a funding action (money movement)', () => {
    const intent = toIxsDepositIntent('yield-agent', { vault: '0xvault', amountUsdc: '100.00', chainId: 8453 });
    expect(defaultPaymentNormalizer.isFunding(intent)).toBe(true);
  });

  it('is allowed under a sane policy (payee allowlisted to the vault, cap respected)', async () => {
    const intent = toIxsDepositIntent('yield-agent', { vault: '0xvault', amountUsdc: '100.00', chainId: 8453 });
    const policy = {
      agentId: 'yield-agent',
      spend: {
        maxAmountPerAction: '1000.00',
        allowedPayees: ['ixs:0xvault'],
        humanInLoopThreshold: '500.00',
      },
    } as unknown as AgentPolicy;
    const d = await engine.decide(intent, policy, { spent: '0', windowStart: 0 }, Date.now());
    expect(d.verdict).toBe('allow');
    expect(d.approvedBinding?.payTo).toBe('ixs:0xvault');
  });

  it('denies a deposit into an unknown (non-allowlisted) vault', async () => {
    const intent = toIxsDepositIntent('yield-agent', { vault: '0xscam', amountUsdc: '100.00', chainId: 8453 });
    const policy = {
      agentId: 'yield-agent',
      spend: { maxAmountPerAction: '1000.00', allowedPayees: ['ixs:0xvault'] },
    } as unknown as AgentPolicy;
    const d = await engine.decide(intent, policy, { spent: '0', windowStart: 0 }, Date.now());
    expect(d.verdict).toBe('deny');
    expect(d.reason.code).toBe('payee_not_allowed');
  });
});