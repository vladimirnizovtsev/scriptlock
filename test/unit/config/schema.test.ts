import { describe, expect, it } from 'vitest';
import { configSchema, defaultConfig, toScriptlockConfig } from '../../../src/config/schema.js';

describe('config defaults', () => {
  it('defaultConfig() carries every default from DESIGN.md section 9', () => {
    const config = defaultConfig();
    expect(config.version).toBe(1);
    expect(config.browser).toEqual({
      channel: 'chromium',
      headless: true,
      viewport: { width: 1366, height: 900 },
      timeoutMs: 30000,
    });
    expect(config.identity).toEqual({ stripQuery: [], keepQuery: [], collapseHashes: true });
    expect(config.scope).toEqual({ tpsp: [], threeds: [] });
    expect(config.integrity).toEqual({ firstParty: 'strict', thirdParty: 'track', inline: 'structural', eval: 'structural' });
    expect(config.profiles['default']).toEqual({
      url: 'https://shop.example.com/checkout',
      wait: 'networkidle',
      settleMs: 3000,
      runs: 1,
      history: false,
    });
  });

  it('applies nested defaults when sections are partially given', () => {
    const parsed = configSchema.parse({
      version: 1,
      browser: { headless: false },
      integrity: { thirdParty: 'strict' },
      profiles: { checkout: { url: 'https://shop.example.com/', runs: 2 } },
    });
    const config = toScriptlockConfig(parsed);
    expect(config.browser.headless).toBe(false);
    expect(config.browser.channel).toBe('chromium');
    expect(config.browser.viewport).toEqual({ width: 1366, height: 900 });
    expect(config.browser.timeoutMs).toBe(30000);
    expect(config.integrity).toEqual({ firstParty: 'strict', thirdParty: 'strict', inline: 'structural', eval: 'structural' });
    expect(config.identity.collapseHashes).toBe(true);
    expect(config.profiles['checkout']).toEqual({
      url: 'https://shop.example.com/',
      wait: 'networkidle',
      settleMs: 3000,
      runs: 2,
      history: false,
    });
  });

  it('does not emit optional keys with undefined values', () => {
    const config = defaultConfig();
    expect(Object.keys(config.browser).sort()).toEqual(['channel', 'headless', 'timeoutMs', 'viewport']);
    expect('steps' in (config.profiles['default'] ?? {})).toBe(false);
    expect('manifest' in (config.profiles['default'] ?? {})).toBe(false);
  });

  it('keeps optional browser and profile fields when given', () => {
    const parsed = configSchema.parse({
      version: 1,
      browser: { executablePath: '/opt/chrome', extraHeaders: { 'X-Token': 'abc' }, locale: 'en-GB' },
      profiles: {
        default: {
          url: 'https://shop.example.com/',
          steps: [{ goto: '/cart' }, { fill: { selector: '#email', value: 'a@b.c' } }, { wait: 500 }],
          manifest: 'locks/shop.yaml',
        },
      },
    });
    const config = toScriptlockConfig(parsed);
    expect(config.browser.executablePath).toBe('/opt/chrome');
    expect(config.browser.extraHeaders).toEqual({ 'X-Token': 'abc' });
    expect(config.browser.locale).toBe('en-GB');
    expect(config.profiles['default']?.steps).toEqual([
      { goto: '/cart' },
      { fill: { selector: '#email', value: 'a@b.c' } },
      { wait: 500 },
    ]);
    expect(config.profiles['default']?.manifest).toBe('locks/shop.yaml');
  });

  it('accepts a module path for steps', () => {
    const parsed = configSchema.parse({ version: 1, profiles: { default: { url: 'https://x.example/', steps: './flow.ts' } } });
    expect(parsed.profiles['default']?.steps).toBe('./flow.ts');
  });

  it('rejects unknown keys, bad enums and bad step shapes', () => {
    expect(configSchema.safeParse({ version: 1, profiles: {}, browsr: {} }).success).toBe(false);
    expect(configSchema.safeParse({ version: 2, profiles: {} }).success).toBe(false);
    expect(configSchema.safeParse({ version: 1, integrity: { inline: 'loose' }, profiles: {} }).success).toBe(false);
    expect(configSchema.safeParse({ version: 1, profiles: { d: { url: 'https://x.example/', wait: 'never' } } }).success).toBe(false);
    expect(configSchema.safeParse({ version: 1, profiles: { d: { url: 'https://x.example/', steps: [{ goto: '/a', click: 'b' }] } } }).success).toBe(false);
    expect(configSchema.safeParse({ version: 1, profiles: { d: { url: 'ftp://x.example/' } } }).success).toBe(false);
  });
});
