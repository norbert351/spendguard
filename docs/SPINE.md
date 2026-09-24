# SPINE — SpendGuard (SERV Hackathon)

- **Event:** OpenServ 1st SERV Hackathon · **submissions close Sep 28 00:00 UTC**. Submission = public X post (name/concept/images/links, tag @openservai) + typeform.
- **Judged axis (verbatim from openserv.ai/hackathon):** "Projects are judged on three things: **creativity, user-readiness, and revenue potential.**" (Plus: must *leverage SERV Reasoning* in one of the four tracks.)
- **Track (recommended):** **Open Track** — "Anything that runs on SERV Reasoning and surprises us." Rationale below in `docs/SUBMISSION.md`; the build is a rail-agnostic guardrail whose load-bearing mechanism is SERV shadow-verification + the immutable audit ledger.

## The one line the app is FOR
The pre-execution guardrail must be the thing that turns a "dangerous agent" into a "board-approved agent" — **and the SERV-shadow-verify + x402-bind mechanism must be the code that proves it, by stopping a real drain on the live demo.**

## Anti-thesis (what it is NOT)
It is NOT a policy/audit dashboard bolted onto generic rails. It is NOT a Coinbase-AgentKit wallet app (we do not ship the @coinbase/agentkit SDK — see track note). It is the guardrail mechanism itself.

## Proof bar (artifact that proves it runs)
On the live demo (`http://129.226.83.2/sg/app`), a replayable counterfactual (`POST /api/demo/:id`, `CANNED_ATTACKS`) shows the guardrail **deny** a bill-swap / injection-drain, with the SERV verdict + x402 binder + an append-only ledger row (`GET /api/ledger`) as signed proof. Counterfactual-of-record: remove the guardrail → the drain returns.

## Load-bearing sponsor integration (grep-able)
- `serv.verify(intent, binding)` called in **every** money-decision path — `apps/api/src/index.ts` `/api/agent/action`, `/api/ixs`, `/api/decide`. Its `shadow_refused`/`injection` verdict **denies** the action. Removing it removes the shadow-drain screen.
- SERV reasoning endpoint: `packages/serv/src/serv-client.ts` `remoteVerify()` → OpenAI-compatible `/chat/completions`. Currently defaults to `local` (offline deterministic) → **enable `SERV_MODE=remote` + key for the live demo** (see `.env.example`).

## The ONE mechanism this build ships (consequence it carries)
The guardrail that **refuses** a signed payload on any drift (amount/payee/chain/token) or injection — spend caps, HITL, velocity, freeze, shadow-verify, audit. Its consequence: an agent literally cannot drain a wallet past-policy.

## ONE primary user + "who it's NOT for"
Primary user: a team running a funded autonomous agent (AgentKit / Robinhood MCP / x402 / IXS vault) that needs spend governance + an audit trail their auditor/investor trusts. **Not for:** users who want a personal P2P transfer app; not a custody/account-abstraction wallet (that's the rails' job).