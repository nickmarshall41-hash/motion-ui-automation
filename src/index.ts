import { connect, launch } from "@cloudflare/playwright";

interface Env {
  MYBROWSER: Fetcher;
  SESSION_KV: KVNamespace;
  AUTOMATION_TOKEN: string;
}

const MOTION_URL = "https://app.usemotion.com/";
const STORAGE_STATE_KEY = "motion:storage-state";
const ACTIVE_SESSION_KEY = "motion:active-session";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, X-Automation-Token",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (request.method === "GET" && path === "/") {
        return Response.redirect(`${url.origin}/setup`, 302);
      }

      if (request.method === "GET" && path === "/setup") {
        return htmlResponse(setupPage());
      }

      if (request.method === "GET" && path === "/health") {
        return jsonResponse({
          ok: true,
          service: "motion-ui-automation",
          version: "1.0.0",
          browserBinding: Boolean(env.MYBROWSER),
          kvBinding: Boolean(env.SESSION_KV),
          automationTokenConfigured: Boolean(env.AUTOMATION_TOKEN),
        });
      }

      const authorizationError = authorize(request, env);

      if (authorizationError) {
        return authorizationError;
      }

      if (request.method === "GET" && path === "/session/status") {
        return getSessionStatus(env);
      }

      if (request.method === "POST" && path === "/session/start") {
        return startLoginSession(env);
      }

      if (request.method === "POST" && path === "/session/save") {
        return saveLoginSession(env);
      }

      if (request.method === "POST" && path === "/session/test") {
        return testSavedSession(env);
      }

      if (request.method === "DELETE" && path === "/session") {
        return clearSavedSession(env);
      }

      return jsonResponse(
        {
          ok: false,
          error: "Unknown route.",
        },
        404,
      );
    } catch (error) {
      console.error("Unhandled Worker error:", error);

      return jsonResponse(
        {
          ok: false,
          error: "Unhandled Worker error.",
          details: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
};

async function startLoginSession(env: Env): Promise<Response> {
  const savedStateJson = await env.SESSION_KV.get(STORAGE_STATE_KEY);

  const savedState = savedStateJson
    ? JSON.parse(savedStateJson)
    : undefined;

  const browser = await launch(env.MYBROWSER, {
    keep_alive: 600_000,
  });

  const context = await browser.newContext({
    storageState: savedState,
    viewport: {
      width: 1440,
      height: 1000,
    },
  });

  const page = await context.newPage();

  await page.goto(MOTION_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const sessionId = browser.sessionId();

  await env.SESSION_KV.put(ACTIVE_SESSION_KEY, sessionId, {
    expirationTtl: 15 * 60,
  });

  // Do not close the browser. It must remain available under
  // Cloudflare Browser Run > Live Sessions for manual login.
  return jsonResponse({
    ok: true,
    sessionId,
    currentUrl: page.url(),
    nextAction:
      "Open Cloudflare Browser Run > Live Sessions, open this session, sign in to Motion, then return to the setup page and click Save signed-in session.",
  });
}

async function saveLoginSession(env: Env): Promise<Response> {
  const sessionId = await env.SESSION_KV.get(ACTIVE_SESSION_KEY);

  if (!sessionId) {
    return jsonResponse(
      {
        ok: false,
        error: "No active login session was found.",
        nextAction: "Start a new Motion login session first.",
      },
      409,
    );
  }

  const browser = await connect(env.MYBROWSER, sessionId);

  try {
    const context = browser.contexts()[0];

    if (!context) {
      return jsonResponse(
        {
          ok: false,
          error: "The browser session has no active context.",
          nextAction: "Start a new Motion login session.",
        },
        409,
      );
    }

    const page = context.pages()[0] ?? (await context.newPage());

    const updatedState = await context.storageState({
      indexedDB: true,
    });

    await env.SESSION_KV.put(
      STORAGE_STATE_KEY,
      JSON.stringify(updatedState),
    );

    await env.SESSION_KV.delete(ACTIVE_SESSION_KEY);

    return jsonResponse({
      ok: true,
      saved: true,
      sessionId,
      currentUrl: page.url(),
      pageTitle: await safePageTitle(page),
      nextAction: "Click Test saved session.",
    });
  } finally {
    /*
     * This browser came from connect().
     * In Cloudflare Playwright, close() disconnects this Worker request
     * without destroying the underlying browser session.
     */
    await browser.close();
  }
}

async function testSavedSession(env: Env): Promise<Response> {
  const savedStateJson = await env.SESSION_KV.get(STORAGE_STATE_KEY);

  if (!savedStateJson) {
    return jsonResponse(
      {
        ok: false,
        error: "No saved Motion browser state exists.",
        nextAction:
          "Start a Motion login session, sign in, and save the session first.",
      },
      409,
    );
  }

  const browser = await launch(env.MYBROWSER);

  try {
    const context = await browser.newContext({
      storageState: JSON.parse(savedStateJson),
      viewport: {
        width: 1440,
        height: 1000,
      },
    });

    const page = await context.newPage();

    await page.goto(MOTION_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(3_000);

    const currentUrl = page.url();
    const pageTitle = await safePageTitle(page);

    const likelySignedIn =
      !/(login|sign-in|signin|authentication|auth)/i.test(currentUrl);

    const refreshedState = await context.storageState({
      indexedDB: true,
    });

    await env.SESSION_KV.put(
      STORAGE_STATE_KEY,
      JSON.stringify(refreshedState),
    );

    return jsonResponse({
      ok: true,
      currentUrl,
      pageTitle,
      likelySignedIn,
      message: likelySignedIn
        ? "The saved Motion browser session appears to be signed in."
        : "Motion redirected to authentication. Start a new login session and save it again.",
    });
  } finally {
    await browser.close();
  }
}

async function getSessionStatus(env: Env): Promise<Response> {
  const [savedState, activeSessionId] = await Promise.all([
    env.SESSION_KV.get(STORAGE_STATE_KEY),
    env.SESSION_KV.get(ACTIVE_SESSION_KEY),
  ]);

  return jsonResponse({
    ok: true,
    signedInStateSaved: Boolean(savedState),
    activeSessionId: activeSessionId ?? null,
  });
}

async function clearSavedSession(env: Env): Promise<Response> {
  await Promise.all([
    env.SESSION_KV.delete(STORAGE_STATE_KEY),
    env.SESSION_KV.delete(ACTIVE_SESSION_KEY),
  ]);

  return jsonResponse({
    ok: true,
    cleared: true,
  });
}

function authorize(request: Request, env: Env): Response | null {
  if (!env.AUTOMATION_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error: "AUTOMATION_TOKEN is not configured.",
      },
      500,
    );
  }

  const authorization = request.headers.get("Authorization");
  const alternateToken = request.headers.get("X-Automation-Token");

  const suppliedToken =
    authorization?.toLowerCase().startsWith("bearer ")
      ? authorization.slice(7).trim()
      : alternateToken?.trim();

  if (!suppliedToken || suppliedToken !== env.AUTOMATION_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error: "Unauthorized.",
      },
      401,
    );
  }

  return null;
}

async function safePageTitle(page: {
  title(): Promise<string>;
}): Promise<string | null> {
  try {
    return await page.title();
  } catch {
    return null;
  }
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function setupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>Motion UI Automation Setup</title>

  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 800px;
      margin: 48px auto;
      padding: 0 20px;
      line-height: 1.45;
    }

    input,
    button {
      font: inherit;
      padding: 10px 12px;
      margin: 6px 4px 6px 0;
    }

    input {
      width: min(560px, 90%);
    }

    button {
      cursor: pointer;
    }

    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #f4f4f4;
      padding: 14px;
      border-radius: 8px;
    }

    .warning {
      background: #fff5d6;
      padding: 12px;
      border-radius: 8px;
    }
  </style>
</head>

<body>
  <h1>Motion UI Automation Setup</h1>

  <p class="warning">
    Enter the Cloudflare <strong>AUTOMATION_TOKEN</strong> you created.
    This page does not save the token.
  </p>

  <input
    id="token"
    type="password"
    autocomplete="off"
    placeholder="AUTOMATION_TOKEN"
  >

  <div>
    <button onclick="callApi('GET', '/session/status')">
      Check status
    </button>

    <button onclick="callApi('POST', '/session/start')">
      Start Motion login session
    </button>

    <button onclick="callApi('POST', '/session/save')">
      Save signed-in session
    </button>

    <button onclick="callApi('POST', '/session/test')">
      Test saved session
    </button>

    <button onclick="callApi('DELETE', '/session')">
      Clear saved session
    </button>
  </div>

  <h2>Result</h2>

  <pre id="result">Ready.</pre>

  <script>
    async function callApi(method, path) {
      const token =
        document.getElementById("token").value;

      const result =
        document.getElementById("result");

      if (!token) {
        result.textContent =
          "Enter AUTOMATION_TOKEN first.";

        return;
      }

      result.textContent = "Working...";

      try {
        const response = await fetch(path, {
          method,
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json"
          }
        });

        result.textContent =
          await response.text();
      } catch (error) {
        result.textContent = String(error);
      }
    }
  </script>
</body>
</html>`;
}
