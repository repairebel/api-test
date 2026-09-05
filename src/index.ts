import { env } from './config/env.js';
import { buildApp } from './app.js';
import { verifySmtp } from './lib/email.js';
import { redis } from './lib/redis.js';
import { pool } from './db/client.js';
import { initSocketIO } from './lib/socket.js';
import { startOfferExpiryWorker, startDispatchTimeoutWorker, startPayoutReleaseWorker } from './lib/queue.js';

async function main() {
  const app = await buildApp();

  // Connect Redis
  await redis.connect();

  // Verify PostgreSQL connectivity
  try {
    const client = await pool.connect();
    client.release();
    app.log.info('✅ PostgreSQL connected');
  } catch (err) {
    app.log.error({ err }, '❌ PostgreSQL connection failed');
    process.exit(1);
  }

  // Verify SMTP connection
  await verifySmtp();

  // Start the server
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`🚀 RepairRebel API running at http://localhost:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Initialise Socket.IO on the underlying HTTP server
  initSocketIO(app.server);

  // Start BullMQ workers
  startOfferExpiryWorker();
  startDispatchTimeoutWorker();
  startPayoutReleaseWorker();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down gracefully…`);
    await app.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
