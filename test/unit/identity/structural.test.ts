import { describe, expect, it } from 'vitest';
import { normalizeStructure, structuralHash } from '../../../src/identity/structural.js';
import { sha256 } from '../../../src/identity/hash.js';

describe('structuralHash: stability across literal changes', () => {
  it('hashes the same when only string literals differ', () => {
    const a = 'self.__next_f.push([1,"abc:123 {\\"token\\":\\"xyz\\"}"])';
    const b = 'self.__next_f.push([1,"def:456 {\\"token\\":\\"qqq\\"}"])';
    expect(structuralHash(a)).toBe(structuralHash(b));
  });

  it('hashes the same when only numeric literals differ', () => {
    expect(structuralHash('window.__ts = 1725000000; var x = 0x1F + 1.5e3 + .25 + 10n;')).toBe(
      structuralHash('window.__ts = 1725099999; var x = 0xFF + 2.75e-1 + .5 + 99n;'),
    );
  });

  it('hashes the same across single, double and template quotes with different contents', () => {
    expect(structuralHash("var a = 'one';")).toBe(structuralHash('var a = "two";'));
    expect(structuralHash("var a = 'one';")).toBe(structuralHash('var a = `three`;'));
  });

  it('hashes the same when whitespace and comments differ', () => {
    const a = 'function f(a, b) {\n  // add\n  return a + b; /* done */\n}';
    const b = 'function f(a,b){return a+b;}';
    const c = 'function\t\tf(a,   b)\r\n{ /* block */ return\n\n a   +\tb;   }';
    expect(structuralHash(a)).toBe(structuralHash(c));
    // Whitespace runs collapse to a single space (they are not removed), so
    // a and b are different structures; the normalised text shows why.
    expect(normalizeStructure(a)).toBe('function f(a, b) { return a + b; }');
    expect(normalizeStructure(b)).toBe('function f(a,b){return a+b;}');
    expect(structuralHash(a)).not.toBe(structuralHash(b));
  });

  it('hashes the same when only regex literals differ', () => {
    expect(structuralHash('var r = /ab+c/gi; if (r.test(s)) go();')).toBe(
      structuralHash('var r = /x[0-9/]+y/; if (r.test(s)) go();'),
    );
  });

  it('is deterministic and returns 64 hex chars', () => {
    const h = structuralHash('console.log("hi")');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(structuralHash('console.log("hi")')).toBe(h);
    expect(h).toBe(sha256('console.log("S")'));
  });
});

describe('structuralHash: sensitivity to code changes', () => {
  it('differs when an identifier changes', () => {
    expect(structuralHash('fetch("/api")')).not.toBe(structuralHash('sendBeacon("/api")'));
  });

  it('differs when a statement is added', () => {
    expect(structuralHash('a();')).not.toBe(structuralHash('a(); b();'));
  });

  it('differs when a string literal becomes a call', () => {
    expect(structuralHash('var x = "a";')).not.toBe(structuralHash('var x = f();'));
  });
});

describe('normalizeStructure: masking rules', () => {
  it('masks strings, numbers and regexes and strips comments', () => {
    expect(normalizeStructure('var s = "x", n = 42, r = /re/g; // c\n/* b */ f(s, n, r);')).toBe(
      'var s = "S", n = 0, r = /R/; f(s, n, r);',
    );
  });

  it('handles escaped quotes inside strings', () => {
    expect(normalizeStructure('a("it\\"s", \'x\\\'y\')')).toBe('a("S", "S")');
  });

  it('masks a template literal without expressions as "S"', () => {
    expect(normalizeStructure('t(`hello\nworld`)')).toBe('t("S")');
  });

  it('keeps expressions of template literals and masks static parts', () => {
    expect(normalizeStructure('t(`Hi ${user.name}, you have ${count + 1} items`)')).toBe(
      't(`S${user.name}S${count + 0}S`)',
    );
    expect(structuralHash('t(`Hi ${user.name}, total ${n}`)')).toBe(structuralHash('t(`Yo ${user.name}, sum ${n}`)'));
    expect(structuralHash('t(`Hi ${user.name}`)')).not.toBe(structuralHash('t(`Hi ${user.id}`)'));
  });

  it('handles nested templates and object literals inside expressions', () => {
    expect(normalizeStructure('t(`a ${ f({ k: `b ${x}` }) } c`)')).toBe('t(`S${ f({ k: `S${x}S` }) }S`)');
  });

  it('treats a slash after an identifier, number or closing bracket as division', () => {
    expect(normalizeStructure('a / b / c')).toBe('a / b / c');
    expect(normalizeStructure('x = (a + 1) / 2 / arr[0]')).toBe('x = (a + 0) / 0 / arr[0]');
  });

  it('treats a slash after an operator, keyword or paren as a regex', () => {
    expect(normalizeStructure('return /a/.test(s)')).toBe('return /R/.test(s)');
    expect(normalizeStructure('s.replace(/[/]+/g, "-")')).toBe('s.replace(/R/, "S")');
    expect(normalizeStructure('x = y ? /a/ : /b/i')).toBe('x = y ? /R/ : /R/');
  });

  it('falls back to division when a would-be regex does not close on the line', () => {
    expect(normalizeStructure('a = b\n/ c\n/ d')).toBe('a = b / c / d');
    // After `=` a regex is allowed, but no closing slash on the line: division.
    expect(normalizeStructure('a =\n/ c\n/ d')).toBe('a = / c / d');
  });

  it('strips a hashbang line and unterminated comments', () => {
    expect(normalizeStructure('#!/usr/bin/env node\nrun()')).toBe('run()');
    expect(normalizeStructure('run() /* never closed')).toBe('run()');
  });

  it('does not mask digits inside identifiers', () => {
    expect(normalizeStructure('var a1 = b2c + 3')).toBe('var a1 = b2c + 0');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizeStructure('')).toBe('');
    expect(normalizeStructure('  \n\t ')).toBe('');
  });
});
