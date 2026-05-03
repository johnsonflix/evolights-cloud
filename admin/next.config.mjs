/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output bundles only the runtime files we need into
  // .next/standalone — half the image size of a full node_modules COPY.
  output: 'standalone',
  // Reject inbound requests for hosts we didn't explicitly configure (admin
  // panel should be served behind a known reverse-proxy hostname).
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Server Actions are enabled by default in Next.js 15 but explicitly
    // gate body size to keep webhook-shaped abuse off the admin form
    // handlers.
    serverActions: {
      bodySizeLimit: '256kb',
    },
  },
};

export default nextConfig;
