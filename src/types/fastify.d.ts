import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId: string;
      userType: 'CUSTOMER' | 'SHOP_OWNER' | 'ADMIN';
      shopId: string;                                    // empty string for CUSTOMER
      role: '' | 'OWNER' | 'MANAGER' | 'TECH';           // empty string for CUSTOMER
      jti: string;
    };
  }
}
