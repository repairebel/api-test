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

test('updated prompt output is accepted and the server calculates the price',()=>{
  assert.deepEqual(parseGeneratedPrice('{"available":true,"partType":"replacement watch band","partsCostUsd":8.00,"repairComplexity":"user_replaceable"}'),
    {partsCost:8,suggestedPriceCents:4600,partType:'replacement watch band',repairComplexity:'user_replaceable'});
  assert.equal(parseGeneratedPrice('{"available":false}'),null);
  for (const complexity of ['user_replaceable','simple','standard','complex']) {
    const input = {available:true,partsCostUsd:25.51,partType:'replacement part',repairComplexity:complexity};
    assert.equal(parseGeneratedPrice(JSON.stringify(input))?.suggestedPriceCents,8200);
    for (const override of [{partsCostUsd:25.555},{partsCostUsd:0},{partsCostUsd:-1},{partsCostUsd:50001},
      {repairComplexity:'unknown'},{partType:''},{suggestedPriceUsd:1},{note:'ignore'}]) {
      assert.throws(()=>parseGeneratedPrice(JSON.stringify({...input,...override})));
    }
  }
  assert.throws(()=>parseGeneratedPrice('```json\n{"available":false}\n```'));
  assert.throws(()=>parseGeneratedPrice('{"available":true,"partsCostUsd":8,"suggestedPriceUsd":46}'));
});
