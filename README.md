# SpendGuard — Agent Trust Guardian

**A pre-execution guardrail + audited control plane that stops AI agents from draining wallets — before they sign.**

> *The one problem under every finance track is people don't trust an AI agent to touch their money. SpendGuard turns a "dangerous agent" into a "board-approved agent" by verifying every action before it's signed, binding the signed payload to exactly what was approved, and logging an immutable audit trail of what the agent *considered, did, declined & why*.*

---

## 🎯 Why it exists

SERV Hackathon · **Track: AgentKit** (rail-agnostic — works across AgentKit / Robinhood MCP / x402 / IXS RWA vaults)

| Evidence (verified) | The problem SpendGuard solves |
|---|---|
| **x402 "bill-swap" #1404** | Approve $5 → attacker swaps the signed payload to $5,900 / a different payee. |
| **Prompt-injection wallet drains** ($175k–$500k documented losses) | Agents read attacker content and exfil money, no guard, no record. |
| **AgentKit ships "no spending limits — add them yourself"** (OpenFort scan) | No per-agent caps, no HITL, no freeze by default. |
| **Robinhood/Binance push liability onto the user with NO audit trail** (verified, Ref 5847437) | Agents act with no record of what they did/declined. |
| **Unbounded autonomy → surprise bills** (`$600` overnight loop, `$34,895` invoice, `$37,901.73`) | The dominant real-world complaint from first-person sources. |

**Zen line from the research:** *"the trust unit is the policy, not the payment."*

---

## ⚙️ What it does (the rail)

Every money action passes through the guardrail — **nothing is signed blind**:

```
schema-force → decide → shadow-verify → bind → audit
```

1. **Schema-forced execution** — the action payload must match the exact permitted shape (`to`/`amount`/`chainId`/`token`) or it's rejected.
2. **Decision engine** — per-agent spend caps, window velocity, payee/kind whitelists, human-in-the-loop (HITL), emergency freeze.
3. **Shadow-agent verification** — a second agent independently validates intent; screens prompt injection before signing.
4. **x402 binder** — freezes the signed payload to the **exact approved amount + payee + chainId + token**; any drift is refused. *(The #1404 fix.)*
5. **Immutable audit ledger** — append-only SHA-256 hash-chain of every considered/did/declined + why, with signed proof artifacts and **explorer-linkable receipts**.

**Counterfactual (test-of-record):** remove the guardrail → the injection-drain / bill-swap returns. The mechanism is *signed, bound, reproducible* — not a described policy UI.

---

## 🧱 Architecture (rail-agnostic monorepo)

```
spendguard/
├── packages/
│   ├── contracts/   # shared Zod schemas + schema-forced validation + explorer links
│   ├── core/        # decision engine + policy evaluation (the brain)
│   ├── ledger/      # append-only audit ledger + SHA-256 proof chain (node:sqlite, zero-dep)
│   ├── serv/        # SERV Reasoning shadow-verify-before-sign client (schema-forced)
│   └── adapters/    # agentkit / robinhood-mcp / x402 / ixs-rwa guards + binders
├── apps/
│   └── api/         # backend HTTP service exposing the guardrail (zero-dep node:http)
└── test/            # end-to-end counterfactual tests
```

**Invariant everywhere:** *never intercept-and-sign blindly; always `verify → bind → approve → sign → log`.*

---

## 🚀 Quickstart

```bash
git clone https://github.com/norbert351/spendguard.git
cd spendguard
npm install

# build + test
npm run build        # all 6 packages → dist/
npm run test         # 58 tests, all 6 packages
npm run typecheck

# run the API service
SPENDGUARD_PORT=8181 \
SPENDGUARD_API_KEY=change-me \
SPENDGUARD_LEDGER=./data/audit.sqlite \
node apps/api/dist/index.js
```

Open the control plane → **http://localhost:8181/app** · landing → **http://localhost:8181/**

---

## 🔌 The live-agent service seam

A real agent calls `POST /api/agent/action` before broadcasting:

```bash
curl -X POST http://localhost:8181/api/agent/action \
  -H "x-api-key: $SPENDGUARD_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "agentId": "demo-trader",
    "kind": "transfer",
    "intent": { "to": "0xMerchant", "amount": "50.00", "chainId": 8453, "token": "USDC" }
  }'
```

Response semantics (proper HTTP):
- `200` → allow + signed proof (with explorer link)
- `202` → require_human (needs `POST /api/approve`)
- `403` → deny, reason logged (over-cap / payee / injection / schema / frozen)

### Full API surface

| Method & path | Purpose |
|---|---|
| `GET  /api/health` | service status + registered agents |
| `POST /api/agent/action` | **the live-agent guardrail seam** |
| `POST /api/decide` | decide → serv-verify → bind |
| `POST /api/robinhood` | gate a Robinhood MCP order (account-boundary defended) |
| `POST /api/demo/:id` | replay a canned attack (bill-swap / exfil / overnight-loop) |
| `GET/POST /api/policy(/:id)` | multi-agent policy registry |
| `POST /api/policy/:id/{freeze,unfreeze}` | emergency kill-switch |
| `GET  /api/pending` · `POST /api/approve` | human-in-the-loop queue + completion |
| `GET  /api/proof/:actionId` | signed proof artifact + explorer link |
| `GET  /api/ledger` | append-only audit trail + chain-integrity check |

---

## 🧪 Tests (58)

- **contracts** — schema-forced validation + explorer links (6)
- **core** — decision engine: caps, whitelists, HITL, freeze, velocity (16)
- **ledger** — append-only, hash-chain tamper-evidence, receipts (7)
- **serv** — shadow-verify injection screen (5)
- **adapters** — x402 bill-swap binder (5), Robinhood gating + drain counterfactual (15), IXS RWA (4)
- End-to-end counterfactual: **bill-swap contained · overnight-loop stopped · exfil blocked**

---

## ⚠️ Honest scope (what is / isn't wired)

**Build is feature-complete and verified** — persistent DB, key-auth, schema-forced, explorer receipts, HITL, freeze, velocity, live-agent seam, 3 agents + IXS RWA track.

**Not production-money-wired:** the adapters gate *real-shaped* intents but do NOT broadcast real transfers — a live AgentKit CDP / real Robinhood order still needs the operator's credentials + a funded account. The guardrail rail is fully functional; the rails' keys are the final integration step.

---

## 📄 License

MIT — see [LICENSE](LICENSE).

---

*SpendGuard · Agent Trust Guardian · built for the SERV Hackathon, Sep 2026.*