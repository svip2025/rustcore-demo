import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { StateResponse } from '../../shared/schema.js';
import { projectSnapshot, protectionResult, type AccountSettings, type CoreSnapshot } from '../src/projection.js';
import { BTC, row, type Row } from '../src/facts.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const CREDENTIAL = 'private-account-9001';
const POSITION = 'private-position-id';
const OBSERVATION = 'private-observation-id';
const settings: AccountSettings = { positionMode: 'ONE_WAY', marginMode: 'CROSS', leverage: 1 };

function list(value: unknown): Row[] {
  assert.ok(Array.isArray(value));
  return value as Row[];
}
function first(value: unknown): Row {
  const entry = list(value)[0];
  assert.ok(entry);
  return entry;
}
function meta(count: number, venue = false): Row {
  return { coverage: venue ? 'AOC_COMPLETE_VENUE' : 'AOC_COMPLETE_LOCAL', overflow: false, returned_count: count, total_count: count };
}
function fixture() {
  // Use the frozen public sample only for the unrelated initial-state fields.
  const previous = (JSON.parse(readFileSync(new URL('../../recordings/mock-success-v1.json', import.meta.url), 'utf8')) as { initial_state: StateResponse }).initial_state;
  const position: Row = { position_id: POSITION, credential_id: CREDENTIAL, bot_uid: 'private-bot-id',
    symbol_key: BTC, direction: 'long', state: 'protected', qty: '0.002', entry_price: '100000', last_reconciled_ms: String(NOW - 1000) };
  const localOrder = (kind: 'sl' | 'tp', id: string, price: string): Row => ({
    protection_order_id: `private-protection-${kind}`, position_id: POSITION, credential_id: CREDENTIAL, kind,
    generation: '3', exchange_algo_id: id, client_algo_id: `private-client-${kind}`, trigger_price: price,
    association_status: 'matched', current_plan_generation_match: true, verified_projection: true, raw_status: 'confirmed',
  });
  const venueOrder = (kind: 'sl' | 'tp', id: string, price: string): Row => ({
    algo_id: id, client_algo_id: `private-client-${kind}`, identity_valid: true, symbol: 'BTCUSDT',
    order_type: kind === 'sl' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET', trigger_price: price,
    side: 'SELL', close_position: true, status: 'NEW',
  });
  const snapshot: CoreSnapshot = {
    account: { available: true, equity_usdt: '10000', available_usdt: '9900', as_of_ms: String(NOW - 2000), observed_at_ms: String(NOW),
      positions: [{ symbol_key: BTC, side: 'long', qty: '0.002', entry_price: '100000', mark_price: '100001' }] },
    positions: { positions: [position], orphan_positions: [] }, orders: {},
    accountOrders: { credential_id: CREDENTIAL, engine_boot_id: 'private-boot-id', observed_at_ms: String(NOW),
      local: {
        positions: { meta: meta(1), rows: [{ position_id: POSITION, credential_id: CREDENTIAL, bot_uid: 'private-bot-id',
          symbol_key: BTC, direction: 'long', quantity: '0.002', raw_state: 'protected' }] },
        protection_plans: { meta: meta(1), rows: [{ position_id: POSITION, credential_id: CREDENTIAL, bot_uid: 'private-bot-id',
          symbol_key: BTC, direction: 'long', generation: '3', association_status: 'matched', stop_loss_price: '95000', take_profit_price: '110000' }] },
        protection_orders: { meta: meta(2), rows: [localOrder('sl', 'private-sl-algo-id', '95000'), localOrder('tp', 'private-tp-algo-id', '110000')] },
      },
      account_kind: 'exchange',
      venue: { availability: 'AOA_AVAILABLE', credential_id: CREDENTIAL, engine_boot_id: 'private-boot-id', observation_id: OBSERVATION,
        capture_started_at_ms: String(NOW - 1500), capture_completed_at_ms: String(NOW - 1000), source_as_of_ms: String(NOW - 1500),
        latest_attempt: { observation_id: OBSERVATION, status: 'succeeded', coverage: 'full_account', started_at_ms: String(NOW - 1500), completed_at_ms: String(NOW - 1000) },
        ordinary: { meta: meta(0, true), rows: [], started_at_ms: String(NOW - 1500), completed_at_ms: String(NOW - 1200) },
        algo: { meta: meta(2, true), rows: [venueOrder('sl', 'private-sl-algo-id', '95000.0'), venueOrder('tp', 'private-tp-algo-id', '110000.00')],
          started_at_ms: String(NOW - 1200), completed_at_ms: String(NOW - 1000) },
      },
    },
    kills: { snapshot_stale: false, rows: [{ found: false }, { found: false }, { found: false }] },
    receivedAt: NOW, bootStartedAt: NOW - 10000,
  };
  return { previous, snapshot, project: () => projectSnapshot(previous, snapshot, CREDENTIAL, settings) };
}

function makeFlat(snapshot: CoreSnapshot): void {
  snapshot.positions.positions = [];
  snapshot.positions.orphan_positions = [];
  snapshot.account.positions = [];
}

test('complete BTC projection preserves decimal facts, hashes public IDs and leaves internal account scope intact', () => {
  const { snapshot, previous, project } = fixture();
  const original = structuredClone(snapshot), oldState = structuredClone(previous);
  const result = project();
  assert.equal(result.positions.status, 'AVAILABLE');
  assert.equal(result.positions.value?.[0]?.notional_usdt, '200.002');
  assert.equal(result.protection.value?.[0]?.sl.status, 'PASS');
  assert.equal(result.protection.value?.[0]?.tp.status, 'PASS');
  const publicText = JSON.stringify(result);
  for (const privateId of [CREDENTIAL, POSITION, OBSERVATION, 'private-bot-id', 'private-sl-algo-id', 'private-tp-algo-id', 'private-client-sl', 'private-client-tp'])
    assert.equal(publicText.includes(privateId), false, privateId);
  assert.deepEqual(snapshot, original);
  assert.deepEqual(previous, oldState);
});

test('invalid local or account quantities remain a partial observation instead of disappearing into a false flat result', () => {
  for (const corrupt of [
    (snapshot: CoreSnapshot) => { first(snapshot.positions.positions).qty = 'not-a-quantity'; },
    (snapshot: CoreSnapshot) => { first(snapshot.account.positions).qty = null; snapshot.positions.positions = []; },
  ]) {
    const { snapshot, project } = fixture(); corrupt(snapshot);
    const result = project();
    assert.equal(result.positions.status, 'PARTIAL');
    assert.match(result.positions.reason, /数量/);
  }
});

test('explicit complete empty positions may be available, while absent available/source/coverage cannot prove flatness', () => {
  const good = fixture(); makeFlat(good.snapshot);
  assert.equal(good.project().positions.status, 'AVAILABLE');
  assert.deepEqual(good.project().positions.value, []);
  for (const corrupt of [
    (snapshot: CoreSnapshot) => { delete snapshot.account.available; },
    (snapshot: CoreSnapshot) => { delete snapshot.account.as_of_ms; },
    (snapshot: CoreSnapshot) => { snapshot.account.as_of_ms = true; },
    (snapshot: CoreSnapshot) => { snapshot.account.as_of_ms = String(NOW + 1); },
    (snapshot: CoreSnapshot) => { delete snapshot.account.positions; },
    (snapshot: CoreSnapshot) => { delete snapshot.positions.orphan_positions; },
  ]) {
    const x = fixture(); makeFlat(x.snapshot); corrupt(x.snapshot);
    const result = x.project();
    assert.equal(result.positions.status, 'UNKNOWN');
    if (x.snapshot.account.available !== true || x.snapshot.account.as_of_ms !== String(NOW - 2000))
      assert.notEqual(result.account.status, 'AVAILABLE', 'absent availability or invalid source time');
  }
  const mismatch = fixture(); mismatch.snapshot.positions.positions = [];
  assert.equal(mismatch.project().positions.status, 'PARTIAL', 'an account holding cannot be hidden by an empty local list');
  assert.match(mismatch.project().positions.reason, /不一致/);
});

test('non-BTC holdings are publicly PARTIAL with an instrument reason without filtering internal risk input', () => {
  const { snapshot, project } = fixture();
  list(snapshot.positions.positions).push({ position_id: 'private-eth-position', credential_id: CREDENTIAL, symbol_key: 'binance|futures|ETH|USDT|USDT',
    direction: 'short', state: 'open', qty: '1', entry_price: '3000', last_reconciled_ms: String(NOW - 1000) });
  list(snapshot.account.positions).push({ symbol_key: 'binance|futures|ETH|USDT|USDT', side: 'short', qty: '1', mark_price: '3001' });
  const before = structuredClone(snapshot.account);
  const result = project();
  assert.equal(result.positions.status, 'PARTIAL');
  assert.match(result.positions.reason, /ETH/);
  assert.equal(result.positions.value?.length, 1);
  assert.equal(result.positions.value?.[0]?.symbol, 'BTCUSDT');
  assert.deepEqual(snapshot.account, before);
  assert.equal(list(snapshot.account.positions).length, 2);
});

test('an active BTC position without prices retains null prices and notional, never synthetic zero', () => {
  const { snapshot, project } = fixture();
  first(snapshot.positions.positions).entry_price = '';
  delete first(snapshot.account.positions).mark_price;
  const result = project(), position = result.positions.value?.[0];
  assert.equal(result.positions.status, 'PARTIAL');
  assert.equal(position?.quantity, '0.002');
  assert.equal(position?.entry_price, null);
  assert.equal(position?.mark_price, null);
  assert.equal(position?.notional_usdt, null);
});

test('source timestamps stay conservative as receipt time advances and stale facts do not refresh themselves', () => {
  const { snapshot, project } = fixture();
  first(snapshot.positions.positions).last_reconciled_ms = String(NOW - 31000);
  const result = project();
  assert.equal(result.positions.status, 'STALE');
  assert.equal(result.positions.source_as_of, new Date(NOW - 31000).toISOString());
  snapshot.receivedAt = NOW + 40000;
  const later = project();
  assert.equal(later.account.status, 'STALE');
  assert.equal(later.open_orders.status, 'STALE');
  assert.equal(later.account.source_as_of, new Date(NOW - 2000).toISOString());
  assert.equal(later.open_orders.source_as_of, new Date(NOW - 1500).toISOString());
});

test('incomplete, overflowed and mixed venue observations stay unknown; uncovered order symbols are partial', () => {
  for (const corrupt of [
    (snapshot: CoreSnapshot) => { row(row(snapshot.accountOrders.venue).ordinary).meta = { ...meta(0, true), coverage: 'AOC_PARTIAL' }; },
    (snapshot: CoreSnapshot) => { row(row(row(snapshot.accountOrders.venue).algo).meta).overflow = true; },
    (snapshot: CoreSnapshot) => { row(row(snapshot.accountOrders.venue).latest_attempt).observation_id = 'another-observation'; },
  ]) {
    const x = fixture(); corrupt(x.snapshot);
    const result = x.project();
    assert.equal(result.open_orders.status, 'UNKNOWN');
    assert.equal(result.open_orders.value, null);
    assert.equal(result.protection.value?.[0]?.sl.status, 'UNKNOWN');
    assert.equal(result.protection.value?.[0]?.tp.status, 'UNKNOWN');
  }
  const x = fixture(), ordinary = row(row(x.snapshot.accountOrders.venue).ordinary);
  ordinary.rows = [{ identity_valid: true, symbol: 'ETHUSDT', order_id: 'private-eth-order-id', order_type: 'LIMIT', side: 'BUY', quantity: '1', price: '3000', status: 'NEW' }];
  ordinary.meta = meta(1, true);
  const result = x.project();
  assert.equal(result.open_orders.status, 'PARTIAL');
  assert.match(result.open_orders.reason, /ETHUSDT/);
  assert.equal(JSON.stringify(result).includes('private-eth-order-id'), false);
});

test('public protection preserves SL PASS with TP FAIL or UNKNOWN from the same independently checked snapshot', () => {
  const missing = fixture(), algo = row(row(missing.snapshot.accountOrders.venue).algo);
  list(algo.rows).pop(); algo.meta = meta(1, true);
  const pair = missing.project().protection.value?.[0];
  assert.ok(pair);
  assert.equal(pair.sl.status, 'PASS');
  assert.equal(pair.tp.status, 'FAIL');
  assert.equal(protectionResult(pair), 'FAIL');
  assert.notEqual(pair.observation_id, OBSERVATION);
  const incomplete = fixture();
  const tp = list(row(row(incomplete.snapshot.accountOrders.venue).algo).rows)[1];
  assert.ok(tp); delete tp.trigger_price;
  const unknown = incomplete.project().protection.value?.[0];
  assert.ok(unknown);
  assert.equal(unknown.sl.status, 'PASS');
  assert.equal(unknown.tp.status, 'UNKNOWN');
  assert.equal(unknown.tp.trigger_price, null);
  assert.equal(protectionResult(unknown), 'UNKNOWN');
});
