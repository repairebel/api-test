import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

// Consistent error codes used across the API
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_REQUEST_SIGNATURE: 'INVALID_REQUEST_SIGNATURE',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  SHOP_NOT_APPROVED: 'SHOP_NOT_APPROVED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCodeType,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// ---- Envelope helpers ----

export function successResponse<T>(data: T) {
  return { success: true as const, data };
}

export function paginatedResponse<T>(
  data: T[],
  pagination: { page: number; pageSize: number; total: number },
) {
  return {
    success: true as const,
    data,
    pagination: {
      ...pagination,
      totalPages: Math.ceil(pagination.total / pagination.pageSize),
    },
  };
}

function errorResponse(code: ErrorCodeType, message: string, details?: unknown) {
  return {
    success: false as const,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

// ---- Plugin ----

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error: any, request: FastifyRequest, reply: FastifyReply) => {
    // Zod validation errors
    if (error instanceof ZodError) {
      const formatted = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return reply.status(400).send(errorResponse(ErrorCode.VALIDATION_ERROR, 'Validation failed', formatted));
    }

    // Our custom AppError
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(errorResponse(error.code, error.message, error.details));
    }

    // Fastify built-in validation/serialization errors
    if (error.validation) {
      return reply.status(400).send(errorResponse(ErrorCode.VALIDATION_ERROR, error.message));
    }

    // Rate limit errors (from @fastify/rate-limit)
    if (error.statusCode === 429) {
      return reply.status(429).send(errorResponse(ErrorCode.RATE_LIMITED, 'Too many requests, please try again later'));
    }

    // Generic HTTP errors from @fastify/sensible
    if (error.statusCode && error.statusCode < 500) {
      const code =
        error.statusCode === 401 ? ErrorCode.UNAUTHORIZED :
        error.statusCode === 403 ? ErrorCode.FORBIDDEN :
        error.statusCode === 404 ? ErrorCode.NOT_FOUND :
        error.statusCode === 409 ? ErrorCode.CONFLICT :
        ErrorCode.INTERNAL_ERROR;
      return reply.status(error.statusCode).send(errorResponse(code, error.message));
    }

    // Unhandled / 500 errors
    request.log.error(error);
    return reply.status(500).send(errorResponse(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred'));
  });

  // Custom 404 handler
  fastify.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(errorResponse(ErrorCode.NOT_FOUND, 'Route not found'));
  });
};

export default fp(errorHandlerPlugin, { name: 'error-handler' });
