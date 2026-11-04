import type { FundingEntry, RoundMetrics } from '../../shared/schema.js';
import { add, money, publicId, rows, timestamp, type Row } from './facts.js';
import { payload } from './runtime.js';

export function emptyMetrics(): RoundMetrics {
  return { step_durations_ms: {}, unknown_duration_ms: 0, unknown_windows: [], protection_confirmation_ms: null,
    reference_price: null, planned_sl_price: null, planned_tp_price: null, effective_sl_pct: null, effective_tp_pct: null,
    tick_size: null, stop_grid: null, accounting_status: 'UNKNOWN', accounting_start_at: null, accounting_end_at: null,
    gross_pnl_usdt: null, fees_usdt: null, funding_usdt: null, net_pnl_usdt: null, funding_entries: null,
    equity_before_usdt: null, equity_after_usdt: null, trigger_observed_at: null, trigger_source_at: null, flat_confirmed_at: null };
}
export function fillAccounting(events: Row[], positionId: string | null): { gross: string; fees: string } | null {
  if (!positionId) return null;
  const seen = new Map<string, string>();
  let gross = '0', fees = '0', entryQuantity = '0', exitQuantity = '0';
  for (const event of events) {
    if (event.event_type !== 'fill') continue;
    const data = payload(event);
    if (data.positionId !== positionId) continue;
    const id = String(data.exchangeTradeId ?? data.exchange_trade_id ?? '');
    if (!id) return null;
    const fingerprint = JSON.stringify([data.orderRole, money(data.fillQty), money(data.fee), data.feeAsset, money(data.realizedPnl)]);
    if (seen.has(id)) { if (seen.get(id) !== fingerprint) return null; else continue; }
    const fee = money(data.fee), pnl = money(data.realizedPnl);
    const quantity = money(data.fillQty);
    if (!fee || fee.startsWith('-') || pnl === null || data.feeAsset !== 'USDT' || !quantity || quantity.startsWith('-') || quantity === '0') return null;
    if (data.orderRole === 'entry') entryQuantity = add(entryQuantity, quantity);
    else if (['exit', 'emergency', 'protection_sl', 'protection_tp'].includes(String(data.orderRole))) exitQuantity = add(exitQuantity, quantity);
    else return null;
    seen.set(id, fingerprint); gross = add(gross, pnl); fees = add(fees, fee);
  }
  return entryQuantity !== '0' && entryQuantity === exitQuantity ? { gross, fees } : null;
}

/** A complete bounded query is required before an empty income list can mean zero. */
export function fundingAccounting(response: Row, fromMs: number, toMs: number): { total: string; entries: FundingEntry[] } | null {
  if (response.complete !== true || Number(response.start_time_ms) !== fromMs || Number(response.end_time_ms) !== toMs
    || !timestamp(response.source_as_of_ms) || Number(response.source_as_of_ms) < toMs || !Array.isArray(response.entries)) return null;
  const entries: FundingEntry[] = [], seen = new Set<string>();
  let total = '0';
  for (const entry of rows(response.entries)) {
    const amount = money(entry.amount_usdt), at = timestamp(entry.transaction_time_ms), id = String(entry.public_id ?? '');
    if (amount === null || !at || !id || seen.has(id) || entry.symbol !== 'BTCUSDT' || entry.asset !== 'USDT'
      || Number(entry.transaction_time_ms) < fromMs || Number(entry.transaction_time_ms) > toMs) return null;
    seen.add(id); total = add(total, amount);
    // Even an unexpected server ID is hashed again before entering the public journal.
    entries.push({ public_id: publicId('funding', id), transaction_at: at, symbol: 'BTCUSDT', asset: 'USDT', amount_usdt: amount });
  }
  return money(response.total_funding_usdt) === total ? { total, entries } : null;
}
