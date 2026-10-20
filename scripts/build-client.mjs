// Assembles the browser half of the plugin into the single lazy-CJS module
// that dsh-client-modules serves. Edit src/client/*.js, then run `npm run build:client`.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceDir = path.join(root, 'src/client');
const target = path.join(root, 'lib/client.js');

// Explicit module order: each fragment shares the factory scope, so helpers and
// constants must be emitted before the modules that use them at load time.
const ORDER = [
  'runtime.js',
  'icons.js',
  'styles.js',
  'i18n.js',
  'utils.js',
  'components.js',
  'panel.js',
  'apply.js',
];

const parts = ORDER.filter((name) => fs.existsSync(path.join(sourceDir, name)));

if (parts.length !== ORDER.length) {
  const missing = ORDER.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
  throw new Error(`missing src/client fragments: ${missing.join(', ')}`);
}

const banner = `/**
 * Browser half of dsh-agent-session-import.
 *
 * GENERATED FILE — edit src/client/*.js and run \`npm run build:client\`.
 *
 * Running this script only registers a factory; the factory materializes when
 * the plugin is first imported and returns the plugin exports. Host calls go
 * through the plugin's own GET/POST routes under ${'`'}/session-import${'`'}.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-session-import',
  factory: (require) => {
`;

const footer = `
    return module.exports;
  },
});
`;

const body = parts
  .map((name) => fs.readFileSync(path.join(sourceDir, name), 'utf8').replace(/\n$/, ''))
  .join('\n\n');

fs.writeFileSync(target, banner + body + footer);
console.log(`built ${path.relative(root, target)} from ${parts.length} fragments (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
