/**
 * Decimal-string-safe money comparisons.
 * NEVER parse monetary strings into JS floats for limit/binding checks.
 * All amounts flow through here as numeric strings.
 */

export interface DecimalCmp {
  /** `a` `b` — returns -1, 0, 1. Safe for arbitrary-length decimal strings. */
  cmp: (a: string, b: string) => -1 | 0 | 1;
  eq: (a: string, b: string) => boolean;
  gt: (a: string, b: string) => boolean;
  gte: (a: string, b: string) => boolean;
  lt: (a: string, b: string) => boolean;
  lte: (a: string, b: string) => boolean;
  /** Normalize by stripping leading zeros + trailing fractional zeros. */
  norm: (n: string) => string;
}

function norm(n: string): string {
  let s = n.trim();
  if (s.startsWith('-')) {
    return '-' + stripZero(s.slice(1));
  }
  return stripZero(s);
}

function stripZero(n: string): string {
  const parts = n.split('.');
  let int = parts[0] ?? '0';
  const frac = parts[1];
  int = int.replace(/^0+(?=\d)/, '') || '0';
  if (frac !== undefined) {
    let f = frac.replace(/0+$/, '');
    if (f === '') return int;
    return `${int}.${f}`;
  }
  return int;
}

function sign(a: string): -1 | 0 | 1 {
  if (a.startsWith('-')) return -1;
  if (a === '0' || /^0(\.0*)?$/.test(a)) return 0;
  return 1;
}

function abs(s: string): string {
  return s.startsWith('-') ? s.slice(1) : s;
}

/** Compare two non-negative normalized decimal strings. */
function cmpPos(a: string, b: string): -1 | 0 | 1 {
  const ap = a.split('.');
  const bp = b.split('.');
  const ai = ap[0] ?? '0';
  const af = ap[1] ?? '';
  const bi = bp[0] ?? '0';
  const bf = bp[1] ?? '';
  const al = ai.length;
  const bl = bi.length;
  if (al !== bl) return al > bl ? 1 : -1;
  if (ai !== bi) return ai > bi ? 1 : -1;
  const maxF = Math.max(af.length, bf.length);
  const afp = af.padEnd(maxF, '0');
  const bfp = bf.padEnd(maxF, '0');
  if (afp === bfp) return 0;
  return afp > bfp ? 1 : -1;
}

function cmp(a: string, b: string): -1 | 0 | 1 {
  const na = norm(a);
  const nb = norm(b);
  const sa = sign(na);
  const sb = sign(nb);
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (sa === 0) return 0;
  // same sign
  const c = cmpPos(abs(na), abs(nb));
  // negative: magnitudes inverted
  return sa === -1 ? (c === 0 ? 0 : (c === 1 ? -1 : 1)) : c;
}

export const decimal: DecimalCmp = {
  cmp,
  eq: (a, b) => cmp(a, b) === 0,
  gt: (a, b) => cmp(a, b) === 1,
  gte: (a, b) => cmp(a, b) >= 0,
  lt: (a, b) => cmp(a, b) === -1,
  lte: (a, b) => cmp(a, b) <= 0,
  norm,
};

/** Decimal-string addition (safe). `0.1 + 0.2 === 0.3`. Uses BigInt scaling. */
export function addAmounts(a: string, b: string): string {
  const ai = a.split('.')[0] ?? '0';
  const af = a.split('.')[1] ?? '';
  const bi = b.split('.')[0] ?? '0';
  const bf = b.split('.')[1] ?? '';
  const maxF = Math.max(af.length, bf.length);
  const afp = af.padEnd(maxF, '0');
  const bfp = bf.padEnd(maxF, '0');
  const scale = 10n ** BigInt(maxF);
  const sum =
    BigInt(ai) * scale +
    BigInt(afp) +
    BigInt(bi) * scale +
    BigInt(bfp);
  const s = sum.toString().padStart(maxF + 1, '0');
  const intPart = s.slice(0, s.length - maxF) || '0';
  const fracPart = s.slice(s.length - maxF).replace(/0+$/, '');
  return fracPart === '' ? intPart : `${intPart}.${fracPart}`;
}