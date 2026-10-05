import type { NextConfig } from 'next';

// The browser reaches the API through this origin (`/api/*`) so auth cookies are first-party and
// OAuth callbacks land on the web address (SD-§5.1, PLAN §5.3). In production Vercel does the same
// forwarding; API_PROXY_URL points at the API there (set in the deploy card).
const apiProxy = (process.env.API_PROXY_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const config: NextConfig = {
  // The contracts package ships TypeScript source (no build step).
  transpilePackages: ['@codearena/contracts'],
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiProxy}/api/:path*` }];
  },
};

export default config;
