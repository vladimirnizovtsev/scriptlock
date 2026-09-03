/**
 * Two-origin fixture server for e2e tests (DESIGN.md section 10).
 *
 * One plain node:http server bound to 127.0.0.1 on a random port, reachable as
 * `http://127.0.0.1:<port>` (first party) and `http://localhost:<port>`
 * (a different origin for the browser, used for the cross-origin iframe).
 *
 * Routes:
 *   /                      main page (fixtures/site/index.html); security headers configurable
 *                          via `setHeaders` or `?headers=none`; `?worker=1` starts a dedicated worker
 *   /app.<hash>.js         first-party bundle; hash and body switched with `setBundle`
 *   /vendor.js?v=<n>       vendor script whose body embeds the version (`setVendorVersion`)
 *   /dynamic.js /late.js   inserted by the main page at runtime (immediately / after 1500 ms)
 *   /spoof.js              body ends with `//# sourceURL=https://js.stripe.com/v3`
 *   /frame-same.html/.js   same-origin iframe with an inline and an external script
 *   /frame-cross.html/.js  iframe loaded from the localhost origin
 *   /worker.js             dedicated worker entry
 *   /challenge             503 page mimicking a Cloudflare interstitial
 *   /extra.js              extra first-party script, included in the main page after `setExtraScript(true)`
 *   /frame-extra.js        extra script inside the cross-origin frame after `setFrameExtraScript(true)`
 *
 * `setBlocked(true)` makes `/` answer with the challenge page (503) so a profile
 * pointing at the main page can exercise the blocked detector.
 *
 * Templates in fixtures/site use {{APP_HASH}}, {{VENDOR_VERSION}}, {{CROSS_ORIGIN}},
 * {{ORIGIN}} and {{NONCE}} (a per-request value inside one inline script, so its
 * sha256 differs per request while its structural hash is stable).
 *
 * Limitations: no HTTPS, no compression, no caching semantics beyond static
 * header values; the challenge page is a look-alike, not a real interstitial.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), 'site');

export interface FixtureServerOptions {
  /** Initial security headers for `/`. Defaults to a permissive CSP, HSTS, XFO, XCTO and Referrer-Policy. */
  headers?: Record<string, string>;
  /** Initial first-party bundle hash (path token in /app.<hash>.js). */
  appHash?: string;
  /** Initial first-party bundle body. */
  appBody?: string;
  /** Initial vendor.js version. */
  vendorVersion?: number;
  /** Include /extra.js in the main page. */
  extraScript?: boolean;
  /** Include /frame-extra.js in the cross-origin frame. */
  frameExtraScript?: boolean;
  /** Serve the challenge page for `/`. */
  blocked?: boolean;
}

export interface RecordedRequest {
  /** Host header of the request (host:port). */
  host: string;
  path: string;
  /** Value of the X-Scanner-Token request header, or undefined when absent. */
  token: string | undefined;
}

export interface FixtureServer {
  port: number;
  /** http://127.0.0.1:<port> */
  origin: string;
  /** http://localhost:<port> */
  crossOrigin: string;
  close(): Promise<void>;
  /** Every request the server has answered since the last clearRequests(). */
  readonly requests: RecordedRequest[];
  /** Forget the recorded requests. */
  clearRequests(): void;
  /** Switch the first-party bundle (hash in the URL and body) to simulate a deploy. */
  setBundle(hash: string, body: string): void;
  /** Replace the security headers served with the main document. */
  setHeaders(headers: Record<string, string>): void;
  /** Change the vendor.js cache buster and body. */
  setVendorVersion(version: number): void;
  /** Include (or drop) an extra first-party script tag in the main page. */
  setExtraScript(enabled: boolean): void;
  /** Include (or drop) an extra script tag inside the cross-origin frame. */
  setFrameExtraScript(enabled: boolean): void;
  /** Serve the Cloudflare-style challenge page (503) for `/`. */
  setBlocked(enabled: boolean): void;
  /** Current bundle hash. */
  readonly appHash: string;
}

export const DEFAULT_APP_HASH = 'deadbeef0badf00d';
export const DEFAULT_APP_BODY = readFileSync(join(siteDir, 'app.default.js'), 'utf8');

export function defaultSecurityHeaders(crossOrigin: string): Record<string, string> {
  return {
    'Content-Security-Policy': `default-src 'self' ${crossOrigin} blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://js.stripe.com; frame-src 'self' ${crossOrigin}; worker-src 'self' blob:`,
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function readSite(name: string): string {
  return readFileSync(join(siteDir, name), 'utf8');
}

export async function start(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  let appHash = options.appHash ?? DEFAULT_APP_HASH;
  let appBody = options.appBody ?? DEFAULT_APP_BODY;
  let vendorVersion = options.vendorVersion ?? 1;
  let securityHeaders: Record<string, string> | undefined = options.headers;
  let extraScript = options.extraScript ?? false;
  let frameExtraScript = options.frameExtraScript ?? false;
  let blocked = options.blocked ?? false;
  let origin = '';
  let crossOrigin = '';

  const requestLog: RecordedRequest[] = [];

  // Two string timers: each compiles page code without a URL and without a stack
  // trace. The interval fires once quickly and clears itself so both compile
  // within the settle window.
  const VECTOR_SCRIPT =
    '<script>\n  setTimeout("window.__fixture.timerString = 1;", 5);\n  var iv = setInterval("window.__fixture.intervalString = (window.__fixture.intervalString || 0) + 1; clearInterval(iv);", 10);\n</script>';

  const render = (template: string, extra: Record<string, string> = {}): string =>
    template
      .replaceAll('{{APP_HASH}}', appHash)
      .replaceAll('{{VENDOR_VERSION}}', String(vendorVersion))
      .replaceAll('{{CROSS_ORIGIN}}', crossOrigin)
      .replaceAll('{{ORIGIN}}', origin)
      .replaceAll('{{EXTRA_SCRIPTS}}', extraScript ? '<script src="/extra.js"></script>' : '')
      .replaceAll('{{FRAME_EXTRA_SCRIPTS}}', frameExtraScript ? '<script src="/frame-extra.js"></script>' : '')
      .replaceAll('{{VECTORS}}', extra['VECTORS'] ?? '')
      .replaceAll('{{NONCE}}', randomBytes(8).toString('hex'));

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string>,
  ): void => {
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };

  const scriptHeaders = (name: string): Record<string, string> => ({
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    ETag: `"${name}-${appHash}-${vendorVersion}"`,
    'Last-Modified': 'Tue, 01 Sep 2026 10:00:00 GMT',
    'Access-Control-Allow-Origin': '*',
  });

  const htmlHeaders: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const path = url.pathname;
    const rawToken = req.headers['x-scanner-token'];
    requestLog.push({ host: req.headers.host ?? '', path, token: typeof rawToken === 'string' ? rawToken : Array.isArray(rawToken) ? rawToken[0] : undefined });

    if (path === '/' && !blocked) {
      const noHeaders = url.searchParams.get('headers') === 'none';
      const sec = noHeaders ? {} : (securityHeaders ?? defaultSecurityHeaders(crossOrigin));
      const vectors = url.searchParams.get('vectors') === '1' ? VECTOR_SCRIPT : '';
      send(res, 200, render(readSite('index.html'), { VECTORS: vectors }), { ...htmlHeaders, ...sec });
      return;
    }
    if (path === '/challenge' || path === '/') {
      send(res, 503, readSite('challenge.html'), {
        ...htmlHeaders,
        'cf-mitigated': 'challenge',
        Server: 'cloudflare',
      });
      return;
    }
    const bundle = /^\/app\.([^/]+)\.js$/.exec(path);
    if (bundle) {
      if (bundle[1] !== appHash) {
        send(res, 404, `// unknown bundle ${bundle[1]}\n`, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return;
      }
      send(res, 200, appBody, scriptHeaders('app'));
      return;
    }
    if (path === '/vendor.js') {
      send(res, 200, render(readSite('vendor.js')), scriptHeaders('vendor'));
      return;
    }
    if (path === '/frame-same.html' || path === '/frame-cross.html') {
      send(res, 200, render(readSite(path.slice(1))), htmlHeaders);
      return;
    }
    if (/^\/(dynamic|late|spoof|frame-same|frame-cross|worker|extra|frame-extra)\.js$/.test(path)) {
      send(res, 200, render(readSite(path.slice(1))), scriptHeaders(path.slice(1, -3)));
      return;
    }
    send(res, 404, 'not found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port');
  const port = address.port;
  origin = `http://127.0.0.1:${port}`;
  crossOrigin = `http://localhost:${port}`;

  return {
    port,
    origin,
    crossOrigin,
    get appHash() {
      return appHash;
    },
    get requests() {
      return requestLog.slice();
    },
    clearRequests() {
      requestLog.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    setBundle(hash, body) {
      appHash = hash;
      appBody = body;
    },
    setHeaders(headers) {
      securityHeaders = headers;
    },
    setVendorVersion(version) {
      vendorVersion = version;
    },
    setExtraScript(enabled) {
      extraScript = enabled;
    },
    setFrameExtraScript(enabled) {
      frameExtraScript = enabled;
    },
    setBlocked(enabled) {
      blocked = enabled;
    },
  };
}
