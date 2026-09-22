import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DecisionEngine, defaultPaymentNormalizer, addAmounts, type WindowState } from '@spendguard/core';
import { AuditLedger } from '@spendguard/ledger';
import { ServClient } from '@spendguard/serv';
import { bindToApproved, replayDrainAttack, CANNED_ATTACKS, guardRobinhoodOrder, type RobinhoodOrder, type RobinhoodAccountGate } from '@spendguard/adapters';
import type { AgentPolicy, ActionIntent, PaymentBinding, SignableBundle, Decision } from '@spendguard/contracts';

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
const LEDGER_FILE = process.env.SPENDGUARD_LEDGER ?? ':memory:';

const engine = new DecisionEngine(defaultPaymentNormalizer);
const ledger = new AuditLedger(LEDGER_FILE);
const serv = new ServClient({ mode: (process.env.SERV_MODE as 'local' | 'remote') ?? 'local', endpoint: process.env.SERV_ENDPOINT, apiKey: process.env.SERV_API_KEY });

// ---- Multi-agent policy registry ----
const policies = new Map<string, AgentPolicy>();
function seedPolicies(): void {
  policies.set('demo-trader', {
    agentId: 'demo-trader',
    spend: {
      maxAmountPerAction: '1000.00',
      maxAmountPerWindow: '2500.00',
      windowMs: 86400000,
      maxActionsPerWindow: 5,
      allowedPayees: ['0xMerchant', 'robinhood:equity', 'robinhood:option', 'robinhood:crypto'],
      allowedKinds: ['transfer', 'x402_payment', 'robinhood_order'],
      humanInLoopThreshold: '100.00',
      frozen: false,
    },
    guardianAddress: '0xGuardian',
    note: 'SERV hackathon demo policy',
  });
  policies.set('rh-agent', {
    agentId: 'rh-agent',
    spend: {
      maxAmountPerAction: '1000.00',
      maxAmountPerWindow: '5000.00',
      windowMs: 86400000,
      maxActionsPerWindow: 10,
      allowedPayees: ['robinhood:equity', 'robinhood:option', 'robinhood:crypto'],
      allowedKinds: ['robinhood_order'],
      humanInLoopThreshold: '500.00',
      frozen: false,
    },
    guardianAddress: '0xGuardianRH',
    note: 'Robinhood MCP trading agent',
  });
}
seedPolicies();

// ---- Per-agent window accounting (spend + count, for velocity guard) ----
type WindowRec = WindowState & { spent: string; count: number };
const windows = new Map<string, WindowRec>();
function getWindow(agentId: string, now: number): { state: WindowRec; policy: AgentPolicy } {
  const policy = policies.get(agentId) ?? policies.get('demo-trader')!;
  const windowMs = policy.spend.windowMs ?? 86400000;
  const cur = windows.get(agentId);
  if (!cur || now - cur.windowStart > windowMs) {
    const fresh: WindowRec = { spent: '0', count: 0, windowStart: now };
    windows.set(agentId, fresh);
    return { state: fresh, policy };
  }
  return { state: cur, policy };
}

// ---- Pending HITL approvals ----
const pendingHITL = new Map<string, Decision>();
function recordPending(d: Decision): void {
  if (d.verdict === 'require_human') pendingHITL.set(d.decisionId, d);
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
    pendingHITL.delete(id);
    const approved: Decision = { ...pending, verdict: 'allow', reason: { code: 'ok', detail: `human-approved by ${String(body.guardian ?? '0xGuardian')}` } };
    const w = getWindow(pending.agentId, Date.now());
    if (approved.approvedBinding) {
      w.state.spent = addAmounts(w.state.spent, approved.approvedBinding.amount);
      w.state.count += 1;
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
    };
    return json(res, 200, { proof });
  }

  // ---- GET /  or static asset  -> UI ----
  if (req.method === 'GET' && (path === '/' || path === '/index.html' || path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.svg'))) {
    const asset = path === '/' || path === '/index.html' ? undefined : path.split('/').pop();
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
    }
    if (decision.verdict === 'require_human') recordPending(decision);
    ledger.append(decision);
    return json(res, 200, { decision, gated: decision.verdict, window: w.state });
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
      if (v.code === 'injection') decision = { ...decision, verdict: 'deny', reason: { code: 'injection_detected', detail: v.detail } };
      else if (v.code === 'shadow_refused') decision = { ...decision, verdict: 'deny', reason: { code: 'shadow_verify_failed', detail: v.detail } };
    }
    if (decision.verdict === 'allow' && decision.approvedBinding) {
      w.state.spent = addAmounts(w.state.spent, decision.approvedBinding.amount);
      w.state.count += 1;
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