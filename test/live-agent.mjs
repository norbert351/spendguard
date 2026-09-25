#!/usr/bin/env node
// LIVE-AGENT DRIVER — proves the REAL rail: an agent's allow is actually
// signed + broadcast to Base Sepolia, and a deny is NOT broadcast.
//
// Usage:
//   REAL_RAIL=1 REAL_WALLET_PK=0x... node --dns-result-order=ipv4first test/live-agent.mjs
// (reads data/.env.real if no env passed)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(root, 'data/.env.real'), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {}
  return out;
}
const env = { ...process.env, ...loadEnv() };
const PORT = 8300 + Math.floor(Math.random() * 200);
const API_KEY = 'sg-real-agent-key';
const PAYEE = '0x10b4064504D3d0D400A607164190B04dE679A4A6'; // humanpay operator (real addr)
const AGENT = 'sg-real-agent';

const child = spawn(process.execPath, ['--dns-result-order=ipv4first', 'apps/api/dist/index.js'], {
  cwd: root,
  env: {
    ...env,
    REAL_RAIL: env.REAL_RAIL || '1',
    SPENDGUARD_PORT: String(PORT),
    SPENDGUARD_API_KEY: API_KEY,
    SPENDGUARD_API_KEY2: API_KEY,
    SPENDGUARD_LEDGER: join(root, 'data/.live-agent.sqlite'),
    SPENDGUARD_AUTH: join(root, 'data/.live-agent-auth.sqlite'),
    SERV_MODE: 'local',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function log(...a) { console.log('[live-agent]', ...a); }
const base = `http://127.0.0.1:${PORT}`;
async function rpc(path, opts = {}) {
  const r = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function waitHealthy(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base + '/api/health', { headers: { 'x-api-key': API_KEY } }); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('API did not become healthy');
}

// capture child stderr (e.g. ethers/network errors)
child.stderr.on('data', (d) => process.env.SG_DEBUG && process.stderr.write(d));

let exit = 0;
try {
  await waitHealthy();
  log(`up on :${PORT}`);

  // register a policy that whitelists the real payee + small cap, no HITL trip
  await rpc(`/api/policy/${AGENT}`, {
    method: 'POST',
    body: JSON.stringify({
      agentId: AGENT,
      spend: {
        maxAmountPerAction: '0.01', maxAmountPerWindow: '0.05', windowMs: 86400000,
        maxActionsPerWindow: 10, allowedPayees: [PAYEE],
        allowedKinds: ['transfer'], humanInLoopThreshold: '0.5', frozen: false,
      },
      guardianAddress: '0xGuardianReal', note: 'real-rail driver policy',
    }),
  });
  log('policy registered:', AGENT);

  // --- CASE 1: legit small native spend -> ALLOW + REAL broadcast ---
  let r = await rpc('/api/agent/action', {
    method: 'POST',
    body: JSON.stringify({ agentId: AGENT, kind: 'transfer', intent: { to: PAYEE, amount: '0.0001', chainId: 84532, token: 'native' } }),
  });
  log('CASE1 allow ->', 'HTTP', r.status, 'verdict', r.body.decision?.verdict);
  if (r.status !== 200 || r.body.decision?.verdict !== 'allow') { log('CASE1 FAILED:', JSON.stringify(r.body)); exit = 1; }
  else if (r.body.real?.status !== 'broadcast' || !r.body.real.receipt?.txHash) { log('CASE1 FAILED: no real broadcast:', JSON.stringify(r.body.real)); exit = 1; }
  else {
    log('   REAL TX HASH  :', r.body.real.receipt.txHash);
    log('   FROM          :', r.body.real.receipt.from);
    log('   EXPLORER      :', r.body.real.receipt.explorerUrl);
  }

  // --- CASE 2: over-cap drain -> DENY, NO broadcast ---
  r = await rpc('/api/agent/action', {
    method: 'POST',
    body: JSON.stringify({ agentId: AGENT, kind: 'transfer', intent: { to: PAYEE, amount: '2.00', chainId: 84532, token: 'native' } }),
  });
  log('CASE2 deny ->', 'HTTP', r.status, 'verdict', r.body.decision?.verdict, 'real', r.body.real?.status);
  if (r.status !== 403 || r.body.decision?.verdict !== 'deny' || r.body.real?.status === 'broadcast') { log('CASE2 FAILED:', JSON.stringify(r.body)); exit = 1; }
  else log('   DENIED, nothing broadcast. reason:', r.body.decision?.reason?.code);
} catch (e) {
  log('ERROR:', e.message);
  exit = 1;
} finally {
  child.kill('SIGKILL');
}
log(exit === 0 ? 'PASS ✓' : 'FAIL ✗');
process.exit(exit);