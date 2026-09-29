/**
 * Guard test: this project must never write to the live user's config during
 * development/test: ~/.dsh, ~/.config/niri, ~/.config/systemd or the running
 * dsh-web.service. We scan executable code for suspicious write/systemd
 * paths and assert the acceptance smoke itself redirects every persistent
 * directory to a mkdtemp tree (the positive runtime proof is the smoke test,
 * which records the child's DSH_HOME from /proc/<pid>/environ).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

const PROD_FILES = [
  ...listFiles(path.join(PROJECT_ROOT, 'src')),
  ...listFiles(path.join(PROJECT_ROOT, 'scripts')),
].filter((file) => file.endsWith('.js'));
const CODE_FILES = [
  ...PROD_FILES,
  ...listFiles(path.join(PROJECT_ROOT, 'test')),
].filter((file) => file.endsWith('.js'));

test('executable code never names live systemd/niri write targets', () => {
  for (const file of PROD_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(PROJECT_ROOT, file);
    assert.doesNotMatch(source, /\.config\/systemd/, `${relative} references ~/.config/systemd`);
    assert.doesNotMatch(source, /dsh-web\.service/, `${relative} references dsh-web.service`);
    assert.doesNotMatch(source, /\bsystemctl\b/, `${relative} references systemctl`);
    assert.doesNotMatch(source, /\.config\/niri/, `${relative} references ~/.config/niri`);
    assert.doesNotMatch(source, /\bniri\s+msg\b/, `${relative} shells out to niri`);
    assert.doesNotMatch(source, /\bpkill\b|\bkillall\b/, `${relative} may kill unrelated processes`);
  }
});

test('dshHome is only spawned with DSH_HOME, never used as a filesystem write root', () => {
  const offenders = [];
  for (const file of CODE_FILES) {
    if (file.endsWith('no-live-writes.test.js')) continue; // the guard itself mentions dshHome paths
    // v02-e2e embeds FAKE runtime scripts that write to an injected temp DSH_HOME.
    if (file.endsWith('v02-e2e.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(PROJECT_ROOT, file);
    // Any fs write/mkdir/rename/unlink/rm whose inline text mentions dshHome:
    const pattern = /fs\.\w*(?:writeFile|appendFile|mkdir|rename|unlink|rm|open)\w*\([^;\n]*dshHome/gi;
    if (pattern.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders, []);

  // No JS file anywhere may pass a literal ~/.dsh path to an fs write call.
  const directWriteOffenders = [];
  for (const file of CODE_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    const directWrite = /(?:writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync|rmSync|writeFile|appendFile|mkdir|rename|unlink|rm)\([^;\n]*['"][^'"]*\.dsh/;
    if (directWrite.test(source)) directWriteOffenders.push(path.relative(PROJECT_ROOT, file));
  }
  assert.deepEqual(directWriteOffenders, []);

  // The runtime passes DSH_HOME through the child environment (managed mode).
  const mainSource = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'main.js'), 'utf8');
  assert.match(mainSource, /env:\s*\{\s*\.\.\.process\.env,\s*DSH_HOME:\s*config\.dshHome\s*\}/);
});

test('acceptance smoke redirects HOME, DSH_HOME, userData and all XDG dirs to mkdtemp', () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'test', 'acceptance', 'smoke-lib.js'), 'utf8');
  assert.match(source, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'dsh-electron-acceptance-'\)\)/);
  assert.match(source, /HOME:\s*dirs\.home/);
  assert.match(source, /DSH_ELECTRON_HOME:\s*dshHome/);
  assert.match(source, /DSH_ELECTRON_USER_DATA:\s*dirs\.userData/);
  assert.match(source, /XDG_CONFIG_HOME:\s*dirs\.config/);
  assert.match(source, /XDG_CACHE_HOME:\s*dirs\.cache/);
  assert.match(source, /XDG_DATA_HOME:\s*dirs\.data/);
  assert.match(source, /DSH_ELECTRON_SMOKE:\s*snapshotPath/);
  // No acceptance file may point a test at the live home.
  const acceptanceFiles = listFiles(path.join(PROJECT_ROOT, 'test', 'acceptance'));
  for (const file of acceptanceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\/home\/Arch\/\.dsh/, `${path.basename(file)} references the live DSH home`);
    assert.doesNotMatch(text, /\/home\/Arch\/\.config\/(?:niri|systemd)/, `${path.basename(file)} references live config`);
  }
});

test('package.json scripts never invoke systemd or the live service', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const scripts = Object.values(pkg.scripts || {}).join(' ');
  assert.doesNotMatch(scripts, /systemctl|dsh-web\.service|\.config\/niri/);
});

test('niri packaging artifact is documentation/rule only, not an installer hook', () => {
  const rule = fs.readFileSync(path.join(PROJECT_ROOT, 'packaging', 'niri-window-rule.kdl'), 'utf8');
  assert.doesNotMatch(rule, /systemctl/);
  assert.doesNotMatch(rule, /spawn-at-startup/);
  // It is intended to be pasted manually; keep it a static window-rule snippet.
  assert.match(rule, /window-rule\s*\{/);
  // ...and it is not part of the packaged app payload, so install cannot apply it.
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const packaged = (pkg.build && Array.isArray(pkg.build.files)) ? pkg.build.files.join(' ') : '';
  assert.doesNotMatch(packaged, /packaging/);
});
