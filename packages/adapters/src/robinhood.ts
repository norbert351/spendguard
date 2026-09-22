import { randomUUID } from 'node:crypto';
import type { ActionIntent, AgentPolicy, Decision } from '@spendguard/contracts';
import { DecisionEngine, defaultPaymentNormalizer } from '@spendguard/core';

/**
 * Robinhood Agentic Trading MCP adapter.
 * Verified surface (official support Ref 5847437, live 2026-09-22): 57 tools,
 * of which 20 are WRITE tools and 9 are ORDER tools the guardrail must gate.
 * This adapter models the money-moving surface so the decision engine + ledger
 * protect real agent-initiated orders.
 */

export type OrderKind = 'equity' | 'option' | 'crypto';
export type OrderSide = 'buy' | 'sell';

export interface RobinhoodOrder {
  kind: OrderKind;
  side: OrderSide;
  /** target symbol / asset id. */
  symbol: string;
  /** dollar cap the agent believes it is spending. */
  notionalUsd: string;
  /** the Agentic account the agent THINKS it is targeting. */
  agenticAccount: string;
  reviewed?: boolean;
}

/** The subset of the 57 documented tools most relevant to money movement. */
export const ROBINHOOD_WRITE_TOOLS = {
  equity: ['review_equity_order', 'place_equity_order', 'cancel_equity_order'],
  option: ['review_option_order', 'place_option_order', 'cancel_option_order'],
  crypto: ['preview_crypto_order', 'place_crypto_order', 'cancel_crypto_order'],
  watchlist: ['create_watchlist', 'update_watchlist', 'follow_watchlist', 'unfollow_watchlist', 'add_to_watchlist', 'remove_from_watchlist', 'add_option_to_watchlist', 'remove_option_from_watchlist'],
  scans: ['create_scan', 'update_scan_filters', 'update_scan_config'],
} as const;

export const ROBINHOOD_ORDER_TOOLS: string[] = [
  ...ROBINHOOD_WRITE_TOOLS.equity,
  ...ROBINHOOD_WRITE_TOOLS.option,
  ...ROBINHOOD_WRITE_TOOLS.crypto,
];

/** Read tools (37) — enumerated for completeness; not money-moving by themselves. */
export const ROBINHOOD_READ_TOOLS = [
  'get_accounts', 'get_portfolio', 'get_realized_pnl', 'get_pnl_trade_history', 'search',
  'get_watchlists', 'get_watchlist_items', 'get_option_watchlist', 'get_popular_watchlists',
  'get_equity_historicals', 'get_equity_fundamentals', 'get_financials', 'get_equity_price_book',
  'get_equity_technical_indicators', 'get_earnings_results', 'get_earnings_calendar', 'get_indexes', 'get_index_quotes',
  'get_equity_positions', 'get_equity_tax_lots', 'get_equity_quotes', 'get_equity_orders', 'get_equity_tradability',
  'get_option_level_upgrade_info', 'get_option_historicals', 'get_option_chains', 'get_option_instruments',
  'get_option_quotes', 'get_option_positions', 'get_option_orders',
  'get_currency_pairs', 'get_crypto_quotes', 'get_crypto_positions', 'get_crypto_orders',
  'get_scans', 'get_scanner_filter_specs', 'run_scan',
];

export const ROBINHOOD_TOTAL_TOOLS = ROBINHOOD_READ_TOOLS.length + ROBINHOOD_WRITE_TOOLS.equity.length + ROBINHOOD_WRITE_TOOLS.option.length + ROBINHOOD_WRITE_TOOLS.crypto.length + ROBINHOOD_WRITE_TOOLS.watchlist.length + ROBINHOOD_WRITE_TOOLS.scans.length;

/**
 * Account-boundary defence. Robinhood walls order placement to the dedicated
 * Agentic account, but a malformed/mis-routed call can hit the WRONG account
 * (`agentic_allowed` ambiguity — the audit-gap the research found). We pin the
 * intended Agentic account here so the decision engine can verify it.
 */
export interface RobinhoodAccountGate {
  /** Address/identifier the operator declares is the true Agentic account. */
  allowedAgenticAccount: string;
}

/**
 * Normalize a Robinhood order into a SpendGuard ActionIntent. Carries the
 * financial binding (payee = the exchange/account, amount = notional) so the
 * same DecisionEngine + binder + ledger protect it.
 */
export function toRobinhoodOrderIntent(
  agentId: string,
  order: RobinhoodOrder,
  gate: RobinhoodAccountGate,
): ActionIntent {
  const wrongAccount = order.agenticAccount !== gate.allowedAgenticAccount;
  return {
    id: randomUUID(),
    agentId,
    kind: 'robinhood_order',
    createdAt: new Date().toISOString(),
    payload: {
      order,
      agenticAccount: order.agenticAccount,
      agenticAllowed: gate.allowedAgenticAccount,
      // financial binding for the engine + binder:
      to: `robinhood:${order.kind}`, // payee is the broker route
      amount: order.notionalUsd,
      chainId: 1,
      token: 'RH',
      // the account-boundary sanity flag the guardrail checks first:
      accountBoundaryBreach: wrongAccount,
      orderTool: ROBINHOOD_WRITE_TOOLS[order.kind]?.[1] ?? `place_${order.kind}_order`,
    },
  };
}

/** Runtime tool-surface enumeration (mirrors Robinhood's per-session model). */
export function enumerateRobinhoodTools(eligible: { equity: boolean; option: boolean; crypto: boolean }): string[] {
  const tools = [
    ...ROBINHOOD_READ_TOOLS,
    ...ROBINHOOD_WRITE_TOOLS.equity,
    ...ROBINHOOD_WRITE_TOOLS.watchlist,
    ...ROBINHOOD_WRITE_TOOLS.scans,
  ];
  if (eligible.option) tools.push(...ROBINHOOD_WRITE_TOOLS.option);
  if (eligible.crypto) tools.push(...ROBINHOOD_WRITE_TOOLS.crypto);
  return tools;
}

/**
 * Full guardrail path for a Robinhood MCP order.
 * 1. Account boundary: refuse if the agent aimed a non-Agentic account.
 * 2. DecisionEngine: spend caps / whitelist / HITL on the notional.
 * Returns the decision; caller persists + logs it.
 */
export async function guardRobinhoodOrder(
  engine: DecisionEngine,
  agentId: string,
  order: RobinhoodOrder,
  gate: RobinhoodAccountGate,
  policy: AgentPolicy,
  window: { spent: string; windowStart: number; count?: number } = { spent: '0', windowStart: 0 },
): Promise<Decision> {
  // Account-boundary defence first (the `agentic_allowed` ambiguity).
  if (order.agenticAccount !== gate.allowedAgenticAccount) {
    return {
      decisionId: randomUUID(),
      actionId: randomUUID(),
      agentId,
      kind: 'robinhood_order',
      verdict: 'deny',
      reason: { code: 'account_boundary_breach', detail: `agent_aimed_non_agentic_account=${order.agenticAccount} (allowed=${gate.allowedAgenticAccount})` },
      decidedAt: new Date().toISOString(),
      nonce: 'rh-acct',
    };
  }
  const intent = toRobinhoodOrderIntent(agentId, order, gate);
  // Pass the caller's real window so freeze / velocity / window-cap apply.
  return engine.decide(intent, policy, window, Date.now());
}

export { defaultPaymentNormalizer };