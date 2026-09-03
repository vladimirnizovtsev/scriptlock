/**
 * SHA-256 helpers for the identity module.
 *
 * Owns: hex SHA-256 over the UTF-8 encoding of a string, the same over raw
 * bytes (WebAssembly bytecode), plus a prefix helper used by identity
 * derivation. Limitation: `sha256` always treats its input as text; use
 * `sha256Bytes` for binary payloads.
 */
import { createHash } from 'node:crypto';

/** Hex SHA-256 over the UTF-8 bytes of `text`. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hex SHA-256 over raw bytes. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** First `length` hex characters of the SHA-256 of `text` (default 16). */
export function sha256Prefix(text: string, length = 16): string {
  return sha256(text).slice(0, length);
}

/** Length of `text` in UTF-8 bytes. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
