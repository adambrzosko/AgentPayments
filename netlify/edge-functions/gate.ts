import type { Context } from "https://edge.netlify.com";

const COOKIE_NAME = "__agp_verified";
const COOKIE_MAX_AGE = 86400; // 24 hours

// --- Crypto helpers ---

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Cookie helpers ---

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isValidCookie(
  request: Request,
  secret: string,
): Promise<boolean> {
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) return false;

  const dotIndex = cookie.indexOf(".");
  if (dotIndex === -1) return false;

  const timestamp = cookie.slice(0, dotIndex);
  const signature = cookie.slice(dotIndex + 1);
  const ts = parseInt(timestamp, 10);

  if (isNaN(ts) || Date.now() - ts > COOKIE_MAX_AGE * 1000) return false;

  const expected = await hmacSign(timestamp, secret);
  return signature === expected;
}

// --- Request helpers ---

function isPublicPath(pathname: string): boolean {
  if (pathname === "/robots.txt") return true;
  if (pathname.startsWith("/.well-known/")) return true;
  return false;
}

function isBrowser(request: Request): boolean {
  const secFetchMode = request.headers.get("sec-fetch-mode");
  const secFetchDest = request.headers.get("sec-fetch-dest");
  return !!(secFetchMode || secFetchDest);
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

// --- Challenge page ---

function challengePage(returnTo: string, nonce: string): Response {
  // Sanitize returnTo to prevent open redirect
  const safePath = returnTo.startsWith("/") ? returnTo : "/";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Just a moment...</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center; min-height: 100vh;
           margin: 0; background: #f4f4f8; color: #333; }
    .box { text-align: center; padding: 2rem; }
    .spinner { width: 40px; height: 40px; border: 4px solid #e8e8e8; border-top-color: #1a1a2e;
               border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { font-size: 1rem; color: #555; }
    .fail { color: #c0392b; }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner" id="spinner"></div>
    <p id="status">Verifying your browser...</p>
  </div>
  <script>
    (function() {
      var status = document.getElementById("status");
      var spinner = document.getElementById("spinner");

      function fail(msg) {
        spinner.style.display = "none";
        status.className = "fail";
        status.textContent = msg;
      }

      // 1. Check for automation
      if (navigator.webdriver) {
        return fail("Automated browser detected.");
      }

      // 2. Verify canvas rendering works (headless often lacks GPU)
      var c = document.createElement("canvas");
      c.width = 200; c.height = 50;
      var ctx = c.getContext("2d");
      if (!ctx) return fail("Canvas unavailable.");
      ctx.font = "18px Arial";
      ctx.fillStyle = "#1a1a2e";
      ctx.fillText("verify", 10, 30);
      var data = c.toDataURL();
      if (!data || data.length < 100) return fail("Canvas check failed.");

      // 3. Check for basic DOM APIs headless environments sometimes lack
      if (typeof window.innerWidth === "undefined" || window.innerWidth === 0) {
        return fail("Browser environment check failed.");
      }

      // All checks passed — submit nonce to verify endpoint
      var form = document.createElement("form");
      form.method = "POST";
      form.action = "/__challenge/verify";

      var fields = {
        nonce: ${JSON.stringify(nonce)},
        return_to: ${JSON.stringify(safePath)},
        fp: data.slice(22, 86)
      };

      for (var key in fields) {
        var input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = fields[key];
        form.appendChild(input);
      }

      document.body.appendChild(form);
      form.submit();
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    },
  });
}

// --- Main handler ---

export default async function gate(request: Request, context: Context) {
  const url = new URL(request.url);
  const secret = Deno.env.get("CHALLENGE_SECRET") || "default-secret-change-me";

  // Always allow public endpoints
  if (isPublicPath(url.pathname)) {
    return context.next();
  }

  // Handle challenge verification POST
  if (url.pathname === "/__challenge/verify" && request.method === "POST") {
    const formData = await request.formData();
    const nonce = formData.get("nonce")?.toString() || "";
    const returnTo = formData.get("return_to")?.toString() || "/";
    const fp = formData.get("fp")?.toString() || "";

    // Validate nonce: must be a recently-signed value
    const dotIndex = nonce.indexOf(".");
    if (dotIndex === -1 || !fp || fp.length < 10) {
      return denyResponse("Challenge verification failed.");
    }

    const nonceTs = nonce.slice(0, dotIndex);
    const nonceSig = nonce.slice(dotIndex + 1);
    const ts = parseInt(nonceTs, 10);

    // Nonce must be less than 5 minutes old
    if (isNaN(ts) || Date.now() - ts > 300_000) {
      return denyResponse("Challenge expired. Please reload the page.");
    }

    const expectedSig = await hmacSign(`nonce:${nonceTs}`, secret);
    if (nonceSig !== expectedSig) {
      return denyResponse("Invalid challenge.");
    }

    // Issue signed cookie
    const now = Date.now().toString();
    const cookieSig = await hmacSign(now, secret);
    const cookieValue = `${now}.${cookieSig}`;
    const safePath = returnTo.startsWith("/") ? returnTo : "/";

    return new Response(null, {
      status: 302,
      headers: {
        Location: safePath,
        "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
      },
    });
  }

  // Non-browser clients (no Sec-Fetch headers) → require API key
  if (!isBrowser(request)) {
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

    const ua = request.headers.get("user-agent") || "unknown";
    console.log(
      `[gate] Authenticated agent: key=${agentKey.slice(0, 8)}... ua=${ua} ip=${context.ip} path=${url.pathname}`,
    );
    return context.next();
  }

  // Browser with valid challenge cookie → pass through
  if (await isValidCookie(request, secret)) {
    return context.next();
  }

  // Browser without cookie → serve JS challenge page
  const nonceTs = Date.now().toString();
  const nonceSig = await hmacSign(`nonce:${nonceTs}`, secret);
  const nonce = `${nonceTs}.${nonceSig}`;

  return challengePage(url.pathname + url.search, nonce);
}
