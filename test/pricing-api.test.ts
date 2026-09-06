import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Server as SocketIOServer } from 'socket.io';

// Guard before importing modules that initialize database/queue connections.
assert.equal(process.env.NODE_ENV, 'test', 'Run through scripts/test-runtime.mjs test');
for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
  const url = new URL(process.env[key] ?? '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), `${key} must be local`);
  if (key === 'DATABASE_URL') assert.match(url.pathname, /test/i, 'Database must be explicitly named for testing');
  if (key === 'REDIS_URL') assert.equal(url.port, '6385', 'Use the isolated pricing-test Redis port');
}
assert.equal(process.env.STRIPE_SECRET_KEY, '', 'Payment integrations must be disabled');
assert.equal(process.env.SMTP_HOST, '127.0.0.1', 'Email must stay local');

type Quote = {
  deviceModelId: string;
  deviceBrand: string;
  deviceModel: string;
  issueType: string;
  catalogVersion: string;
  suggestedPriceCents: number;
  minPriceCents: number;
  suggestedOfferCents: number;
  partsCost: number;
  markupMultiplier: number;
  laborFeeCents: number;
  source: string;
  priceSnapshot: Record<string, unknown>;
};

const runId = randomUUID();
const customerId = randomUUID();
const ownerId = randomUUID();
const shopId = randomUUID();
const requestIds = new Set<string>();
const offerIds = new Set<string>();
const nonceKeys: string[] = [];
const dispatchEvents: Array<Record<string, unknown>> = [];
let app: FastifyInstance | undefined;
let io: SocketIOServer | undefined;
let database: typeof import('../src/db/client.js') | undefined;
let redisModule: typeof import('../src/lib/redis.js') | undefined;
let queues: typeof import('../src/lib/queue.js') | undefined;
let tokens: typeof import('../src/lib/tokens.js');
let customerToken: string;
let ownerToken: string;
let quote: Quote;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function inject(method: 'GET' | 'POST', url: string, token?: string, payload?: Record<string, unknown>) {
  const headers: Record<string, string> = { 'x-forwarded-for': `pricing-test-${runId}` };
  if (token) {
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const bodyHash = sha256(payload === undefined ? '' : JSON.stringify(stableValue(payload)));
    const canonical = [method, url, timestamp, nonce, bodyHash].join('\n');
    headers.authorization = `Bearer ${token}`;
    headers['x-rr-ts'] = timestamp;
    headers['x-rr-nonce'] = nonce;
    headers['x-rr-signature'] = sha256(`${token}:${canonical}`);
    nonceKeys.push(`sig-nonce:${tokens.verifyAccessToken(token).jti}:${nonce}`);
  }
  return app!.inject({ method, url, headers, ...(payload ? { payload } : {}) });
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    deviceModelId: quote.deviceModelId,
    deviceBrand: quote.deviceBrand,
    deviceModel: quote.deviceModel,
    issueType: quote.issueType,
    catalogVersion: quote.catalogVersion,
    issueDescription: `Dataset pricing integration ${runId}`,
    customerOfferCents: quote.suggestedPriceCents,
    photos: [],
    latitude: '-55.0001',
    longitude: '-140.0001',
    address: 'Isolated test fixture location',
    dispatchRadiusMiles: 1,
    ...overrides,
  };
}

async function customerRequestCount() {
  const result = await database!.pool.query('SELECT count(*)::int AS count FROM requests WHERE customer_id = $1', [customerId]);
  return result.rows[0].count as number;
}

describe('dataset pricing through authenticated customer and store APIs', { concurrency: false, timeout: 120_000 }, () => {
  before(async () => {
    database = await import('../src/db/client.js');
    redisModule = await import('../src/lib/redis.js');
    queues = await import('../src/lib/queue.js');
    tokens = await import('../src/lib/tokens.js');
    await database.pool.query('SELECT 1');
    await redisModule.redis.ping();

    const sample = await database.pool.query(`
      SELECT d.id FROM device_models d JOIN repair_prices p ON p.device_model_id = d.id
      WHERE d.brand = 'Apple' AND d.model_name IN ('iPhone 12', 'iPhone 13')
        AND p.issue_type = 'SCREEN' AND p.active = true
      ORDER BY d.model_name LIMIT 1
    `);
    assert.equal(sample.rowCount, 1, 'Import the workbook catalog before running API tests');

    // Synthetic users have no payment accounts or push tokens. The unique location
    // keeps this dispatch away from other test shops without altering their data.
    await database.pool.query(`
      INSERT INTO users (id, email, password_hash, full_name, user_type)
      VALUES ($1, $2, 'unused-test-password-hash', 'Pricing Test Customer', 'CUSTOMER'),
             ($3, $4, 'unused-test-password-hash', 'Pricing Test Owner', 'SHOP_OWNER')
    `, [customerId, `${runId}-customer@example.invalid`, ownerId, `${runId}-owner@example.invalid`]);
    await database.pool.query(`
      INSERT INTO shops (id, name, onboarding_status, vacation_mode, latitude, longitude, service_radius, categories)
      VALUES ($1, 'Pricing API Test Shop', 'APPROVED', false, '-55.0001', '-140.0001', 2, '["Apple"]'::jsonb)
    `, [shopId]);
    await database.pool.query('INSERT INTO memberships (user_id, shop_id, role) VALUES ($1, $2, $3)', [ownerId, shopId, 'OWNER']);
    customerToken = tokens.signAccessToken({ sub: customerId, userType: 'CUSTOMER' });
    ownerToken = tokens.signAccessToken({ sub: ownerId, userType: 'SHOP_OWNER', shopId, role: 'OWNER' });

    app = await (await import('../src/app.js')).buildApp();
    app.log.level = 'silent';
    await app.ready();
    io = (await import('../src/lib/socket.js')).initSocketIO(app.server);
    const adapter = io.of('/').adapter;
    const broadcast = adapter.broadcast.bind(adapter);
    adapter.broadcast = (packet, options) => {
      if (packet.data?.[0] === 'dispatch:popup' && options.rooms.has(`shop:${shopId}`)) {
        dispatchEvents.push(packet.data[1]);
      }
      broadcast(packet, options);
    };

    const response = await inject('GET', `/v1/price-estimate?deviceModelId=${sample.rows[0].id}&issueType=SCREEN`);
    assert.equal(response.statusCode, 200, response.body);
    quote = response.json().data;
  });

  after(async () => {
    try {
      // Delete only this run's fixtures and queue jobs; never clear shared tables or Redis.
      if (database) {
        const ownedRequests = await database.pool.query('SELECT id FROM requests WHERE customer_id = $1', [customerId]);
        for (const row of ownedRequests.rows) requestIds.add(row.id);
      }
      if (queues) {
        for (const queue of [queues.dispatchTimeoutQueue, queues.offerExpiryQueue, queues.payoutReleaseQueue]) {
          const jobs = await queue.getJobs(['delayed', 'waiting', 'failed', 'completed']);
          for (const job of jobs) {
            if (requestIds.has(job.data.requestId) || offerIds.has(job.data.offerId)) await job.remove();
          }
        }
      }
      if (database) {
        await database.pool.query('DELETE FROM requests WHERE customer_id = $1', [customerId]);
        await database.pool.query('DELETE FROM shops WHERE id = $1', [shopId]);
        await database.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[customerId, ownerId]]);
      }
      if (redisModule && nonceKeys.length) await redisModule.redis.del(...nonceKeys);
    } finally {
      if (io) await new Promise<void>((resolve) => io!.close(() => resolve()));
      if (app) await app.close();
      if (queues) await Promise.all([queues.dispatchTimeoutQueue.close(), queues.offerExpiryQueue.close(), queues.payoutReleaseQueue.close()]);
      if (redisModule) await redisModule.redis.quit();
      if (database) await database.pool.end();
    }
  });

  it('customer map excludes shops over 100 miles even when an older client asks for 5000 km', async () => {
    const near = await inject('GET', '/v1/customer/nearby-shops?lat=-55.0001&lng=-140.0001&radius=5000', customerToken);
    assert.equal(near.statusCode, 200, near.body);
    assert.ok(near.json().data.some((shop: {id: string}) => shop.id === shopId));
    const far = await inject('GET', '/v1/customer/nearby-shops?lat=-53.0001&lng=-140.0001&radius=5000', customerToken);
    assert.equal(far.statusCode, 200, far.body);
    assert.ok(!far.json().data.some((shop: {id: string}) => shop.id === shopId));
    assert.ok(far.json().data.every((shop: {distanceKm: number}) => shop.distanceKm <= 160.9344 + 1e-9));
    const invalid = await inject('GET', '/v1/customer/nearby-shops?lat=invalid&lng=0', customerToken);
    assert.equal(invalid.statusCode, 400, invalid.body);
  });

  it('publishes supported models and repairs and the exact workbook-derived quote', async () => {
    const models = await inject('GET', '/v1/device-models?brand=Apple&query=iPhone%2012&limit=500');
    assert.equal(models.statusCode, 200, models.body);
    if (quote.deviceModel === 'iPhone 12') assert.ok(models.json().data.some((model: { id: string }) => model.id === quote.deviceModelId));
    const issues = await inject('GET', `/v1/issue-types?deviceModelId=${quote.deviceModelId}`);
    assert.equal(issues.statusCode, 200, issues.body);
    const screen = issues.json().data.find((issue: { id: string }) => issue.id === 'SCREEN');
    assert.ok(screen);
    assert.equal(screen.suggestedPriceCents, quote.suggestedPriceCents);
    assert.equal(quote.source, 'dataset');
    assert.equal(quote.markupMultiplier, 2);
    assert.equal(quote.laborFeeCents, 3000);
    assert.equal(quote.suggestedPriceCents, Math.ceil((quote.partsCost * 2 + 30) * 100 - 1e-8));
    assert.equal(quote.minPriceCents, quote.suggestedPriceCents);
    assert.equal(quote.suggestedOfferCents, quote.suggestedPriceCents);
    assert.equal(quote.priceSnapshot.suggestedPriceCents, quote.suggestedPriceCents);
    assert.ok(quote.catalogVersion);
  });

  it('requires a model-specific quote and refuses unsupported repairs', async () => {
    const missingModel = await inject('GET', '/v1/price-estimate?deviceBrand=Apple&issueType=SCREEN');
    assert.equal(missingModel.statusCode, 400, missingModel.body);
    const unsupported = await inject('GET', `/v1/price-estimate?deviceModelId=${quote.deviceModelId}&issueType=UNSUPPORTED_REPAIR`);
    assert.equal(unsupported.statusCode, 422, unsupported.body);
  });

  it('rejects one cent below the suggested floor without saving a request', async () => {
    const beforeCount = await customerRequestCount();
    const response = await inject('POST', '/v1/customer/requests', customerToken, requestBody({
      customerOfferCents: quote.suggestedPriceCents - 1,
      minPriceCents: 1,
      suggestedPriceCents: 1,
    }));
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error.message, /suggested price/i);
    assert.equal(await customerRequestCount(), beforeCount);
  });

  it('rejects stale quotes, mismatched model labels, and unsupported repairs before saving', async () => {
    const beforeCount = await customerRequestCount();
    for (const [overrides, expectedStatus] of [
      [{ catalogVersion: 'stale-catalog-version' }, 409],
      [{ deviceModel: 'A different device model' }, 400],
      [{ deviceBrand: 'Samsung' }, 400],
      [{ issueType: 'UNSUPPORTED_REPAIR' }, 422],
    ] as const) {
      const response = await inject('POST', '/v1/customer/requests', customerToken, requestBody(overrides));
      assert.equal(response.statusCode, expectedStatus, response.body);
      assert.equal(await customerRequestCount(), beforeCount);
    }
  });

  it('accepts the exact floor and preserves it through storage, dispatch, and store offer validation', async () => {
    const created = await inject('POST', '/v1/customer/requests', customerToken, requestBody());
    assert.equal(created.statusCode, 201, created.body);
    const request = created.json().data;
    requestIds.add(request.requestId);
    assert.equal(request.customerOfferCents, quote.suggestedPriceCents);
    assert.equal(request.suggestedPriceCents, quote.suggestedPriceCents);
    assert.ok(['LIVE', 'DISPATCHING'].includes(request.status), created.body);

    const persisted = await database!.pool.query('SELECT min_price_cents, device_model_id, price_snapshot FROM requests WHERE id = $1', [request.requestId]);
    assert.equal(persisted.rows[0].min_price_cents, quote.suggestedPriceCents);
    assert.equal(persisted.rows[0].device_model_id, quote.deviceModelId);
    assert.deepEqual(persisted.rows[0].price_snapshot, quote.priceSnapshot);
    const dispatched = dispatchEvents.find((event) => event.requestId === request.requestId);
    assert.ok(dispatched, 'The real dispatch flow must notify the fixture shop');
    assert.equal(dispatched.suggestedPriceCents, quote.suggestedPriceCents);
    assert.equal(dispatched.minPriceCents, quote.suggestedPriceCents);

    for (const [url, token] of [
      [`/v1/customer/requests/${request.requestId}`, customerToken],
      [`/v1/requests/${request.requestId}`, ownerToken],
    ]) {
      const response = await inject('GET', url, token);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().data.suggestedPriceCents, quote.suggestedPriceCents);
      assert.equal(response.json().data.minPriceCents, quote.suggestedPriceCents);
      assert.equal(response.json().data.issueDisplayName, 'Screen');
    }
    const feed = await inject('GET', '/v1/shops/me/requests?status=LIVE', ownerToken);
    assert.equal(feed.statusCode, 200, feed.body);
    const feedRequest = feed.json().data.find((item: { requestId: string }) => item.requestId === request.requestId);
    assert.ok(feedRequest);
    assert.equal(feedRequest.suggestedPriceCents, quote.suggestedPriceCents);

    const offerUrl = `/v1/requests/${request.requestId}/offers`;
    const offerBody = { etaMinutes: 60, warrantyDays: 30, partsQuality: 'PREMIUM' };
    const underFloor = await inject('POST', offerUrl, ownerToken, { ...offerBody, priceCents: quote.suggestedPriceCents - 1 });
    assert.equal(underFloor.statusCode, 400, underFloor.body);
    const offersBefore = await database!.pool.query('SELECT count(*)::int AS count FROM offers WHERE request_id = $1', [request.requestId]);
    assert.equal(offersBefore.rows[0].count, 0);
    const exactFloor = await inject('POST', offerUrl, ownerToken, { ...offerBody, priceCents: quote.suggestedPriceCents });
    assert.equal(exactFloor.statusCode, 201, exactFloor.body);
    offerIds.add(exactFloor.json().data.offerId);
    assert.equal(exactFloor.json().data.priceCents, quote.suggestedPriceCents);
    assert.equal(exactFloor.json().data.status, 'PENDING');
  });
  it('restricts plan discovery and direct subscriptions to completed, released repairs', async () => {
    const pool = database!.pool;
    const planId = randomUUID();
    const jobId = randomUUID();
    const req = await pool.query('SELECT id FROM requests WHERE customer_id=$1 LIMIT 1', [customerId]);
    const offer = await pool.query('SELECT id FROM offers WHERE request_id=$1 LIMIT 1', [req.rows[0].id]);
    await pool.query('UPDATE shops SET protection_enabled=true WHERE id=$1', [shopId]);
    await pool.query(`INSERT INTO protection_plans(id,shop_id,name,billing_type,price_cents,max_payout_per_claim_cents)
      VALUES($1,$2,'Eligibility fixture','MONTHLY',1000,20000)`, [planId,shopId]);
    const url = `/v1/customer/protection/plans?shopId=${shopId}`;
    assert.equal((await inject('GET', url)).statusCode, 401);
    assert.equal((await inject('GET', url, ownerToken)).statusCode, 403);
    assert.deepEqual((await inject('GET', url, customerToken)).json().data, []);
    const denied = await inject('POST', '/v1/customer/protection/subscribe', customerToken, { planId });
    assert.equal(denied.statusCode,403,denied.body);
    await pool.query(`INSERT INTO jobs(id,request_id,offer_id,shop_id,customer_id,customer_name,device_brand,device_model,issue_description,price_cents,eta_minutes,status,payment_status)
      VALUES($1,$2,$3,$4,$5,'Fixture','Apple','iPhone 13','Screen',10000,60,'READY','HELD')`,
      [jobId,req.rows[0].id,offer.rows[0].id,shopId,customerId]);
    for (const [status,payment] of [['READY','HELD'],['COMPLETED','HELD'],['COMPLETED','REFUNDED'],['CANCELLED','RELEASED']]) {
      await pool.query('UPDATE jobs SET status=$2,payment_status=$3 WHERE id=$1',[jobId,status,payment]);
      assert.deepEqual((await inject('GET',url,customerToken)).json().data,[]);
    }
    await pool.query("UPDATE jobs SET status='COMPLETED',payment_status='RELEASED' WHERE id=$1",[jobId]);
    assert.equal((await inject('GET',url,customerToken)).json().data[0].id,planId);
    const all = await inject('GET','/v1/customer/protection/plans',customerToken);
    assert.deepEqual(all.json().data.map((p: {id:string}) => p.id),[planId]);
    // A different customer's completion cannot grant eligibility.
    await pool.query('UPDATE jobs SET customer_id=$2 WHERE id=$1',[jobId,ownerId]);
    assert.deepEqual((await inject('GET',url,customerToken)).json().data,[]);
    await pool.query('UPDATE jobs SET customer_id=$2 WHERE id=$1',[jobId,customerId]);
    await pool.query('UPDATE shops SET protection_enabled=false WHERE id=$1',[shopId]);
    assert.deepEqual((await inject('GET',url,customerToken)).json().data,[]);
    await pool.query('UPDATE shops SET protection_enabled=true WHERE id=$1',[shopId]);
    await pool.query("UPDATE protection_plans SET status='PAUSED' WHERE id=$1",[planId]);
    assert.deepEqual((await inject('GET',url,customerToken)).json().data,[]);
  });

  it('serves safe store contact details and only visible paginated customer reviews', async () => {
    const pool = database!.pool;
    await pool.query(`UPDATE shops SET public_email='hello@example.invalid', website='https://example.invalid',
      phone='+15555550100',logo_url='https://example.invalid/logo.png',
      business_hours='[{"day":"Monday","isOpen":true,"openTime":"09:00","closeTime":"17:00"}]'::jsonb WHERE id=$1`,[shopId]);
    await pool.query(`INSERT INTO reviews(shop_id,customer_id,customer_name,rating,text,is_hidden)
      VALUES($1,$2,'Visible customer',5,'Great service',false),($1,$2,'Hidden customer',1,'Hidden text',true)`,[shopId,customerId]);
    const url = `/v1/customer/shops/${shopId}`;
    assert.equal((await inject('GET',url)).statusCode,401);
    assert.equal((await inject('GET',url,ownerToken)).statusCode,403);
    const response = await inject('GET',url,customerToken);
    assert.equal(response.statusCode,200,response.body);
    const profile = response.json().data;
    assert.equal(profile.email,'hello@example.invalid');
    assert.equal(profile.businessHours[0].openTime,'09:00');
    assert.equal(profile.logoUrl,'https://example.invalid/logo.png');
    assert.equal(profile.reviewCount,1); assert.equal(profile.rating,5);
    assert.equal(profile.reviews[0].text,'Great service');
    assert.equal(profile.stripeAccountId,undefined); assert.equal(profile.reviews[0].customerId,undefined);
    assert.equal((await inject('GET',url+'?page=0',customerToken)).statusCode,400);
    assert.deepEqual((await inject('GET',url+'?page=2',customerToken)).json().data.reviews,[]);
    await pool.query("UPDATE shops SET onboarding_status='REJECTED' WHERE id=$1",[shopId]);
    assert.equal((await inject('GET',url,customerToken)).statusCode,404);
    assert.equal((await inject('GET',`/v1/customer/shops/${randomUUID()}`,customerToken)).statusCode,404);
  });

  it('keeps admin sessions persistent, revokes previous devices, and persists realtime alerts', async () => {
    const adminId = randomUUID();
    const email = `${runId}-admin@example.invalid`;
    const password = 'Test-Admin-Pass-999!';
    const { hashPassword } = await import('../src/lib/password.js');
    await database!.pool.query("INSERT INTO users(id,email,password_hash,user_type) VALUES($1,$2,$3,'ADMIN')", [adminId,email,await hashPassword(password)]);
    await database!.pool.query("INSERT INTO admin_users(user_id,name) VALUES($1,'Alert test admin')", [adminId]);
    try {
      const login = async () => {
        const result = await inject('POST','/v1/auth/login',undefined,{email,password,expectedUserType:'ADMIN'});
        assert.equal(result.statusCode,200,result.body); return result.json().data;
      };
      const first = await login();
      const expiry = await database!.pool.query('SELECT expires_at FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL',[adminId]);
      assert.equal(new Date(expiry.rows[0].expires_at).getUTCFullYear(),9999);
      const renewed = await Promise.all([1,2].map(() => inject('POST','/v1/auth/refresh',undefined,{refreshToken:first.refreshToken})));
      for (const res of renewed) { assert.equal(res.statusCode,200,res.body); assert.equal(res.json().data.refreshToken,first.refreshToken); }
      const second = await login();
      assert.equal((await inject('GET','/v1/me',first.accessToken)).statusCode,401);
      assert.equal((await inject('POST','/v1/auth/refresh',undefined,{refreshToken:first.refreshToken})).statusCode,401);
      assert.equal((await inject('GET','/v1/me',second.accessToken)).statusCode,200);
      const { notifyAdmin } = await import('../src/lib/notify.js');
      const events: string[] = [];
      const adapter = io!.of('/').adapter;
      const broadcast = adapter.broadcast.bind(adapter);
      adapter.broadcast = (packet, options) => { if (options.rooms.has(`admin-user:${adminId}`)) events.push(packet.data?.[0]); broadcast(packet,options); };
      try {
        await notifyAdmin({adminUserId:adminId,event:'dispute:created',payload:{disputeId:'fixture'},persist:{category:'dispute',title:'New dispute',body:'Fixture'}});
        await notifyAdmin({adminUserId:adminId,event:'support:customer-message',payload:{conversationId:'fixture'},persist:{category:'chat',title:'New support message',body:'Fixture'}});
        assert.deepEqual(events,['notification:new','notification:new']);
        const saved = await database!.pool.query('SELECT category FROM notifications WHERE user_id=$1 ORDER BY category',[adminId]);
        assert.deepEqual(saved.rows.map(r=>r.category),['chat','dispute']);
      } finally { adapter.broadcast = broadcast; }
      await inject('POST','/v1/auth/logout',second.accessToken,{refreshToken:second.refreshToken});
      assert.equal((await inject('POST','/v1/auth/refresh',undefined,{refreshToken:second.refreshToken})).statusCode,401);
    } finally { await database!.pool.query('DELETE FROM users WHERE id=$1',[adminId]); }
  });

});
