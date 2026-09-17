import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getHttpTelemetry,
  recordRequest,
  recordRequestFailure,
  resetHttpTelemetryForTests,
} from '../dist/lib/http-telemetry.js';

test('summarizes API latency and server failures without retaining resource IDs', () => {
  resetHttpTelemetryForTests();
  for (let index = 1; index <= 20; index += 1) {
    recordRequest({
      durationMs: index * 10,
      method: 'GET',
      route: `/v1/jobs/123e4567-e89b-12d3-a456-426614174000?token=secret`,
      statusCode: index === 20 ? 500 : 200,
    });
  }
  recordRequestFailure({
    method: 'GET',
    route: '/v1/jobs/123e4567-e89b-12d3-a456-426614174000?token=secret',
    statusCode: 500,
    message: 'postgresql://user:password@private-host/database',
  });

  const telemetry = getHttpTelemetry();
  assert.equal(telemetry.requests, 20);
  assert.equal(telemetry.errorRate, 5);
  assert.equal(telemetry.latencyMs.p95, 190);
  assert.equal(telemetry.failingRoutes[0].route, 'GET /v1/jobs/:id');
  assert.equal(telemetry.recentFailures[0].route, '/v1/jobs/:id');
  assert.equal(telemetry.recentFailures[0].message, 'Server request failed');
});
