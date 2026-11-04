import assert from 'node:assert/strict';
import test from 'node:test';
import { fillAccounting, fundingAccounting } from '../src/round-accounting.js';
import type { Row } from '../src/facts.js';
const fill = (id: string, role: string, qty: string, fee: unknown = '0.04', asset: unknown = 'USDT'): Row => ({
  event_type: 'fill', payload_json: JSON.stringify({ positionId: 'position-internal-mock', orderRole: role,
    exchangeTradeId: id, fillQty: qty, fee, feeAsset: asset, realizedPnl: role === 'entry' ? '0' : '0.2' }),
});
test('fee accounting deduplicates fills, covers partial exits and refuses incomplete/unknown fees', () => {
  const events = [fill('1', 'entry', '2'), fill('2', 'protection_sl', '1'), fill('3', 'exit', '1')];
  assert.deepEqual(fillAccounting([...events, events[1]!], 'position-internal-mock'), { gross: '0.4', fees: '0.12' });
  assert.equal(fillAccounting(events.slice(0, 2), 'position-internal-mock'), null);
  assert.equal(fillAccounting([...events, fill('2', 'protection_sl', '1', '0.05')], 'position-internal-mock'), null);
  assert.equal(fillAccounting([events[0]!, fill('4', 'exit', '2', null)], 'position-internal-mock'), null);
  assert.equal(fillAccounting([events[0]!, fill('4', 'exit', '2', '0.04', 'BNB')], 'position-internal-mock'), null);
  assert.equal(fillAccounting(events, 'another-position'), null);
});

test('funding zero requires complete exact coverage; duplicate, partial, wrong-window and total mismatch remain unknown', () => {
  const response: Row = { complete: true, start_time_ms: '1000', end_time_ms: '2000', source_as_of_ms: '2001', total_funding_usdt: '0', entries: [] };
  assert.deepEqual(fundingAccounting(response, 1000, 2000), { total: '0', entries: [] });
  for (const changed of [{ complete: false }, { start_time_ms: '1001' }, { total_funding_usdt: '-0.01' }, { entries: null }])
    assert.equal(fundingAccounting({ ...response, ...changed }, 1000, 2000), null);
  const entry: Row = { public_id: 'internal-mock-ledger', transaction_time_ms: '1500', symbol: 'BTCUSDT', asset: 'USDT', amount_usdt: '-0.12345678' };
  const valid = { ...response, total_funding_usdt: '-0.12345678', entries: [entry] };
  const parsed = fundingAccounting(valid, 1000, 2000)!;
  assert.equal(parsed.total, '-0.12345678');
  assert.notEqual(parsed.entries[0]!.public_id, entry.public_id);
  assert.equal(fundingAccounting({ ...valid, entries: [entry, entry] }, 1000, 2000), null);
  assert.equal(fundingAccounting({ ...valid, entries: [{ ...entry, transaction_time_ms: '999' }] }, 1000, 2000), null);
});
