import type { NextConfig } from "next";

// Origin(s) allowed to embed Kairos in an <iframe> (Proxmox dashboard). Default self.
const frameAncestors = process.env.FRAME_ANCESTORS ?? "'self'";

// React dev mode needs eval() for debugging features; production never does.
const scriptExtra = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; styles use inline style attributes.
  `script-src 'self' 'unsafe-inline'${scriptExtra}`,
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
  experimental: {
    // proxy.ts makes Next buffer request bodies with a 10MB default cap, which
    // truncated lecture-audio uploads (=> "Failed to parse body as FormData").
    // Keep in sync with MAX_BYTES in app/api/notes/ingest.
    proxyClientMaxBodySize: "512mb",
  },
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
