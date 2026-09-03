import { describe, expect, it } from 'vitest';
import { sha256, sha256Prefix, utf8Length } from '../../../src/identity/hash.js';

describe('sha256', () => {
  it('returns the hex SHA-256 over UTF-8 bytes', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes non-ASCII text as UTF-8', () => {
    // "é" is 0xC3 0xA9 in UTF-8.
    expect(sha256('é')).toBe(sha256(Buffer.from([0xc3, 0xa9]).toString('utf8')));
    expect(sha256('é')).not.toBe(sha256('e'));
  });

  it('exposes prefix and byte length helpers', () => {
    expect(sha256Prefix('abc')).toBe('ba7816bf8f01cfea');
    expect(sha256Prefix('abc', 4)).toBe('ba78');
    expect(utf8Length('éa')).toBe(3);
  });
});
