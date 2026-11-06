import { mkdirSync } from "fs";
import { join } from "path";

import { expect, test, type Page } from "@playwright/test";

/**
 * P4 Task 4: collections in the owner's dashboard, at 1280 and 390 px, in
 * a private world (sim rail — no PayPal): the owner's agent borrows $10
 * for 7 days against a $15 invoice nobody pays; the world page shows the
 * due day and the ladder step; +7 +1 → LATE (notice badge, days late,
 * late fee); +1 ×8 → CHARGED_OFF: the guarantee card ("As guarantor you
 * owe …"), the drawer's charged-off loan and ladder events; the owner
 * pays the guarantee on the sim approve page → RECOVERED; mark all
 * notices read.
 */

const SCREENSHOTS = join(process.cwd(), "docs", "design", "screenshots");

async function signIn(page: Page, name: string) {
  const response = await page.request.post("/api/test/session", {
    form: { name, return_to: "/dashboard" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

for (const width of [1280, 390]) {
  test(`P4: a charged-off loan in the owner's dashboard and paying the guarantee (${width} px)`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page, "Grace Guarantor");

    // A private world and the owner's agent in it (path B), with a mandate.
    await page.goto("/dashboard/worlds");
    await page.getByLabel("World name").fill(`Collections ${width}`);
    await page.getByRole("button", { name: "Create world" }).click();
    await expect(page.getByTestId("world-name")).toHaveText(`Collections ${width}`);
    const worldId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/dashboard/agents/new?world=${worldId}`);
    await page.getByLabel("Agent name").fill(`Courier ${width}`);
    await page.getByLabel("Operator").fill("Tester");
    await page.getByLabel("Model").fill("Claude");
    await page.getByLabel("Payout PayPal account").fill("courier@example.com");
    await page.getByRole("button", { name: "Register agent" }).click();
    await expect(page.getByText("mnd_", { exact: false }).first()).toBeVisible();
    const apiKey = /mnd_[a-z2-7]{8}_[a-z2-7]{32}/.exec(await page.content())![0];
    const auth = { authorization: `Bearer ${apiKey}` };
    const status = (await (await page.request.post("/api/v1/get_status", { headers: auth, data: {} })).json()) as {
      data: { agent: { id: string } };
    };
    const agentId = status.data.agent.id;

    await page.goto(`/dashboard?agent=${agentId}`);
    const drawer = page.getByTestId("agent-drawer");
    await drawer.getByLabel("Max per loan").fill("20");
    await drawer.getByLabel("Max total owed").fill("50");
    await drawer.getByLabel("Max fee").fill("10");
    await drawer.getByLabel("Max term").fill("30");
    await drawer.getByLabel("Type your full name to sign").fill("Grace Guarantor");
    await drawer.getByLabel("I agree to the mandate above.").check();
    await drawer.getByRole("button", { name: "Sign mandate" }).click();
    await expect(drawer.getByTestId("drawer-notice")).toContainText("Mandate signed");

    // The agent borrows $10 for 7 days against a $15 invoice (that nobody pays).
    const applied = (await (
      await page.request.post("/api/v1/apply_for_loan", {
        headers: auth,
        data: {
          amount_cents: 1000,
          term_days: 7,
          purpose: "Materials for a client job",
          invoice: { client_email: "client@example.com", amount_cents: 1500, due_in_days: 7, description: "Website build" },
          declarations: { no_other_debt: true },
          attest: true,
        },
      })
    ).json()) as { status: string; data: { offer_id: string; disclosure_hash: string } };
    expect(applied.status).toBe("OFFERED");
    const accepted = (await (
      await page.request.post("/api/v1/accept_offer", {
        headers: auth,
        data: { offer_id: applied.data.offer_id, disclosure_hash: applied.data.disclosure_hash },
      })
    ).json()) as { status: string; data: { loan_id: string } };
    expect(accepted.status).toBe("ACTIVE");

    // The world page: the loan's due day and its (empty) ladder step.
    await page.goto(`/dashboard/worlds/${worldId}`);
    const row = page.getByTestId("world-loan");
    await expect(row.getByTestId("world-loan-due")).toContainText("Due day 7");
    await expect(row.getByTestId("world-loan-step")).toContainText("none yet · next: late on day 8");

    // +7 +1 → due + 1: LATE.
    await page.getByRole("button", { name: "+7 days" }).click();
    await expect(page.getByTestId("sim-date")).toContainText("Day 7");
    await page.getByRole("button", { name: "+1 day" }).click();
    await expect(page.getByTestId("sim-date")).toContainText("Day 8");
    await expect(row.getByTestId("world-loan-step")).toContainText("Ladder step: late");
    await expect(row.getByText("Late", { exact: true })).toBeVisible();
    await expect(page.getByTestId("notices-badge")).toContainText("1");

    await page.goto(`/dashboard?world=${worldId}`);
    const card = page.getByTestId("agent-card").filter({ hasText: `Courier ${width}` });
    await expect(card.getByTestId("card-days-late")).toHaveText("1 day late");
    await expect(card.getByTestId("card-delinquency")).toContainText("late fee $1.00");
    await expect(page.getByTestId("notices-list").getByTestId("notice").first()).toContainText("past due");

    // +1 ×9 → due + 10: CHARGED_OFF (the ladder walks penalty, substandard on the way).
    await page.goto(`/dashboard/worlds/${worldId}`);
    for (let day = 9; day <= 17; day += 1) {
      await page.getByRole("button", { name: "+1 day" }).click();
      await expect(page.getByTestId("sim-date")).toContainText(`Day ${day}`);
    }
    await expect(row.getByTestId("world-loan-step")).toContainText("charged off");
    await expect(page.getByTestId("trial-balance")).toHaveText("$0.00");

    // The owner's view: the guarantee card, the charged-off loan, ladder events, notices.
    await page.goto(`/dashboard?world=${worldId}&agent=${agentId}`);
    const guarantee = page.getByTestId("guarantee-card");
    await expect(guarantee).toContainText(`Courier ${width}'s loan`);
    await expect(guarantee).toContainText("was charged off");
    await expect(guarantee).toContainText("As guarantor you owe");
    const owed = (await guarantee.getByTestId("guarantee-owed").textContent())!.trim();
    expect(owed).toMatch(/^\$1\d\.\d\d$/);
    await expect(drawer.getByTestId("loan-status").first()).toContainText("Charged off");
    await expect(drawer.getByTestId("loan-recoverable").first()).toHaveText(owed);
    await expect(drawer.getByTestId("loan-days-late").first()).toHaveText("10");
    await expect(drawer.getByTestId("guarantee-link")).toBeVisible();
    await expect(page.getByTestId("notices-unread")).toHaveText("4 unread");
    await expect(page.getByTestId("notices-badge")).toContainText("4");
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth)
        .slice(0, 8)
        .map((el) => `${el.tagName}.${(el as HTMLElement).className} ${Math.round(el.getBoundingClientRect().right)}`),
    );
    expect(wide).toEqual([]);
    await noOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    mkdirSync(SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOTS, `p4-collections-${width}.png`), fullPage: true });

    await drawer.getByRole("tab", { name: "Events" }).click();
    await expect(drawer.getByTestId("pane-events")).toContainText("Loan charged off: your guarantee is invoked");
    await expect(drawer.getByTestId("pane-events")).toContainText("Loan is late: late fee added");

    // Pay the guarantee on the sim approve page → RECOVERED.
    await guarantee.getByTestId("guarantee-pay").click();
    await expect(page.getByRole("heading", { name: "Approve this payment" })).toBeVisible();
    await expect(page.getByText("your guarantee is invoked")).toBeVisible();
    await noOverflow(page);
    await page.getByRole("button", { name: `Approve ${owed}` }).click();
    await expect(page).toHaveURL(/\/checkout\/guarantee\/return\?token=/);

    await page.goto(`/dashboard?world=${worldId}&agent=${agentId}`);
    await expect(page.getByTestId("guarantee-card")).toHaveCount(0);
    await expect(drawer.getByTestId("loan-status").first()).toContainText("Recovered");
    await expect(page.getByTestId("notices-unread")).toHaveText("5 unread");
    await expect(page.getByTestId("notices-list").getByTestId("notice").first()).toContainText("fully recovered");

    // Mark all read (owner state only).
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(page.getByTestId("notices-unread")).toHaveCount(0);
    await expect(page.getByTestId("notices-badge")).toHaveAttribute("aria-label", "Notices: none unread");
    const agentView = (await (await page.request.post("/api/v1/get_status", { headers: auth, data: {} })).json()) as {
      data: { agent: { status: string }; notices: unknown[] };
    };
    expect(agentView.data.agent.status).toBe("ACTIVE");
    expect(agentView.data.notices.length).toBe(5);
  });
}
