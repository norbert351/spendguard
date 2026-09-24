# SpendGuard Architecture

## The rail (invariant everywhere)

```
schema-force  →  decide  →  shadow-verify  →  bind  →  audit
```

Nothing is signed blind. Every money action from any rail (AgentKit / Robinhood MCP / x402 / IXS RWA) flows through the same five stages before it touches a signing key.

## Packages

| Package | Responsibility |
|---|---|
| **contracts** | Shared Zod schemas: action intents, spend policy, decision, audit event, signed proof. Plus schema-forced validation (`validateFundingPayload`) and explorer-link helpers (`explorerHashUrl`/`explorerAddressUrl`). |
| **core** | `DecisionEngine` — policy evaluation: per-agent caps, window velocity, payee/kind whitelists, HITL threshold, emergency freeze. Float-safe decimal math (`addAmounts`). |
| **ledger** | `AuditLedger` — append-only `node:sqlite` store with a SHA-256 hash chain (each event stores `{hash, prev_hash}` → tamper-evident). Also persists policies + windows + config. Zero dependencies. |
| **serv** | `ServClient` — shadow "verify-before-sign" Reasoning client. `local` mode is a deterministic screen (prompt-injection + shadow-refusal); `remote` mode calls an OpenAI/Anthropic-compatible endpoint with a **schema-forced** bounded verdict. |
| **adapters** | Rail guards + binders: `agentkit.ts` (real transfer guard), `robinhood.ts` (57-tool MCP surface + account-boundary defence), `x402-binder.ts` (bill-swap fix #1404), `ixs.ts` (RWA vault deposit), `drain-demo.ts` (replayable counterfactual). |

## App

**`apps/api`** — a zero-dependency `node:http` backend (no framework). Routes expose the full guardrail:

- `POST /api/agent/action` — the live-agent service seam
- `POST /api/decide`, `POST /api/robinhood`, `POST /api/demo/:id`
- `GET/POST /api/policy`, `POST /api/policy/:id/{freeze,unfreeze}`
- `GET /api/pending`, `POST /api/approve`, `GET /api/proof/:actionId`, `GET /api/ledger`
- Static UI: `/` (landing), `/app` (control plane), plus generated images.

**Persistence:** a single sqlite file (`data/audit.sqlite`, configurable via `SPENDGUARD_LEDGER`) stores the audit ledger, policies, windows, and pending-HITL queue — so nothing resets on restart.

**Auth:** all `/api/*` require `x-api-key` (`SPENDGUARD_API_KEY`). Public: landing + control-plane UI shell + static assets.

## Security model

- **Schema-forced execution** — malformed intents are rejected before the engine (`validation_error`).
- **Decision engine** — policy is the source of truth: caps, whitelists, HITL, freeze.
- **Shadow verification** — an independent check screens prompt injection and refuses suspicious intent.
- **x402 binder** — the signed payload is bound to the *approved* amount+payee+chain+token. This is the #1404 bill-swap fix.
- **Audit ledger** — every considered/did/declined + why is hashed into a tamper-evident chain with signed proof artifacts + explorer links.

## Testing

- **Unit** (`npm run test`): 58 tests across all 6 packages.
- **E2E** (`npm run test:e2e`): boots the real API and drives the full rail — auth, schema-force, all 3 counterfactuals, live allow/deny, chain integrity.

## Deploy

- **Render:** `render.yaml` blueprint (connect the repo in Render; persistent disk for the ledger).
- **Docker:** `Dockerfile` (node:22-slim, healthcheck, env-driven).
- **Local:** see README quickstart.