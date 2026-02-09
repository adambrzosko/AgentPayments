import { createNextMiddleware } from './index';

export default createNextMiddleware();

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
