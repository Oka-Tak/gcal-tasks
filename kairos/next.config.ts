import type { NextConfig } from "next";

// Origin(s) allowed to embed Kairos in an <iframe> (Proxmox dashboard). Default self.
const frameAncestors = process.env.FRAME_ANCESTORS ?? "'self'";

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; styles use inline style attributes.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "form-action 'self' https://accounts.google.com",
  "base-uri 'self'",
  `frame-ancestors ${frameAncestors}`,
].join("; ");

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it external so it isn't bundled.
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
