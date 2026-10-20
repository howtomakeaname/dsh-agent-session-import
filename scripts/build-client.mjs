// Bundles src/client/ (real ES modules) into the single lazy-CJS module that
// dsh-client-modules serves. Run `npm run build:client` after editing sources.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.join(root, 'src/client/index.js');
const target = path.join(root, 'lib/client.js');

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
];

/**
 * Bundle the browser half into the file whose script tag registers the plugin
 * factory. Platform modules stay external and resolve through the `require`
 * argument that the loader hands to the factory.
 * @returns the generated `lib/client.js` content.
 */
export async function buildClientSource() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    logLevel: 'silent',
    legalComments: 'none',
  });
  const code = result.outputFiles[0].text;

  const banner = `/**
 * Browser half of dsh-agent-session-import.
 *
 * GENERATED FILE — edit src/client/*.js and run \`npm run build:client\`.
 *
 * Running this script only registers a factory; the factory materializes when
 * the plugin is first imported and returns the plugin exports. Host calls go
 * through the plugin's own GET/POST routes under \`/session-import\`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-session-import',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`;

  const footer = `
    return module.exports;
  },
});
`;
  return banner + code + footer;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const source = await buildClientSource();
  fs.writeFileSync(target, source);
  console.error(`built ${path.relative(root, target)} (${(Buffer.byteLength(source) / 1024).toFixed(1)} KB)`);
}
