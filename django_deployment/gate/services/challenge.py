import json

from django.http import HttpResponse


def challenge_page(return_to: str, nonce: str) -> HttpResponse:
    """Return the browser challenge page that auto-submits after verification."""
    safe_path = return_to if return_to.startswith("/") else "/"
    nonce_json = json.dumps(nonce)
    safe_path_json = json.dumps(safe_path)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Just a moment...</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center; min-height: 100vh;
           margin: 0; background: #f4f4f8; color: #333; }}
    .box {{ text-align: center; padding: 2rem; }}
    .spinner {{ width: 40px; height: 40px; border: 4px solid #e8e8e8; border-top-color: #1a1a2e;
               border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1rem; }}
    @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
    p {{ font-size: 1rem; color: #555; }}
    .fail {{ color: #c0392b; }}
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner" id="spinner"></div>
    <p id="status">Verifying your browser...</p>
  </div>
  <script>
    (function() {{
      var status = document.getElementById("status");
      var spinner = document.getElementById("spinner");
      function fail(msg) {{ spinner.style.display = "none"; status.className = "fail"; status.textContent = msg; }}
      if (navigator.webdriver) return fail("Automated browser detected.");
      var c = document.createElement("canvas"); c.width = 200; c.height = 50;
      var ctx = c.getContext("2d");
      if (!ctx) return fail("Canvas unavailable.");
      ctx.font = "18px Arial"; ctx.fillStyle = "#1a1a2e"; ctx.fillText("verify", 10, 30);
      var data = c.toDataURL();
      if (!data || data.length < 100) return fail("Canvas check failed.");
      if (typeof window.innerWidth === "undefined" || window.innerWidth === 0) return fail("Browser check failed.");
      var form = document.createElement("form"); form.method = "POST"; form.action = "/__challenge/verify";
      var fields = {{ nonce: {nonce_json}, return_to: {safe_path_json}, fp: data.slice(22, 86) }};
      for (var key in fields) {{ var input = document.createElement("input"); input.type = "hidden"; input.name = key; input.value = fields[key]; form.appendChild(input); }}
      document.body.appendChild(form); form.submit();
    }})();
  </script>
</body>
</html>"""

    return HttpResponse(html, content_type="text/html", headers={"Cache-Control": "no-store"})
