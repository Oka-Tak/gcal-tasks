import { NextResponse, type NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Origin-side Cloudflare Access enforcement (defence layer 1, before the app's
 * own Google login). When CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set, every
 * request must carry a valid `Cf-Access-Jwt-Assertion` issued by your Access
 * team — anything that bypassed Access (a misconfigured tunnel route, or a LAN
 * client hitting the port directly) gets 403 before touching any route.
 * Both env vars unset (dev) = complete no-op.
 */

const teamDomain = (process.env.CF_ACCESS_TEAM_DOMAIN ?? "").replace(/\/$/, "");
const aud = process.env.CF_ACCESS_AUD ?? "";

const jwks = teamDomain
  ? createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
  : null;

export async function proxy(req: NextRequest) {
  if (!jwks || !aud) return NextResponse.next();

  const token = req.headers.get("cf-access-jwt-assertion");
  if (token) {
    try {
      await jwtVerify(token, jwks, { issuer: teamDomain, audience: aud });
      return NextResponse.next();
    } catch {
      // fall through to 403 — invalid/expired/foreign token
    }
  }
  return new NextResponse("Forbidden: Cloudflare Access required", { status: 403 });
}

export const config = {
  // Everything except Next's immutable static assets (they contain no data).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
