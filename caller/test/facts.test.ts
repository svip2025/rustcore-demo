import assert from 'node:assert/strict';
import test from 'node:test';
import { integerPriceTick, priceAt } from '../src/facts.js';

test('stop planning grid is both an integer and an exact multiple of the exchange tick', () => {
  for (const [tick, expected] of [['0.1', '1'], ['0.125', '1'], ['0.3', '3'], ['2.5', '5'], ['10', '10']])
    assert.equal(integerPriceTick(tick!), expected);
  assert.throws(() => integerPriceTick('0'));
});

test('integer stop remains unchanged through f64 plan formatting and respects the original stop fraction', () => {
  const fractional = priceAt('77762.5', '0.99', '0.1');
  assert.equal(fractional, '76984.8');
  assert.equal(Number(fractional).toFixed(12), '76984.800000000003');
  const stop = priceAt('77762.5', '0.99', integerPriceTick('0.1'));
  assert.equal(stop, '76984');
  assert.equal(Number(stop).toFixed(12), '76984.000000000000');
  assert.equal(priceAt(stop, '1', '0.1', true), stop);
  assert.equal(priceAt('77762.5', '1.025', '0.1', true), '79706.6');
});
