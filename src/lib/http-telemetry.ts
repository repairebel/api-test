const WINDOW_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 5_000;
const MAX_FAILURES = 50;

interface RequestSample {
  timestamp: number;
  durationMs: number;
  statusCode: number;
  method: string;
  route: string;
}

export interface RecentFailure {
  timestamp: string;
  method: string;
  route: string;
  statusCode: number;
  code?: string;
  message: string;
}

const samples: RequestSample[] = [];
const failures: RecentFailure[] = [];

function cleanRoute(route: string): string {
  const path = route.split('?')[0] || '/';
  // Avoid putting customer IDs, job IDs, or other path values in diagnostics.
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
    .replace(/\/(?:pi|ch|acct|cus|pm)_[A-Za-z0-9_]+/g, '/:id')
    .slice(0, 180);
}

function prune(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  while (samples.length && samples[0].timestamp < cutoff) samples.shift();
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  if (failures.length > MAX_FAILURES) failures.splice(MAX_FAILURES);
}

export function recordRequest(sample: Omit<RequestSample, 'timestamp' | 'route'> & { route: string }) {
  samples.push({ ...sample, timestamp: Date.now(), route: cleanRoute(sample.route) });
  prune();
}

export function recordRequestFailure(input: Omit<RecentFailure, 'timestamp' | 'route' | 'message'> & {
  route: string;
  message?: string;
}) {
  failures.unshift({
    ...input,
    timestamp: new Date().toISOString(),
    route: cleanRoute(input.route),
    // Error messages can contain provider details. Keep this intentionally generic.
    message: input.statusCode >= 500 ? 'Server request failed' : (input.message || 'Request failed').slice(0, 120),
  });
  prune();
}

function percentile(values: number[], value: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] * 10) / 10;
}

export function getHttpTelemetry() {
  const now = Date.now();
  prune(now);
  const recent = samples.filter((sample) => sample.timestamp >= now - WINDOW_MS);
  const durations = recent.map((sample) => sample.durationMs);
  const statusCodes = {
    success: recent.filter((sample) => sample.statusCode < 400).length,
    clientError: recent.filter((sample) => sample.statusCode >= 400 && sample.statusCode < 500).length,
    serverError: recent.filter((sample) => sample.statusCode >= 500).length,
  };
  const failingRoutes = new Map<string, { route: string; count: number; lastStatus: number }>();
  for (const sample of recent) {
    if (sample.statusCode < 500) continue;
    const key = `${sample.method} ${sample.route}`;
    const current = failingRoutes.get(key);
    failingRoutes.set(key, {
      route: key,
      count: (current?.count ?? 0) + 1,
      lastStatus: sample.statusCode,
    });
  }

  return {
    windowMinutes: WINDOW_MS / 60_000,
    requests: recent.length,
    requestsPerMinute: Math.round((recent.length / (WINDOW_MS / 60_000)) * 10) / 10,
    errorRate: recent.length ? Math.round((statusCodes.serverError / recent.length) * 10_000) / 100 : 0,
    statusCodes,
    latencyMs: {
      average: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : 0,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
    },
    failingRoutes: [...failingRoutes.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    recentFailures: failures.slice(0, 12),
  };
}

export function resetHttpTelemetryForTests() {
  samples.length = 0;
  failures.length = 0;
}
