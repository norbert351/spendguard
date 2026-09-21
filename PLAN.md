# SpendGuard — Agent Trust Guardian (SERV Hackathon, Edition 01)

**Track recommendation:** AgentKit (with Mainnet/MCP + RWA rail-agnostic adapters)
**Submission goal:** Sep 28 2026 00:00 UTC
**Thesis:** The one problem under every finance track is *people don't trust an AI agent to touch their money.* SERV Reasoning is the trust layer. SpendGuard is the product that turns "dangerous agent" into "board-approved agent" — by verifying every action before it's signed, binding the signed payload to what was approved, and logging an immutable audit trail of *what it considered, did, declined & why.*

**Counterfactual test (load-bearing):** Remove the guardrail → the injection-drain / bill-swap theft returns. The mechanism must be *signed, bound, reproducible* — not a described policy UI.

---

## 🎯 One-sentence product

SpendGuard is a pre-execution guardrail + audited control plane that sits on top of a money-handling agent (AgentKit wallet / Robinhood MCP / x402 / IXS vault), verifies every action with a Shadow Agent, blocks prompt-injection before signing, enforces spend/asset policy, and emits a signed proof artifact for every decision.

---

## 🔒 LOCKED IDEAS (do not lose these — source of truth)

### A. Core guards (the engine)
1. **x402 "bill-swap" fix (#1404) — THE demo centerpiece.** Bind the signed payload to the approved amount + payee. Present `$5 @ payee` → after verification, the SAME option (amount+payee+chainId+token) must be what gets signed. Reject any mismatch. This is the reproducible, judge-visible proof.
2. **Per-agent spend limits.** One-time cap set by the operator. Deny anything over the ceiling. Log why.
3. **Action whitelist** (per asset / per recipient / per tool). Only approved actions execute.
4. **Human-in-the-loop (HITL)** for high-risk or over-threshold actions; the guardrail enforces the approval gate.
5. **Prompt-injection screen before signing.** Content the agent read is screened; a Shadow Agent independently validates intent before signature.
6. **Schema-forced execution.** The exact permitted action set is an enforced schema, so agents can't drift outside it.

### B. Audit ledger (the proof)
7. **Immutable append-only ledger** of every decision: considered / did / declined / why.
8. **Signed proof artifacts.** Each decision hash is bound (hash-chain) so the trail is tamper-evident and reproducible.
9. **Explorer-linkable receipts** for the UI + X post (Solscan-style link per decision).

### C. Social-perception hook (evidence-anchored)
10. Visa: consumers *fine letting AI shop, deeply unwilling to let it pay* (~23% trust) → the emotional hook for the X post.
11. Documented losses ($175k Grok, $200k Base, $500k router, $83.85M/106k victims) → the dollar anchor.
12. Robinhood/Binance push liability onto the user with **no audit record** → our differentiator.

### D. Revenue (honest framing)
13. **Nameable B2B buyer:** devs running AgentKit/Bedrock agents who hand-build this layer today (open issues #1168/#1445/#1061). Per-agent/month compliance subscription.
14. Scoring note: "revenue potential" is a judging criterion — we *score* on it. We do NOT claim to ship revenue in 6 days. Near-term money = $5k prize.
15. Rail-agnostic protects the best-overall $2k shot (works across all 4 tracks).

### E. Build order (thinnest verifiable artifact first)
16. Phase 1 (now): scaffold monorepo + policy engine + ledger + SERV client + agentkit adapter interface. Testable core.
17. Phase 2: x402 bill-swap binder (the demo), replayable injection-attack demo, wire AgentKit CDP action through guardrail.
18. Phase 3: API + minimal UI + explorer links, live counterfactual test.
19. Phase 4: X post naming AGENTKIT + SERV + the #1404 proof + counterfactual screenshot.

### F. Gating criteria (prove in first 48h or pivot)
20. Robinhood MCP tool inventory lands (subagent) → if weak, commit fully to AgentKit track (strongest evidence).
21. Visa split confirms "shop ok / pay not" → if weak, lead with documented losses instead.
22. Live dry-run: one AgentKit action → guardrail → rejected with reason logged + signed artifact.

---

## 🧱 Architecture (rail-agnostic monorepo)

```
spendguard/
├── packages/
│   ├── contracts/   # shared Zod schemas: actions, policy, decision, audit-event, signed-proof
│   ├── core/        # decision engine + policy evaluation (the brain)
│   ├── ledger/      # append-only audit ledger + proof hashing (node:sqlite, zero-dep)
│   ├── serv/        # SERV Reasoning client — shadow-verify-before-sign (OpenAI/Anthropic-compatible)
│   └── adapters/    # agentkit / robinhood-mcp / x402 binders
├── apps/
│   └── api/         # backend HTTP service exposing the guardrail
└── test/            # end-to-end counterfactual tests
```

**Key invariant everywhere:** *never intercept-and-sign blindly; always verify→bind→approve→sign→log.* The signed artifact is a Real proof, not a toast message.

---

## ✅ Done list (living)
- [x] PLAN.MD written (this file)
- [x] Monorepo scaffold + deps installed
- [x] contracts package (schemas)
- [x] core decision engine + tests
- [x] ledger (node:sqlite + proof chain) + tests
- [x] serv client + tests
- [x] x402 bill-swap binder + counterfactual test
- [x] agentkit adapter
- [x] API backend
- [x] build + typecheck + full test pass (28/28)
- [x] git init + push (norbert351/spendguard, master, b4d8887)

---

## 🔬 VERIFIED EVIDENCE (locked 2026-09-22 — downstream-backed thesis anchors)

### 1. Visa "23% trust" — VERIFIED FULLY (was PARTIAL)
- **Exact stat:** *"Only 23% of U.S. consumers trust GenAI to handle payment transactions on their behalf."* — Visa Trust Index for agentic commerce.
- **Methodology:** Harris Poll Omnibus on behalf of Visa, **n=2,065 US adults, fielded May 26–28 2026**, matched to US Census General Adult population. Per-brand payment question subsample = 1,028–1,034.
- **Shop-vs-pay split:** 72% have used an AI assistant (shop/recommend) vs 23% trust GenAI to PAY. ⚠️ Cite as 72% shop vs 23% pay — do NOT invent a directly-paired question.
- **Visa's plan:** Visa Intelligent Commerce (100+ cos; powers Amazon "Buy for Me" + Meta autofill), Trusted Agent Protocol, Agentic Directory, Agent Score, Agentic Ready (150+ issuers), tokenized payment "digital keys." Guardrails = authenticated tokenized credential + spend/where/when permissions + merchant whitelists + thresholds + HITL → full autonomy. B2B (procurement/invoicing) goes first.
- **Trust jump:** **61%** would trust Visa for agentic payments (23%→61%, "acceptance almost triples"); **68%** ages 18–34, **71%** frequent AI users.
- **Precision warning:** 23% is the *payment-side* trust stat — NOT general "trust AI with money." Keep it precise in the X post.
- Sources: Visa official PR + Perspectives (Jack Forestell, Chief Product & Strategy Officer), Forbes (John Koetsier, Sep 9 2026, verbatim via Yahoo Finance republication), CardRates / SmallBizTrends / FinelyPick (matched). Full report: `/home/ubuntu/forbes_visa_23percent_verification.md`.

### 2. Robinhood MCP — VERIFIED (was UNVERIFIED). This changes the Mainnet/MCP build path.
- **Exact inventory (official, Ref 5847437, live 2026-09-22): 57 documented tools** across 7 classes.
- **20 are WRITE/mutation tools** — the surface the guardrail must gate. **9 order tools:** `place/review/cancel` × {equity_order, option_order, crypto_order}. Plus 8 watchlist writes + 3 scan writes. **37 read-only.**
- **Rollout (Sep 22 2026):** order placement LIVE for **long equities + options + crypto**. Event contracts + futures NOT exposed. Crypto excluded in NY + some states; agent can't transfer/stake/lend. No margin borrowing.
- **Agentic account model:** order placement walled to separate funded "Agentic account"; read scope = ALL accounts. **No spend/loss/kill-switch cap beyond the account balance + confirmation setting** (confirmed NOT documented). Unfunded by default.
- **Audit gap confirmed (the guardrail's exact market):** no record of what the agent did/considered/declined, `agentic_allowed` account ambiguity, silent watchlist writes, irreversible fills, kill-switch can't unwind a filled trade, credentials pasted in chat. Liability 100% on customer.
- ⚠️ 57 = **maximum documented surface**; per-session exposure depends on per-account options/crypto approval → **guardrail must enumerate tools at runtime, not trust a hardcoded list.**
- Also: **Agentic Credit Card (Banking MCP)** — second supporting endpoint (`banking-agent.robinhood.com/mcp/banking`) with real guardrails (virtual-card wall, manual approval, required monthly limit). A second surface to cover.
- Full report: `/home/ubuntu/robinhood_mcp/ROBINHOOD_MCP_INVENTORY.md`. **Ignore all unofficial GitHub robin_stocks wrappers — NOT the product.**

### 3. First-person social quotes — 21 captured (16 VERIFIED full-text, 5 Reddit URL-verified, X unreachable)
- **Dominant pain = unbounded autonomy → surprise bills.** HN (all full-text fetched): `$600` overnight recursive loop (2026-03-18), `$32` runaway kill-switch story (2026-03-17), `$34,895` invoice would "financially destroy me" (2026-04-16), `$37,901.73` "complete lack of hard safety rails" (2026-04-28), GitHub `$200` silently burned by Claude Code (2026-04-25), dev.to `$47` bill (2026-05-26).
- **Trust framing:** "Would you trust an AI with $500? yes for reversible actions, not yet irreversible" (2026-03-14); "people give these agents full wallet access then get surprised when drained lol" (2026-03-22); trading agent "lost a bit of money, stop losses set too close to the top" (2026-09-08).
- **The coping = exactly SERV**: hard dollar caps, kill switches, pre-authorized spend policies — *"the trust unit is the policy, not the payment."*
- ⚠️ Reddit snippets only (403'd from this IP); X fully unreachable (no quotes). Deck should get logged-in screenshots for the social-proof section.
- Full deliverable: `/home/ubuntu/serv_evidence/quotes.md`.

### 🎯 IMPACT ON BUILD DIRECTION
- **Track: AGENTKIT remains primary** (strongest verified evidence: #1404 bill-swap bug + 3 open GitHub issues + named losses). The counterfactual binder is the load-bearing demo.
- **Mainnet/MCP is now a REAL second track** (was previously hampered by UNVERIFIED tool list): the 20 write tools + audit gap give a concrete second demo surface (e.g., a `place_crypto_order` through the guardrail). Doable by Sep 28.
- **X post should carry BOTH:** the 23%→61% Visa trust anchor AND the $600/$32/$34,895 surprise-bill quotes (all the emotional hooks). Keep the 23% wording precise (payment-side).
- **"the trust unit is the policy, not the payment"** = a strong X-post line from the research.

## 🔧 Phase 2 (next) — from the now-locked evidence
- [ ] Replayable injection-drain demo (the $600-loop / $200-claude-code style attack) → guardrail intercepts
- [ ] Real AgentKit CDP wallet action fired through the guardrail (decide→verify→bind→sign)
- [ ] Robinhood MCP `place_crypto_order` gated demo (uses the verified 57-tool surface — runtime tool enumeration)
- [ ] Minimal UI (decision feed + ledger viewer + proof card)
- [ ] X post: 23%→61% Visa anchor + surprise-bill quotes + the counterfactual screenshot