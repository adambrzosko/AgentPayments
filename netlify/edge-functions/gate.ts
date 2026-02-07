import type { Context } from "https://edge.netlify.com";

function isPublicPath(pathname: string): boolean {
  if (pathname === "/robots.txt") return true;
  if (pathname.startsWith("/.well-known/")) return true;
  return false;
}

// Real browsers send Sec-Fetch-* headers automatically on navigation.
// Programmatic clients (agent runtimes, curl, python-requests, etc.) do not.
function isBrowser(request: Request): boolean {
  const secFetchMode = request.headers.get("sec-fetch-mode");
  const secFetchDest = request.headers.get("sec-fetch-dest");

  // Browser navigation: mode=navigate, dest=document
  // Browser sub-resources (CSS, images, scripts): mode=no-cors/cors, dest=script/style/image/etc.
  // If any Sec-Fetch header is present, it's a real browser.
  if (secFetchMode || secFetchDest) {
    return true;
  }

  return false;
}

function denyResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: "forbidden",
      message,
      details: "GET /.well-known/agent-access.json for access instructions.",
    }),
    {
      status: 403,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export default async function gate(request: Request, context: Context) {
  const url = new URL(request.url);

  // Always allow public endpoints
  if (isPublicPath(url.pathname)) {
    return context.next();
  }

  // Real browser traffic passes through — no key needed
  if (isBrowser(request)) {
    return context.next();
  }

  // Not a browser → require a valid agent key
  const agentKey = request.headers.get("X-Agent-Key");

  if (!agentKey) {
    return denyResponse(
      "Non-browser access requires a valid API key. Send it via the X-Agent-Key header.",
    );
  }

  const allowedKeysRaw = Deno.env.get("ALLOWED_KEYS") || "";
  const allowedKeys = allowedKeysRaw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (!allowedKeys.includes(agentKey)) {
    return denyResponse("Invalid API key.");
  }

  // Valid key — log and pass through
  const ua = request.headers.get("user-agent") || "unknown";
  console.log(
    `[gate] Authenticated agent: key=${agentKey.slice(0, 8)}... ua=${ua} ip=${context.ip} path=${url.pathname}`,
  );

  return context.next();
}
