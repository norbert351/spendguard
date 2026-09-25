import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realRailEnabled, broadcastBoundTransfer } from '../dist/real-broadcast.js';

// Deterministic invariants of the REAL rail (never needs a live chain):
// 1. OFF by default (REAL_RAIL unset) — the guardrail's normal path never signs.
// 2. When off, broadcast refuses loudly.
// 3. Even when enabled, non-native (token) bindings are refused — no fake ERC20.

const prevRail = process.env.REAL_RAIL;
const prevPk = process.env.REAL_WALLET_PK;

test("real rail is OFF by default (REAL_RAIL unset)", () => {
  delete process.env.REAL_RAIL;
  delete process.env.REAL_WALLET_PK;
  assert.equal(realRailEnabled(), false);
});

test('broadcast refuses when the rail is off', async () => {
  delete process.env.REAL_RAIL;
  delete process.env.REAL_WALLET_PK;
  await assert.rejects(
    () => broadcastBoundTransfer({ payTo: '0xabc', amount: '0.0001', chainId: 84532, token: 'native' }),
    /REAL_RAIL is not enabled/,
  );
});

test('broadcast refuses non-native (token) bindings — no fake ERC20', async () => {
  process.env.REAL_RAIL = '1';
  process.env.REAL_WALLET_PK = '0x0000000000000000000000000000000000000000000000000000000000000001';
  await assert.rejects(
    () => broadcastBoundTransfer({ payTo: '0xabc', amount: '0.0001', chainId: 84532, token: '0xUSDC' }),
    /only broadcasts NATIVE/,
  );
});

test('broadcast refuses a binding on a different chain than configured', async () => {
  process.env.REAL_RAIL = '1';
  process.env.REAL_WALLET_PK = '0x0000000000000000000000000000000000000000000000000000000000000001';
  process.env.REAL_CHAIN = '84532';
  await assert.rejects(
    () => broadcastBoundTransfer({ payTo: '0xabc', amount: '0.0001', chainId: 1, token: 'native' }),
    /chainId/,
  );
});

test.after(() => {
  if (prevRail === undefined) delete process.env.REAL_RAIL; else process.env.REAL_RAIL = prevRail;
  if (prevPk === undefined) delete process.env.REAL_WALLET_PK; else process.env.REAL_WALLET_PK = prevPk;
});