// Pre-publish guard: verifies the bundle shape and that no maintainer-specific
// paths or machine-local counts leak into the published files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { buildClientSource } from './build-client.mjs';

const root = path.resolve(import.meta.dirname, '..');
const expectedClient = await buildClientSource().catch((error) => {
  console.error(`FAIL generated client bundle — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  return null;
});
const failures = [];
const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

check('bundle manifest', () => {
  if (typeof pkg.name !== 'string' || pkg.name === '') throw new Error('missing package name');
  if (pkg.private === true) throw new Error('package.json is still private');
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch must be ./cordis.patch.yml');
  if (pkg.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform must be web');
  return `${pkg.name}@${pkg.version}`;
});

check('required files', () => {
  for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/adding-provider.md']) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`missing ${file}`);
  }
  return 'bundle files present';
});

check('bundle patch entry', () => {
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  if (!patch.includes('session-import')) throw new Error('cordis.patch.yml does not declare the session-import row');
  if (!patch.includes(pkg.name)) throw new Error(`cordis.patch.yml does not reference package name ${pkg.name}`);
  if (/^\s*name:\s*@/m.test(patch)) throw new Error('scoped package names must be quoted in cordis.patch.yml');
  return 'patch rows reference the package';
});

check('client entry contract', () => {
  const client = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
  if (!client.includes('window.__ModuleLoader__.load')) throw new Error('client.js is not a DSH client module');

  let definition = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
      head: { appendChild() {} },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(client, sandbox);
  if (definition === null) throw new Error('factory was not registered');

  const elementStub = () => ({ type: 'div', props: {} });
  const react = {
    createElement: elementStub,
    Fragment: 'Fragment',
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  };
  const primitives = new Proxy({}, { get: () => elementStub });
  const exportsObj = definition.factory((name) => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: elementStub, jsxs: elementStub };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected platform module: ${name}`);
  });
  for (const key of ['NS', 'PANEL_ID', 'inject', 'apply']) {
    if (exportsObj[key] === undefined) throw new Error(`missing export ${key}`);
  }
  if (typeof exportsObj.apply !== 'function') throw new Error('apply is not a function');
  return 'factory exports NS/PANEL_ID/inject/apply';
});

check('generated client bundle is up to date', () => {
  if (expectedClient === null) throw new Error('client bundle build failed');
  const expected = expectedClient;
  const actual = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
  // Git on Windows may check out CRLF; compare line endings normalized.
  const normalizedActual = actual.replace(/\r\n/g, '\n');
  const normalizedExpected = expected.replace(/\r\n/g, '\n');
  if (normalizedActual !== normalizedExpected) throw new Error('lib/client.js is stale; run `npm run build:client`');
  return 'src/client matches lib/client.js';
});

check('host and client sources parse', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(root, 'lib'));
  walk(path.join(root, 'scripts'));
  for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  return `${files.length} files`;
});

check('readme screenshot exists', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const match = readme.match(/\(docs\/screenshots\/([^)]+)\)/);
  if (match === null) throw new Error('README does not reference docs/screenshots');
  if (!fs.existsSync(path.join(root, 'docs/screenshots', match[1]))) throw new Error(`missing docs/screenshots/${match[1]}`);
  return match[1];
});

check('no leftover TODO/FIXME markers', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(md|js|json|yml)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, 'lib'));
  walk(path.join(root, 'src'));
  walk(path.join(root, 'docs'));
  const offenders = files.filter((file) => /\b(TODO|FIXME|XXX)\b/.test(fs.readFileSync(file, 'utf8')));
  if (offenders.length > 0) throw new Error(`markers in ${offenders.map((f) => path.relative(root, f)).join(', ')}`);
  return `${files.length} files clean`;
});

check('no machine-specific paths in published files', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (/\.(md|js|json|yml)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  const offenders = [];
  for (const file of files) {
    // The guard's own source contains the pattern, so skip it.
    if (path.basename(file) === 'check-package.mjs') continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/(?:^|[\s"'(=])\/(?:Users|home)\/[A-Za-z0-9._-]+/.test(text)) offenders.push(path.relative(root, file));
  }
  if (offenders.length > 0) throw new Error(`absolute user paths in ${offenders.join(', ')}`);
  return `${files.length} files clean`;
});

check('import state directory naming', () => {
  const state = fs.readFileSync(path.join(root, 'lib/host/state.js'), 'utf8');
  if (!state.includes("'session-import'") || !state.includes('imported.json')) {
    throw new Error('import state path is not namespaced under session-import/imported.json');
  }
  return 'state namespaced';
});

for (const line of checks) console.error(line);
if (failures.length > 0) {
  for (const line of failures) console.error(line);
  process.exitCode = 1;
} else {
  console.error(`pre-publish checks passed (${checks.length})`);
}
