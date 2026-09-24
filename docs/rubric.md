# SpendGuard — Judge-Verification Map (docs/rubric.md)

Every SERV Hackathon judging axis mapped to the exact evidence a judge can verify in one
click — repo path, live endpoint, or code line. Honest self-flagged gaps are the signature
of trust.

**Event:** OpenServ 1st SERV Hackathon · **Track: Open Track** ("Anything that runs on SERV
Reasoning and surprises us") · closes Sep 28 00:00 UTC.

## The judged axes (verbatim from openserv.ai/hackathon) → where the evidence lives

| Axis | Where the evidence is (one click) | Depth |
|---|---|---|
| **Creativity** | **Bill-swap binder** (`packages/adapters/src/x402-binder.ts`; live `POST /api/demo/bill-swap` → `contained:true`, `x402-binder: amount_mismatch: approved 5.00 != presented 5900.00`, `notionalSaved 5900.00`) · **SERV shadow-verify** (`packages/serv/src/serv-client.ts`) · immutable consider/did/declined ledger (`packages/ledger`, `GET /api/ledger`) | Mechanism, not a fence: the "trust unit is the policy" framing |
| **User-readiness** | **Live demo** http://129.226.83.2/sg/app (multi-agent policy registry, freeze, HITL pending queue, replayable attacks, ledger with proof hashes + explorer links). 58/58 tests (`npm test`). Rail-agnostic (AgentKit/Robinhood MCP/x402/IXS). | Real, authenticated, persistent service — not a mock |
| **Revenue potential** | SaaS guardrail for funded-agent teams: per-fleet/per-agent licensing + enterprise immutable-audit/compliance tier (the artifact enterprises pay for). See `docs/SUBMISSION.md §Revenue`. | Credible line; no overclaim |
| **Leverages SERV Reasoning** (ALL tracks) | `serv.verify()` called in every money-decision path — `apps/api/src/index.ts` `/api/agent/action` (:350), `/api/ixs` (:392), `/api/decide` (:425) — verdict `shadow_refused`/`injection` **denies** the action. **Live in remote SERV mode** (`serv=remote` in the boot log). Every decision carries `shadow: {engine:'serv', code, traceId}`. | Load-bearing — removing SERV removes the drain screen |

## Verified live proof (2026-09-24)

| Claim | Proof |
|---|---|
| SERV Reasoning live | live API runs `serv=remote`; `POST /api/decide` returns `shadow:{engine:'serv',code:'ok',traceId:<hex>}` |
| SERV refused a bill-swap | real call to inference-api.openserv.ai: `passed:false, code:'shadow_refused'` on $5→$5,900 drift |
| Guardrail denies on-chain drift | `POST /api/demo/bill-swap` → `contained:true`, blocked at x402-binder, `notionalSaved 5900.00` |
| Immutable ledger | `GET /api/ledger`; `packages/ledger` `makeProof` binds each decision into a SHA-256 hash-chain with explorer-linkable proof hash |

## Honest ❌ (we did NOT do)

| Thing | Status |
|---|---|
| Coinbase AgentKit SDK | ❌ not integrated (`@coinbase/agentkit` absent) → entered **Open Track**, not AgentKit |
| Real on-chain execution behind the guardrail | ❌ the guardrail *decides/denies*; it does not itself broadcast real funds (the rails' job) |
| Fabricated SERV verdicts | ❌ ledger only records what SERV actually returned; unverified = honest note |

## What to run right before the demo video / submission

```bash
npm test                          # 58/58
curl -s -X POST -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  http://129.226.83.2/sg/api/decide \
  -d '{"agentId":"demo-trader","kind":"x402_payment","payload":{"to":"0xMerchant","amount":"5.00","chainId":1,"token":"USDC"}}'
# → decision.shadow = {engine:'serv', code:'ok', traceId}  (proves live SERV in the demo)
curl -s -X POST -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  http://129.226.83.2/sg/api/demo/bill-swap
# → contained:true, notionalSaved 5900.00 (proves the guardrail blocks the drain)
```