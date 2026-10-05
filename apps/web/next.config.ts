import type { NextConfig } from 'next';

const config: NextConfig = {
  // The contracts package ships TypeScript source (no build step).
  transpilePackages: ['@codearena/contracts'],
  poweredByHeader: false,
};

export default config;
