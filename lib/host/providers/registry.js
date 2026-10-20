/**
 * Import-provider registry.
 *
 * Adding a new third-party agent source means dropping one module next to this
 * file that exports `{ id, label, description, status(), list(), load(id) }`
 * and appending its module path to `OPTIONAL_PROVIDERS`. The sidebar panel then
 * lists it automatically — the rest of the import pipeline is source-agnostic.
 */
import * as cursor from './cursor.js';

/** Providers that are always part of this build. */
const BUILTIN_PROVIDERS = [cursor];

/**
 * Provider modules that may be absent in a trimmed checkout (they are imported
 * lazily so a missing file only removes that source, never breaks the plugin).
 */
const OPTIONAL_PROVIDERS = [
  { name: 'codex', module: './codex.js' },
  { name: 'claude-code', module: './claude-code.js' },
  { name: 'zcode', module: './zcode.js' },
  { name: 'kimi', module: './kimi.js' },
];

/** Resolved provider list (module load is idempotent). */
let resolved = null;

/**
 * Resolve every available provider module.
 * @returns provider modules in display order.
 */
export async function providers() {
  if (resolved !== null) return resolved;
  const list = [...BUILTIN_PROVIDERS];
  for (const entry of OPTIONAL_PROVIDERS) {
    try {
      const module = await import(entry.module);
      if (typeof module.id === 'string' && typeof module.list === 'function' && typeof module.load === 'function') list.push(module);
    } catch {
      // Optional provider not shipped in this copy.
    }
  }
  resolved = list;
  return resolved;
}

/**
 * Look one provider up by id.
 * @param id - provider id.
 * @returns the provider module, or undefined.
 */
export async function providerById(id) {
  const list = await providers();
  return list.find((module) => module.id === id);
}

/** Descriptor text used by the sidebar panel's source tabs. */
export async function providerLabels() {
  const list = await providers();
  return list.map((module) => ({
    id: module.id,
    label: typeof module.label === 'string' ? module.label : module.id,
    description: typeof module.description === 'string' ? module.description : '',
  }));
}
