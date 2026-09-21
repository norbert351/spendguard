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
- [ ] Monorepo scaffold + deps installed
- [ ] contracts package (schemas)
- [ ] core decision engine + tests
- [ ] ledger (node:sqlite + proof chain) + tests
- [ ] serv client + tests
- [ ] x402 bill-swap binder + counterfactual test
- [ ] agentkit adapter
- [ ] API backend
- [ ] build + typecheck + full test pass
- [ ] git init + push