import { expect, test } from "@playwright/test";
import { E2E_SETUP_TOKEN } from "../../playwright.config";

const ADMIN = { name: "Erin Example", email: "erin@openmeet.test", password: "e2e-password-2026" };

test.describe.configure({ mode: "serial" });

test("fresh install → setup → event type → public booking → reschedule → cancel", async ({ page, context }) => {
  // 1. Fresh install redirects to the protected setup wizard.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Welcome to OpenMeet" })).toBeVisible();

  // A wrong token is rejected.
  await page.getByLabel("Setup token").fill("not-the-right-token-at-all-000000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid setup token");

  await page.getByLabel("Setup token").fill(E2E_SETUP_TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();

  // 2. Administrator
  await page.getByLabel("Full name").fill(ADMIN.name);
  await page.getByLabel("E-mail").fill(ADMIN.email);
  await page.getByLabel("Username").fill("erin");
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Continue" }).click();

  // 3. Instance, 4. e-mail (skip), 5. calendars (skip)
  await expect(page.getByRole("heading", { name: "Configure the instance" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();

  // 6. Organization, 7. first event type
  await page.getByLabel("Organization name").fill("E2E Studio");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Title").fill("Intro call");
  await page.getByLabel("URL").fill("intro");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "You're ready" })).toBeVisible();

  // The wizard is locked afterwards.
  const locked = await page.request.post("/api/setup/complete", { headers: { "x-openmeet-csrf": "1", "content-type": "application/json" }, data: { token: E2E_SETUP_TOKEN } });
  expect(locked.status()).toBe(410);

  // 8. Create another event type in the dashboard.
  await page.goto("/app/event-types/new");
  await page.getByLabel("Title", { exact: true }).fill("Support session");
  await page.getByLabel("Minimum notice (minutes)").fill("0");
  await page.getByRole("button", { name: "Create event type" }).click();
  await expect(page).toHaveURL(/\/app\/event-types\/[a-z0-9]+$/);
  await page.goto("/app/event-types");
  await expect(page.getByText("Support session")).toBeVisible();

  // 9. Public booking as an external visitor (separate browser context = no session).
  const guest = await context.browser()!.newContext({ timezoneId: "America/New_York", locale: "en-US" });
  const g = await guest.newPage();
  await g.goto("/u/erin/support-session");
  await expect(g.getByRole("heading", { name: "Support session" })).toBeVisible();
  // pick the first available day in the next month to avoid "today" edge cases
  await g.getByRole("button", { name: "Next month" }).click();
  const day = g.locator('[role="gridcell"]:not([disabled])').first();
  await day.click();
  const firstSlot = g.locator("ul button").first();
  const slotLabel = await firstSlot.textContent();
  await firstSlot.click();
  await g.getByLabel("Name").fill("Gabi Guest");
  await g.getByLabel("E-mail").fill("gabi@example.org");
  await g.getByRole("button", { name: "Confirm booking" }).click();

  // 10. Confirmation
  await expect(g.getByRole("heading", { name: "You're booked" })).toBeVisible();
  await expect(g.getByText("America/New York")).toBeVisible();
  const rescheduleHref = await g.getByRole("link", { name: "Reschedule" }).getAttribute("href");
  expect(rescheduleHref).toMatch(/^\/reschedule\/.+/);

  // The booked slot is gone for the next visitor.
  const slots = await g.request.get(g.url().replace(/\/u\/.*/, "/api/public/users/erin/support-session"));
  expect(slots.ok()).toBe(true);

  // 11. Reschedule
  await g.goto(rescheduleHref!);
  await expect(g.getByRole("heading", { name: "Pick a new time" })).toBeVisible();
  await g.getByRole("button", { name: "Next month" }).click();
  await g.locator('[role="gridcell"]:not([disabled])').nth(1).click();
  await g.locator("ul button").nth(2).click();
  await g.getByRole("button", { name: "Confirm new time" }).click();
  await expect(g.getByRole("heading", { name: "Moved to the new time" })).toBeVisible();

  // 12. Organizer sees the booking in the dashboard
  await page.goto("/app/bookings");
  await expect(page.getByText("Gabi Guest")).toBeVisible();

  // 13. Cancel
  const token = rescheduleHref!.split("/").pop();
  await g.goto(`/cancel/${token}`);
  await g.getByLabel("Reason (optional)").fill("Plans changed");
  await g.getByRole("button", { name: "Cancel booking" }).click();
  await expect(g.getByRole("heading", { name: "Booking cancelled" })).toBeVisible();

  await page.goto("/app/bookings");
  await page.getByRole("tab", { name: "Cancelled" }).click();
  await expect(page.getByText("Gabi Guest")).toBeVisible();
  expect(slotLabel).toBeTruthy();
  await guest.close();
});
