/**
 * SpendGuard end-to-end counterfactual test.
 *
 * Spins up the real API service (dist build) on a random port and drives it:
 *   schema-force -> decide -> serv-verify -> x402-bind -> audit ledger.
 * Proves the LOAD-BEARING counterfactual: with the guardrail in place the
 * injection-drain / bill-swap is CONTAINED and audited to an intact hash chain.
 *
 * Run:  node test/e2e.mjs
 * Requires: npm run build first (apps/api/dist/index.js).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const PORT = 18199;
const API_KEY = 'e2e-key';
const BASE = `http://127.0.0.1:${PORT}`;
const ledger = '/tmp/spendguard-e2e.sqlite';
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/health`, { headers: { 'x-api-key': API_KEY } }); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('API did not come up');
};

// kill stale
try { const fs = await import('node:fs'); for (const f of fs.readdirSync('/tmp')) if (f.startsWith('spendguard-e2e')) fs.rmSync('/tmp/' + f, { force: true }); } catch {}

const child = spawn('node', ['apps/api/dist/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    SPENDGUARD_PORT: String(PORT),
    SPENDGUARD_API_KEY: API_KEY,
    SPENDGUARD_LEDGER: ledger,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': API_KEY } });
  return { status: r.status, data: await r.json() };
}

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : '  ← ' + (extra ?? '')}`);
  if (!ok) failures++;
}

try {
  await waitUp();
  console.log('── e2e: SpendGuard API up ──\n');

  // 1. auth gate
  const noAuth = await fetch(`${BASE}/api/ledger`);
  check('auth: 401 without key', noAuth.status === 401);

  // 2. schema-forced: malformed intent refused
  const malformed = await post('/api/agent/action', { agentId: 'demo-trader', kind: 'transfer', intent: { amount: '50', chainId: 1 } });
  check('schema-force: malformed intent → deny/403', malformed.status === 403 && malformed.data.decision?.reason?.code === 'validation_error', JSON.stringify(malformed.data));

  // 3. bill-swap counterfactual demo
  const bill = await post('/api/demo/bill-swap', {});
  check('counterfactual: bill-swap CONTAINED', bill.data.contained === true, JSON.stringify(bill.data));

  // 4. injection "ignore previous" exfil
  const exfil = await post('/api/demo/exfil-ignore-prev', {});
  check('counterfactual: prompt-injection exfil CONTAINED', exfil.data.contained === true, JSON.stringify(exfil.data));

  // 5. overnight $600 loop stopped
  const loop = await post('/api/demo/overnight-loop', {});
  check('counterfactual: overnight-loop stopped', loop.data.loopsStopped > 0, JSON.stringify(loop.data));

  // 6. live agent action allowed + explorer-linked proof
  const okAction = await post('/api/agent/action', { agentId: 'demo-trader', kind: 'transfer', intent: { to: '0xMerchant', amount: '25.00', chainId: 8453, token: 'USDC' } });
  check('live agent: allow + proof + explorerUrl', okAction.status === 200 && okAction.data.decision?.verdict === 'allow' && !!okAction.data.proof?.explorerUrl, JSON.stringify(okAction.data).slice(0, 160));

  // 7. over-cap denied with reason
  const over = await post('/api/agent/action', { agentId: 'demo-trader', kind: 'transfer', intent: { to: '0xMerchant', amount: '99999.00', chainId: 1, token: 'USDC' } });
  check('live agent: over-cap denied', over.status === 403 && over.data.decision?.verdict === 'deny', JSON.stringify(over.data).slice(0, 160));

  // 8. audit chain integrity
  const ledgerRes = await get('/api/ledger');
  check('audit ledger: hash-chain integrity VALID', ledgerRes.data.integrity?.valid === true, JSON.stringify(ledgerRes.data.integrity));
} catch (e) {
  console.error('e2e crashed:', e.message);
  failures++;
} finally {
  child.kill('SIGTERM');
}

console.log(`\n── ${failures === 0 ? 'ALL E2E PASSED' : failures + ' FAILURES'} ──`);
process.exit(failures === 0 ? 0 : 1);