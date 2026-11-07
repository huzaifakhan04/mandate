import { mkdirSync } from "fs";
import { join } from "path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * P7 (Bryntum) at 1280 and 390 px, in an owner's private world (sim rail):
 *
 * - the owner's agent borrows, then DRIVES ITS OWN SCHEDULE over REST:
 *   plan_repayments (3 installments, auto_reschedule), a partial
 *   repay_loan, and — after the world clock passes installment 1's day —
 *   the bank's re-planner flags it missed and auto-moves it; the agent
 *   moves installment 3 itself with reschedule_installment;
 * - the dashboard Timeline tab (Bryntum Scheduler) renders the loan bar
 *   and installment milestones, read-only, from the owner-only endpoint
 *   (401 without a session);
 * - the console Calendar tab (Bryntum Calendar) renders the world's due
 *   dates and installments (month / week / agenda), PII-free;
 * - no page-level horizontal scroll; screenshots p7-bryntum-{timeline,calendar}.png
 *   (1280) and -390 variants.
 */

const SCREENSHOTS = join(process.cwd(), "docs", "design", "screenshots");
const DAY_MS = 86_400_000;

async function signIn(page: Page, name: string) {
  const response = await page.request.post("/api/test/session", { form: { name, return_to: "/dashboard" }, maxRedirects: 0 });
  expect(response.status()).toBe(303);
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

type Envelope<T = Record<string, unknown>> = { status: string; data: T; reason_codes: string[] };

async function tool<T = Record<string, unknown>>(request: APIRequestContext, key: string, name: string, data: unknown) {
  const res = await request.post(`/api/v1/${name}`, { headers: { authorization: `Bearer ${key}` }, data });
  return (await res.json()) as Envelope<T>;
}

const day = (iso: string, plus = 0) => new Date(Date.parse(iso.slice(0, 10)) + plus * DAY_MS).toISOString().slice(0, 10);

for (const width of [1280, 390]) {
  test(`P7: agent-driven repayment timeline + bank calendar (${width} px)`, async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page, "Tara Timeline");

    // A private world and the owner's agent in it, with a mandate.
    await page.goto("/dashboard/worlds");
    await page.getByLabel("World name").fill(`Timeline ${width}`);
    await page.getByRole("button", { name: "Create world" }).click();
    await expect(page.getByTestId("world-name")).toHaveText(`Timeline ${width}`);
    const worldId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/dashboard/agents/new?world=${worldId}`);
    await page.getByLabel("Agent name").fill(`Planner ${width}`);
    await page.getByLabel("Operator").fill("Tester");
    await page.getByLabel("Model").fill("Claude");
    await page.getByLabel("Payout PayPal account").fill("planner@example.com");
    await page.getByRole("button", { name: "Register agent" }).click();
    await expect(page.getByText("mnd_", { exact: false }).first()).toBeVisible();
    const key = /mnd_[a-z2-7]{8}_[a-z2-7]{32}/.exec(await page.content())![0];
    const me = await tool<{ agent: { id: string }; sim_now: string }>(page.request, key, "get_status", {});
    const agentId = me.data.agent.id;

    await page.goto(`/dashboard?agent=${agentId}`);
    const drawer = page.getByTestId("agent-drawer");
    await drawer.getByLabel("Max per loan").fill("20");
    await drawer.getByLabel("Max total owed").fill("50");
    await drawer.getByLabel("Max fee").fill("10");
    await drawer.getByLabel("Max term").fill("30");
    await drawer.getByLabel("Type your full name to sign").fill("Tara Timeline");
    await drawer.getByLabel("I agree to the mandate above.").check();
    await drawer.getByRole("button", { name: "Sign mandate" }).click();
    await expect(drawer.getByTestId("drawer-notice")).toContainText("Mandate signed");

    // Borrow $10 for 7 days against a $15 invoice.
    const applied = await tool<{ offer_id: string; disclosure_hash: string }>(page.request, key, "apply_for_loan", {
      amount_cents: 1000,
      term_days: 7,
      purpose: "Materials for a client job",
      invoice: { client_email: "client@example.com", amount_cents: 1500, due_in_days: 7, description: "Website build" },
      declarations: { no_other_debt: true },
      attest: true,
    });
    expect(applied.status).toBe("OFFERED");
    const accepted = await tool<{ loan_id: string }>(page.request, key, "accept_offer", {
      offer_id: applied.data.offer_id,
      disclosure_hash: applied.data.disclosure_hash,
    });
    expect(accepted.status).toBe("ACTIVE");
    const loanId = accepted.data.loan_id;
    const loan = await tool<{ total_due_cents: number; due_sim_at: string }>(page.request, key, "get_loan", { loan_id: loanId });
    const total = loan.data.total_due_cents;
    const now = (await tool<{ sim_now: string }>(page.request, key, "get_status", {})).data.sim_now;

    // The agent plans its own schedule (auto-reschedule on).
    const planned = await tool(page.request, key, "plan_repayments", {
      auto_reschedule: true,
      installments: [
        { date: day(now, 1), amount_cents: 400 },
        { date: day(now, 3), amount_cents: 400 },
        { date: day(loan.data.due_sim_at), amount_cents: total - 800 },
      ],
    });
    expect(planned.status).toBe("PLANNED");

    // A partial $3 repayment now, approved on the sim checkout page.
    const repay = await tool<{ checkout_id: string; approve_url: string }>(page.request, key, "repay_loan", { loan_id: loanId, amount_cents: 300 });
    expect(repay.status).toBe("AWAITING_APPROVAL");
    // The sim approve page (path only: the URL's origin is the configured public base).
    const approve = new URL(repay.data.approve_url);
    await page.goto(`${approve.pathname}${approve.search}`);
    await page.getByRole("button", { name: /^Approve \$3\.00/ }).click();
    await expect(page).toHaveURL(/\/checkout\/.*return/);
    expect((await tool(page.request, key, "confirm_checkout", { checkout_id: repay.data.checkout_id })).status).toBe("COMPLETED");

    // The world clock passes installment 1's day: the bank flags it missed and moves it once.
    for (let i = 0; i < 2; i += 1) {
      const moved = await page.request.post(`/dashboard/worlds/${worldId}/advance`, {
        form: { days: "1" },
        headers: { origin: baseURL!, accept: "application/json" },
      });
      expect(moved.status()).toBe(200);
    }
    const afterMiss = await tool<{ repayment_plan: { installments: Array<{ status: string; paid_cents: number; auto_moved: boolean }> } }>(
      page.request,
      key,
      "get_loan",
      { loan_id: loanId },
    );
    expect(afterMiss.data.repayment_plan.installments[0]).toMatchObject({ status: "PLANNED", paid_cents: 300, auto_moved: true });
    const status = await tool<{ notices: Array<{ kind: string }> }>(page.request, key, "get_status", {});
    expect(status.data.notices.map((n) => n.kind)).toContain("installment_rescheduled");

    // The agent moves installment 2 itself.
    const nowAfter = (await tool<{ sim_now: string }>(page.request, key, "get_status", {})).data.sim_now;
    const rescheduled = await tool(page.request, key, "reschedule_installment", { installment: 2, date: day(nowAfter, 2) });
    expect(rescheduled.status).toBe("RESCHEDULED");

    // --- the owner's Timeline (Bryntum Scheduler) ---
    expect((await page.request.get("/api/dashboard/timeline")).status()).toBe(200);
    const anonymous = await page.context().browser()!.newContext();
    expect((await anonymous.request.get(`${baseURL}/api/dashboard/timeline`)).status()).toBe(401);
    await anonymous.close();

    await page.goto(`/dashboard?world=${worldId}`);
    await page.getByTestId("view-timeline").click();
    await expect(page).toHaveURL(/view=timeline/);
    const panel = page.getByTestId("timeline-panel");
    await expect(panel).toBeVisible();
    const scheduler = page.getByTestId("timeline-scheduler");
    await expect(scheduler.locator(".b-scheduler")).toBeVisible({ timeout: 30_000 });
    await expect(scheduler.locator(".b-grid-cell", { hasText: `Planner ${width}` })).toBeVisible();
    const bar = (prefix: string) => scheduler.locator(`.b-sch-event-wrap[data-event-id^="${prefix}:"]`);
    await expect(bar("loan")).toHaveCount(1);
    await expect(bar("inst")).toHaveCount(3);
    await expect(bar("miss")).toHaveCount(1);
    await expect(bar("pay")).toHaveCount(1);
    // Read-only: the owner watches; the scheduler carries Bryntum's read-only state.
    const classes = await scheduler.locator(".b-scheduler").first().getAttribute("class");
    expect(classes).toMatch(/b-read-?only/);
    await expect(panel.getByText("planned", { exact: false }).first()).toBeVisible();
    await noHorizontalScroll(page);
    mkdirSync(SCREENSHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: join(SCREENSHOTS, width === 1280 ? "p7-bryntum-timeline.png" : "p7-bryntum-timeline-390.png"),
      fullPage: true,
    });

    // --- the console Calendar (Bryntum Calendar) ---
    const cal = await page.request.get(`/api/console/calendar?world=${worldId}`);
    expect(cal.status()).toBe(200);
    expect(cal.headers()["cache-control"]).toBe("no-store");
    const calText = await cal.text();
    expect(calText).not.toContain("@");
    expect(calText).toContain('"calendar":"installment"');

    await page.goto(`/console?world=${worldId}`);
    await page.getByTestId("tab-calendar").click();
    const calendar = page.getByTestId("console-calendar");
    await expect(calendar.locator(".b-calendar")).toBeVisible({ timeout: 30_000 });
    await expect(calendar.getByRole("region", { name: width === 1280 ? /Calendar, Month/ : /Calendar, Agenda/ })).toBeVisible();
    await noHorizontalScroll(page);
    await page.waitForTimeout(500);
    // The records panel (tabs + calendar) — a full-page shot would catch the sticky header mid-page.
    await page.locator("section.gridpanel").screenshot({
      path: join(SCREENSHOTS, width === 1280 ? "p7-bryntum-calendar.png" : "p7-bryntum-calendar-390.png"),
    });

    // Agenda lists every event by day: the agent's installments and the loan's due date.
    if (width === 1280) {
      await calendar.getByRole("button", { name: /Agenda/ }).click();
    }
    await expect(calendar.getByText(/#1 \$4\.00/).first()).toBeVisible();
    await expect(calendar.getByText(/ due · /).first()).toBeVisible();
  });
}
