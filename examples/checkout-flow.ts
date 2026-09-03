/**
 * Example flow module for a Scriptlock profile (`steps: ./examples/checkout-flow.ts`).
 *
 * The default export receives the Playwright page after `page.goto(profile.url)` and walks
 * to the rendered payment form. Scriptlock then waits `settleMs` and records what loaded.
 * Limitations: selectors are illustrative and must be adapted to your storefront; the
 * module is loaded with tsx (`.ts`) or imported directly (`.js`, `.mjs`); it runs under
 * `browser.timeoutMs` and any thrown error fails the scan with exit code 2.
 *
 * Never fill in or submit card details. Production scans stop at the payment form.
 */
import type { Page } from 'playwright-core';

export default async function checkoutFlow(page: Page): Promise<void> {
  const base = new URL(page.url());

  // Put something in the cart so the checkout renders a payment form.
  await page.goto(new URL('/product/42', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add to cart' }).click();

  // Go to checkout and fill the fields that gate the payment step. Use a dedicated
  // scanner account or guest checkout, never a real customer.
  await page.goto(new URL('/checkout', base).toString(), { waitUntil: 'networkidle' });
  await page.fill('#email', 'scriptlock-scan@example.com');
  await page.fill('#postal-code', '10115');

  // Dismiss a consent banner if one is shown, so consent-gated tags load and are recorded.
  const accept = page.getByRole('button', { name: /accept all/i });
  if (await accept.isVisible().catch(() => false)) {
    await accept.click();
  }

  // Wait for the payment provider iframe. Stop here: the card form is rendered, which is
  // what the inventory needs. Do not type a card number and do not click "Pay".
  await page.waitForSelector('#payment-element iframe', { timeout: 15_000 });
}
