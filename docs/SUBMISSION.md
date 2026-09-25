# SpendGuard — SERV Hackathon Submission Pack (paste-ready)

**Event:** OpenServ 1st SERV Hackathon · **closes Sep 28 00:00 UTC**.
**How to submit (the official mechanism):** (1) post on X with all info + tag **@openservai**; (2) fill the typeform `https://form.typeform.com/to/GyPxGqRn`.
**Judged on:** creativity · user-readiness · revenue potential.

---

## Track decision — **LOCKED: Open Track**

**Enter the Open Track** ("Anything that runs on SERV Reasoning and surprises us"), decided 2026-09-24.

The build's real centerpiece is **SERV shadow-verify + x402-bind + audit ledger**, which is
exactly what the Open Track rewards. The "AgentKit" track is **not** entered: SpendGuard has
its own `agentkit.js` adapter but **not** the `@coinbase/agentkit` SDK — claiming the
AgentKit track without the SDK would be a thin, decorative integration claim. Rail-agnostic
(AgentKit / Robinhood MCP / x402 / IXS) is a strength *within* Open Track, not an AgentKit
entry.

---

## A. X post (copy, adjust emoji/images) — tag @openservai

> Started building SpendGuard for the @openservai SERV Hackathon. 🛡️
>
> Agent wallets can drain — prompt injection, "bill-swap" payload swaps, unbounded autonomy. There's no record of what a funded agent *considered, did, declined, and why*.
>
> SpendGuard is a **pre-execution guardrail + immutable audit ledger** that makes an AI agent "board-approved" before it touches money:
> - schema-forced execution (payload must match the permitted shape — or reject)
> - per-agent spend caps, window velocity, HITL, emergency freeze
> - **SERV Reasoning shadow-verify** — a second agent independently re-checks the approved binding for injection/drift before you sign
> - x402 **bill-swap binder** (freezes the signed payload to the exact approved amount + payee + chain + token)
> - append-only SHA-256 audit chain of every considered/did/declined + why, with explorer-linkable receipts
>
> Counterfactual demo (real, replayable on the live app): a $5 approve → attacker swaps to $5,900 / a different payee → **refused**. A prompt-injection drain → **refused, logged**.
>
> Live demo: https://spendguard.afterhourequity.xyz/app · Demo video: https://spendguard.afterhourequity.xyz/spendguard-demo.mp4 · Code (MIT): https://github.com/norbert351/spendguard
> [add screenshots: guardrail deny card + immutable ledger rows + inject test]
>
> #SERVHackathon #agents #safety #openserv

*(The reply — tag the account, add a clip of the deny-in-the-demo, one line: "58 tests · live · rail-agnostic (AgentKit / Robinhood MCP / x402 / IXS RWA).")*

---

## B. Typeform answers (paste-ready)

- **Project name:** SpendGuard
- **Concept (one-liner):** A pre-execution guardrail + immutable audit ledger that stops AI agents from draining wallets — before they sign — with SERV Reasoning shadow-verification, per-agent spend policies, HITL, freeze, and a signed append-only receipt trail.
- **How it leverages SERV Reasoning:** Every money action is shadow-verified by SERV before signing (`serv.verify` in `/api/agent/action`, `/api/ixs`, `/api/decide`); SERV performs the injection screen + approved-binding re-check whose verdict can deny the action; the verdict + SERV traceId are written to the audit ledger. Removing SERV removes the drain screen.
- **Creativity:** The "trust unit is the policy, not the payment" framing + the bill-swap binder (the #1404 fix) + immutable considered/did/declined ledger — security that survives prompt injection rather than relying on the agent being well-behaved.
- **User-readiness:** Live at https://spendguard.afterhourequity.xyz/app — real multi-agent policy registry, freeze/HITL/pending queue, replayable counterfactual attacks, immutable ledger, explorer links. 60/60 tests. Rail-agnostic.
- **Revenue potential (be concrete):** SaaS guardrail for agent teams — per-fleet licensing (per-agent/per-month), enterprise tier for the immutable compliance ledger + auditor export (a compliance artifact enterprises pay for), and a usage tier on signed payloads / HITL approvals. Target: the funded-agent + agentic-wallet operators that markets (MetaMask Agent Wallet, Virtuals, Binance BAOS) are growing.
- **Links:** GitHub https://github.com/norbert351/spendguard · Live demo https://spendguard.afterhourequity.xyz/app · X post (this one)

---

## C. Judging-axis proof map (what makes it score)

| Axis | Evidence in the build |
|---|---|
| **Creativity** | Bill-swap binder (#1404), SERV shadow-verify, immutable consider/did/declined SHA-256 chain — the "policy is the trust unit" angle, not a wallet UI |
| **User-readiness** | Live demo, real multi-agent policies, freeze/HITL, replayable attacks, 60/60 tests, ledger with explorer links, environment-oriented (MIT, one-command deploy) |
| **Revenue potential** | SaaS guardrail licensing + paid immutable-audit/compliance tier — the thing enterprises pay for |

---

## D. Demo video script (make before Sep 28, ≤20MB 720p, on-camera real action)
1. Landing → login.
2. **Guardrail deny (money shot):** run `POST /api/demo/bill-swap` — approve $5, attacker swaps to $5,900/different payee → **refused**, ledger row written. 
3. **Injection drain** demo → refused + logged with SERV verdict.
4. **REAL rail (the honest money shot):** fire a legit `allow` on the live app → a **real signed tx hits Base Sepolia** (sepolia.basescan.org tx link on screen, ~few seconds to mine); then fire an over-cap/injection → `deny`, **no tx**. This is the "it really moves money — safely" proof.
5. **Ledger** — append-only rows: considered / did / declined + why, explorer links. The real txHash is in the proof.
6. HITL pending → approve → action proceeds on-policy.

---

## E. Make SERV Reasoning live (one command after you have the key)
```bash
cd ~/spendguard && npm run build -w @spendguard/api && \
cd apps/api && SERV_MODE=remote \
  SERV_ENDPOINT=https://inference-api.openserv.ai/v1 \
  SERV_API_KEY=<YOUR_KEY> \
  SPENDGUARD_PORT=8181 SPENDGUARD_API_KEY=<your key> \
  node --dns-result-order=ipv4first dist/index.js
```
> ✅ **Verified live (2026-09-24):** remote SERV Reasoning is wired and running
> (`serv=remote` in the boot log). A real bill-swap verify against SERV returned
> `passed:false, code:'shadow_refused'`; a clean in-policy decide returned
> `allow` with `traceHint: serv:5.00`. The client now sends a required system
> prompt, uses a real SERV catalog model (`gpt-5.4-mini` default) and the
> `inference-api.openserv.ai/v1` endpoint by default — no code changes needed,
> just the key.

---

## F. Honest ✅/⚠️/❌ matrix (from the audit)
- ✅ 60/60 tests · typecheck clean · live deploy (/sg/, /sg/app 200) · SERV load-bearing in code · x402-binder · immutable ledger · docs set · repo pushed
- ✅ **REAL rail live (Base Sepolia testnet):** `allow` actually signs + broadcasts — verified on-chain `0x39805e56…82fb3` (block 47282295) live; `deny` → no tx. See `README.md` honest scope + `test/live-agent.mjs` (`npm run test:real`, needs `REAL_WALLET_PK`).
- ⚠️ SERV runs **remote** live (boot log `serv=remote`); falls back to `local` if the key is absent
- ⚠️ Coinbase AgentKit SDK not integrated → Open Track recommended (or wire it for AgentKit track)
- ⚠️ Submission still needs the **X post + typeform + demo video** (this pack); video now has a real money-shot step
- ❌ (intentional) no fabricated SERV verdicts; token (USDC) broadcasts refused (real rail is native-only) — an honest boundary, never a fake ERC20 tx