import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { env } from '../config/env.js';
import { setShopOnline, setCustomerOnline, removeShopPresence, removeCustomerPresence } from './presence.js';

let io: SocketIOServer | null = null;

/**
 * Initialise Socket.IO on top of the existing HTTP server.
 * Call once from index.ts after `app.listen()`.
 */
export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // Track which shop/customer this socket belongs to for cleanup on disconnect
    let socketShopId: string | null = null;
    let socketCustomerId: string | null = null;

    socket.on('disconnect', (reason) => {
      console.log(`❌ Socket disconnected: ${socket.id} — reason: ${reason}`);
      // Remove presence on disconnect
      if (socketShopId) removeShopPresence(socketShopId);
      if (socketCustomerId) removeCustomerPresence(socketCustomerId);
    });

    // ─── Presence heartbeat ─────────────────────────────
    socket.on('presence:heartbeat', (data: { shopId?: string; customerId?: string }) => {
      if (data?.shopId) {
        socketShopId = data.shopId;
        setShopOnline(data.shopId);
      }
      if (data?.customerId) {
        socketCustomerId = data.customerId;
        setCustomerOnline(data.customerId);
      }
    });

    // Allow clients to join their customer room
    socket.on('join:customer', (customerId: string) => {
      if (typeof customerId === 'string' && customerId.length > 0) {
        socket.join(`customer:${customerId}`);
        socketCustomerId = customerId;
        setCustomerOnline(customerId);
      }
    });

    socket.on('leave:customer', (customerId: string) => {
      if (typeof customerId === 'string' && customerId.length > 0) {
        socket.leave(`customer:${customerId}`);
      }
    });

    // Allow clients to join their shop room
    socket.on('join:shop', (shopId: string) => {
      if (typeof shopId === 'string' && shopId.length > 0) {
        socket.join(`shop:${shopId}`);
        socketShopId = shopId;
        setShopOnline(shopId);
      }
    });

    socket.on('leave:shop', (shopId: string) => {
      if (typeof shopId === 'string' && shopId.length > 0) {
        socket.leave(`shop:${shopId}`);
      }
    });

    // Allow clients to join/leave a request room (for offer updates)
    socket.on('join:request', (requestId: string) => {
      if (typeof requestId === 'string' && requestId.length > 0) {
        socket.join(`request:${requestId}`);
      }
    });

    socket.on('leave:request', (requestId: string) => {
      if (typeof requestId === 'string' && requestId.length > 0) {
        socket.leave(`request:${requestId}`);
      }
    });

    // Allow clients to join/leave a job room (for status updates)
    socket.on('join:job', (jobId: string) => {
      if (typeof jobId === 'string' && jobId.length > 0) {
        socket.join(`job:${jobId}`);
      }
    });

    socket.on('leave:job', (jobId: string) => {
      if (typeof jobId === 'string' && jobId.length > 0) {
        socket.leave(`job:${jobId}`);
      }
    });

    // Allow clients to join/leave a chat room (per-job chat thread)
    socket.on('join:chat', (jobId: string) => {
      if (typeof jobId === 'string' && jobId.length > 0) {
        socket.join(`chat:${jobId}`);
      }
    });

    socket.on('leave:chat', (jobId: string) => {
      if (typeof jobId === 'string' && jobId.length > 0) {
        socket.leave(`chat:${jobId}`);
      }
    });

    // Allow clients to join/leave a support conversation room (for live agent chat)
    socket.on('join:support', (conversationId: string) => {
      if (typeof conversationId === 'string' && conversationId.length > 0) {
        socket.join(`support:${conversationId}`);
        console.log(`💬 Socket ${socket.id} joined support:${conversationId}`);
      }
    });

    socket.on('leave:support', (conversationId: string) => {
      if (typeof conversationId === 'string' && conversationId.length > 0) {
        socket.leave(`support:${conversationId}`);
      }
    });

    // Allow admin clients to join the admin room (for real-time dashboard notifications)
    socket.on('join:admin', () => {
      socket.join('admin');
      console.log(`🛡️ Socket ${socket.id} joined admin room`);
    });

    socket.on('leave:admin', () => {
      socket.leave('admin');
    });
  });

  console.log('✅ Socket.IO initialised');
  return io;
}

/**
 * Get the Socket.IO instance. Throws if not initialised yet.
 */
export function getIO(): SocketIOServer {
  if (!io) throw new Error('Socket.IO not initialised — call initSocketIO() first');
  return io;
}
