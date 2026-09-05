import test from 'node:test';
import assert from 'node:assert/strict';
import {nearbyShopsQuerySchema, CUSTOMER_MAP_RADIUS_KM} from '../src/modules/requests/nearby-shops-query.js';

test('customer nearby radius defaults to and is capped at exactly 100 miles',()=>{
  assert.equal(nearbyShopsQuerySchema.parse({lat:'0',lng:'0'}).radius,CUSTOMER_MAP_RADIUS_KM);
  assert.equal(nearbyShopsQuerySchema.parse({lat:'42',lng:'-73',radius:'5000'}).radius,CUSTOMER_MAP_RADIUS_KM);
  assert.equal(nearbyShopsQuerySchema.parse({lat:'42',lng:'-73',radius:'50'}).radius,50);
});
test('invalid coordinates and radii are rejected instead of partially parsed',()=>{
  for(const query of [{lat:'',lng:'0'},{lat:'91',lng:'0'},{lat:'0',lng:'181'},{lat:'1oops',lng:'0'},{lat:'NaN',lng:'0'},{lat:'0',lng:'0',radius:'-1'},{lat:'0',lng:'0',radius:'Infinity'}]) {
    assert.equal(nearbyShopsQuerySchema.safeParse(query).success,false);
  }
});
