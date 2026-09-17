import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { pool } from '../db/client.js';
import { env } from '../config/env.js';
import { redis } from './redis.js';
import { dispatchTimeoutQueue, offerExpiryQueue, payoutReleaseQueue } from './queue.js';
import { getHttpTelemetry } from './http-telemetry.js';
import { getIO } from './socket.js';
import { notifyAdmin } from './notify.js';

export type HealthStatus = 'operational' | 'degraded' | 'outage' | 'not_configured';

export interface HealthComponent {
  id: string;
  name: string;
  status: HealthStatus;
  summary: string;
  latencyMs?: number;
  details?: Record<string, string | number | boolean | null>;
}

export interface HealthIncident {
  id: string;
  timestamp: string;
  status: Exclude<HealthStatus, 'not_configured'>;
  title: string;
  message: string;
  affectedComponents: string[];
}

const REPORT_CACHE_MS = 8_000;
const RAILWAY_CACHE_MS = 60_000;
const INCIDENT_KEY = 'ops:system-health:incidents';
const STATE_KEY = 'ops:system-health:last-state';
const LEADER_LOCK_KEY = 'ops:system-health:monitor-lock';

let cachedReport: SystemHealthReport | null = null;
let cachedAt = 0;
let cachedRailway: HealthComponent | null = null;
let railwayCachedAt = 0;
let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;
let localLastState = '';
const localIncidents: HealthIncident[] = [];

export interface SystemHealthReport {
  status: Exclude<HealthStatus, 'not_configured'>;
  checkedAt: string;
  monitorIntervalMs: number;
  summary: { operational: number; degraded: number; outage: number; notConfigured: number };
  components: HealthComponent[];
  telemetry: ReturnType<typeof getHttpTelemetry>;
  runtime: {
    uptimeSeconds: number;
    nodeVersion: string;
    environment: string;
    hostname: string;
    memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
    system: { loadAverage1m: number; cpuCount: number; freeMemoryMb: number; totalMemoryMb: number };
  };
  railway: {
    configured: boolean;
    connected: boolean;
    project: string | null;
    environment: string | null;
    service: string | null;
    deploymentId: string | null;
    deploymentStatus: string | null;
    deployedAt: string | null;
    region: string | null;
    replicaId: string | null;
    commitSha: string | null;
    branch: string | null;
  };
  incidents: HealthIncident[];
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

function safeErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (/password|token|secret|postgres(?:ql)?:\/\/|redis:\/\//i.test(message)) return fallback;
  return message.slice(0, 160);
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkPostgres(): Promise<HealthComponent> {
  const start = performance.now();
  try {
    await withTimeout(pool.query('SELECT 1'), 3_000, 'PostgreSQL check');
    const latencyMs = roundMs(performance.now() - start);
    const saturated = pool.waitingCount > 0 || (pool.totalCount >= 20 && pool.idleCount === 0);
    return {
      id: 'postgres',
      name: 'PostgreSQL',
      status: saturated || latencyMs > 1_000 ? 'degraded' : 'operational',
      summary: saturated ? 'Connection pool is under pressure' : latencyMs > 1_000 ? 'Database is responding slowly' : 'Queries are responding normally',
      latencyMs,
      details: { totalConnections: pool.totalCount, idleConnections: pool.idleCount, waitingRequests: pool.waitingCount },
    };
  } catch (error) {
    return { id: 'postgres', name: 'PostgreSQL', status: 'outage', summary: safeErrorMessage(error, 'Database check failed'), latencyMs: roundMs(performance.now() - start) };
  }
}

async function checkRedis(): Promise<HealthComponent> {
  const start = performance.now();
  try {
    const pong = await withTimeout(redis.ping(), 2_500, 'Redis check');
    const latencyMs = roundMs(performance.now() - start);
    return {
      id: 'redis',
      name: 'Redis',
      status: pong !== 'PONG' ? 'degraded' : latencyMs > 500 ? 'degraded' : 'operational',
      summary: pong !== 'PONG' ? 'Unexpected cache response' : latencyMs > 500 ? 'Cache is responding slowly' : 'Cache and realtime coordination are healthy',
      latencyMs,
      details: { connection: redis.status },
    };
  } catch (error) {
    return { id: 'redis', name: 'Redis', status: 'outage', summary: safeErrorMessage(error, 'Cache check failed'), latencyMs: roundMs(performance.now() - start), details: { connection: redis.status } };
  }
}

async function checkQueues(): Promise<HealthComponent> {
  const start = performance.now();
  try {
    const queues = [
      ['offerExpiry', offerExpiryQueue],
      ['dispatchTimeout', dispatchTimeoutQueue],
      ['payoutRelease', payoutReleaseQueue],
    ] as const;
    const results = await withTimeout(Promise.all(queues.map(async ([name, queue]) => ({
      name,
      counts: await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'paused'),
    }))), 3_500, 'Queue check');
    const totals = results.reduce((acc, item) => {
      for (const key of ['waiting', 'active', 'delayed', 'failed', 'paused'] as const) acc[key] += item.counts[key] ?? 0;
      return acc;
    }, { waiting: 0, active: 0, delayed: 0, failed: 0, paused: 0 });
    const status: HealthStatus = totals.paused > 0 || totals.failed > 0 ? 'degraded' : 'operational';
    return {
      id: 'queues',
      name: 'Background jobs',
      status,
      summary: totals.paused > 0 ? 'One or more queues are paused' : totals.failed > 0 ? `${totals.failed} retained failed job${totals.failed === 1 ? '' : 's'} need review` : 'All job queues are processing normally',
      latencyMs: roundMs(performance.now() - start),
      details: totals,
    };
  } catch (error) {
    return { id: 'queues', name: 'Background jobs', status: 'outage', summary: safeErrorMessage(error, 'Queue check failed'), latencyMs: roundMs(performance.now() - start) };
  }
}

function checkApi(): HealthComponent {
  const telemetry = getHttpTelemetry();
  const enoughTraffic = telemetry.requests >= 20;
  const status: HealthStatus = enoughTraffic && telemetry.errorRate >= 20
    ? 'outage'
    : telemetry.statusCodes.serverError > 0 || (enoughTraffic && telemetry.latencyMs.p95 >= 3_000)
      ? 'degraded'
      : 'operational';
  return {
    id: 'api',
    name: 'API traffic',
    status,
    summary: status === 'outage' ? 'A high percentage of requests are failing' : status === 'degraded' ? 'Elevated errors or latency detected' : 'Request success rate and latency are healthy',
    latencyMs: telemetry.latencyMs.p95,
    details: { requests5m: telemetry.requests, requestsPerMinute: telemetry.requestsPerMinute, serverErrorRatePercent: telemetry.errorRate, p95LatencyMs: telemetry.latencyMs.p95 },
  };
}

function checkConfiguration(): HealthComponent {
  const stripe = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  const cloudinary = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
  const ai = Boolean(env.OPENAI_API_KEY);
  return {
    id: 'integrations',
    name: 'Service configuration',
    status: 'operational',
    summary: 'Required server configuration is loaded',
    details: { stripeConfigured: stripe, emailConfigured: Boolean(env.SMTP_HOST && env.SMTP_USER), mediaConfigured: cloudinary, aiConfigured: ai },
  };
}

type RailwayPayload = { data?: { deployment?: { id: string; status: string; createdAt?: string; url?: string | null } }; errors?: Array<{ message?: string }> };

async function checkRailway(force = false): Promise<HealthComponent> {
  if (!force && cachedRailway && Date.now() - railwayCachedAt < RAILWAY_CACHE_MS) return cachedRailway;
  const token = env.RAILWAY_TOKEN || env.RAILWAY_API_TOKEN;
  if (!token || !env.RAILWAY_DEPLOYMENT_ID) {
    cachedRailway = {
      id: 'railway', name: 'Railway deployment', status: 'not_configured',
      summary: token ? 'Deployment metadata is unavailable outside Railway' : 'Add a Railway API token to enable deployment checks',
    };
    railwayCachedAt = Date.now();
    return cachedRailway;
  }

  const start = performance.now();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.RAILWAY_TOKEN) headers['Project-Access-Token'] = env.RAILWAY_TOKEN;
    else headers.Authorization = `Bearer ${env.RAILWAY_API_TOKEN}`;
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST', headers, signal: AbortSignal.timeout(4_000),
      body: JSON.stringify({
        query: 'query deployment($id: String!) { deployment(id: $id) { id status createdAt url } }',
        variables: { id: env.RAILWAY_DEPLOYMENT_ID },
      }),
    });
    const body = await response.json() as RailwayPayload;
    if (!response.ok || body.errors?.length || !body.data?.deployment) {
      throw new Error(body.errors?.[0]?.message || `Railway returned HTTP ${response.status}`);
    }
    const deployment = body.data.deployment;
    const outageStates = new Set(['FAILED', 'CRASHED', 'REMOVED']);
    const transitionalStates = new Set(['BUILDING', 'DEPLOYING', 'SLEEPING', 'WAITING', 'QUEUED']);
    const status: HealthStatus = outageStates.has(deployment.status) ? 'outage' : transitionalStates.has(deployment.status) ? 'degraded' : 'operational';
    cachedRailway = {
      id: 'railway', name: 'Railway deployment', status,
      summary: status === 'operational' ? `Deployment ${deployment.status.toLowerCase()}` : `Deployment state: ${deployment.status}`,
      latencyMs: roundMs(performance.now() - start),
      details: { deploymentStatus: deployment.status, deployedAt: deployment.createdAt || null },
    };
  } catch (error) {
    cachedRailway = { id: 'railway', name: 'Railway deployment', status: 'degraded', summary: safeErrorMessage(error, 'Railway API check failed'), latencyMs: roundMs(performance.now() - start) };
  }
  railwayCachedAt = Date.now();
  return cachedRailway;
}

function summarize(components: HealthComponent[]) {
  return {
    operational: components.filter((c) => c.status === 'operational').length,
    degraded: components.filter((c) => c.status === 'degraded').length,
    outage: components.filter((c) => c.status === 'outage').length,
    notConfigured: components.filter((c) => c.status === 'not_configured').length,
  };
}

function overallStatus(components: HealthComponent[]): SystemHealthReport['status'] {
  if (components.some((component) => component.status === 'outage')) return 'outage';
  if (components.some((component) => component.status === 'degraded')) return 'degraded';
  return 'operational';
}

async function readIncidents(): Promise<HealthIncident[]> {
  try {
    const items = await withTimeout(redis.lrange(INCIDENT_KEY, 0, 24), 1_000, 'Incident history');
    return items.map((item) => JSON.parse(item) as HealthIncident).filter(Boolean);
  } catch {
    return localIncidents.slice(0, 25);
  }
}

export async function getSystemHealth(force = false): Promise<SystemHealthReport> {
  if (!force && cachedReport && Date.now() - cachedAt < REPORT_CACHE_MS) return cachedReport;
  const [postgres, redisHealth, queues, railway] = await Promise.all([
    checkPostgres(), checkRedis(), checkQueues(), checkRailway(false),
  ]);
  const components = [checkApi(), postgres, redisHealth, queues, railway, checkConfiguration()];
  const telemetry = getHttpTelemetry();
  const memory = process.memoryUsage();
  const report: SystemHealthReport = {
    status: overallStatus(components),
    checkedAt: new Date().toISOString(),
    monitorIntervalMs: env.HEALTH_MONITOR_INTERVAL_MS,
    summary: summarize(components),
    components,
    telemetry,
    runtime: {
      uptimeSeconds: Math.round(process.uptime()), nodeVersion: process.version,
      environment: env.NODE_ENV, hostname: os.hostname(),
      memory: { rssMb: Math.round(memory.rss / 1_048_576), heapUsedMb: Math.round(memory.heapUsed / 1_048_576), heapTotalMb: Math.round(memory.heapTotal / 1_048_576) },
      system: { loadAverage1m: Math.round(os.loadavg()[0] * 100) / 100, cpuCount: os.cpus().length, freeMemoryMb: Math.round(os.freemem() / 1_048_576), totalMemoryMb: Math.round(os.totalmem() / 1_048_576) },
    },
    railway: {
      configured: Boolean(env.RAILWAY_TOKEN || env.RAILWAY_API_TOKEN),
      connected: typeof railway.details?.deploymentStatus === 'string',
      project: env.RAILWAY_PROJECT_NAME || env.RAILWAY_PROJECT_ID || null,
      environment: env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT_ID || null,
      service: env.RAILWAY_SERVICE_NAME || env.RAILWAY_SERVICE_ID || null,
      deploymentId: env.RAILWAY_DEPLOYMENT_ID || null,
      deploymentStatus: typeof railway.details?.deploymentStatus === 'string' ? railway.details.deploymentStatus : null,
      deployedAt: typeof railway.details?.deployedAt === 'string' ? railway.details.deployedAt : null,
      region: env.RAILWAY_REPLICA_REGION || null, replicaId: env.RAILWAY_REPLICA_ID || null,
      commitSha: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || null, branch: env.RAILWAY_GIT_BRANCH || null,
    },
    incidents: await readIncidents(),
  };
  cachedReport = report;
  cachedAt = Date.now();
  return report;
}

function stateSignature(report: SystemHealthReport) {
  return report.components
    .map((component) => `${component.id}:${component.status === 'not_configured' ? 'operational' : component.status}`)
    .sort()
    .join('|');
}

async function addIncident(report: SystemHealthReport, previousState: string) {
  const affected = report.components.filter((component) => component.status === 'degraded' || component.status === 'outage');
  const recovered = affected.length === 0;
  const incident: HealthIncident = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: report.checkedAt,
    status: report.status,
    title: recovered ? 'System health recovered' : report.status === 'outage' ? 'System outage detected' : 'System degradation detected',
    message: recovered
      ? 'All monitored services are operational again.'
      : affected.map((component) => `${component.name}: ${component.summary}`).join(' · ').slice(0, 500),
    affectedComponents: affected.map((component) => component.id),
  };
  localIncidents.unshift(incident);
  localIncidents.splice(25);
  try {
    await redis.multi().lpush(INCIDENT_KEY, JSON.stringify(incident)).ltrim(INCIDENT_KEY, 0, 24).expire(INCIDENT_KEY, 60 * 60 * 24 * 30).exec();
  } catch { /* Keep the in-memory copy while Redis is unavailable. */ }

  // Do not create a recovery notification when a new instance starts healthy.
  if (!previousState && recovered) return;
  try {
    const incidentPayload: Record<string, unknown> = {
      id: incident.id,
      timestamp: incident.timestamp,
      status: incident.status,
      title: incident.title,
      message: incident.message,
      affectedComponents: incident.affectedComponents,
    };
    await notifyAdmin({
      adminRoles: ['super_admin'], event: 'system:health-alert', payload: incidentPayload,
      persist: { category: 'system', title: incident.title, body: incident.message, data: incidentPayload },
    });
  } catch (error) {
    console.error('Failed to deliver system health alert:', safeErrorMessage(error, 'notification delivery failed'));
  }
}

async function monitorOnce() {
  const lockOwner = `${env.RAILWAY_REPLICA_ID || os.hostname()}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let hasLeaderLock = false;
  try {
    hasLeaderLock = (await redis.set(LEADER_LOCK_KEY, lockOwner, 'PX', 30_000, 'NX')) === 'OK';
  } catch {
    hasLeaderLock = true;
  }
  if (!hasLeaderLock) return;
  try {
    const report = await getSystemHealth(true);
    try { getIO().to('admin-role:super_admin').emit('system:health', report); } catch { /* Socket may still be starting. */ }
    const nextState = stateSignature(report);
    let previousState = localLastState;
    try { previousState = (await redis.get(STATE_KEY)) || previousState; } catch { /* Use local state. */ }
    if (nextState !== previousState) {
      await addIncident(report, previousState);
      try { await redis.set(STATE_KEY, nextState); } catch { /* Use local state. */ }
      localLastState = nextState;
    }
  } finally {
    try {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        LEADER_LOCK_KEY,
        lockOwner,
      );
    } catch { /* Lock expires automatically. */ }
  }
}

function triggerMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;
  void monitorOnce()
    .catch((error) => console.error('System health monitor failed:', safeErrorMessage(error, 'monitor failed')))
    .finally(() => { monitorRunning = false; });
}

export function startSystemHealthMonitor() {
  if (monitorTimer) return;
  triggerMonitor();
  monitorTimer = setInterval(triggerMonitor, env.HEALTH_MONITOR_INTERVAL_MS);
  monitorTimer.unref();
}

export function stopSystemHealthMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
