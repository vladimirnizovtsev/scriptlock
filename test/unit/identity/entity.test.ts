import { describe, expect, it } from 'vitest';
import { lookupEntity } from '../../../src/identity/entity.js';

describe('lookupEntity', () => {
  it('returns name and category for a known third party', () => {
    const gtm = lookupEntity('https://www.googletagmanager.com/gtm.js?id=GTM-ABC');
    expect(gtm).toEqual({ name: 'Google Tag Manager', category: 'tag-manager' });
    const stripe = lookupEntity('https://js.stripe.com/v3');
    expect(stripe?.name).toBe('Stripe');
    expect(typeof stripe?.category).toBe('string');
  });

  it('returns undefined for unknown hosts', () => {
    expect(lookupEntity('https://shop.example.com/assets/app.js')).toBeUndefined();
  });

  it('returns undefined instead of throwing for non-URL input', () => {
    expect(lookupEntity('inline:https://shop.example.com:9f2c41ba0d77e1a3')).toBeUndefined();
    expect(lookupEntity('')).toBeUndefined();
    expect(lookupEntity('blob:https://shop.example.com')).toBeUndefined();
  });
});
