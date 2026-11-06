import { createHash, generateKeyPairSync, randomUUID, sign } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * P2 Task 5: the owner journey on the dashboard, at 1280 and 390 px.
 *
 * Sign-in: the dev server's main world is on the real PayPal rail, so a
 * browser can't approve the sandbox identity order here. The journey signs
 * in through the env-gated `POST /api/test/session` (a fresh verified
 * principal + the real `mandate_session` cookie, exactly what
 * /verify/return leaves); the Verify round trip itself is covered on the
 * sim rail by tests/unit/app/verify.test.ts.
 *
 * Then: register an agent (path B) → its API key once + MCP config → sign
 * a mandate → the card goes ACTIVE at T1 → the agent registers a signing
 * key and the owner uploads a KYA document → T2 → freeze (its mutating
 * calls get AGENT_NOT_ACTIVE) → unfreeze → revoke the signing key → T1.
 */

const SCREENSHOTS = join(process.cwd(), "docs", "design", "screenshots");

// A 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: Page, name: string) {
  const response = await page.request.post("/api/test/session", {
    form: { name, return_to: "/dashboard" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

async function restCall(
  request: APIRequestContext,
  apiKey: string,
  tool: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const raw = JSON.stringify(body);
  const response = await request.post(`/api/v1/${tool}`, {
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...headers },
    data: raw,
  });
  return (await response.json()) as { status: string; data: Record<string, unknown> };
}

function signedHeaders(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000);
  const digest = createHash("sha256").update(body).digest("hex");
  return {
    "x-mandate-timestamp": String(ts),
    "x-mandate-signature": sign(null, Buffer.from(`${ts}\nPOST\n${path}\n${digest}`), privateKey).toString("base64"),
  };
}

for (const width of [1280, 390]) {
  test(`P2: owner journey — register (path B), mandate, KYA, freeze, revoke key (${width} px)`, async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page, "Ada Owner");

    // The empty dashboard.
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Your agents" })).toBeVisible();
    await expect(page.getByText("via PayPal · sandbox")).toBeAttached();
    await expect(page.getByTestId("stat-active")).toContainText("0 / 0");

    // Path B: register an agent.
    await page.getByRole("link", { name: "+ Register an agent" }).click();
    await expect(page.getByRole("heading", { name: "Register an agent" })).toBeVisible();
    await page.getByLabel("Agent name").fill(`Nova ${width}`);
    await page.getByLabel("Operator").fill("Studio LLC");
    await page.getByLabel("Model").fill("Claude");
    await page.getByLabel("Payout PayPal account").fill("nova@example.com");
    await page.getByRole("button", { name: "Register agent" }).click();

    // The key, once, with MCP config carrying it.
    await expect(page.getByRole("heading", { name: `Nova ${width} is registered` })).toBeVisible();
    const apiKey = (await page.getByTestId("api-key").textContent())!.trim();
    expect(apiKey).toMatch(/^mnd_[a-z2-7]{8}_[a-z2-7]{32}$/);
    await expect(page.getByTestId("mcp-claudeCode")).toContainText(`Authorization: Bearer ${apiKey}`);
    await expect(page.getByTestId("mcp-cursor")).toContainText("/api/mcp/mcp");
    await expect(page.getByTestId("mcp-codex")).toContainText("[mcp_servers.mandate]");
    const keyPage = page.url();

    // The agent is claimed and can authenticate; it can't borrow yet.
    const status = await restCall(request, apiKey, "get_status", {});
    expect(status.data).toMatchObject({ kya: { tier: 0, claimed: true, borrow_blockers: ["mandate_missing"] } });

    // Sign a mandate from the CTA.
    await page.getByRole("link", { name: "Sign a mandate →" }).click();
    const drawer = page.getByTestId("agent-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("drawer-status")).toContainText("Pending");
    await drawer.getByLabel("Max per loan").fill("250");
    await drawer.getByLabel("Max total owed").fill("500");
    await drawer.getByLabel("Max fee").fill("5");
    await drawer.getByLabel("Max term").fill("30");
    await drawer.getByLabel("Type your full name to sign").fill("Ada Owner");
    await drawer.getByLabel("I agree to the mandate above.").check();
    await drawer.getByRole("button", { name: "Sign mandate" }).click();

    await expect(drawer.getByTestId("drawer-notice")).toContainText("Mandate signed");
    await expect(drawer.getByTestId("mandate-per-loan")).toHaveText("$250.00");
    await expect(drawer.getByTestId("mandate-total")).toHaveText("$500.00");
    await expect(drawer.getByTestId("drawer-tier")).toHaveText("T1");
    const card = page.getByTestId("agent-card").filter({ hasText: `Nova ${width}` });
    await expect(card.getByText("Active", { exact: true })).toBeVisible();
    await expect(card.getByTestId("card-tier")).toHaveText("T1");
    // P3: the ring shows the Agent Credit Score — claimed (10) + nothing owed (10) = 20, grade E.
    await expect(card.getByTestId("card-score")).toHaveText("20 · E");
    await expect(card.getByTestId("card-cap")).toHaveText("$250.00");
    await expect(page.getByTestId("stat-ceiling")).toContainText("$500.00");
    await expect(page.getByTestId("stat-active")).toContainText("1 / 1");

    // The key page doesn't show the key again.
    await page.goto(keyPage);
    await expect(page.getByTestId("key-already-shown")).toBeVisible();
    await expect(page.getByTestId("api-key")).toHaveCount(0);

    // The agent registers an Ed25519 key (signed by it); the owner uploads a KYA document → T2.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const body = JSON.stringify({ public_key: spki });
    const registered = await restCall(
      request,
      apiKey,
      "register_public_key",
      { public_key: spki },
      signedHeaders(privateKey, "/api/v1/register_public_key", body),
    );
    expect(registered.status).toBe("OK");

    const agentId = status.data.agent && (status.data.agent as { id: string }).id;
    await page.goto(`/dashboard?agent=${agentId}`);
    await drawer.getByLabel("File (PDF, PNG or JPEG, up to 2 MB)").setInputFiles({
      name: "operator-registration.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await drawer.getByRole("button", { name: "Upload document" }).click();
    await expect(drawer.getByTestId("drawer-notice")).toContainText("Document uploaded");
    await expect(drawer.getByTestId("documents")).toContainText("operator-registration.png");
    await expect(drawer.getByTestId("drawer-tier")).toHaveText("T2");
    await expect(drawer.getByTestId("key-fingerprint")).toContainText("ed25519");

    // Tabs: events show the owner's actions.
    await drawer.getByRole("tab", { name: "Events" }).click();
    await expect(drawer.getByTestId("pane-events")).toContainText("Mandate signed · v1");
    await expect(drawer.getByTestId("pane-events")).toContainText("Registered by you in the dashboard");

    // Freeze: the agent's mutating calls are refused.
    await drawer.getByRole("button", { name: "Freeze agent" }).click();
    await expect(drawer.getByTestId("drawer-notice")).toContainText("Agent frozen");
    await expect(drawer.getByTestId("drawer-status")).toContainText("Frozen");
    await expect(card.getByText("Frozen", { exact: true })).toBeVisible();
    const offerId = randomUUID();
    const declineBody = JSON.stringify({ offer_id: offerId });
    const refused = await restCall(
      request,
      apiKey,
      "decline_offer",
      { offer_id: offerId },
      signedHeaders(privateKey, "/api/v1/decline_offer", declineBody),
    );
    expect(refused.status).toBe("AGENT_NOT_ACTIVE");

    await drawer.getByRole("button", { name: "Unfreeze agent" }).click();
    await expect(drawer.getByTestId("drawer-status")).toContainText("Active");

    // Revoke the signing key: back to T1.
    await drawer.getByRole("button", { name: "Revoke signing key" }).click();
    await expect(drawer.getByTestId("drawer-notice")).toContainText("Signing key revoked");
    await expect(drawer.getByTestId("drawer-tier")).toHaveText("T1");
    await expect(drawer.getByTestId("no-signing-key")).toBeVisible();

    // Keyboard: the drawer takes focus once hydrated, and Escape closes it.
    await expect(drawer).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("agent-drawer")).toHaveCount(0);

    // No horizontal overflow, then the screenshot with the drawer open.
    await page.goto(`/dashboard?agent=${agentId}`);
    await expect(drawer).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    mkdirSync(SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOTS, `p2-dashboard-${width}.png`), fullPage: true });
  });
}

test("P2: another principal's agent id opens nothing, and owner actions on it are 404", async ({ page, browser }) => {
  await signIn(page, "Owner One");
  await page.goto("/dashboard/agents/new");
  await page.getByLabel("Agent name").fill("Private Agent");
  await page.getByLabel("Operator").fill("Ops");
  await page.getByLabel("Model").fill("Model");
  await page.getByLabel("Payout PayPal account").fill("private@example.com");
  await page.getByRole("button", { name: "Register agent" }).click();
  const agentId = new URL(page.url()).pathname.split("/")[3]!;

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, "Owner Two");
  await otherPage.goto(`/dashboard?agent=${agentId}`);
  await expect(otherPage.getByText("That agent isn't one of yours.")).toBeVisible();
  await expect(otherPage.getByTestId("agent-drawer")).toHaveCount(0);
  const base = new URL(otherPage.url()).origin;
  for (const path of ["freeze", "key/revoke", "api-key/rotate", "mandate/revoke"]) {
    const response = await otherPage.request.post(`/dashboard/agents/${agentId}/${path}`, {
      headers: { origin: base, accept: "application/json" },
      maxRedirects: 0,
    });
    expect(response.status(), path).toBe(404);
  }
  // Cross-origin is refused before anything else.
  const crossOrigin = await page.request.post(`/dashboard/agents/${agentId}/freeze`, {
    headers: { origin: "https://evil.example.com" },
    maxRedirects: 0,
  });
  expect(crossOrigin.status()).toBe(403);
  await other.close();
});
