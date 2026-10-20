/**
 * Import-provider registry.
 *
 * Adding a new third-party agent source means dropping one module next to this
 * file that exports `{ id, label, description, status(), list(), load(id) }`
 * and appending its entry to `PROVIDER_ORDER` below. The sidebar panel then
 * lists it automatically — the rest of the import pipeline is source-agnostic.
 */
import * as cursor from './cursor.js';

/**
 * Display order of the sources. `cursor` ships with the package; every other
 * entry is imported lazily, so a missing module only removes that source and
 * never breaks the plugin.
 */
const PROVIDER_ORDER = [
  { id: 'codex', module: './codex.js' },
  { id: 'claude-code', module: './claude-code.js' },
  { id: 'cursor', module: cursor },
  { id: 'zcode', module: './zcode.js' },
  { id: 'kimi', module: './kimi.js' },
];

/** Resolved provider list (module load is idempotent). */
let resolved = null;

/**
 * Resolve every available provider module.
 * @returns provider modules in display order.
 */
export async function providers() {
  if (resolved !== null) return resolved;
  const list = [];
  for (const entry of PROVIDER_ORDER) {
    try {
      const module = typeof entry.module === 'string' ? await import(entry.module) : entry.module;
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
