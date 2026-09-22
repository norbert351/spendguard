import { randomUUID } from 'node:crypto';
import {
  type ActionIntent,
  type Decision,
  type DecisionReason,
  type PaymentBinding,
  type SpendPolicy,
  type AgentPolicy,
} from '@spendguard/contracts';
import { decimal, addAmounts } from './decimal.js';

/**
 * A normalize: pulls the spendable amount + payee from an action's payload.
 * Adaptors must supply this so the engine stays rail-agnostic.
 */
export interface ActionNormalizer {
  /** Extract the intended payment binding from the action payload. */
  extractBinding(action: ActionIntent): PaymentBinding;
  /** true when the action carries money movement at all. */
  isFunding(action: ActionIntent): boolean;
}

export interface WindowState {
  /** accumulated amount spent in the current window. */
  spent: string;
  /** ms epoch the current window started. */
  windowStart: number;
  /** count of funding actions in the current window (velocity guard). */
  count?: number;
}

/**
 * The decision engine. Stateless in shape; window accounting is injected so the
 * caller owns persistence. Returns a Decision the caller MUST persist + emit.
 */
export class DecisionEngine {
  constructor(private readonly normalizer: ActionNormalizer) {}

  async decide(
    intent: ActionIntent,
    policy: AgentPolicy,
    window: WindowState | null,
    now: number = Date.now(),
  ): Promise<Decision> {
    const rid = randomUUID();
    const base = {
      decisionId: rid,
      actionId: intent.id,
      agentId: intent.agentId,
      kind: intent.kind,
      decidedAt: new Date(now).toISOString(),
      nonce: `${now}-${rid.slice(0, 8)}`,
    };

    // 1. kind whitelist
    const allowedKinds = policy.spend.allowedKinds ?? [];
    if (allowedKinds.length > 0 && !allowedKinds.includes(intent.kind)) {
      return this.deny(base, { code: 'kind_not_allowed', detail: `action kind '${intent.kind}' not on policy allowlist` });
    }

    // Only funding actions carry a binding to validate.
    if (!this.normalizer.isFunding(intent)) {
      return { ...base, verdict: 'allow', reason: { code: 'ok', detail: 'non-funding action cleared by policy' } };
    }

    const binding = this.normalizer.extractBinding(intent);
    const sp = policy.spend;

    // 1.5 emergency freeze — deny ALL funding actions.
    if (sp.frozen === true) {
      return this.deny(base, { code: 'frozen', detail: 'agent policy is frozen; no funding actions allowed until unfrozen' });
    }

    // 1.6 velocity guard — cap funding actions per window.
    if (sp.maxActionsPerWindow !== undefined && sp.windowMs !== undefined && window) {
      const count = window.count ?? 0;
      if (count >= sp.maxActionsPerWindow) {
        return this.deny(base, {
          code: 'rate_limited',
          detail: `window already used ${count} funding actions (cap ${sp.maxActionsPerWindow})`,
        });
      }
    }

    // 2. payee whitelist
    const allowedPayees = sp.allowedPayees ?? [];
    if (allowedPayees.length > 0 && !allowedPayees.includes(binding.payTo)) {
      return this.deny(base, { code: 'payee_not_allowed', detail: `payee ${binding.payTo} not on policy allowlist` });
    }

    // 3. per-action cap
    if (decimal.gt(binding.amount, sp.maxAmountPerAction)) {
      return this.deny(base, {
        code: 'over_spend_limit',
        detail: `amount ${binding.amount} exceeds per-action cap ${sp.maxAmountPerAction}`,
      });
    }

    // 4. window cap
    if (sp.maxAmountPerWindow !== undefined && sp.windowMs !== undefined && window) {
      if (decimal.gt(sqlAdd(binding.amount, window.spent), sp.maxAmountPerWindow)) {
        return this.deny(base, {
          code: 'over_window_limit',
          detail: `window spend ${sqlAdd(binding.amount, window.spent)} exceeds cap ${sp.maxAmountPerWindow}`,
        });
      }
    }

    // 5. human in the loop threshold
    if (sp.humanInLoopThreshold !== undefined && decimal.gt(binding.amount, sp.humanInLoopThreshold)) {
      return { ...base, verdict: 'require_human', reason: { code: 'human_required', detail: `amount ${binding.amount} above HITL threshold` }, approvedBinding: binding };
    }

    return {
      ...base,
      verdict: 'allow',
      reason: { code: 'ok', detail: 'action passed all spend/policy checks' },
      approvedBinding: binding,
    };
  }

  private deny(
    base: Pick<Decision, 'decisionId' | 'actionId' | 'agentId' | 'decidedAt' | 'nonce'>,
    reason: DecisionReason,
  ): Decision {
    return { ...base, verdict: 'deny', reason };
  }
}

/**
 * Decimal-string addition moved to decimal.ts. Re-exported here for
 * backward-compat with the engine's public surface.
 */
export { addAmounts } from './decimal.js';

// internal alias to avoid duplicate logic above
function sqlAdd(a: string, b: string): string {
  return addAmounts(a, b);
}

export type { SpendPolicy };