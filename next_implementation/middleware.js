import { createNextMiddleware } from './lib/next-gate';

export default createNextMiddleware({
  publicPathAllowlist: ['/favicon.ico'],
  minPayment: 0.01,
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
