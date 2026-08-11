import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // Railway runs the built server from a Docker image; standalone output keeps
  // that image small by tracing only the files the server actually needs.
  output: 'standalone',

  // The monorepo root, so file tracing follows workspace packages correctly.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  async headers() {
    return [
      {
        // The service worker must never be cached, or clients can be stuck on
        // an old one indefinitely and never see an update.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default config;
