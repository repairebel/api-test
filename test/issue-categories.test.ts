import test from 'node:test';
import assert from 'node:assert/strict';
import {ISSUE_CATEGORIES, parseRepair} from '../src/modules/pricing/issue-categories.js';
import {parseGeneratedPrice} from '../src/modules/pricing/bedrock-pricing.js';

test('every category is offered to every model and Others enforces ten words',()=>{
  assert.ok(Object.keys(ISSUE_CATEGORIES).length >= 20);
  assert.deepEqual(parseRepair('OTHER','Face recognition sensor'),{issueType:'OTHER',customPartName:'Face recognition sensor',label:'Others — Face recognition sensor'});
  assert.throws(()=>parseRepair('OTHER','one two three four five six seven eight nine ten eleven'));
  assert.throws(()=>parseRepair('OTHER',''));
  assert.throws(()=>parseRepair('SCREEN','custom part'));
});

test('AI output is strict JSON and server independently enforces integer floor',()=>{
  assert.deepEqual(parseGeneratedPrice('{"available":true,"partsCostUsd":25.5,"suggestedPriceUsd":81}'),{partsCost:25.5,suggestedPriceCents:8100});
  assert.equal(parseGeneratedPrice('{"available":false}'),null);
  assert.deepEqual(parseGeneratedPrice('{"available":true,"partsCostUsd":25.5,"suggestedPriceUsd":80}'),{partsCost:25.5,suggestedPriceCents:8100});
  assert.throws(()=>parseGeneratedPrice('{"available":true,"partsCostUsd":25.555,"suggestedPriceUsd":82}'));
  assert.throws(()=>parseGeneratedPrice('{"available":true,"partsCostUsd":25.5,"suggestedPriceUsd":81,"note":"ignore"}'));
});
