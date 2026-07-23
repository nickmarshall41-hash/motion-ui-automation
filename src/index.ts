import {
  launch,
  type BrowserContextOptions,
  type BrowserWorker,
} from "@cloudflare/playwright";

interface Env {
  MYBROWSER: BrowserWorker;
  SESSION_KV: KVNamespace;
  AUTOMATION_TOKEN: string;
}

const MOTION_URL = "https://app.usemotion.com/";

const STORAGE_STATE_KEY = "motion:storage-state";
const ACTIVE_ATTEMPT_KEY = "motion:active-login-attempt";
const CONFIRM_PREFIX = "motion:login-confirmed:";
const CANCEL_PREFIX = "motion:login-cancelled:";

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
          version: "2.0.0",
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

      if (request.method === "POST" && path === "/session/login") {
        return runInteractiveLogin(env);
      }

      if (request.method === "POST" && path === "/session/confirm") {
        return confirmInteractiveLogin(env);
      }

      if (request.method === "POST" && path === "/session/cancel") {
        return cancelInteractiveLogin(env);
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
          details:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500,
      );
    }
  },
};

async function runInteractiveLogin(
  env: Env,
): Promise<Response> {
  const existingAttempt =
    await env.SESSION_KV.get(ACTIVE_ATTEMPT_KEY);

  if (existingAttempt) {
    return jsonResponse(
      {
        ok: false,
        error: "A Motion login attempt is already active.",
        attemptId: existingAttempt,
        nextAction:
          "Finish or cancel the existing attempt first.",
      },
      409,
    );
  }

  const attemptId = crypto.randomUUID();
  const confirmKey = `${CONFIRM_PREFIX}${attemptId}`;
  const cancelKey = `${CANCEL_PREFIX}${attemptId}`;

  await env.SESSION_KV.put(
    ACTIVE_ATTEMPT_KEY,
    attemptId,
    {
      expirationTtl: 15 * 60,
    },
  );

  const savedStateJson =
    await env.SESSION_KV.get(STORAGE_STATE_KEY);

  const savedState = savedStateJson
    ? (JSON.parse(savedStateJson) as
        BrowserContextOptions["storageState"])
    : undefined;

  const browser = await launch(env.MYBROWSER, {
    keep_alive: 600_000,
  });

  try {
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
    const startTime = Date.now();
    const maximumWait = 9 * 60 * 1000;

    while (Date.now() - startTime < maximumWait) {
      const [confirmed, cancelled] =
        await Promise.all([
          env.SESSION_KV.get(confirmKey),
          env.SESSION_KV.get(cancelKey),
        ]);

      if (cancelled) {
        return jsonResponse({
          ok: false,
          cancelled: true,
          sessionId,
          message:
            "The interactive Motion login was cancelled.",
        });
      }

      if (confirmed) {
        await page.waitForTimeout(2_000);

        const storageState =
          await context.storageState({
            indexedDB: true,
          });

        await env.SESSION_KV.put(
          STORAGE_STATE_KEY,
          JSON.stringify(storageState),
        );

        return jsonResponse({
          ok: true,
          saved: true,
          attemptId,
          sessionId,
          currentUrl: page.url(),
          pageTitle: await safePageTitle(page),
          nextAction: "Click Test saved session.",
        });
      }

      await sleep(1_000);
    }

    return jsonResponse(
      {
        ok: false,
        error:
          "The login attempt timed out before confirmation.",
        sessionId,
        nextAction:
          "Start another attempt and complete it within nine minutes.",
      },
      408,
    );
  } finally {
    await Promise.all([
      env.SESSION_KV.delete(ACTIVE_ATTEMPT_KEY),
      env.SESSION_KV.delete(confirmKey),
      env.SESSION_KV.delete(cancelKey),
    ]);

    await browser.close();
  }
}

async function confirmInteractiveLogin(
  env: Env,
): Promise<Response> {
  const attemptId =
    await env.SESSION_KV.get(ACTIVE_ATTEMPT_KEY);

  if (!attemptId) {
    return jsonResponse(
      {
        ok: false,
        error: "No active Motion login attempt exists.",
        nextAction: "Click Start Motion login first.",
      },
      409,
    );
  }

  await env.SESSION_KV.put(
    `${CONFIRM_PREFIX}${attemptId}`,
    "true",
    {
      expirationTtl: 10 * 60,
    },
  );

  return jsonResponse({
    ok: true,
    confirmed: true,
    attemptId,
    message:
      "Confirmation received. Keep this setup page open while the original login request saves the session.",
  });
}

async function cancelInteractiveLogin(
  env: Env,
): Promise<Response> {
  const attemptId =
    await env.SESSION_KV.get(ACTIVE_ATTEMPT_KEY);

  if (!attemptId) {
    return jsonResponse({
      ok: true,
      cancelled: false,
      message: "There is no active login attempt.",
    });
  }

  await env.SESSION_KV.put(
    `${CANCEL_PREFIX}${attemptId}`,
    "true",
    {
      expirationTtl: 10 * 60,
    },
  );

  return jsonResponse({
    ok: true,
    cancelled: true,
    attemptId,
  });
}

async function testSavedSession(
  env: Env,
): Promise<Response> {
  const savedStateJson =
    await env.SESSION_KV.get(STORAGE_STATE_KEY);

  if (!savedStateJson) {
    return jsonResponse(
      {
        ok: false,
        error: "No saved Motion browser state exists.",
        nextAction:
          "Complete the interactive Motion login first.",
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

    await page.waitForTimeout(4_000);

    const currentUrl = page.url();
    const pageTitle = await safePageTitle(page);

    const passwordVisible = await page
      .locator('input[type="password"]')
      .isVisible()
      .catch(() => false);

    const welcomeBackVisible = await page
      .getByText("Welcome back!", {
        exact: false,
      })
      .isVisible()
      .catch(() => false);

    const likelySignedIn =
      !passwordVisible &&
      !welcomeBackVisible &&
      !/(login|sign-in|signin|auth)/i.test(
        currentUrl,
      );

    if (likelySignedIn) {
      const refreshedState =
        await context.storageState({
          indexedDB: true,
        });

      await env.SESSION_KV.put(
        STORAGE_STATE_KEY,
        JSON.stringify(refreshedState),
      );
    }

    return jsonResponse({
      ok: true,
      currentUrl,
      pageTitle,
      likelySignedIn,
      message: likelySignedIn
        ? "The saved Motion browser session appears to be signed in."
        : "Motion appears to require authentication. Run the interactive login again.",
    });
  } finally {
    await browser.close();
  }
}

async function getSessionStatus(
  env: Env,
): Promise<Response> {
  const [savedState, activeAttemptId] =
    await Promise.all([
      env.SESSION_KV.get(STORAGE_STATE_KEY),
      env.SESSION_KV.get(ACTIVE_ATTEMPT_KEY),
    ]);

  return jsonResponse({
    ok: true,
    signedInStateSaved: Boolean(savedState),
    activeLoginAttemptId: activeAttemptId ?? null,
  });
}

async function clearSavedSession(
  env: Env,
): Promise<Response> {
  const attemptId =
    await env.SESSION_KV.get(ACTIVE_ATTEMPT_KEY);

  const keys = [
    STORAGE_STATE_KEY,
    ACTIVE_ATTEMPT_KEY,
    "motion:active-session",
  ];

  if (attemptId) {
    keys.push(
      `${CONFIRM_PREFIX}${attemptId}`,
      `${CANCEL_PREFIX}${attemptId}`,
    );
  }

  await Promise.all(
    keys.map((key) => env.SESSION_KV.delete(key)),
  );

  return jsonResponse({
    ok: true,
    cleared: true,
  });
}

function authorize(
  request: Request,
  env: Env,
): Response | null {
  if (!env.AUTOMATION_TOKEN) {
    return jsonResponse(
      {
        ok: false,
        error:
          "AUTOMATION_TOKEN is not configured.",
      },
      500,
    );
  }

  const authorization =
    request.headers.get("Authorization");

  const alternateToken =
    request.headers.get("X-Automation-Token");

  const suppliedToken =
    authorization
      ?.toLowerCase()
      .startsWith("bearer ")
      ? authorization.slice(7).trim()
      : alternateToken?.trim();

  if (
    !suppliedToken ||
    suppliedToken !== env.AUTOMATION_TOKEN
  ) {
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

async function safePageTitle(
  page: {
    title(): Promise<string>;
  },
): Promise<string | null> {
  try {
    return await page.title();
  } catch {
    return null;
  }
}

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds),
  );
}

function normalizePath(
  pathname: string,
): string {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(body, null, 2),
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function htmlResponse(
  html: string,
): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type":
        "text/html; charset=utf-8",
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
    content="width=device-width,initial-scale=1"
  >

  <title>Motion UI Automation Setup</title>

  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 820px;
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

    .steps {
      background: #eef6ff;
      padding: 12px 18px 12px 36px;
      border-radius: 8px;
    }
  </style>
</head>

<body>
  <h1>Motion UI Automation Setup</h1>

  <p class="warning">
    Enter your Cloudflare
    <strong>AUTOMATION_TOKEN</strong>.
    This page does not save it.
  </p>

  <ol class="steps">
    <li>
      Click <strong>Start Motion login</strong>.
      The request will remain open.
    </li>

    <li>
      Open Cloudflare Browser Run →
      Live Sessions and sign in to Motion.
    </li>

    <li>
      Return here and click
      <strong>I am signed in — save session</strong>.
    </li>

    <li>
      Wait for the Login result to say
      <code>"saved": true</code>.
    </li>

    <li>
      Click <strong>Test saved session</strong>.
    </li>
  </ol>

  <input
    id="token"
    type="password"
    autocomplete="off"
    placeholder="AUTOMATION_TOKEN"
  >

  <div>
    <button onclick="startLogin()">
      Start Motion login
    </button>

    <button
      onclick="quickCall(
        'POST',
        '/session/confirm'
      )"
    >
      I am signed in — save session
    </button>

    <button
      onclick="quickCall(
        'POST',
        '/session/test'
      )"
    >
      Test saved session
    </button>

    <button
      onclick="quickCall(
        'GET',
        '/session/status'
      )"
    >
      Check status
    </button>

    <button
      onclick="quickCall(
        'POST',
        '/session/cancel'
      )"
    >
      Cancel login
    </button>

    <button
      onclick="quickCall(
        'DELETE',
        '/session'
      )"
    >
      Clear saved session
    </button>
  </div>

  <h2>Login result</h2>
  <pre id="loginResult">Not started.</pre>

  <h2>Action result</h2>
  <pre id="actionResult">Ready.</pre>

  <script>
    function getToken() {
      return document
        .getElementById("token")
        .value;
    }

    function getHeaders() {
      return {
        Authorization:
          "Bearer " + getToken(),

        "Content-Type":
          "application/json"
      };
    }

    async function startLogin() {
      const result =
        document.getElementById(
          "loginResult"
        );

      if (!getToken()) {
        result.textContent =
          "Enter AUTOMATION_TOKEN first.";

        return;
      }

      result.textContent =
        "The login browser is starting. " +
        "Open Cloudflare Browser Run → " +
        "Live Sessions, sign in, then " +
        "return here and click I am " +
        "signed in — save session.";

      try {
        const response = await fetch(
          "/session/login",
          {
            method: "POST",
            headers: getHeaders()
          }
        );

        result.textContent =
          await response.text();
      } catch (error) {
        result.textContent =
          String(error);
      }
    }

    async function quickCall(
      method,
      path
    ) {
      const result =
        document.getElementById(
          "actionResult"
        );

      if (!getToken()) {
        result.textContent =
          "Enter AUTOMATION_TOKEN first.";

        return;
      }

      result.textContent = "Working...";

      try {
        const response = await fetch(
          path,
          {
            method,
            headers: getHeaders()
          }
        );

        result.textContent =
          await response.text();
      } catch (error) {
        result.textContent =
          String(error);
      }
    }
  </script>
</body>
</html>`;
}
