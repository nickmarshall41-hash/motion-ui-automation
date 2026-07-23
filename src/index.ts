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

type LocatorTarget = {
  by:
    | "role"
    | "text"
    | "label"
    | "placeholder"
    | "testId"
    | "css";
  value?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  nth?: number;
};

type UiStep =
  | {
      action: "goto";
      url: string;
      waitUntil?:
        | "load"
        | "domcontentloaded"
        | "networkidle"
        | "commit";
      timeoutMs?: number;
    }
  | {
      action: "click";
      target: LocatorTarget;
      timeoutMs?: number;
    }
  | {
      action: "fill";
      target: LocatorTarget;
      value: string;
      timeoutMs?: number;
    }
  | {
      action: "clear";
      target: LocatorTarget;
      timeoutMs?: number;
    }
  | {
      action: "press";
      key: string;
      target?: LocatorTarget;
      timeoutMs?: number;
    }
  | {
      action: "select";
      target: LocatorTarget;
      value: string | string[];
      timeoutMs?: number;
    }
  | {
      action: "check" | "uncheck";
      target: LocatorTarget;
      timeoutMs?: number;
    }
  | {
      action: "wait";
      ms: number;
    }
  | {
      action: "waitFor";
      target: LocatorTarget;
      state?:
        | "attached"
        | "detached"
        | "visible"
        | "hidden";
      timeoutMs?: number;
    }
  | {
      action: "assertVisible";
      target: LocatorTarget;
      timeoutMs?: number;
    }
  | {
      action: "assertText";
      target: LocatorTarget;
      text: string;
      exact?: boolean;
      timeoutMs?: number;
    }
  | {
      action: "assertUrl";
      contains?: string;
      matches?: string;
    }
  | {
      action: "scroll";
      target?: LocatorTarget;
      direction?: "up" | "down";
      amount?: number;
    }
  | {
      action: "reload";
      waitUntil?:
        | "load"
        | "domcontentloaded"
        | "networkidle"
        | "commit";
      timeoutMs?: number;
    }
  | {
      action: "screenshot";
      fullPage?: boolean;
    };

type RunRequest = {
  operationName?: string;
  startUrl?: string;
  steps: UiStep[];
  dryRun?: boolean;
  confirmDestructive?: boolean;
  saveState?: boolean;
  inspectAfter?: boolean;
  includeVisibleTextAfter?: boolean;
  maxControlsAfter?: number;
};

type InspectRequest = {
  url?: string;
  includeVisibleText?: boolean;
  maxControls?: number;
  screenshot?: boolean;
  waitMs?: number;
};

const MOTION_ORIGIN =
  "https://app.usemotion.com";

const MOTION_URL =
  `${MOTION_ORIGIN}/`;

const STORAGE_STATE_KEY =
  "motion:storage-state";

const ACTIVE_ATTEMPT_KEY =
  "motion:active-login-attempt";

const CONFIRM_PREFIX =
  "motion:login-confirmed:";

const CANCEL_PREFIX =
  "motion:login-cancelled:";

const AUTOMATION_LOCK_KEY =
  "motion:ui-automation-lock";

const ARTIFACT_PREFIX =
  "motion:artifact:";

const MAX_UI_STEPS = 50;
const MAX_WAIT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const AUTOMATION_LOCK_TTL_SECONDS =
  4 * 60;

const ARTIFACT_TTL_SECONDS =
  24 * 60 * 60;

const CORS_HEADERS:
  Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Automation-Token",
    "Access-Control-Max-Age": "86400",
  };

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      const requestUrl =
        new URL(request.url);

      const path =
        normalizePath(requestUrl.pathname);

      if (
        request.method === "GET" &&
        path === "/"
      ) {
        return Response.redirect(
          `${requestUrl.origin}/setup`,
          302,
        );
      }

      if (
        request.method === "GET" &&
        path === "/setup"
      ) {
        return htmlResponse(setupPage());
      }

      if (
        request.method === "GET" &&
        path === "/health"
      ) {
        return jsonResponse({
          ok: true,
          service:
            "motion-ui-automation",
          version: "3.0.0",
          browserBinding:
            Boolean(env.MYBROWSER),
          kvBinding:
            Boolean(env.SESSION_KV),
          automationTokenConfigured:
            Boolean(
              env.AUTOMATION_TOKEN,
            ),
        });
      }

      const authorizationError =
        authorize(request, env);

      if (authorizationError) {
        return authorizationError;
      }

      if (
        request.method === "GET" &&
        path === "/capabilities"
      ) {
        return jsonResponse(
          capabilities(),
        );
      }

      if (
        request.method === "GET" &&
        path === "/session/status"
      ) {
        return getSessionStatus(env);
      }

      if (
        request.method === "POST" &&
        path === "/session/login"
      ) {
        return runInteractiveLogin(env);
      }

      if (
        request.method === "POST" &&
        path === "/session/confirm"
      ) {
        return confirmInteractiveLogin(
          env,
        );
      }

      if (
        request.method === "POST" &&
        path === "/session/cancel"
      ) {
        return cancelInteractiveLogin(
          env,
        );
      }

      if (
        request.method === "POST" &&
        path === "/session/test"
      ) {
        return testSavedSession(env);
      }

      if (
        request.method === "DELETE" &&
        path === "/session"
      ) {
        return clearSavedSession(env);
      }

      if (
        request.method === "POST" &&
        path === "/ui/inspect"
      ) {
        const body =
          await readJson<InspectRequest>(
            request,
          );

        return inspectMotionUi(
          env,
          requestUrl.origin,
          body,
        );
      }

      if (
        request.method === "POST" &&
        path === "/ui/run"
      ) {
        const body =
          await readJson<RunRequest>(
            request,
          );

        return runMotionUi(
          env,
          requestUrl.origin,
          body,
        );
      }

      const artifactMatch =
        path.match(
          /^\/artifacts\/([a-zA-Z0-9-]+)$/,
        );

      if (
        request.method === "GET" &&
        artifactMatch
      ) {
        return getArtifact(
          env,
          artifactMatch[1],
        );
      }

      return jsonResponse(
        {
          ok: false,
          error: "Unknown route.",
          supportedRoutes:
            capabilities().routes,
        },
        404,
      );
    } catch (error) {
      console.error(
        "Unhandled Worker error:",
        error,
      );

      return jsonResponse(
        {
          ok: false,
          error:
            "Unhandled Worker error.",
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

function capabilities() {
  return {
    ok: true,
    service:
      "motion-ui-automation",
    version: "3.0.0",

    purpose:
      "Authenticated Motion-only UI inspection and controlled browser automation for features not exposed by the public Motion API.",

    routes: [
      "GET /health",
      "GET /capabilities",
      "GET /session/status",
      "POST /session/login",
      "POST /session/confirm",
      "POST /session/cancel",
      "POST /session/test",
      "DELETE /session",
      "POST /ui/inspect",
      "POST /ui/run",
      "GET /artifacts/{artifactId}",
    ],

    supportedUiSteps: [
      "goto",
      "click",
      "fill",
      "clear",
      "press",
      "select",
      "check",
      "uncheck",
      "wait",
      "waitFor",
      "assertVisible",
      "assertText",
      "assertUrl",
      "scroll",
      "reload",
      "screenshot",
    ],

    supportedLocators: [
      "role",
      "text",
      "label",
      "placeholder",
      "testId",
      "css",
    ],

    safety: {
      allowedOrigin:
        MOTION_ORIGIN,

      maxSteps:
        MAX_UI_STEPS,

      destructiveActionsRequireConfirmation:
        true,

      arbitraryJavaScriptExecution:
        false,

      diagnosticScreenshotsOnFailure:
        true,

      sessionStateRefreshAfterSuccessfulRuns:
        true,

      concurrencyLock:
        true,
    },
  };
}

async function inspectMotionUi(
  env: Env,
  workerOrigin: string,
  input: InspectRequest,
): Promise<Response> {
  const lock =
    await acquireAutomationLock(
      env,
      "inspect",
    );

  if (!lock.ok) {
    return jsonResponse(lock, 409);
  }

  let browser:
    Awaited<
      ReturnType<typeof launch>
    > | null = null;

  try {
    const savedState =
      await requireSavedState(env);

    const targetUrl =
      validateMotionUrl(
        input?.url ?? MOTION_URL,
      );

    browser =
      await launch(env.MYBROWSER);

    const context =
      await browser.newContext({
        storageState: savedState,
        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    const page =
      await context.newPage();

    page.setDefaultTimeout(
      DEFAULT_TIMEOUT_MS,
    );

    await page.goto(targetUrl, {
      waitUntil:
        "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(
      clampInteger(
        input?.waitMs ?? 2_000,
        0,
        MAX_WAIT_MS,
      ),
    );

    assertPageStayedInMotion(
      page.url(),
    );

    await ensureSignedIn(page);

    const summary =
      await collectPageSummary(
        page,
        Boolean(
          input?.includeVisibleText,
        ),
        clampInteger(
          input?.maxControls ?? 120,
          1,
          250,
        ),
      );

    let artifactId:
      string | null = null;

    if (input?.screenshot) {
      artifactId =
        await saveScreenshot(
          env,
          page,
          true,
        );
    }

    await persistStorageState(
      env,
      context,
    );

    return jsonResponse({
      ok: true,
      summary,

      artifact:
        artifactId
          ? {
              id: artifactId,
              endpoint:
                `${workerOrigin}/artifacts/${artifactId}`,
              expiresInSeconds:
                ARTIFACT_TTL_SECONDS,
            }
          : null,
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Motion UI inspection failed.",
        details:
          errorMessage(error),
      },
      500,
    );
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => undefined);
    }

    await releaseAutomationLock(
      env,
      lock.lockId,
    );
  }
}

async function runMotionUi(
  env: Env,
  workerOrigin: string,
  input: RunRequest,
): Promise<Response> {
  validateRunRequest(input);

  const destructiveMatches =
    findDestructiveMatches(
      input.steps,
    );

  const destructive =
    destructiveMatches.length > 0;

  if (
    destructive &&
    !input.confirmDestructive
  ) {
    return jsonResponse(
      {
        ok: false,

        error:
          "This plan appears to include a destructive or cleanup action. Resubmit with confirmDestructive=true only after verifying the intended targets.",

        destructiveMatches,
      },
      409,
    );
  }

  if (input.dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,

      operationName:
        input.operationName ?? null,

      destructive,

      normalizedPlan:
        sanitizeStepsForOutput(
          input.steps,
        ),

      message:
        "No browser was opened and no Motion data was changed.",
    });
  }

  const lock =
    await acquireAutomationLock(
      env,
      input.operationName ??
        "ui-run",
    );

  if (!lock.ok) {
    return jsonResponse(lock, 409);
  }

  let browser:
    Awaited<
      ReturnType<typeof launch>
    > | null = null;

  let page: any = null;

  let artifactId:
    string | null = null;

  const stepResults:
    unknown[] = [];

  try {
    const savedState =
      await requireSavedState(env);

    const startUrl =
      validateMotionUrl(
        input.startUrl ??
          MOTION_URL,
      );

    browser =
      await launch(
        env.MYBROWSER,
        {
          keep_alive:
            180_000,
        },
      );

    const context =
      await browser.newContext({
        storageState: savedState,

        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    page =
      await context.newPage();

    page.setDefaultTimeout(
      DEFAULT_TIMEOUT_MS,
    );

    await page.goto(startUrl, {
      waitUntil:
        "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(
      2_000,
    );

    assertPageStayedInMotion(
      page.url(),
    );

    await ensureSignedIn(page);

    for (
      let index = 0;
      index <
      input.steps.length;
      index += 1
    ) {
      const step =
        input.steps[index];

      try {
        const result =
          await executeUiStep(
            env,
            page,
            step,
          );

        assertPageStayedInMotion(
          page.url(),
        );

        stepResults.push({
          index,
          action:
            step.action,
          ok: true,
          result,
          currentUrl:
            page.url(),
        });
      } catch (error) {
        artifactId =
          await saveScreenshot(
            env,
            page,
            true,
          ).catch(() => null);

        throw new Error(
          `Step ${index + 1} (${step.action}) failed: ${errorMessage(error)}`,
        );
      }
    }

    if (
      input.saveState !== false
    ) {
      await persistStorageState(
        env,
        context,
      );
    }

    const summary =
      input.inspectAfter
        ? await collectPageSummary(
            page,

            Boolean(
              input
                .includeVisibleTextAfter,
            ),

            clampInteger(
              input
                .maxControlsAfter ??
                120,
              1,
              250,
            ),
          )
        : null;

    return jsonResponse({
      ok: true,

      operationName:
        input.operationName ?? null,

      destructive,

      stepCount:
        input.steps.length,

      steps:
        stepResults,

      finalUrl:
        page.url(),

      finalTitle:
        await safePageTitle(
          page,
        ),

      summary,

      artifact:
        artifactId
          ? {
              id:
                artifactId,

              endpoint:
                `${workerOrigin}/artifacts/${artifactId}`,
            }
          : null,
    });
  } catch (error) {
    if (
      page &&
      !artifactId
    ) {
      artifactId =
        await saveScreenshot(
          env,
          page,
          true,
        ).catch(() => null);
    }

    return jsonResponse(
      {
        ok: false,

        error:
          "Motion UI automation failed.",

        details:
          errorMessage(error),

        completedSteps:
          stepResults,

        artifact:
          artifactId
            ? {
                id:
                  artifactId,

                endpoint:
                  `${workerOrigin}/artifacts/${artifactId}`,

                expiresInSeconds:
                  ARTIFACT_TTL_SECONDS,
              }
            : null,
      },
      500,
    );
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => undefined);
    }

    await releaseAutomationLock(
      env,
      lock.lockId,
    );
  }
}

async function executeUiStep(
  env: Env,
  page: any,
  step: UiStep,
): Promise<unknown> {
  switch (step.action) {
    case "goto": {
      const url =
        validateMotionUrl(
          step.url,
        );

      await page.goto(url, {
        waitUntil:
          step.waitUntil ??
          "domcontentloaded",

        timeout:
          clampInteger(
            step.timeoutMs ??
              60_000,
            1_000,
            90_000,
          ),
      });

      await page.waitForTimeout(
        1_000,
      );

      return {
        url:
          page.url(),

        title:
          await safePageTitle(
            page,
          ),
      };
    }

    case "click": {
      const locator =
        resolveLocator(
          page,
          step.target,
        );

      await locator.click({
        timeout:
          clampInteger(
            step.timeoutMs ??
              DEFAULT_TIMEOUT_MS,
            500,
            60_000,
          ),
      });

      await page.waitForTimeout(
        400,
      );

      return describeTarget(
        step.target,
      );
    }

    case "fill": {
      const locator =
        resolveLocator(
          page,
          step.target,
        );

      await locator.fill(
        step.value,
        {
          timeout:
            clampInteger(
              step.timeoutMs ??
                DEFAULT_TIMEOUT_MS,
              500,
              60_000,
            ),
        },
      );

      return {
        target:
          describeTarget(
            step.target,
          ),

        valueLength:
          step.value.length,
      };
    }

    case "clear": {
      const locator =
        resolveLocator(
          page,
          step.target,
        );

      await locator.clear({
        timeout:
          clampInteger(
            step.timeoutMs ??
              DEFAULT_TIMEOUT_MS,
            500,
            60_000,
          ),
      });

      return describeTarget(
        step.target,
      );
    }

    case "press": {
      const timeout =
        clampInteger(
          step.timeoutMs ??
            DEFAULT_TIMEOUT_MS,
          500,
          60_000,
        );

      if (step.target) {
        await resolveLocator(
          page,
          step.target,
        ).press(
          step.key,
          { timeout },
        );
      } else {
        await page.keyboard.press(
          step.key,
        );
      }

      return {
        key:
          step.key,

        target:
          step.target
            ? describeTarget(
                step.target,
              )
            : "page",
      };
    }

    case "select": {
      const selected =
        await resolveLocator(
          page,
          step.target,
        ).selectOption(
          step.value,
          {
            timeout:
              clampInteger(
                step.timeoutMs ??
                  DEFAULT_TIMEOUT_MS,
                500,
                60_000,
              ),
          },
        );

      return {
        target:
          describeTarget(
            step.target,
          ),

        selected,
      };
    }

    case "check":
    case "uncheck": {
      const locator =
        resolveLocator(
          page,
          step.target,
        );

      const timeout =
        clampInteger(
          step.timeoutMs ??
            DEFAULT_TIMEOUT_MS,
          500,
          60_000,
        );

      if (
        step.action === "check"
      ) {
        await locator.check({
          timeout,
        });
      } else {
        await locator.uncheck({
          timeout,
        });
      }

      return describeTarget(
        step.target,
      );
    }

    case "wait": {
      const ms =
        clampInteger(
          step.ms,
          0,
          MAX_WAIT_MS,
        );

      await page.waitForTimeout(
        ms,
      );

      return {
        waitedMs: ms,
      };
    }

    case "waitFor": {
      await resolveLocator(
        page,
        step.target,
      ).waitFor({
        state:
          step.state ??
          "visible",

        timeout:
          clampInteger(
            step.timeoutMs ??
              DEFAULT_TIMEOUT_MS,
            500,
            60_000,
          ),
      });

      return {
        target:
          describeTarget(
            step.target,
          ),

        state:
          step.state ??
          "visible",
      };
    }

    case "assertVisible": {
      await resolveLocator(
        page,
        step.target,
      ).waitFor({
        state: "visible",

        timeout:
          clampInteger(
            step.timeoutMs ??
              DEFAULT_TIMEOUT_MS,
            500,
            60_000,
          ),
      });

      return describeTarget(
        step.target,
      );
    }

    case "assertText": {
      const actual =
        normalizeWhitespace(
          await resolveLocator(
            page,
            step.target,
          ).innerText({
            timeout:
              clampInteger(
                step.timeoutMs ??
                  DEFAULT_TIMEOUT_MS,
                500,
                60_000,
              ),
          }),
        );

      const expected =
        normalizeWhitespace(
          step.text,
        );

      const matches =
        step.exact
          ? actual === expected
          : actual.includes(
              expected,
            );

      if (!matches) {
        throw new Error(
          `Text assertion failed. Expected ${step.exact ? "exactly" : "to include"} "${expected}", received "${actual.slice(0, 500)}".`,
        );
      }

      return {
        matched: true,

        target:
          describeTarget(
            step.target,
          ),
      };
    }

    case "assertUrl": {
      const currentUrl =
        page.url();

      if (
        step.contains &&
        !currentUrl.includes(
          step.contains,
        )
      ) {
        throw new Error(
          `URL assertion failed. Expected the URL to contain "${step.contains}", received "${currentUrl}".`,
        );
      }

      if (step.matches) {
        const regex =
          new RegExp(
            step.matches,
          );

        if (
          !regex.test(
            currentUrl,
          )
        ) {
          throw new Error(
            `URL assertion failed. "${currentUrl}" did not match /${step.matches}/.`,
          );
        }
      }

      return {
        currentUrl,
      };
    }

    case "scroll": {
      const amount =
        clampInteger(
          step.amount ?? 700,
          1,
          5_000,
        );

      const signedAmount =
        (
          step.direction ??
          "down"
        ) === "down"
          ? amount
          : -amount;

      if (step.target) {
        await resolveLocator(
          page,
          step.target,
        ).evaluate(
          (
            element:
              HTMLElement,

            delta:
              number,
          ) => {
            element.scrollBy({
              top: delta,
              behavior: "auto",
            });
          },
          signedAmount,
        );
      } else {
        await page.mouse.wheel(
          0,
          signedAmount,
        );
      }

      await page.waitForTimeout(
        300,
      );

      return {
        direction:
          step.direction ??
          "down",

        amount,

        target:
          step.target
            ? describeTarget(
                step.target,
              )
            : "page",
      };
    }

    case "reload": {
      await page.reload({
        waitUntil:
          step.waitUntil ??
          "domcontentloaded",

        timeout:
          clampInteger(
            step.timeoutMs ??
              60_000,
            1_000,
            90_000,
          ),
      });

      await page.waitForTimeout(
        1_000,
      );

      return {
        url:
          page.url(),

        title:
          await safePageTitle(
            page,
          ),
      };
    }

    case "screenshot": {
      const artifactId =
        await saveScreenshot(
          env,
          page,
          step.fullPage ??
            true,
        );

      return {
        artifactId,
      };
    }

    default: {
      const neverStep:
        never = step;

      throw new Error(
        `Unsupported step: ${JSON.stringify(neverStep)}`,
      );
    }
  }
}

function resolveLocator(
  page: any,
  target: LocatorTarget,
): any {
  validateLocatorTarget(
    target,
  );

  let locator: any;

  switch (target.by) {
    case "role":
      locator =
        page.getByRole(
          target.role,
          {
            name:
              target.name ??
              target.value,

            exact:
              target.exact ??
              false,
          },
        );
      break;

    case "text":
      locator =
        page.getByText(
          target.value ??
            "",
          {
            exact:
              target.exact ??
              false,
          },
        );
      break;

    case "label":
      locator =
        page.getByLabel(
          target.value ??
            "",
          {
            exact:
              target.exact ??
              false,
          },
        );
      break;

    case "placeholder":
      locator =
        page.getByPlaceholder(
          target.value ??
            "",
          {
            exact:
              target.exact ??
              false,
          },
        );
      break;

    case "testId":
      locator =
        page.getByTestId(
          target.value ??
            "",
        );
      break;

    case "css":
      locator =
        page.locator(
          target.value ??
            "",
        );
      break;

    default:
      throw new Error(
        `Unsupported locator type: ${String((target as any).by)}`,
      );
  }

  if (
    Number.isInteger(
      target.nth,
    )
  ) {
    locator =
      locator.nth(
        target.nth,
      );
  }

  return locator;
}

async function collectPageSummary(
  page: any,
  includeVisibleText:
    boolean,
  maxControls:
    number,
): Promise<unknown> {
  const headings =
    (
      await page
        .locator(
          'h1, h2, h3, [role="heading"]',
        )
        .allTextContents()
    )
      .map(
        normalizeWhitespace,
      )
      .filter(Boolean)
      .slice(0, 60);

  const dialogs =
    (
      await page
        .locator(
          '[role="dialog"]',
        )
        .allTextContents()
    )
      .map(
        normalizeWhitespace,
      )
      .filter(Boolean)
      .slice(0, 20)
      .map(
        (text: string) =>
          text.slice(
            0,
            2_000,
          ),
      );

  const controls =
    await page
      .locator(
        'button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [contenteditable="true"]',
      )
      .evaluateAll(
        (
          elements:
            Element[],

          limit:
            number,
        ) => {
          const normalize =
            (
              value:
                string |
                null |
                undefined,
            ) =>
              (
                value ??
                ""
              )
                .replace(
                  /\s+/g,
                  " ",
                )
                .trim();

          return elements
            .filter(
              (
                element,
              ) => {
                const html =
                  element as HTMLElement;

                const rect =
                  html
                    .getBoundingClientRect();

                const style =
                  window
                    .getComputedStyle(
                      html,
                    );

                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.visibility !==
                    "hidden" &&
                  style.display !==
                    "none"
                );
              },
            )
            .slice(
              0,
              limit,
            )
            .map(
              (
                element,
                index,
              ) => {
                const html =
                  element as HTMLElement;

                const input =
                  element as HTMLInputElement;

                const anchor =
                  element as HTMLAnchorElement;

                const associatedLabel =
                  "labels" in input &&
                  input.labels &&
                  input.labels
                    .length > 0
                    ? normalize(
                        input
                          .labels[0]
                          ?.textContent,
                      )
                    : "";

                const tag =
                  element
                    .tagName
                    .toLowerCase();

                const role =
                  element
                    .getAttribute(
                      "role",
                    ) ||
                  (
                    tag ===
                    "button"
                  )
                    ? "button"
                    : (
                        tag ===
                        "a"
                      )
                      ? "link"
                      : "";

                const text =
                  normalize(
                    html.innerText ||
                      element
                        .textContent,
                  );

                const ariaLabel =
                  normalize(
                    element
                      .getAttribute(
                        "aria-label",
                      ),
                  );

                const placeholder =
                  normalize(
                    element
                      .getAttribute(
                        "placeholder",
                      ),
                  );

                const testId =
                  normalize(
                    element
                      .getAttribute(
                        "data-testid",
                      ),
                  );

                const title =
                  normalize(
                    element
                      .getAttribute(
                        "title",
                      ),
                  );

                const type =
                  normalize(
                    element
                      .getAttribute(
                        "type",
                      ),
                  );

                const name =
                  normalize(
                    element
                      .getAttribute(
                        "name",
                      ),
                  );

                const suggestions:
                  unknown[] = [];

                if (
                  role &&
                  (
                    ariaLabel ||
                    text
                  )
                ) {
                  suggestions.push({
                    by: "role",
                    role,
                    name:
                      ariaLabel ||
                      text.slice(
                        0,
                        160,
                      ),
                    exact: true,
                  });
                }

                if (
                  associatedLabel
                ) {
                  suggestions.push({
                    by: "label",
                    value:
                      associatedLabel,
                    exact: true,
                  });
                }

                if (
                  placeholder
                ) {
                  suggestions.push({
                    by:
                      "placeholder",
                    value:
                      placeholder,
                    exact: true,
                  });
                }

                if (testId) {
                  suggestions.push({
                    by: "testId",
                    value:
                      testId,
                  });
                }

                if (
                  text &&
                  text.length <=
                    180
                ) {
                  suggestions.push({
                    by: "text",
                    value: text,
                    exact: true,
                  });
                }

                return {
                  index,
                  tag,

                  role:
                    role ||
                    null,

                  text:
                    text
                      ? text.slice(
                          0,
                          240,
                        )
                      : null,

                  ariaLabel:
                    ariaLabel ||
                    null,

                  associatedLabel:
                    associatedLabel ||
                    null,

                  placeholder:
                    placeholder ||
                    null,

                  testId:
                    testId ||
                    null,

                  title:
                    title ||
                    null,

                  type:
                    type ||
                    null,

                  name:
                    name ||
                    null,

                  href:
                    tag ===
                      "a" &&
                    anchor.href
                      ? anchor.href
                      : null,

                  disabled:
                    element.hasAttribute(
                      "disabled",
                    ) ||
                    element.getAttribute(
                      "aria-disabled",
                    ) ===
                      "true",

                  checked:
                    type ===
                      "checkbox" ||
                    type ===
                      "radio"
                      ? Boolean(
                          input.checked,
                        )
                      : null,

                  hasValue:
                    tag ===
                      "input" ||
                    tag ===
                      "textarea" ||
                    tag ===
                      "select"
                      ? Boolean(
                          input.value,
                        )
                      : null,

                  suggestedTargets:
                    suggestions.slice(
                      0,
                      5,
                    ),
                };
              },
            );
        },
        maxControls,
      );

  const visibleText =
    includeVisibleText
      ? normalizeWhitespace(
          await page
            .locator("body")
            .innerText(),
        ).slice(
          0,
          15_000,
        )
      : null;

  return {
    url:
      page.url(),

    title:
      await safePageTitle(
        page,
      ),

    headings,
    dialogs,
    controls,
    visibleText,
  };
}

async function runInteractiveLogin(
  env: Env,
): Promise<Response> {
  const existingAttempt =
    await env.SESSION_KV.get(
      ACTIVE_ATTEMPT_KEY,
    );

  if (existingAttempt) {
    return jsonResponse(
      {
        ok: false,

        error:
          "A Motion login attempt is already active.",

        attemptId:
          existingAttempt,

        nextAction:
          "Finish or cancel the existing attempt first.",
      },
      409,
    );
  }

  const attemptId =
    crypto.randomUUID();

  const confirmKey =
    `${CONFIRM_PREFIX}${attemptId}`;

  const cancelKey =
    `${CANCEL_PREFIX}${attemptId}`;

  await env.SESSION_KV.put(
    ACTIVE_ATTEMPT_KEY,
    attemptId,
    {
      expirationTtl:
        15 * 60,
    },
  );

  const savedStateJson =
    await env.SESSION_KV.get(
      STORAGE_STATE_KEY,
    );

  const savedState =
    savedStateJson
      ? (
          JSON.parse(
            savedStateJson,
          ) as
            BrowserContextOptions[
              "storageState"
            ]
        )
      : undefined;

  const browser =
    await launch(
      env.MYBROWSER,
      {
        keep_alive:
          600_000,
      },
    );

  try {
    const context =
      await browser.newContext({
        storageState:
          savedState,

        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    const page =
      await context.newPage();

    await page.goto(
      MOTION_URL,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          60_000,
      },
    );

    const sessionId =
      browser.sessionId();

    const startTime =
      Date.now();

    const maximumWait =
      9 * 60 * 1_000;

    while (
      Date.now() -
        startTime <
      maximumWait
    ) {
      const [
        confirmed,
        cancelled,
      ] =
        await Promise.all([
          env.SESSION_KV.get(
            confirmKey,
          ),

          env.SESSION_KV.get(
            cancelKey,
          ),
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
        await page
          .waitForTimeout(
            2_000,
          );

        await persistStorageState(
          env,
          context,
        );

        return jsonResponse({
          ok: true,
          saved: true,
          attemptId,
          sessionId,

          currentUrl:
            page.url(),

          pageTitle:
            await safePageTitle(
              page,
            ),

          nextAction:
            "Click Test saved session.",
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
      env.SESSION_KV.delete(
        ACTIVE_ATTEMPT_KEY,
      ),

      env.SESSION_KV.delete(
        confirmKey,
      ),

      env.SESSION_KV.delete(
        cancelKey,
      ),
    ]);

    await browser.close();
  }
}

async function confirmInteractiveLogin(
  env: Env,
): Promise<Response> {
  const attemptId =
    await env.SESSION_KV.get(
      ACTIVE_ATTEMPT_KEY,
    );

  if (!attemptId) {
    return jsonResponse(
      {
        ok: false,

        error:
          "No active Motion login attempt exists.",

        nextAction:
          "Click Start Motion login first.",
      },
      409,
    );
  }

  await env.SESSION_KV.put(
    `${CONFIRM_PREFIX}${attemptId}`,
    "true",
    {
      expirationTtl:
        10 * 60,
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
    await env.SESSION_KV.get(
      ACTIVE_ATTEMPT_KEY,
    );

  if (!attemptId) {
    return jsonResponse({
      ok: true,
      cancelled: false,

      message:
        "There is no active login attempt.",
    });
  }

  await env.SESSION_KV.put(
    `${CANCEL_PREFIX}${attemptId}`,
    "true",
    {
      expirationTtl:
        10 * 60,
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
  const lock =
    await acquireAutomationLock(
      env,
      "session-test",
    );

  if (!lock.ok) {
    return jsonResponse(lock, 409);
  }

  let browser:
    Awaited<
      ReturnType<typeof launch>
    > | null = null;

  try {
    const savedState =
      await requireSavedState(
        env,
      );

    browser =
      await launch(
        env.MYBROWSER,
      );

    const context =
      await browser.newContext({
        storageState:
          savedState,

        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    const page =
      await context.newPage();

    await page.goto(
      MOTION_URL,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          60_000,
      },
    );

    await page.waitForTimeout(
      4_000,
    );

    const likelySignedIn =
      !(
        await pageLooksLoggedOut(
          page,
        )
      );

    if (likelySignedIn) {
      await persistStorageState(
        env,
        context,
      );
    }

    return jsonResponse({
      ok: true,

      currentUrl:
        page.url(),

      pageTitle:
        await safePageTitle(
          page,
        ),

      likelySignedIn,

      message:
        likelySignedIn
          ? "The saved Motion browser session appears to be signed in."
          : "Motion appears to require authentication. Run the interactive login again.",
    });
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => undefined);
    }

    await releaseAutomationLock(
      env,
      lock.lockId,
    );
  }
}

async function getSessionStatus(
  env: Env,
): Promise<Response> {
  const [
    savedState,
    activeAttemptId,
    activeLock,
  ] =
    await Promise.all([
      env.SESSION_KV.get(
        STORAGE_STATE_KEY,
      ),

      env.SESSION_KV.get(
        ACTIVE_ATTEMPT_KEY,
      ),

      env.SESSION_KV.get(
        AUTOMATION_LOCK_KEY,
      ),
    ]);

  return jsonResponse({
    ok: true,

    signedInStateSaved:
      Boolean(savedState),

    activeLoginAttemptId:
      activeAttemptId ??
      null,

    automationLock:
      activeLock
        ? JSON.parse(
            activeLock,
          )
        : null,
  });
}

async function clearSavedSession(
  env: Env,
): Promise<Response> {
  const attemptId =
    await env.SESSION_KV.get(
      ACTIVE_ATTEMPT_KEY,
    );

  const keys = [
    STORAGE_STATE_KEY,
    ACTIVE_ATTEMPT_KEY,
    AUTOMATION_LOCK_KEY,
    "motion:active-session",
  ];

  if (attemptId) {
    keys.push(
      `${CONFIRM_PREFIX}${attemptId}`,
      `${CANCEL_PREFIX}${attemptId}`,
    );
  }

  await Promise.all(
    keys.map(
      (key) =>
        env.SESSION_KV.delete(
          key,
        ),
    ),
  );

  return jsonResponse({
    ok: true,
    cleared: true,
  });
}

async function getArtifact(
  env: Env,
  artifactId: string,
): Promise<Response> {
  const stored =
    await env.SESSION_KV.get(
      `${ARTIFACT_PREFIX}${artifactId}`,
      "arrayBuffer",
    );

  if (!stored) {
    return jsonResponse(
      {
        ok: false,

        error:
          "Artifact not found or expired.",
      },
      404,
    );
  }

  return new Response(stored, {
    status: 200,

    headers: {
      "Content-Type":
        "image/png",

      "Content-Disposition":
        `inline; filename="${artifactId}.png"`,

      "Cache-Control":
        "private, no-store",

      "X-Content-Type-Options":
        "nosniff",
    },
  });
}

async function saveScreenshot(
  env: Env,
  page: any,
  fullPage: boolean,
): Promise<string> {
  const artifactId =
    crypto.randomUUID();

  const bytes =
    await page.screenshot({
      fullPage,
      type: "png",
    });

  await env.SESSION_KV.put(
    `${ARTIFACT_PREFIX}${artifactId}`,
    bytes,
    {
      expirationTtl:
        ARTIFACT_TTL_SECONDS,
    },
  );

  return artifactId;
}

async function acquireAutomationLock(
  env: Env,
  operationName: string,
): Promise<
  | {
      ok: true;
      lockId: string;
    }
  | {
      ok: false;
      error: string;
      activeLock: unknown;
    }
> {
  const existing =
    await env.SESSION_KV.get(
      AUTOMATION_LOCK_KEY,
      "json",
    );

  if (existing) {
    return {
      ok: false,

      error:
        "Another Motion UI automation request is already active. Wait for it to finish before retrying.",

      activeLock:
        existing,
    };
  }

  const lockId =
    crypto.randomUUID();

  await env.SESSION_KV.put(
    AUTOMATION_LOCK_KEY,
    JSON.stringify({
      lockId,
      operationName,

      createdAt:
        new Date()
          .toISOString(),
    }),
    {
      expirationTtl:
        AUTOMATION_LOCK_TTL_SECONDS,
    },
  );

  return {
    ok: true,
    lockId,
  };
}

async function releaseAutomationLock(
  env: Env,
  lockId: string,
): Promise<void> {
  const existing =
    (
      await env.SESSION_KV.get(
        AUTOMATION_LOCK_KEY,
        "json",
      )
    ) as {
      lockId?: string;
    } | null;

  if (
    existing?.lockId ===
    lockId
  ) {
    await env.SESSION_KV.delete(
      AUTOMATION_LOCK_KEY,
    );
  }
}

async function requireSavedState(
  env: Env,
): Promise<
  BrowserContextOptions[
    "storageState"
  ]
> {
  const savedStateJson =
    await env.SESSION_KV.get(
      STORAGE_STATE_KEY,
    );

  if (!savedStateJson) {
    throw new Error(
      "No saved Motion login exists. Use the setup page to complete the interactive login first.",
    );
  }

  return JSON.parse(
    savedStateJson,
  ) as
    BrowserContextOptions[
      "storageState"
    ];
}

async function persistStorageState(
  env: Env,
  context: any,
): Promise<void> {
  const storageState =
    await context.storageState({
      indexedDB: true,
    });

  await env.SESSION_KV.put(
    STORAGE_STATE_KEY,
    JSON.stringify(
      storageState,
    ),
  );
}

async function ensureSignedIn(
  page: any,
): Promise<void> {
  if (
    await pageLooksLoggedOut(
      page,
    )
  ) {
    throw new Error(
      "The saved Motion session is no longer signed in. Refresh it from the setup page before running UI automation.",
    );
  }
}

async function pageLooksLoggedOut(
  page: any,
): Promise<boolean> {
  const currentUrl =
    page.url();

  const passwordVisible =
    await page
      .locator(
        'input[type="password"]',
      )
      .isVisible()
      .catch(
        () => false,
      );

  const welcomeBackVisible =
    await page
      .getByText(
        "Welcome back!",
        {
          exact: false,
        },
      )
      .isVisible()
      .catch(
        () => false,
      );

  return (
    passwordVisible ||
    welcomeBackVisible ||
    /\/(login|sign-in|signin|authentication|auth)(\/|$|\?)/i.test(
      new URL(
        currentUrl,
      ).pathname,
    )
  );
}

function validateRunRequest(
  input: RunRequest,
): void {
  if (
    !input ||
    typeof input !== "object"
  ) {
    throw new Error(
      "The request body must be a JSON object.",
    );
  }

  if (
    !Array.isArray(
      input.steps,
    )
  ) {
    throw new Error(
      "steps must be an array.",
    );
  }

  if (
    input.steps.length < 1
  ) {
    throw new Error(
      "At least one UI step is required.",
    );
  }

  if (
    input.steps.length >
    MAX_UI_STEPS
  ) {
    throw new Error(
      `A maximum of ${MAX_UI_STEPS} UI steps is allowed per request.`,
    );
  }

  for (
    const step of
    input.steps
  ) {
    if (
      !step ||
      typeof step !==
        "object" ||
      !(
        "action" in
        step
      )
    ) {
      throw new Error(
        "Every step must contain an action.",
      );
    }

    if (
      "target" in step &&
      step.target
    ) {
      validateLocatorTarget(
        step.target as
          LocatorTarget,
      );
    }
  }

  if (input.startUrl) {
    validateMotionUrl(
      input.startUrl,
    );
  }
}

function validateLocatorTarget(
  target: LocatorTarget,
): void {
  if (
    !target ||
    typeof target !==
      "object"
  ) {
    throw new Error(
      "A locator target must be an object.",
    );
  }

  const supported =
    new Set([
      "role",
      "text",
      "label",
      "placeholder",
      "testId",
      "css",
    ]);

  if (
    !supported.has(
      target.by,
    )
  ) {
    throw new Error(
      `Unsupported locator type: ${String(target.by)}`,
    );
  }

  if (
    target.by ===
    "role"
  ) {
    if (!target.role) {
      throw new Error(
        'A role locator requires "role".',
      );
    }

    if (
      !target.name &&
      !target.value
    ) {
      throw new Error(
        'A role locator requires "name" or "value".',
      );
    }
  } else if (
    !target.value
  ) {
    throw new Error(
      `A ${target.by} locator requires "value".`,
    );
  }

  if (
    target.nth !==
      undefined &&
    (
      !Number.isInteger(
        target.nth,
      ) ||
      target.nth < 0
    )
  ) {
    throw new Error(
      "target.nth must be a non-negative integer.",
    );
  }
}

function validateMotionUrl(
  value: string,
): string {
  let url: URL;

  try {
    url =
      new URL(
        value,
        MOTION_URL,
      );
  } catch {
    throw new Error(
      `Invalid URL: ${value}`,
    );
  }

  if (
    url.origin !==
    MOTION_ORIGIN
  ) {
    throw new Error(
      `Navigation is restricted to ${MOTION_ORIGIN}.`,
    );
  }

  return url.toString();
}

function assertPageStayedInMotion(
  value: string,
): void {
  const url =
    new URL(value);

  if (
    url.origin !==
    MOTION_ORIGIN
  ) {
    throw new Error(
      `Motion UI navigation left the allowed origin and was stopped: ${url.origin}`,
    );
  }
}

function findDestructiveMatches(
  steps: UiStep[],
): string[] {
  const pattern =
    /\b(delete|remove|archive|trash|disconnect|revoke|clear|cancel project|close project|delete label|remove label|remove blocker|unblock)\b/i;

  const matches:
    string[] = [];

  steps.forEach(
    (
      step,
      index,
    ) => {
      const searchable =
        JSON.stringify({
          action:
            step.action,

          target:
            "target" in
            step
              ? step.target
              : null,

          text:
            "text" in step
              ? step.text
              : null,

          url:
            "url" in step
              ? step.url
              : null,
        });

      if (
        pattern.test(
          searchable,
        )
      ) {
        matches.push(
          `step ${index + 1}: ${searchable.slice(0, 300)}`,
        );
      }
    },
  );

  return matches;
}

function sanitizeStepsForOutput(
  steps: UiStep[],
): unknown[] {
  return steps.map(
    (step) => {
      if (
        step.action ===
        "fill"
      ) {
        return {
          ...step,

          value:
            `[REDACTED:${step.value.length} characters]`,
        };
      }

      return step;
    },
  );
}

function describeTarget(
  target: LocatorTarget,
): unknown {
  return {
    by:
      target.by,

    role:
      target.role ??
      null,

    name:
      target.name ??
      null,

    value:
      target.value ??
      null,

    exact:
      target.exact ??
      false,

    nth:
      target.nth ??
      null,
  };
}

function authorize(
  request: Request,
  env: Env,
): Response | null {
  if (
    !env.AUTOMATION_TOKEN
  ) {
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
    request.headers.get(
      "Authorization",
    );

  const alternateToken =
    request.headers.get(
      "X-Automation-Token",
    );

  const suppliedToken =
    authorization
      ?.toLowerCase()
      .startsWith(
        "bearer ",
      )
      ? authorization
          .slice(7)
          .trim()
      : alternateToken
          ?.trim();

  if (
    !suppliedToken ||
    suppliedToken !==
      env.AUTOMATION_TOKEN
  ) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unauthorized.",
      },
      401,
    );
  }

  return null;
}

async function readJson<T>(
  request: Request,
): Promise<T> {
  const contentType =
    request.headers.get(
      "Content-Type",
    ) ?? "";

  if (
    !contentType
      .toLowerCase()
      .includes(
        "application/json",
      )
  ) {
    throw new Error(
      "Content-Type must be application/json.",
    );
  }

  try {
    return (
      await request.json()
    ) as T;
  } catch {
    throw new Error(
      "The request body was not valid JSON.",
    );
  }
}

async function safePageTitle(
  page: any,
): Promise<string | null> {
  try {
    return await page.title();
  } catch {
    return null;
  }
}

function normalizeWhitespace(
  value: string,
): string {
  return value
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function clampInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isFinite(
      value,
    )
  ) {
    return minimum;
  }

  return Math.min(
    Math.max(
      Math.trunc(value),
      minimum,
    ),
    maximum,
  );
}

function errorMessage(
  error: unknown,
): string {
  return error instanceof
    Error
    ? error.message
    : String(error);
}

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds,
      ),
  );
}

function normalizePath(
  pathname: string,
): string {
  if (
    !pathname ||
    pathname === "/"
  ) {
    return "/";
  }

  return pathname
    .endsWith("/")
    ? pathname.slice(
        0,
        -1,
      )
    : pathname;
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(
      body,
      null,
      2,
    ),
    {
      status,

      headers: {
        ...CORS_HEADERS,

        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        "X-Content-Type-Options":
          "nosniff",
      },
    },
  );
}

function htmlResponse(
  html: string,
): Response {
  return new Response(
    html,
    {
      status: 200,

      headers: {
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store",

        "X-Content-Type-Options":
          "nosniff",

        "Referrer-Policy":
          "no-referrer",
      },
    },
  );
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

  <title>
    Motion UI Automation Setup
  </title>

  <style>
    body {
      font-family:
        system-ui,
        sans-serif;

      max-width:
        860px;

      margin:
        48px auto;

      padding:
        0 20px;

      line-height:
        1.45;
    }

    input,
    button {
      font:
        inherit;

      padding:
        10px 12px;

      margin:
        6px 4px 6px 0;
    }

    input {
      width:
        min(600px, 90%);
    }

    button {
      cursor:
        pointer;
    }

    pre {
      white-space:
        pre-wrap;

      overflow-wrap:
        anywhere;

      background:
        #f4f4f4;

      padding:
        14px;

      border-radius:
        8px;
    }

    .warning {
      background:
        #fff5d6;

      padding:
        12px;

      border-radius:
        8px;
    }
  </style>
</head>

<body>
  <h1>
    Motion UI Automation Setup
  </h1>

  <p class="warning">
    Enter your Cloudflare
    <strong>
      AUTOMATION_TOKEN
    </strong>.

    This page does not save it.
  </p>

  <input
    id="token"
    type="password"
    autocomplete="off"
    placeholder="AUTOMATION_TOKEN"
  >

  <div>
    <button
      onclick="startLogin()"
    >
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
        'GET',
        '/capabilities'
      )"
    >
      Show capabilities
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

  <h2>
    Login result
  </h2>

  <pre id="loginResult">
Not started.
  </pre>

  <h2>
    Action result
  </h2>

  <pre id="actionResult">
Ready.
  </pre>

  <script>
    function getToken() {
      return document
        .getElementById(
          "token"
        )
        .value;
    }

    function getHeaders() {
      return {
        Authorization:
          "Bearer " +
          getToken(),

        "Content-Type":
          "application/json"
      };
    }

    async function startLogin() {
      const result =
        document
          .getElementById(
            "loginResult"
          );

      if (!getToken()) {
        result.textContent =
          "Enter AUTOMATION_TOKEN first.";

        return;
      }

      result.textContent =
        "The login browser is starting. Open Cloudflare Browser Run → Live Sessions, sign in, then return here and click I am signed in — save session.";

      try {
        const response =
          await fetch(
            "/session/login",
            {
              method:
                "POST",

              headers:
                getHeaders()
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
        document
          .getElementById(
            "actionResult"
          );

      if (!getToken()) {
        result.textContent =
          "Enter AUTOMATION_TOKEN first.";

        return;
      }

      result.textContent =
        "Working...";

      try {
        const response =
          await fetch(
            path,
            {
              method,

              headers:
                getHeaders()
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
