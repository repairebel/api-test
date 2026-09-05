import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSuggestedPriceCents, median } from '../src/modules/pricing/pricing-math.js';
import { buildCatalog, readCatalog } from '../src/modules/pricing/catalog.js';
import { assertTestDatabase } from '../src/scripts/test-database-guard.js';

test('workbook formula adds tier labor and rounds positive half dollars up', () => {
  assert.equal(calculateSuggestedPriceCents(7.5, 2.2, 2000), 3700);
  assert.equal(calculateSuggestedPriceCents(58.085, 2.2, 3000), 15800);
  assert.equal(calculateSuggestedPriceCents(10.225, 2.2, 3000), 5200);
  assert.equal(calculateSuggestedPriceCents(10.23, 2.2, 3000), 5300);
  assert.throws(() => calculateSuggestedPriceCents(NaN, 2.2, 2000));
  assert.throws(() => calculateSuggestedPriceCents(5, -1, 2000));
});

test('all harvested rows match the independently extracted Excel formula', () => {
  const catalog = readCatalog();
  assert.equal(catalog.rows.length, 8513);
  for (const row of catalog.rows) {
    assert.equal(calculateSuggestedPriceCents(row.partsCost, row.markupMultiplier, Math.round(row.laborFee * 100)), Number(row.sourceSuggestedPrice) * 100, `row ${row.sourceId}`);
  }
});

test('catalog preserves all sources, excludes flagged rows, and resolves shared iPhone parts', () => {
  const catalog = readCatalog();
  const result = buildCatalog(catalog);
  assert.equal(result.sourceCount, 8513);
  assert.ok(result.prices.length > 4000);
  const bySource = new Map(catalog.rows.map(row => [row.sourceId, row]));
  for (const price of result.prices) {
    assert.ok(price.snapshot.sourceRowIds.every(id => bySource.get(id)?.catalogEligible));
    assert.equal(price.snapshot.partsCost, median(price.snapshot.sourceRowIds.map(id => bySource.get(id)!.partsCost)));
  }
  for (const model of ['iPhone 12', 'iPhone 12 Pro', 'iPhone 13']) {
    assert.ok(result.prices.find(price => price.model === model && price.issueType === 'SCREEN'), `${model} has screen pricing`);
  }
  assert.ok(result.prices.some(price => price.issueType === 'INNER_SCREEN'));
  assert.ok(result.prices.some(price => price.issueType === 'OUTER_SCREEN'));
  assert.ok(result.prices.some(price => price.issueType === 'FRONT_CAMERA'));
  assert.ok(result.prices.some(price => price.issueType === 'REAR_CAMERA'));
});

test('normalization changes invalidate quotes and unsafe import data fails closed', () => {
  const catalog = readCatalog();
  const before = buildCatalog(catalog);
  const changed = structuredClone(catalog);
  changed.rows.find(row => row.catalogEligible)!.partsCost += 1;
  assert.notEqual(before.version, buildCatalog(changed).version);
  assert.throws(() => buildCatalog({ ...catalog, rows: [] }));
  assert.throws(() => buildCatalog({ ...catalog, rows: [catalog.rows[0]!, catalog.rows[0]!] }));
});

test('test database guard rejects unverified production targets', () => {
  assert.doesNotThrow(() => assertTestDatabase('postgresql://test@localhost/repairebel_pricing_test'));
  assert.throws(() => assertTestDatabase('postgresql://test@localhost/production'));
  assert.throws(() => assertTestDatabase('postgresql://test@example.com/production'));
});
