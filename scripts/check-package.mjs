// Pre-publish guard: verifies the bundle shape and that no maintainer-specific
// paths or machine-local counts leak into the published files.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
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
  if (!client.includes('exports.apply')) throw new Error('client.js does not export apply()');
  return 'ModuleLoader bundle';
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
  const service = fs.readFileSync(path.join(root, 'lib/host/service.js'), 'utf8');
  if (!service.includes("'session-import'")) throw new Error('import state path is not namespaced under session-import');
  return 'state namespaced';
});

for (const line of checks) console.error(line);
if (failures.length > 0) {
  for (const line of failures) console.error(line);
  process.exitCode = 1;
} else {
  console.error(`pre-publish checks passed (${checks.length})`);
}
