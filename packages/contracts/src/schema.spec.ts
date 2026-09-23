import { describe, expect, it } from 'vitest';
import { validateFundingPayload, isFundingKind, explorerBase, explorerAddressUrl, explorerHashUrl } from './action.js';

describe('schema-forced execution (#6) + explorer links (#9)', () => {
  it('accepts a well-formed funding payload', () => {
    expect(validateFundingPayload('transfer', { to: '0xA', amount: '5.00', chainId: 1, token: 'USDC' })).toEqual([]);
  });

  it('rejects a missing recipient', () => {
    const v = validateFundingPayload('transfer', { amount: '5.00', chainId: 1, token: 'USDC' });
    expect(v.some((x) => x.field === 'to')).toBe(true);
  });

  it('rejects a non-numeric amount', () => {
    const v = validateFundingPayload('transfer', { to: '0xA', amount: 'abc', chainId: 1, token: 'USDC' });
    expect(v.some((x) => x.field === 'amount')).toBe(true);
  });

  it('rejects an unsupported kind', () => {
    const v = validateFundingPayload('rogue_call', { to: '0xA', amount: '5', chainId: 1, token: 'x' });
    expect(v[0]?.field).toBe('kind');
  });

  it('isFundingKind classifies correctly', () => {
    expect(isFundingKind('x402_payment')).toBe(true);
    expect(isFundingKind('robinhood_order')).toBe(true);
    expect(isFundingKind('contract_call')).toBe(false);
  });

  it('builds chain-specific explorer links (#9)', () => {
    expect(explorerBase(8453)).toBe('https://basescan.org');
    const addr = explorerAddressUrl(8453, '0xRecipient');
    expect(addr).toBe('https://basescan.org/address/0xRecipient');
    const tx = explorerHashUrl(1, '0xdeadbeef');
    expect(tx).toBe('https://etherscan.io/tx/0xdeadbeef');
  });
});