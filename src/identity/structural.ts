/**
 * Structural hash of JavaScript source (DESIGN.md section 4.3).
 *
 * Owns: a hand-written tokenizer that masks string literals as `"S"`
 * (template literals without expressions included; templates with `${}` keep
 * the expression code and mask the static parts as `S`), numeric literals as
 * `0`, regex literals as `/R/`, strips line and block comments, collapses
 * whitespace runs to one space and trims. The SHA-256 of that text is the
 * structural hash.
 *
 * Known limitations (no full parser is used):
 * - Regex versus division is decided from the previous significant token: a
 *   `/` after an identifier, number, string, `)` or `]` is division, anything
 *   else starts a regex. `if (x) /re/.test(y)` and `a++ / 2` are therefore
 *   mis-tokenized; a would-be regex that hits a newline before closing is
 *   re-read as division.
 * - `}` is treated as a statement end (regex allowed after it).
 * - Unterminated strings run to the end of the line; unterminated templates,
 *   comments and regexes run to the end of input.
 * - Identifiers, keywords and punctuation are kept verbatim, so renaming a
 *   variable changes the hash. That is intended.
 */
import { sha256 } from './hash.js';

type Last = 'none' | 'ident' | 'keyword' | 'number' | 'string' | 'closeParen' | 'closeBracket' | 'punct';

/** Keywords after which a `/` starts a regex rather than a division. */
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$#\\]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$\\]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Return the structurally normalised source text (before hashing). Exported
 * for tests and debugging; `structuralHash` is the public entry point.
 */
export function normalizeStructure(source: string): string {
  const src = source;
  const len = src.length;
  let pos = 0;

  const at = (offset = 0): string => src[pos + offset] ?? '';

  /** Scan a `'` or `"` string starting at `pos` (on the quote). */
  function scanString(quote: string): void {
    pos++; // opening quote
    while (pos < len) {
      const ch = at();
      if (ch === '\\') {
        pos += 2;
        continue;
      }
      if (ch === quote) {
        pos++;
        return;
      }
      if (ch === '\n' || ch === '\r') return; // unterminated: stop at line end
      pos++;
    }
  }

  /** Scan a numeric literal starting at `pos` (digit or `.` followed by digit). */
  function scanNumber(): void {
    if (at() === '0' && /[xXoObB]/.test(at(1))) {
      pos += 2;
      while (pos < len && /[0-9A-Fa-f_]/.test(at())) pos++;
      if (at() === 'n') pos++;
      return;
    }
    while (pos < len && /[0-9_]/.test(at())) pos++;
    // The fractional part is scanned the same way whether digits preceded the
    // dot (`1.5`) or not (`.5`).
    if (at() === '.') {
      pos++;
      while (pos < len && /[0-9_]/.test(at())) pos++;
    }
    if (/[eE]/.test(at()) && (isDigit(at(1)) || (/[+-]/.test(at(1)) && isDigit(at(2))))) {
      pos += 2;
      while (pos < len && /[0-9_]/.test(at())) pos++;
    }
    if (at() === 'n') pos++;
  }

  /**
   * Try to scan a regex literal starting at `pos` (on the `/`). Returns true
   * when a complete literal was consumed on one line, false otherwise (then
   * `pos` is unchanged and the `/` is a division operator).
   */
  function scanRegex(): boolean {
    const start = pos;
    let p = pos + 1;
    let inClass = false;
    while (p < len) {
      const ch = src[p] ?? '';
      if (ch === '\n' || ch === '\r') {
        pos = start;
        return false;
      }
      if (ch === '\\') {
        p += 2;
        continue;
      }
      if (inClass) {
        if (ch === ']') inClass = false;
        p++;
        continue;
      }
      if (ch === '[') {
        inClass = true;
        p++;
        continue;
      }
      if (ch === '/') {
        p++;
        while (p < len && /[A-Za-z]/.test(src[p] ?? '')) p++;
        pos = p;
        return true;
      }
      p++;
    }
    pos = start;
    return false;
  }

  /**
   * Scan a template literal starting at `pos` (on the backtick). Returns the
   * masked text: `"S"` when it has no expressions, otherwise a backtick
   * template whose static parts are `S` and whose expressions are the
   * recursively normalised expression code.
   */
  function scanTemplate(): string {
    pos++; // opening backtick
    const parts: string[] = [];
    let hasExpression = false;
    while (pos < len) {
      const ch = at();
      if (ch === '\\') {
        pos += 2;
        continue;
      }
      if (ch === '`') {
        pos++;
        break;
      }
      if (ch === '$' && at(1) === '{') {
        pos += 2;
        hasExpression = true;
        parts.push('S');
        const expr = scanCode(true);
        parts.push('${' + expr + '}');
        continue;
      }
      pos++;
    }
    if (!hasExpression) return '"S"';
    parts.push('S');
    return '`' + parts.join('') + '`';
  }

  /**
   * Scan code until end of input, or (inside a template expression) until the
   * `}` that closes the expression. Returns the masked output text.
   */
  function scanCode(inTemplateExpression: boolean): string {
    const out: string[] = [];
    let last: Last = 'none';
    let braceDepth = 0;

    const regexAllowed = (): boolean =>
      last !== 'ident' && last !== 'number' && last !== 'string' && last !== 'closeParen' && last !== 'closeBracket';

    while (pos < len) {
      const ch = at();
      const next = at(1);

      // Whitespace: keep one space; collapsed again at the end.
      if (isWhitespace(ch)) {
        out.push(' ');
        pos++;
        continue;
      }

      // Comments.
      if (ch === '/' && next === '/') {
        while (pos < len && at() !== '\n' && at() !== '\r') pos++;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = src.indexOf('*/', pos + 2);
        pos = end === -1 ? len : end + 2;
        out.push(' ');
        continue;
      }
      if (ch === '#' && next === '!' && pos === 0) {
        while (pos < len && at() !== '\n' && at() !== '\r') pos++;
        continue;
      }

      // Strings.
      if (ch === '"' || ch === "'") {
        scanString(ch);
        out.push('"S"');
        last = 'string';
        continue;
      }
      if (ch === '`') {
        out.push(scanTemplate());
        last = 'string';
        continue;
      }

      // Numbers.
      if (isDigit(ch) || (ch === '.' && isDigit(next))) {
        scanNumber();
        out.push('0');
        last = 'number';
        continue;
      }

      // Identifiers and keywords (private names and unicode escapes included).
      if (isIdentStart(ch)) {
        const start = pos;
        pos++;
        while (pos < len && isIdentPart(at())) pos++;
        const word = src.slice(start, pos);
        out.push(word);
        last = KEYWORDS_BEFORE_EXPRESSION.has(word) ? 'keyword' : 'ident';
        continue;
      }

      // Regex literals.
      if (ch === '/' && regexAllowed() && scanRegex()) {
        out.push('/R/');
        last = 'string';
        continue;
      }

      // Template expression end.
      if (inTemplateExpression && ch === '}') {
        if (braceDepth === 0) {
          pos++;
          return out.join('');
        }
        braceDepth--;
      } else if (inTemplateExpression && ch === '{') {
        braceDepth++;
      }

      // Punctuation.
      out.push(ch);
      pos++;
      if (ch === ')') last = 'closeParen';
      else if (ch === ']') last = 'closeBracket';
      else last = 'punct';
    }
    return out.join('');
  }

  return scanCode(false).replace(/\s+/g, ' ').trim();
}

/** Hex SHA-256 of the structurally normalised source. */
export function structuralHash(source: string): string {
  return sha256(normalizeStructure(source));
}
