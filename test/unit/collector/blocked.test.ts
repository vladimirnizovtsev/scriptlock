import { describe, expect, it } from 'vitest';
import { detectBlocked, extractTitle } from '../../../src/collector/blocked.js';

const CHALLENGE_HTML = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><div id="challenge-running">Checking your browser</div>
<form class="challenge-form"><input name="cf-chl" value="x"></form>
<script>window._cf_chl_opt = { cvId: '3' };</script></body></html>`;

// A normal 200 page that carries the Cloudflare JavaScript-detections sensor.
const JSD_PAGE = `<!doctype html><html><head><title>Shop checkout</title>
<script>window.__CF$cv$params = { r: 'abc' };</script>
<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
</head><body>Checkout</body></html>`;

// A normal 200 page that carries the Turnstile widget.
const TURNSTILE_PAGE = `<!doctype html><html><head><title>Shop</title></head>
<body><div class="cf-chl-widget" id="cf-chl-widget-abcd"></div></body></html>`;

describe('detectBlocked: Cloudflare', () => {
  it('flags the challenge fixture at 503', () => {
    const result = detectBlocked({ status: 503, title: '', html: CHALLENGE_HTML });
    expect(result?.vendor).toBe('cloudflare');
    expect(result?.evidence).toContain('Just a moment');
    expect(result?.evidence).toContain('503');
  });

  it('flags a cf-mitigated: challenge response header even at 403', () => {
    const result = detectBlocked({ status: 403, title: '', html: '<html><body>blocked</body></html>', headers: { 'CF-Mitigated': 'challenge' } });
    expect(result?.vendor).toBe('cloudflare');
    expect(result?.evidence).toContain('cf-mitigated');
  });

  it('does NOT flag a 200 page that only carries the JS-detections loader', () => {
    expect(detectBlocked({ status: 200, title: 'Shop checkout', html: JSD_PAGE })).toBeUndefined();
  });

  it('does NOT flag a 200 page that only carries the Turnstile widget', () => {
    expect(detectBlocked({ status: 200, title: 'Shop', html: TURNSTILE_PAGE })).toBeUndefined();
  });

  it('does NOT treat server: cloudflare on a normal 200 page as blocked', () => {
    expect(detectBlocked({ status: 200, title: 'Shop', html: '<html><body>ok</body></html>', headers: { Server: 'cloudflare' } })).toBeUndefined();
  });

  it('names the marker that actually matched', () => {
    const result = detectBlocked({ status: 503, title: '', html: '<html><body><div class="challenge-running"></div></body></html>' });
    expect(result?.evidence).toContain('challenge-running');
  });
});

describe('detectBlocked: Akamai', () => {
  it('flags the SEC-CPT crypto challenge at 428', () => {
    const result = detectBlocked({ status: 428, title: '', html: '<html><body><script src="/_sec/cp_challenge/sec-cpt-c.js"></script></body></html>' });
    expect(result?.vendor).toBe('akamai');
    expect(result?.evidence).toContain('/_sec/cp_challenge/');
    expect(result?.evidence).toContain('428');
  });

  it('flags a bm-verify block page on its own', () => {
    const result = detectBlocked({ status: 403, title: 'Access Denied', html: '<html><body>{"bm-verify":"abc"}</body></html>' });
    expect(result?.vendor).toBe('akamai');
  });

  it('does NOT flag a 200 page whose body merely mentions sec-cpt', () => {
    expect(detectBlocked({ status: 200, title: 'Docs', html: '<html><body>our sec-cpt guide</body></html>' })).toBeUndefined();
  });
});

describe('detectBlocked: PerimeterX', () => {
  it('flags a px-captcha block page', () => {
    const result = detectBlocked({ status: 403, title: 'Access to this page has been denied', html: '<html><body><div id="px-captcha"></div></body></html>' });
    expect(result?.vendor).toBe('perimeterx');
  });

  it('does NOT flag a 200 page that only bootstraps the sensor (_pxAppId)', () => {
    expect(detectBlocked({ status: 200, title: 'Shop', html: "<html><body><script>window._pxAppId='PXabcd';</script></body></html>" })).toBeUndefined();
  });
});

describe('detectBlocked: status only', () => {
  it('flags a bare 403 / 428 / 429 / 503 with no markers as unknown', () => {
    for (const status of [403, 428, 429, 503]) {
      expect(detectBlocked({ status, title: 'Error', html: '<html><body>error</body></html>' })).toMatchObject({ vendor: 'unknown' });
    }
  });

  it('returns undefined for an ordinary 200 page', () => {
    expect(detectBlocked({ status: 200, title: 'Home', html: '<html><body>hello</body></html>' })).toBeUndefined();
  });
});

describe('extractTitle', () => {
  it('reads and decodes the document title', () => {
    expect(extractTitle('<title>Just a moment&#39;s wait</title>')).toBe("Just a moment's wait");
    expect(extractTitle('<html><body>no title</body></html>')).toBe('');
  });
});
