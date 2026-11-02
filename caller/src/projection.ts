import type { AccountView, CheckResult, OpenOrderView, PositionView, ProtectionLegView, ProtectionPairView, StateResponse } from '../../shared/schema.js';
import { verifyProtection } from './protection.js';
import { abs, add, BTC, fresh, money, multiply, publicId, row, rows, safeReason, text, timestamp, type Row } from './facts.js';

export interface CoreSnapshot {
  account: Row; positions: Row; orders: Row; accountOrders: Row; kills: Row;
  receivedAt: number; bootStartedAt: number;
}
export interface AccountSettings { positionMode: 'ONE_WAY' | 'HEDGE' | 'UNKNOWN'; marginMode: 'CROSS' | 'ISOLATED' | 'UNKNOWN'; leverage: number | null }

function nativeTime(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && timestamp(parsed) !== null ? parsed : null;
}
function sourceState(values: unknown[], now: number): 'AVAILABLE' | 'STALE' | 'UNKNOWN' {
  const times = values.map(nativeTime);
  return times.some(value => value === null || value > now) ? 'UNKNOWN'
    : times.some(value => !fresh(value, now)) ? 'STALE' : 'AVAILABLE';
}
function oldestSource(values: unknown[]): string | null {
  const known = values.map(nativeTime).filter((value): value is number => value !== null);
  return known.length ? timestamp(Math.min(...known)) : null;
}
function sourceTimestamp(value: unknown): string | null {
  const parsed = nativeTime(value);
  return parsed === null ? null : timestamp(parsed);
}
function positivePrice(value: unknown): string | null {
  const parsed = money(value);
  return parsed !== null && parsed !== '0' && !parsed.startsWith('-') ? parsed : null;
}
function heldRows(values: Row[]): Row[] {
  // Invalid/missing quantities are retained for a coverage failure, never
  // filtered as though they had been measured as zero.
  return values.filter(value => money(value.qty) !== '0');
}
function instrument(value: unknown): string {
  const asset = typeof value === 'string' ? value.split('|')[2] : undefined;
  return asset && /^[A-Z0-9]{1,24}$/.test(asset) ? asset : '未知品种';
}
function scopes(values: Row[], direction: 'direction' | 'side'): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const quantity = money(value.qty);
    if (quantity === null || quantity === '0' || !['long', 'short'].includes(String(value[direction]))) continue;
    const key = `${value.symbol_key}|${value[direction]}`;
    result.set(key, add(result.get(key) ?? '0', abs(quantity)));
  }
  return result;
}
function sameScopes(local: Row[], account: Row[]): boolean {
  const a = scopes(local, 'direction'), b = scopes(account, 'side');
  return a.size === b.size && [...a].every(([key, quantity]) => b.get(key) === quantity);
}
function enumIs(value: unknown, number: number, name: string): boolean {
  return value === number || value === String(number) || value === name;
}
function sectionComplete(section: Row): boolean {
  const meta = row(section.meta), list = rows(section.rows);
  return Array.isArray(section.rows) && enumIs(meta.coverage, 2, 'AOC_COMPLETE_VENUE') && meta.overflow === false &&
    (meta.returned_count === list.length || meta.returned_count === String(list.length)) &&
    (meta.total_count === list.length || meta.total_count === String(list.length)) && list.every(value => value.identity_valid === true);
}

export function protectionView(snapshot: CoreSnapshot, position: Row, credentialId: string): ProtectionPairView {
  const orders = snapshot.accountOrders, venue = row(orders.venue);
  if (position.symbol_key !== BTC || !['long', 'short'].includes(String(position.direction)) ||
      position.credential_id !== credentialId) {
    const unknownLeg = (kind: 'SL' | 'TP'): ProtectionLegView => ({ kind, status: 'UNKNOWN', reason: '持仓身份或方向不足，不能核对保护单',
      reason_code: 'PROTECTION_UNKNOWN', order_id: null, trigger_price: null, venue_status: null,
      observed_at: sourceTimestamp(orders.observed_at_ms), source_as_of: sourceTimestamp(venue.source_as_of_ms) });
    return { position_id: publicId('position', position.position_id), observation_id: null, sl: unknownLeg('SL'), tp: unknownLeg('TP') };
  }
  const result = verifyProtection({ snapshot: orders, credential_id: credentialId,
    position_id: String(position.position_id), symbol_key: BTC,
    direction: position.direction === 'short' ? 'short' : 'long',
    expected_boot_id: String(orders.engine_boot_id ?? ''), boot_started_at_ms: snapshot.bootStartedAt, now_ms: snapshot.receivedAt });
  const leg = (kind: 'SL' | 'TP'): ProtectionLegView => {
    const fact = result[kind === 'SL' ? 'sl' : 'tp'];
    const target = rows(row(venue.algo).rows).find(o =>
      (fact.exchange_algo_id && o.algo_id === fact.exchange_algo_id) ||
      (fact.client_algo_id && o.client_algo_id === fact.client_algo_id));
    return { kind, status: fact.status, reason: safeReason(fact.reason, [credentialId]),
      reason_code: `PROTECTION_${fact.status}`, order_id: target ? publicId('algo', target.algo_id ?? target.client_algo_id) : null,
      trigger_price: positivePrice(target?.trigger_price), venue_status: text(fact.venue_status) ? safeReason(fact.venue_status, [credentialId]) : null,
      observed_at: sourceTimestamp(orders.observed_at_ms), source_as_of: sourceTimestamp(venue.source_as_of_ms) };
  };
  return { position_id: publicId('position', position.position_id), observation_id: result.observation_id ? publicId('observation', result.observation_id) : null,
    sl: leg('SL'), tp: leg('TP') };
}

export function projectSnapshot(previous: StateResponse, snapshot: CoreSnapshot, credentialId: string, settings: AccountSettings): StateResponse {
  const { account, positions, accountOrders, receivedAt: now } = snapshot;
  const output = structuredClone(previous);
  output.generated_at = new Date(now).toISOString();
  output.rustcore = { status: 'ONLINE', checked_at: output.generated_at, last_restart_at: previous.rustcore.last_restart_at, reason: '公开 gRPC 读取成功；恢复状态由场景单独核对' };
  const accountGood = account.available === true && money(account.equity_usdt) !== null && money(account.available_usdt) !== null;
  const accountTime = sourceState([account.as_of_ms], now);
  const accountValue: AccountView | null = accountGood ? { account_label: 'testnet-demo', equity_usdt: String(money(account.equity_usdt)),
    available_usdt: String(money(account.available_usdt)), position_mode: settings.positionMode, margin_mode: settings.marginMode, btc_leverage: settings.leverage } : null;
  output.account = { status: account.available === false ? 'UNAVAILABLE' : !accountGood ? 'UNKNOWN' : accountTime,
    observed_at: sourceTimestamp(account.observed_at_ms), source_as_of: sourceTimestamp(account.as_of_ms), value: accountValue,
    reason: !accountGood ? '账户事实不可用或字段缺失；没有补造金额' : accountTime === 'UNKNOWN' ? '账户源时间缺失、无效或位于未来' : accountTime === 'AVAILABLE' ? '交易所账户事实' : '账户源数据已过期' };

  const localRows = rows(positions.positions), accountRows = rows(account.positions);
  const held = heldRows(localRows), accountHeld = heldRows(accountRows);
  const arraysPresent = Array.isArray(positions.positions) && Array.isArray(positions.orphan_positions) && Array.isArray(account.positions);
  const unsupported = [...new Set([...held, ...rows(positions.orphan_positions), ...accountHeld]
    .filter(p => p.symbol_key !== BTC).map(p => instrument(p.symbol_key)))];
  const orphan = rows(positions.orphan_positions).length > 0;
  const invalid = localRows.some(p => money(p.qty) === null) || accountRows.some(p => money(p.qty) === null) ||
    held.some(p => !['long', 'short'].includes(String(p.direction)) || p.credential_id !== credentialId || !text(p.position_id)) ||
    accountHeld.some(p => !['long', 'short'].includes(String(p.side)));
  const mismatch = arraysPresent && !sameScopes(held, accountHeld);
  const sourceTimes: unknown[] = [account.as_of_ms, ...held.map(p => p.last_reconciled_ms),
    ...accountHeld.filter(p => p.mark_truth !== undefined && p.mark_truth !== null).map(p => row(p.mark_truth).source_timestamp_ms)];
  const positionTime = sourceState(sourceTimes, now);
  let missingPrices = false, invalidState = false;
  const value: PositionView[] = held.filter(p => p.symbol_key === BTC && money(p.qty) !== null &&
    ['long', 'short'].includes(String(p.direction)) && p.credential_id === credentialId && text(p.position_id)).map(p => {
    const marks = accountRows.filter(a => a.symbol_key === BTC && a.side === p.direction);
    const price = marks.length === 1 ? positivePrice(marks[0]!.mark_price) : null;
    const entry = positivePrice(p.entry_price), quantity = abs(money(p.qty)!);
    if (price === null || entry === null) missingPrices = true;
    const allowed = ['PENDING', 'OPEN', 'PROTECTED', 'CLOSING', 'FLATTENING', 'CLOSED'] as const;
    const state = String(p.state).toUpperCase();
    if (!allowed.includes(state as typeof allowed[number]) || state === 'CLOSED') invalidState = true;
    return { position_id: publicId('position', p.position_id), symbol: 'BTCUSDT', side: p.direction === 'short' ? 'SHORT' : 'LONG', quantity,
      entry_price: entry, mark_price: price, notional_usdt: price !== null ? multiply(quantity, price) : null,
      state: allowed.includes(state as typeof allowed[number]) ? state as typeof allowed[number] : 'UNKNOWN', source_as_of: sourceTimestamp(p.last_reconciled_ms) };
  });
  const positionReasons = [
    ...(!arraysPresent ? ['完整账户持仓数组缺失，不能宣称空仓'] : []),
    ...(!accountGood ? ['账户 available 或金额事实不可用'] : []),
    ...(unsupported.length ? [`公开 v1 未覆盖持仓品种：${safeReason(unsupported.join(', '), [credentialId])}`] : []),
    ...(orphan ? ['存在孤儿持仓，不能宣称完整'] : []), ...(invalid ? ['持仓数量、身份或方向字段无效/缺失'] : []),
    ...(mismatch ? ['本地与账户持仓范围或数量不一致'] : []), ...(missingPrices ? ['活跃持仓价格事实不足，价格及名义额保持未知'] : []),
    ...(invalidState ? ['持仓状态无效或与非零数量冲突'] : []),
    ...(positionTime === 'UNKNOWN' ? ['持仓或账户源时间缺失、无效或位于未来'] : positionTime === 'STALE' ? ['持仓或账户源数据过期'] : []),
  ];
  output.positions = { status: !arraysPresent || !accountGood ? 'UNKNOWN' : unsupported.length || orphan || invalid || mismatch || missingPrices || invalidState ? 'PARTIAL' : positionTime,
    observed_at: output.generated_at, source_as_of: oldestSource(sourceTimes), value: arraysPresent && accountGood ? value : null,
    reason: positionReasons.join('；') || '完整账户范围的 BTCUSDT 持仓投影' };

  const venue = row(accountOrders.venue);
  const attempt = row(venue.latest_attempt), start = nativeTime(venue.capture_started_at_ms), end = nativeTime(venue.capture_completed_at_ms);
  const source = nativeTime(venue.source_as_of_ms);
  const complete = enumIs(venue.availability, 1, 'AOA_AVAILABLE') && attempt.status === 'succeeded' && attempt.coverage === 'full_account' &&
    text(venue.observation_id) !== null && attempt.observation_id === venue.observation_id &&
    accountOrders.credential_id === credentialId && venue.credential_id === credentialId &&
    text(accountOrders.engine_boot_id) !== null && venue.engine_boot_id === accountOrders.engine_boot_id &&
    start !== null && end !== null && source !== null && start >= snapshot.bootStartedAt && end >= start && end <= now &&
    end - start <= 30_000 && source >= start && source <= end && nativeTime(attempt.started_at_ms) === start && nativeTime(attempt.completed_at_ms) === end &&
    ['ordinary', 'algo'].every(name => {
      const section = row(venue[name]), a = nativeTime(section.started_at_ms), b = nativeTime(section.completed_at_ms);
      return sectionComplete(section) && a !== null && b !== null && a >= start && b >= a && b <= end;
    });
  const venueTime = sourceState([venue.source_as_of_ms, venue.capture_started_at_ms], now), venueFresh = venueTime === 'AVAILABLE';
  const venueOrders: Row[] = [...rows(row(venue.ordinary).rows).map<Row>(o => ({ ...o, section: 'ordinary' })), ...rows(row(venue.algo).rows).map<Row>(o => ({ ...o, section: 'algo' }))];
  const unknownOrders = venueOrders.some(o => o.symbol !== 'BTCUSDT');
  const orderValue: OpenOrderView[] = venueOrders.filter(o => o.symbol === 'BTCUSDT').map(o => {
    const type = safeReason(o.order_type ?? 'UNKNOWN', [credentialId]);
    return { order_id: publicId(String(o.section), o.algo_id ?? o.order_id ?? o.client_algo_id ?? o.client_order_id), position_id: null, symbol: 'BTCUSDT',
      role: type === 'STOP_MARKET' ? 'SL' : type === 'TAKE_PROFIT_MARKET' ? 'TP' : 'UNKNOWN',
      side: o.side === 'BUY' || o.side === 'SELL' ? o.side : 'UNKNOWN', order_type: type,
      quantity: money(o.quantity), price: positivePrice(o.trigger_price) ?? positivePrice(o.price), status: safeReason(o.status ?? 'UNKNOWN', [credentialId]), source_as_of: sourceTimestamp(venue.source_as_of_ms) };
  });
  const unsupportedOrders = [...new Set(venueOrders.filter(o => o.symbol !== 'BTCUSDT').map(o =>
    typeof o.symbol === 'string' && /^[A-Z0-9]{1,32}$/.test(o.symbol) ? o.symbol : '未知品种'))];
  output.open_orders = { status: !complete ? 'UNKNOWN' : unknownOrders ? 'PARTIAL' : venueTime, observed_at: sourceTimestamp(accountOrders.observed_at_ms),
    source_as_of: sourceTimestamp(venue.source_as_of_ms), value: complete ? orderValue : null,
    reason: !complete ? '当前 boot 的同一轮完整普通及 Algo 交易所快照尚不可用' :
      unknownOrders ? `存在公开 v1 未覆盖的品种挂单：${safeReason(unsupportedOrders.join(', '), [credentialId])}${!venueFresh ? '；源快照过期或时间未知' : ''}` :
        !venueFresh ? '交易所挂单源快照过期或时间未知' : '同一轮全账户普通及 Algo 快照' };
  output.protection = { status: output.positions.status === 'AVAILABLE' && complete && venueFresh ? 'AVAILABLE' : output.positions.status === 'PARTIAL' ? 'PARTIAL' : 'UNKNOWN',
    observed_at: sourceTimestamp(accountOrders.observed_at_ms), source_as_of: sourceTimestamp(venue.source_as_of_ms),
    value: held.filter(p => p.symbol_key === BTC).map(p => protectionView(snapshot, p, credentialId)),
    reason: held.length ? 'SL / TP 分别核对同一轮 Algo 快照；请读取每条腿的结果' : '当前无可验证持仓；空列表不代表历史保护验证通过' };
  const authorities = rows(snapshot.kills.rows);
  const levels = ['none', 'pause_new', 'manage_only', 'flatten'] as const;
  const valid = snapshot.kills.snapshot_stale === false && authorities.length === 3 && authorities.every(a => a.found === false || (a.level_canonical === true && levels.includes(a.level as typeof levels[number])));
  const level = valid ? authorities.reduce<number>((max, a) => Math.max(max, a.found === false ? 0 : levels.indexOf(a.level as typeof levels[number])), 0) : -1;
  output.kill_switch = { level: levels[level] ?? 'UNKNOWN', reason: valid ? '全局、账户及演示 bot 的只读熔断状态' : '熔断事实尚未完整取得', observed_at: valid ? output.generated_at : null };
  return output;
}

export function protectionResult(pair: ProtectionPairView): CheckResult {
  return pair.sl.status === 'FAIL' || pair.tp.status === 'FAIL' ? 'FAIL' : pair.sl.status === 'PASS' && pair.tp.status === 'PASS' ? 'PASS' : 'UNKNOWN';
}
