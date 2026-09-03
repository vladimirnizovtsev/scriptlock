import { describe, expect, it } from 'vitest';
import type { ScopeConfig } from '../../../src/types.js';
import { BUILTIN_THREEDS_HOSTS, BUILTIN_TPSP_HOSTS, classifyFrame, isFirstParty } from '../../../src/identity/scope.js';

const cfg: ScopeConfig = { tpsp: [], threeds: [] };
const mainOrigin = 'https://shop.example.com';

describe('classifyFrame', () => {
  it('classifies the main frame as merchant', () => {
    expect(classifyFrame({ url: 'https://shop.example.com/checkout', isMain: true, mainOrigin }, cfg)).toBe('merchant');
  });

  it('classifies a same-origin frame as merchant', () => {
    expect(classifyFrame({ url: 'https://shop.example.com/frame.html', isMain: false, mainOrigin }, cfg)).toBe('merchant');
    expect(classifyFrame({ url: 'https://shop.example.com:443/frame.html', isMain: false, mainOrigin }, cfg)).toBe('merchant');
  });

  it('treats a different scheme, host or port as cross-origin', () => {
    expect(classifyFrame({ url: 'http://shop.example.com/frame.html', isMain: false, mainOrigin }, cfg)).toBe('embedded');
    expect(classifyFrame({ url: 'https://shop.example.com:8443/frame.html', isMain: false, mainOrigin }, cfg)).toBe('embedded');
    expect(classifyFrame({ url: 'https://sub.shop.example.com/frame.html', isMain: false, mainOrigin }, cfg)).toBe('embedded');
  });

  it('classifies blank frames as merchant', () => {
    expect(classifyFrame({ url: 'about:blank', isMain: false, mainOrigin }, cfg)).toBe('merchant');
    expect(classifyFrame({ url: '', isMain: false, mainOrigin }, cfg)).toBe('merchant');
  });

  it('classifies built-in TPSP hosts', () => {
    expect(classifyFrame({ url: 'https://js.stripe.com/v3/elements-inner-card-0a1b2c3d4e5f.html', isMain: false, mainOrigin }, cfg)).toBe('tpsp');
    expect(classifyFrame({ url: 'https://checkoutshopper-live.adyen.com/checkoutshopper/securedfields.html', isMain: false, mainOrigin }, cfg)).toBe('tpsp');
    expect(classifyFrame({ url: 'https://m.stripe.network/inner.html', isMain: false, mainOrigin }, cfg)).toBe('embedded');
    expect(classifyFrame({ url: 'https://www.paypal.com/smart/buttons', isMain: false, mainOrigin }, cfg)).toBe('tpsp');
    expect(classifyFrame({ url: 'https://pay.google.com/gp/p/ui/pay', isMain: false, mainOrigin }, cfg)).toBe('tpsp');
    expect(classifyFrame({ url: 'https://assets.braintreegateway.com/web/3.97.2/html/hosted-fields-frame.min.html', isMain: false, mainOrigin }, cfg)).toBe('tpsp');
  });

  it('matches TPSP hosts case-insensitively', () => {
    expect(classifyFrame({ url: 'https://JS.STRIPE.COM/v3', isMain: false, mainOrigin }, cfg)).toBe('tpsp');
  });

  it('classifies built-in 3DS hosts', () => {
    expect(classifyFrame({ url: 'https://centinelapi.cardinalcommerce.com/V1/Cruise/Collect', isMain: false, mainOrigin }, cfg)).toBe('threeds');
    expect(classifyFrame({ url: 'https://acs.bank.example/challenge', isMain: false, mainOrigin }, cfg)).toBe('threeds');
    expect(classifyFrame({ url: 'https://secure5.arcot.com/acspage/cap', isMain: false, mainOrigin }, cfg)).toBe('threeds');
    expect(classifyFrame({ url: 'https://www.3dsecure.example.net/x', isMain: false, mainOrigin }, cfg)).toBe('threeds');
    expect(classifyFrame({ url: 'https://challenge.3ds.bank.example/x', isMain: false, mainOrigin }, cfg)).toBe('threeds');
    expect(classifyFrame({ url: 'https://3ds.modirum.com/x', isMain: false, mainOrigin }, cfg)).toBe('threeds');
  });

  it('matches the ACS 3DS glob on a label boundary, not any host containing "acs"', () => {
    expect(classifyFrame({ url: 'https://acs.bank.example/challenge', isMain: false, mainOrigin }, cfg)).toBe('threeds');
    expect(classifyFrame({ url: 'https://x.acs.bank.example/challenge', isMain: false, mainOrigin }, cfg)).toBe('threeds');
    expect(classifyFrame({ url: 'https://macs.example.net/x', isMain: false, mainOrigin }, cfg)).toBe('embedded');
    expect(classifyFrame({ url: 'https://tracsystems.example.net/x', isMain: false, mainOrigin }, cfg)).toBe('embedded');
  });

  it('prefers tpsp when a host matches both lists', () => {
    const both: ScopeConfig = { tpsp: ['acs.bank.example'], threeds: [] };
    expect(classifyFrame({ url: 'https://acs.bank.example/x', isMain: false, mainOrigin }, both)).toBe('tpsp');
  });

  it('applies configured extra globs', () => {
    const extra: ScopeConfig = { tpsp: ['localhost', '*.pay.example.org'], threeds: ['auth.bank.example'] };
    expect(classifyFrame({ url: 'http://localhost:4321/tpsp.html', isMain: false, mainOrigin: 'http://127.0.0.1:4321' }, extra)).toBe('tpsp');
    expect(classifyFrame({ url: 'https://widgets.pay.example.org/form', isMain: false, mainOrigin }, extra)).toBe('tpsp');
    expect(classifyFrame({ url: 'https://auth.bank.example/step', isMain: false, mainOrigin }, extra)).toBe('threeds');
  });

  it('matches bare host globs exactly, not as substrings', () => {
    const extra: ScopeConfig = { tpsp: ['localhost'], threeds: [] };
    expect(classifyFrame({ url: 'http://localhost/x', isMain: false, mainOrigin }, extra)).toBe('tpsp');
    expect(classifyFrame({ url: 'http://localhost.evil.example/x', isMain: false, mainOrigin }, extra)).toBe('embedded');
    expect(classifyFrame({ url: 'http://notlocalhost/x', isMain: false, mainOrigin }, extra)).toBe('embedded');
  });

  it('classifies any other cross-origin frame as embedded', () => {
    expect(classifyFrame({ url: 'https://widget.intercom.io/frame', isMain: false, mainOrigin }, cfg)).toBe('embedded');
    expect(classifyFrame({ url: 'http://localhost:4321/frame.html', isMain: false, mainOrigin: 'http://127.0.0.1:4321' }, cfg)).toBe('embedded');
  });
});

describe('built-in host lists', () => {
  it('contain the hosts named in DESIGN.md', () => {
    for (const host of [
      'js.stripe.com',
      '*.stripe.com',
      'checkoutshopper-live.adyen.com',
      '*.adyen.com',
      '*.paypal.com',
      '*.paypalobjects.com',
      '*.braintreegateway.com',
      '*.braintree-api.com',
      '*.checkout.com',
      '*.klarna.com',
      '*.klarnaservices.com',
      '*.mollie.com',
      '*.squareup.com',
      '*.squarecdn.com',
      'pay.google.com',
      '*.apple.com',
      '*.authorize.net',
      '*.worldpay.com',
      '*.payments.worldpay.com',
      '*.nuvei.com',
      '*.2checkout.com',
      '*.paddle.com',
      '*.recurly.com',
      '*.chargebee.com',
      '*.gocardless.com',
    ]) {
      expect(BUILTIN_TPSP_HOSTS).toContain(host);
    }
    for (const host of ['*.cardinalcommerce.com', '*.arcot.com', '*3dsecure*', 'acs.*', '*.acs.*', '*.3ds.*', '*.modirum.com', '*.netcetera.com', '*.gpayments.com']) {
      expect(BUILTIN_THREEDS_HOSTS).toContain(host);
    }
  });
});

describe('isFirstParty', () => {
  it('is true for the same host', () => {
    expect(isFirstParty('https://shop.example.com/assets/app.js', mainOrigin)).toBe(true);
    expect(isFirstParty('https://SHOP.example.com/assets/app.js', mainOrigin)).toBe(true);
  });

  it('is true for a subdomain of the main host', () => {
    expect(isFirstParty('https://static.shop.example.com/app.js', mainOrigin)).toBe(true);
    expect(isFirstParty('https://a.b.shop.example.com/app.js', mainOrigin)).toBe(true);
  });

  it('ignores scheme and port', () => {
    expect(isFirstParty('http://shop.example.com:8080/app.js', mainOrigin)).toBe(true);
  });

  it('is false for other hosts, parent domains and lookalikes', () => {
    expect(isFirstParty('https://js.stripe.com/v3', mainOrigin)).toBe(false);
    expect(isFirstParty('https://example.com/app.js', mainOrigin)).toBe(false);
    expect(isFirstParty('https://evilshop.example.com/app.js', mainOrigin)).toBe(false);
  });

  it('accepts a full URL as mainOrigin and is false for unparseable input', () => {
    expect(isFirstParty('https://shop.example.com/a.js', 'https://shop.example.com/checkout?x=1')).toBe(true);
    expect(isFirstParty('inline:https://shop.example.com:abc', mainOrigin)).toBe(false);
    expect(isFirstParty('https://shop.example.com/a.js', 'nope')).toBe(false);
  });
});
