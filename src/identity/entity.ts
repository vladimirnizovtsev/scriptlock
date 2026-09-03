/**
 * Third-party entity lookup backed by the bundled third-party-web dataset.
 *
 * Owns: `lookupEntity(url)` returning the entity name and category for a
 * script URL, or undefined when the host is unknown, first party, or the
 * input is not a URL. The dataset ships with the package; no network access.
 *
 * Limitations: third-party-web is a CommonJS module and is imported through
 * its default export. Lookup is by host only; the category is the dataset's
 * own label (for example "tag-manager", "analytics", "utility") and is not
 * mapped onto Tessera's ScriptCategory.
 */
import thirdPartyWeb from 'third-party-web';
import type { ScriptEntity } from '../types.js';

export function lookupEntity(url: string): ScriptEntity | undefined {
  try {
    const entity = thirdPartyWeb.getEntity(url);
    if (!entity || typeof entity.name !== 'string') return undefined;
    return { name: entity.name, category: typeof entity.category === 'string' ? entity.category : 'other' };
  } catch {
    return undefined;
  }
}
