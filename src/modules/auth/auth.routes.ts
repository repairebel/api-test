import { FastifyPluginAsync } from 'fastify';
import {
  signupHandler,
  signupCustomerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  getMeHandler,
} from './auth.controller.js';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // ──── Public routes (no auth required) ────

  // Shop owner signup (backward compat)
  fastify.post('/auth/signup', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    handler: signupHandler,
  });

  // Shop owner signup (explicit name)
  fastify.post('/auth/signup-shop', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    handler: signupHandler,
  });

  // Customer signup
  fastify.post('/auth/signup-customer', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    handler: signupCustomerHandler,
  });

  fastify.post('/auth/login', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    handler: loginHandler,
  });

  fastify.post('/auth/refresh', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
    handler: refreshHandler,
  });

  fastify.post('/auth/forgot-password', {
    config: {
      rateLimit: { max: 3, timeWindow: '1 minute' },
    },
    handler: forgotPasswordHandler,
  });

  fastify.post('/auth/reset-password', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    handler: resetPasswordHandler,
  });

  // ──── Protected routes (auth required) ────

  fastify.post('/auth/logout', {
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
    handler: logoutHandler,
  });

  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
    handler: getMeHandler,
  });
};

export default authRoutes;
