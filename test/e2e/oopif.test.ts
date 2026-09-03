/**
 * Out-of-process iframe capture (DESIGN.md 3.2). Forces real site isolation
 * with --site-per-process so the cross-origin fixture frame runs in its own
 * process, then checks that a parser-inserted script inside it keeps its
 * network initiator and response headers, captured over a child target that
 * was attached before the frame ran.
 */
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachCapture } from '../../src/collector/session.js';
import { start, type FixtureServer } from '../../fixtures/server.js';

let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = await start();
  browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

describe('out-of-process iframe capture', () => {
  it('keeps the parser initiator and response headers of a script in a cross-origin frame', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const capture = await attachCapture(context, page);
    try {
      await page.goto(`${server.origin}/`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(1000);
      await capture.settle();
      await capture.refreshFrames();
      await capture.settle();

      const crossFrame = page.frames().find((f) => f.url().includes(`localhost:${server.port}`));
      expect(crossFrame).toBeDefined();
      let oopif = false;
      try {
        const probe = await context.newCDPSession(crossFrame!);
        oopif = true;
        await probe.detach();
      } catch {
        oopif = false;
      }

      const request = capture.requests.find((r) => r.url.endsWith('/frame-cross.js'));
      const response = capture.responses.find((r) => r.url.endsWith('/frame-cross.js'));
      const script = capture.scripts.find((s) => s.url.endsWith('/frame-cross.js') || s.embedderName.endsWith('/frame-cross.js'));

      // The frame's parser-inserted script must be seen with its real initiator,
      // its response headers, and its body, even under site isolation.
      expect(request).toBeDefined();
      expect(request?.initiator.type).toBe('parser');
      expect(response).toBeDefined();
      expect(Object.keys(response?.headers ?? {}).length).toBeGreaterThan(0);
      expect(script).toBeDefined();
      expect(script?.source.length).toBeGreaterThan(0);

      // When the runner actually isolates the frame, the record must come from the
      // child (OOPIF) session that auto-attach wired before the frame ran.
      if (oopif) {
        expect(request?.sessionKey.startsWith('oopif')).toBe(true);
        expect(script?.sessionKey.startsWith('oopif')).toBe(true);
      }
    } finally {
      await capture.dispose();
      await context.close();
    }
  });
});
