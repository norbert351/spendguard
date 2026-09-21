import { describe, expect, it } from 'vitest';
import { decimal, addAmounts } from './decimal.js';

describe('decimal string math (never float)', () => {
  it('0.1 + 0.2 === 0.3 exactly', () => {
    expect(addAmounts('0.1', '0.2')).toBe('0.3');
  });

  it('1.005 + 1.005 = 2.01 (not 2.0100000000000002)', () => {
    expect(addAmounts('1.005', '1.005')).toBe('2.01');
  });

  it('large integer addition stays exact', () => {
    expect(addAmounts('9007199254740993', '1')).toBe('9007199254740994');
  });

  it('cmp handles sign + magnitude', () => {
    expect(decimal.gt('2.00', '1.50')).toBe(true);
    expect(decimal.lt('-5', '-1')).toBe(true);
    expect(decimal.eq('0.1', '0.10')).toBe(true);
    expect(decimal.gte('3', '3.0')).toBe(true);
  });

  it('norm strips leading zeros and trailing fractional zeros', () => {
    expect(decimal.norm('00012.500')).toBe('12.5');
    expect(decimal.norm('0.0')).toBe('0');
    expect(decimal.norm('-007.00')).toBe('-7');
  });
});