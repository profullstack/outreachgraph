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
        // The CLI's curl installer: served as a shell script, never cached for long,
        // so `curl -fsSL https://outreachgraph.com/install.sh | sh` always gets the current one.
        source: '/install.sh',
        headers: [
          { key: 'Content-Type', value: 'text/x-sh; charset=utf-8' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
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
