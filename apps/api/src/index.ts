import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DecisionEngine, defaultPaymentNormalizer, addAmounts, type WindowState } from '@spendguard/core';
import { AuditLedger } from '@spendguard/ledger';
import { ServClient } from '@spendguard/serv';
import { AuthStore, parseCookies, sessionCookie, clearSessionCookie } from './auth.js';
import { bindToApproved, replayDrainAttack, CANNED_ATTACKS, guardRobinhoodOrder, toIxsDepositIntent, type RobinhoodOrder, type RobinhoodAccountGate, type IxsDeposit } from '@spendguard/adapters';
import type { AgentPolicy, ActionIntent, PaymentBinding, SignableBundle, Decision } from '@spendguard/contracts';
import { validateFundingPayload, explorerHashUrl, explorerAddressUrl } from '@spendguard/contracts';

/**
 * SpendGuard API — a zero-dependency node:http backend that wires the full
 * guardrail rail: decide -> serv verify -> x402 bind -> append-only audit
 * ledger. This build ships EVERY product feature from PLAN.md:
 *   - multi-agent policy registry + management      GET/POST /api/policy(:id)
 *   - freeze / unfreeze                                POST /api/policy/:id/freeze
 *   - HITL pending queue + approval completion         GET /api/pending, POST /api/approve
 *   - velocity guard + spend caps (engine)             enforced in /api/decide + /api/robinhood
 *   - x402 bill-swap bind + signed proof artifacts     POST /api/sign, GET /api/proof/:actionId
 *   - replayable counterfactual demo                   POST /api/demo/:id
 *   - append-only audited ledger                       GET /api/ledger
 */

const PORT = Number(process.env.SPENDGUARD_PORT ?? 8181);
const LEDGER_FILE = process.env.SPENDGUARD_LEDGER ?? '/home/ubuntu/spendguard/data/audit.sqlite';
const AUTH_FILE = process.env.SPENDGUARD_AUTH ?? '/home/ubuntu/spendguard/data/auth.sqlite';

const engine = new DecisionEngine(defaultPaymentNormalizer);
const ledger = new AuditLedger(LEDGER_FILE);
const auth = new AuthStore(AUTH_FILE);
const serv = new ServClient({ mode: (process.env.SERV_MODE as 'local' | 'remote') ?? 'local', endpoint: process.env.SERV_ENDPOINT, apiKey: process.env.SERV_API_KEY });

// ---- API key auth (real service, not an open device) ----
const API_KEY = process.env.SPENDGUARD_API_KEY ?? '';
function authorized(req: IncomingMessage): boolean {
  if (!API_KEY) return true; // no key configured = open (dev mode)
  const h = req.headers['x-api-key'] ?? req.headers['authorization']?.toString().replace(/^Bearer\s+/i, '');
  return h === API_KEY;
}

/** Resolve the logged-in owner from the HttpOnly session cookie, if any. */
function getOwner(req: IncomingMessage) {
  const cookies = parseCookies(req.headers['cookie']);
  return auth.getSession(cookies['sg_session']);
}

// ---- Persistent multi-agent policy registry (seeded into sqlite on boot) ----
function defaultPolicy(agentId: string): AgentPolicy {
  const isRh = agentId === 'rh-agent';
  const isYield = agentId === 'yield-agent';
  return {
    agentId,
    spend: {
      maxAmountPerAction: '1000.00',
      maxAmountPerWindow: isRh ? '5000.00' : '2500.00',
      windowMs: 86400000,
      maxActionsPerWindow: isRh ? 10 : 5,
      allowedPayees: isRh
        ? ['robinhood:equity', 'robinhood:option', 'robinhood:crypto']
        : isYield
          ? ['ixs:0xagentic-vault', 'ixs:0xvault'] // RWA track — licensed IXS vault payees
          : ['0xMerchant', 'robinhood:equity', 'robinhood:option', 'robinhood:crypto'],
      allowedKinds: isRh ? ['robinhood_order'] : isYield ? ['ixs_deposit'] : ['transfer', 'x402_payment', 'robinhood_order'],
      humanInLoopThreshold: isRh ? '500.00' : '100.00',
      frozen: false,
    },
    guardianAddress: isRh ? '0xGuardianRH' : isYield ? '0xGuardianYield' : '0xGuardian',
    note: isRh ? 'Robinhood MCP trading agent' : isYield ? 'RWA yield agent (IXS vault deposits)' : 'SERV hackathon demo policy',
  };
}
const policies = new Map<string, AgentPolicy>();
function loadPoliciesFromDisk(): void {
  const raw = ledger.loadPolicies();
  for (const [id, json] of Object.entries(raw)) {
    try { policies.set(id, JSON.parse(json) as AgentPolicy); } catch { /* skip corrupt */ }
  }
  // seed defaults for known agents if absent
  for (const id of ['demo-trader', 'rh-agent', 'yield-agent']) {
    if (!policies.has(id)) {
      const p = defaultPolicy(id);
      policies.set(id, p);
      ledger.savePolicy(id, JSON.stringify(p));
    }
  }
}
loadPoliciesFromDisk();
function persistPolicy(id: string): void { ledger.savePolicy(id, JSON.stringify(policies.get(id))); }

// ---- Persistent per-agent window accounting ----
type WindowRec = { spent: string; count: number; windowStart: number };
function getWindow(agentId: string, now: number): { state: WindowRec; policy: AgentPolicy } {
  const policy = policies.get(agentId) ?? policies.get('demo-trader')!;
  const windowMs = policy.spend.windowMs ?? 86400000;
  const persisted = ledger.loadWindow(agentId);
  const cur = persisted ? (persisted as WindowRec) : null;
  if (!cur || now - cur.windowStart > windowMs) {
    const fresh: WindowRec = { spent: '0', count: 0, windowStart: now };
    ledger.saveWindow(agentId, fresh.spent, fresh.count, fresh.windowStart);
    return { state: fresh, policy };
  }
  return { state: cur, policy };
}
function persistWindow(agentId: string, w: WindowRec): void { ledger.saveWindow(agentId, w.spent, w.count, w.windowStart); }

// ---- Pending HITL approvals — PERSISTED so approvals survive restart ----
const pendingHITL = new Map<string, Decision>();
function recordPending(d: Decision): void {
  if (d.verdict === 'require_human') {
    pendingHITL.set(d.decisionId, d);
    ledger.savePending(d.decisionId, JSON.stringify(d));
  }
}
function loadPendingFromDisk(): void {
  for (const [k, v] of Object.entries(ledger.loadPending())) {
    try { const d = JSON.parse(v) as Decision; pendingHITL.set(d.decisionId, d); } catch { /* skip */ }
  }
}
loadPendingFromDisk();
function dropPending(id: string): void {
  pendingHITL.delete(id);
  ledger.deletePending(id);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(payload);
}
function handleOptions(res: ServerResponse): void {
  res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Serve the bundled static UI (single-file HTML) + its image assets. */
function serveUI(res: ServerResponse, asset?: string): boolean {
  const pubDir = new URL('../public/', import.meta.url).pathname;
  const file = asset ?? 'index.html';
  const uiPath = pubDir + file;
  if (!existsSync(uiPath)) {
    if (!asset) json(res, 500, { error: 'UI not bundled; run npm run build -w @spendguard/api' });
    return false;
  }
  const buf = readFileSync(uiPath);
  let type = 'text/html; charset=utf-8';
  if (file.endsWith('.png')) type = 'image/png';
  else if (file.endsWith('.jpg') || file.endsWith('.jpeg')) type = 'image/jpeg';
  else if (file.endsWith('.svg')) type = 'image/svg+xml';
  res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'access-control-allow-origin': '*' });
  res.end(buf);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (req.method === 'OPTIONS') return handleOptions(res);

  // ---- auth: owner email+password session (control plane) OR x-api-key (API) ----
  const sessionOwner = getOwner(req);
  const authed = !!sessionOwner || authorized(req);
  const isPublicAuth = path.startsWith('/api/auth/'); // register/login/logout/me are public (any method)
  const isPublic =
    isPublicAuth ||
    ((req.method === 'GET') &&
      (path === '/' || path === '/index.html' || path === '/login' || path === '/login.html' ||
        path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.svg')));
  if (path.startsWith('/api/') && !isPublic && !authed) {
    return json(res, 401, { error: 'unauthorized — log in (email+password) or provide x-api-key' });
  }

  // ---- auth endpoints (public) ----
  if (req.method === 'POST' && path === '/api/auth/register') {
    const b = await readBody(req);
    const email = String(b.email ?? '');
    const password = String(b.password ?? '');
    const r = auth.register(email, password);
    if ('error' in r) return json(res, 400, { error: r.error });
    const sess = auth.createSession(r.owner.id);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(sess.token) });
    res.end(JSON.stringify({ ok: true, owner: { id: r.owner.id, email: r.owner.email }, sessionExpiresAt: sess.expiresAt }));
    return;
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    const b = await readBody(req);
    const email = String(b.email ?? '');
    const password = String(b.password ?? '');
    const owner = auth.login(email, password);
    if (!owner) return json(res, 401, { error: 'invalid email or password' });
    const sess = auth.createSession(owner.id);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(sess.token) });
    res.end(JSON.stringify({ ok: true, owner: { id: owner.id, email: owner.email }, sessionExpiresAt: sess.expiresAt }));
    return;
  }
  if (req.method === 'POST' && path === '/api/auth/logout') {
    const cookies = parseCookies(req.headers['cookie']);
    auth.deleteSession(cookies['sg_session']);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': clearSessionCookie() });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'GET' && path === '/api/auth/me') {
    const owner = getOwner(req);
    if (!owner) return json(res, 401, { error: 'not logged in' });
    return json(res, 200, { owner: { id: owner.id, email: owner.email } });
  }

  if (req.method === 'GET' && path === '/api/health') {
    return json(res, 200, { status: 'ok', ledger: ledger.count(), service: 'spendguard', agents: [...policies.keys()] });
  }
  if (req.method === 'GET' && path === '/api/ledger') {
    return json(res, 200, { events: ledger.list(Number(url.searchParams.get('limit') ?? 50)), integrity: ledger.verify() });
  }

  // ---- GET /api/policy (:id optional) — list or read a policy ----
  if (req.method === 'GET' && (path === '/api/policy' || path.startsWith('/api/policy/'))) {
    const id = path.split('/').pop() ?? '';
    if (id && id !== 'policy') {
      const p = policies.get(id);
      if (!p) return json(res, 404, { error: `no policy for agent '${id}'` });
      return json(res, 200, { agentId: p.agentId, policy: p.spend, guardianAddress: p.guardianAddress, note: p.note });
    }
    return json(res, 200, { agents: [...policies.values()].map((p) => ({ agentId: p.agentId, spend: p.spend, guardianAddress: p.guardianAddress, note: p.note })) });
  }

  // ---- POST /api/policy/:id/freeze | /unfreeze — emergency kill switch ----
  // (must come BEFORE the generic /api/policy/:id upsert below)
  if (req.method === 'POST' && (path.includes('/freeze') || path.includes('/unfreeze'))) {
    const isFreeze = path.includes('/freeze');
    const id = path.split('/')[3] ?? 'demo-trader';
    const p = policies.get(id);
    if (!p) return json(res, 404, { error: `no policy for '${id}'` });
    p.spend.frozen = isFreeze;
    policies.set(id, p);
    persistPolicy(id);
    const evt: Decision = {
      decisionId: randomUUID(), actionId: randomUUID(), agentId: id, kind: 'policy_control',
      verdict: 'deny' as const, reason: { code: 'frozen', detail: isFreeze ? 'agent policy FROZEN by guardian' : 'agent policy UNFROZEN by guardian' },
      decidedAt: new Date().toISOString(), nonce: `freeze-${Date.now()}`,
    };
    ledger.append(evt);
    return json(res, 200, { agentId: id, frozen: p.spend.frozen ?? false, audited: true });
  }

  // ---- POST /api/policy/:id — upsert a per-agent policy ----
  if (req.method === 'POST' && path.startsWith('/api/policy/')) {
    const id = path.split('/').pop() ?? '';
    const body = await readBody(req);
    const spend = body.spend as AgentPolicy['spend'];
    if (!spend) return json(res, 400, { error: 'spend policy required' });
    const merged: AgentPolicy = {
      agentId: id,
      spend: { ...(policies.get(id)?.spend ?? {}), ...spend },
      guardianAddress: String(body.guardianAddress ?? policies.get(id)?.guardianAddress ?? ''),
      note: String(body.note ?? policies.get(id)?.note ?? ''),
    };
    policies.set(id, merged);
    persistPolicy(id);
    return json(res, 200, { agentId: id, policy: merged.spend, saved: true });
  }

  // ---- GET /api/pending — HITL queue ----
  if (req.method === 'GET' && path === '/api/pending') {
    return json(res, 200, { pending: [...pendingHITL.values()] });
  }

  // ---- POST /api/approve {decisionId} — human completes a pending HITL gate ----
  if (req.method === 'POST' && path === '/api/approve') {
    const body = await readBody(req);
    const id = String(body.decisionId ?? '');
    const pending = pendingHITL.get(id);
    if (!pending) return json(res, 404, { error: `no pending HITL decision '${id}'` });
    dropPending(id);
    const approved: Decision = { ...pending, verdict: 'allow', reason: { code: 'ok', detail: `human-approved by ${String(body.guardian ?? '0xGuardian')}` } };
    const w = getWindow(pending.agentId, Date.now());
    if (approved.approvedBinding) {
      w.state.spent = addAmounts(w.state.spent, approved.approvedBinding.amount);
      w.state.count += 1;
      persistWindow(pending.agentId, w.state);
    }
    ledger.append(approved, `hitl:${String(body.guardian ?? '0xGuardian')}`);
    return json(res, 200, { approved: true, decision: approved, audited: true });
  }

  // ---- GET /api/proof/:actionId — retrieve the signed proof for an action ----
  if (req.method === 'GET' && path.startsWith('/api/proof/')) {
    const actionId = path.split('/').pop() ?? '';
    const events = ledger.list(500);
    const evt = events.find((e) => e.actionId === actionId);
    if (!evt) return json(res, 404, { error: `no event for action '${actionId}'` });
    // rebuild a proof-shaped object (the stored hash is the audit hash; here we
    // surface the receipt/proof linkage when present).
    const proof = {
      actionId: evt.actionId,
      decisionId: evt.hash, // audit anchor
      agentId: evt.agentId,
      verdict: evt.verdict,
      reasonCode: evt.reasonCode,
      proofHash: evt.hash,
      approved: {},
      signedAt: evt.ts,
      receiptId: evt.receiptId ?? null,
      explorerUrl: explorerHashUrl(1, evt.hash), // default chain; chain-specific when known
      payeeUrl: evt.receiptId ? explorerAddressUrl(1, evt.receiptId) : undefined,
    };
    return json(res, 200, { proof });
  }

  // ---- GET / , /app, or static asset -> UI ----
  if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/app' || path === '/app.html' || path === '/login' || path === '/login.html' || path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.svg'))) {
    let asset;
    if (path === '/app' || path === '/app.html') asset = authed ? 'app.html' : 'login.html';
    else if (path === '/login' || path === '/login.html') asset = 'login.html';
    else if (path === '/' || path === '/index.html') asset = undefined;
    else asset = path.split('/').pop();
    return serveUI(res, asset);
  }

  // ---- POST /api/demo/:id  -> replay a canned attack ----
  if (req.method === 'POST' && path.startsWith('/api/demo/')) {
    const id = path.split('/').pop() ?? '';
    const attack = CANNED_ATTACKS.find((a) => a.id === id);
    if (!attack) return json(res, 404, { error: `unknown demo '${id}'` });
    const result = await replayDrainAttack(attack);
    result.steps.forEach((s) => { if (s.decision) ledger.append(s.decision); });
    return json(res, 200, result);
  }

  // ---- POST /api/robinhood  -> gate a Robinhood MCP order ----
  if (req.method === 'POST' && path === '/api/robinhood') {
    const body = await readBody(req);
    const agentId = String(body.agentId ?? 'rh-agent');
    const order = body.order as RobinhoodOrder;
    const gate: RobinhoodAccountGate = { allowedAgenticAccount: String(body.agenticAccount ?? 'acct-AGENTIC') };
    if (!order || !order.kind || !order.notionalUsd) {
      return json(res, 400, { error: 'order {kind, notionalUsd, symbol, agenticAccount} required' });
    }
    const policy = policies.get(agentId) ?? policies.get('demo-trader')!;
    const w = getWindow(agentId, Date.now());
    const decision = await guardRobinhoodOrder(engine, agentId, order, gate, policy, w.state);
    if (decision.verdict === 'allow' && decision.approvedBinding) {
      w.state.spent = addAmounts(w.state.spent, decision.approvedBinding.amount);
      w.state.count += 1;
      persistWindow(agentId, w.state);
    }
    if (decision.verdict === 'require_human') recordPending(decision);
    ledger.append(decision);
    return json(res, 200, { decision, gated: decision.verdict, window: w.state });
  }

  // ---- POST /api/agent/action — the REAL service seam an agent calls ----
  // Body: { agentId, kind, intent: { to, amount, chainId, token }, signPayload? }
  // Runs the full rail: schema-force -> decide -> serv verify -> bind -> audit. Returns a
  // signed proof when allowed. This is what a live AgentKit/Robinhood/x402
  // agent would call before broadcasting.
  if (req.method === 'POST' && path === '/api/agent/action') {
    const body = await readBody(req);
    const agentId = String(body.agentId ?? 'demo-trader');
    const kind = String(body.kind ?? 'transfer');
    const intentPayload = (body.intent ?? {}) as Record<string, unknown>;
    // #6 schema-forced execution: reject malformed intents outright.
    const violations = validateFundingPayload(kind, intentPayload);
    if (violations.length > 0) {
      const schemaDeny: Decision = {
        decisionId: randomUUID(), actionId: randomUUID(), agentId, kind,
        verdict: 'deny', reason: { code: 'validation_error', detail: `schema violation: ${violations.map((v) => `${v.field}=${v.problem}`).join('; ')}` },
        decidedAt: new Date().toISOString(), nonce: `schema-${Date.now()}`,
      };
      ledger.append(schemaDeny);
      return json(res, 403, { decision: schemaDeny, proof: ledger.makeProof(schemaDeny), window: getWindow(agentId, Date.now()).state });
    }
    const policy = policies.get(agentId) ?? policies.get('demo-trader')!;
    const intent = {
      id: randomUUID(),
      agentId,
      kind,
      createdAt: new Date().toISOString(),
      payload: intentPayload,
    } as ActionIntent;

    const w = getWindow(intent.agentId, Date.now());
    let decision = await engine.decide(intent, policy, w.state, Date.now());

    if (decision.verdict === 'allow' || decision.verdict === 'require_human') {
      const binding = defaultPaymentNormalizer.extractBinding(intent);
      const v = await serv.verify(intent, binding);
      if (v.code === 'injection') decision = { ...decision, verdict: 'deny', reason: { code: 'injection_detected', detail: v.detail }, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
      else if (v.code === 'shadow_refused') decision = { ...decision, verdict: 'deny', reason: { code: 'shadow_verify_failed', detail: v.detail }, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
      else decision = { ...decision, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
    }
    if (decision.verdict === 'allow' && decision.approvedBinding) {
      w.state.spent = addAmounts(w.state.spent, decision.approvedBinding.amount);
      w.state.count += 1;
      persistWindow(intent.agentId, w.state);
    }
    if (decision.verdict === 'require_human') recordPending(decision);
    ledger.append(decision);

    // If the agent supplied a signable bundle, run the x402 bind as well.
    let bind = undefined;
    if (body.bundle) {
      bind = bindToApproved(decision, body.bundle as SignableBundle);
    }

    const proof = ledger.makeProof(decision);
    const chainId = defaultPaymentNormalizer.extractBinding(intent).chainId;
    return json(res, decision.verdict === 'allow' ? 200 : (decision.verdict === 'require_human' ? 202 : 403), {
      decision,
      bind,
      window: w.state,
      proof: { ...proof, explorerUrl: explorerHashUrl(chainId, proof.proofHash) },
    });
  }

  // ---- POST /api/ixs  {agentId, deposit:{vault,amountUsdc,chainId}} -> gate an RWA deposit ----
  if (req.method === 'POST' && path === '/api/ixs') {
    const body = await readBody(req);
    const agentId = String(body.agentId ?? 'demo-trader');
    const dep = body.deposit as IxsDeposit;
    if (!dep || !dep.vault || !dep.amountUsdc) {
      return json(res, 400, { error: 'deposit {vault, amountUsdc, chainId} required' });
    }
    const policy = policies.get(agentId) ?? policies.get('demo-trader')!;
    const intent = toIxsDepositIntent(agentId, { vault: dep.vault, amountUsdc: dep.amountUsdc, chainId: dep.chainId ?? 8453, strategy: dep.strategy });
    const w = getWindow(agentId, Date.now());
    let decision = await engine.decide(intent, policy, w.state, Date.now());
    if (decision.verdict === 'allow' || decision.verdict === 'require_human') {
      const binding = defaultPaymentNormalizer.extractBinding(intent);
      const v = await serv.verify(intent, binding);
      if (v.code === 'injection') decision = { ...decision, verdict: 'deny', reason: { code: 'injection_detected', detail: v.detail }, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
      else if (v.code === 'shadow_refused') decision = { ...decision, verdict: 'deny', reason: { code: 'shadow_verify_failed', detail: v.detail }, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
      else decision = { ...decision, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
    }
    if (decision.verdict === 'allow' && decision.approvedBinding) {
      w.state.spent = addAmounts(w.state.spent, decision.approvedBinding.amount);
      w.state.count += 1;
      persistWindow(agentId, w.state);
    }
    if (decision.verdict === 'require_human') recordPending(decision);
    ledger.append(decision);
    return json(res, decision.verdict === 'allow' ? 200 : (decision.verdict === 'require_human' ? 202 : 403), {
      decision, gated: decision.verdict, window: w.state, proof: ledger.makeProof(decision),
    });
  }

  // ---- POST /api/decide  -> decide -> serv verify -> bind ----
  if (req.method === 'POST' && path === '/api/decide') {
    const body = await readBody(req);
    const policy = policies.get(String(body.agentId ?? 'demo-trader')) ?? policies.get('demo-trader')!;
    const intent = {
      id: randomUUID(),
      agentId: policy.agentId,
      kind: String(body.kind ?? 'transfer'),
      createdAt: new Date().toISOString(),
      payload: body.payload ?? {},
    } as ActionIntent;

    const w = getWindow(intent.agentId, Date.now());
    let decision = await engine.decide(intent, policy, w.state, Date.now());

    if (decision.verdict === 'allow' || decision.verdict === 'require_human') {
      const binding = defaultPaymentNormalizer.extractBinding(intent);
      const v = await serv.verify(intent, binding);
      if (v.code === 'injection') decision = { ...decision, verdict: 'deny', reason: { code: 'injection_detected', detail: v.detail }, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
      else if (v.code === 'shadow_refused') decision = { ...decision, verdict: 'deny', reason: { code: 'shadow_verify_failed', detail: v.detail }, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
      else decision = { ...decision, shadow: { engine: 'serv', code: v.code, traceId: v.traceId } };
    }
    if (decision.verdict === 'allow' && decision.approvedBinding) {
      w.state.spent = addAmounts(w.state.spent, decision.approvedBinding.amount);
      w.state.count += 1;
      persistWindow(intent.agentId, w.state);
    }
    if (decision.verdict === 'require_human') recordPending(decision);
    ledger.append(decision);
    return json(res, 200, { decision, window: w.state, traceHint: `serv:${defaultPaymentNormalizer.extractBinding(intent).amount}` });
  }

  // ---- POST /api/sign  -> the x402 bill-swap bind ----
  if (req.method === 'POST' && path === '/api/sign') {
    const body = await readBody(req);
    const decision = body.decision as Decision;
    const bundle = body.bundle as SignableBundle;
    if (!decision || !bundle) return json(res, 400, { error: 'decision + bundle required' });
    const bound = bindToApproved(decision, bundle);
    if (!bound.ok) {
      const denied = { ...decision, verdict: 'deny' as const, reason: { code: bound.code, detail: bound.detail } };
      ledger.append(denied);
      return json(res, 422, { ok: false, code: bound.code, detail: bound.detail, note: 'bill-swap refused — the retry drifted from the approved binding' });
    }
    const proof = ledger.makeProof(decision);
    ledger.append(decision, `proof:${bound.proofHash}`);
    return json(res, 200, { ok: true, signPayload: bound.signPayload, proofHash: bound.proofHash, proof });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[spendguard] listening on :${PORT}`);
  console.log(`[spendguard] ledger=${LEDGER_FILE} serv=${process.env.SERV_MODE ?? 'local'}`);
  console.log(`[spendguard] agents: ${[...policies.keys()].join(', ')}`);
});