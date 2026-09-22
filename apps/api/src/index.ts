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
 * ledger. Stateless across restarts (in-memory window accounting + sqlite ledger
 * at data/audit.sqlite). Lightweight on purpose: runs on a 3.6GB VM.
 */

const PORT = Number(process.env.SPENDGUARD_PORT ?? 8181);
const LEDGER_FILE = process.env.SPENDGUARD_LEDGER ?? ':memory:';

const engine = new DecisionEngine(defaultPaymentNormalizer);
const ledger = new AuditLedger(LEDGER_FILE);
const serv = new ServClient({ mode: (process.env.SERV_MODE as 'local' | 'remote') ?? 'local', endpoint: process.env.SERV_ENDPOINT, apiKey: process.env.SERV_API_KEY });

// Demo agent policy + a tiny persisted spend tracker.
const defaultAgent: AgentPolicy = {
  agentId: 'demo-trader',
  spend: {
    maxAmountPerAction: '1000.00',
    maxAmountPerWindow: '2500.00',
    windowMs: 86400000,
    allowedPayees: ['0xMerchant', 'robinhood:equity', 'robinhood:option', 'robinhood:crypto'],
    allowedKinds: ['transfer', 'x402_payment', 'robinhood_order'],
    humanInLoopThreshold: '100.00',
  },
  guardianAddress: '0xGuardian',
  note: 'SERV hackathon demo policy',
};

const windows = new Map<string, WindowState>();
function getWindow(agentId: string, now: number): WindowState {
  const w = windows.get(agentId);
  const owner = { spent: '0', windowStart: now };
  if (!w || now - w.windowStart > (defaultAgent.spend.windowMs ?? 86400000)) {
    windows.set(agentId, owner);
    return owner;
  }
  return w;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Serve the bundled static UI (single-file HTML). */
function serveUI(res: ServerResponse): void {
  const uiPath = new URL('../public/index.html', import.meta.url).pathname;
  if (!existsSync(uiPath)) {
    return json(res, 500, { error: 'UI not bundled; run npm run build -w @spendguard/api' });
  }
  const html = readFileSync(uiPath, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/health') {
    return json(res, 200, { status: 'ok', ledger: ledger.count(), service: 'spendguard' });
  }

  if (req.method === 'GET' && path === '/api/ledger') {
    return json(res, 200, { events: ledger.list(Number(url.searchParams.get('limit') ?? 50)), integrity: ledger.verify() });
  }

  if (req.method === 'GET' && path === '/api/policy') {
    return json(res, 200, { agentId: defaultAgent.agentId, policy: defaultAgent.spend, guardianAddress: defaultAgent.guardianAddress });
  }

  // GET /  -> static UI (decision feed + ledger + demo trigger)
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    return serveUI(res);
  }

  // POST /api/demo/:id  -> run one of the canned attacks through the counterfactual
  if (req.method === 'POST' && path.startsWith('/api/demo/')) {
    const id = path.split('/').pop() ?? '';
    const attack = CANNED_ATTACKS.find((a) => a.id === id);
    if (!attack) return json(res, 404, { error: `unknown demo '${id}'` });
    const result = await replayDrainAttack(attack);
    // log a summary into the audit ledger so it shows on the feed
    result.steps.forEach((s) => {
      if (s.decision) ledger.append(s.decision);
    });
    return json(res, 200, { attack: result.attack, contained: result.contained, steps: result.steps, loopsStopped: result.loopsStopped, notionalSaved: result.notionalSaved, traceId: result.traceId });
  }

  // POST /api/robinhood  {agentId, order, agenticAccount}  -> gate a Robinhood MCP order
  if (req.method === 'POST' && path === '/api/robinhood') {
    const body = await readBody(req);
    const agentId = String(body.agentId ?? defaultAgent.agentId);
    const order = body.order as RobinhoodOrder;
    const gate: RobinhoodAccountGate = { allowedAgenticAccount: String(body.agenticAccount ?? 'acct-AGENTIC') };
    if (!order || !order.kind || !order.notionalUsd) {
      return json(res, 400, { error: 'order {kind, notionalUsd, symbol, agenticAccount} required' });
    }
    const decision = await guardRobinhoodOrder(engine, agentId, order, gate, defaultAgent as never);
    ledger.append(decision);
    return json(res, 200, { decision, gated: decision.verdict });
  }

  // POST /api/decide  {agentId, kind, payload}
  // Runs decide -> serv verify -> binder. Returns the raw decision.
  if (req.method === 'POST' && path === '/api/decide') {
    const body = await readBody(req);
    const intent = {
      id: randomUUID(),
      agentId: String(body.agentId ?? defaultAgent.agentId),
      kind: String(body.kind ?? 'transfer'),
      createdAt: new Date().toISOString(),
      payload: body.payload ?? {},
    } as ActionIntent;

    if (intent.agentId !== defaultAgent.agentId) {
      return json(res, 400, { error: 'unknown agent' });
    }

    const now = Date.now();
    const window = getWindow(intent.agentId, now);
    let decision = await engine.decide(intent, defaultAgent, window, now);

    // If it's funding and allowed-at-this-stage, run shadow verification first.
    if (decision.verdict === 'allow' || decision.verdict === 'require_human') {
      const binding = defaultPaymentNormalizer.extractBinding(intent);
      const v = await serv.verify(intent, binding);
      if (v.code === 'injection') {
        decision = { ...decision, verdict: 'deny', reason: { code: 'injection_detected', detail: v.detail } };
      } else if (v.code === 'shadow_refused') {
        decision = { ...decision, verdict: 'deny', reason: { code: 'shadow_verify_failed', detail: v.detail } };
      }
    }

    if (decision.verdict === 'allow' && decision.approvedBinding) {
      window.spent = addAmounts(window.spent, decision.approvedBinding.amount);
    }

    ledger.append(decision);
    return json(res, 200, { decision, traceHint: `serv:${defaultPaymentNormalizer.extractBinding(intent).amount}` });
  }

  // POST /api/sign  {decision, bundle}  -> the BIND (bill-swap guard).
  // Mirrors the 402 retry contact. Refuses if the retry drifted from approval.
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
    // Successfully bound; emit a proof artifact.
    const proof = ledger.makeProof(decision);
    ledger.append(decision, `proof:${bound.proofHash}`);
    return json(res, 200, { ok: true, signPayload: bound.signPayload, proofHash: bound.proofHash, proof });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[spendguard] listening on :${PORT}`);
  console.log(`[spendguard] ledger=${LEDGER_FILE} serv=${process.env.SERV_MODE ?? 'local'}`);
  console.log(`[spendguard] health  http://127.0.0.1:${PORT}/api/health`);
  console.log(`[spendguard] decide  POST /api/decide   sign  POST /api/sign   ledger GET /api/ledger`);
});