#!/usr/bin/env node
/**
 * Pre-flight check for the extension. Run after moving or renaming files:
 *
 *   node scripts/check-extension.js
 *
 * Chrome only reports a broken reference when the extension loads, so this
 * follows every one of them offline:
 *   1. every file named in manifest.json exists
 *   2. every <script src> / <link href> in an extension page exists
 *   3. the background worker boots: its importScripts() chain resolves (paths are
 *      relative to the worker file, as in Chrome) and defines what it should
 *   4. hardcoded file paths in the code (createDocument url, notification icon)
 *   5. every content-script group parses as one script, which catches two files
 *      declaring the same top-level name (scripts of one extension share a world)
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const problems = [];
const fail = (msg) => problems.push(msg);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
const rel = (from, to) => path.posix.normalize(path.posix.join(path.posix.dirname(from), to));

// 1. manifest
const manifestFiles = new Set();
const add = (file, why) => {
  if (!file) return;
  manifestFiles.add(file);
  if (!exists(file)) fail(`manifest: ${why} -> ${file} does not exist`);
};
add(manifest.background && manifest.background.service_worker, 'background.service_worker');
add(manifest.action && manifest.action.default_popup, 'action.default_popup');
Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((f) => add(f, 'action.default_icon'));
Object.values(manifest.icons || {}).forEach((f) => add(f, 'icons'));
(manifest.content_scripts || []).forEach((group, i) =>
  [...(group.js || []), ...(group.css || [])].forEach((f) => add(f, `content_scripts[${i}]`))
);

// 2. extension pages
const pages = [...manifestFiles].filter((f) => f.endsWith('.html'));
const walk = (dir) =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.posix.join(dir, e.name);
    return e.isDirectory() ? (['node_modules', '.git', 'supabase', 'test'].includes(e.name) ? [] : walk(p)) : [p];
  });
const allFiles = walk('.');
allFiles.filter((f) => f.endsWith('.html') && !pages.includes(f)).forEach((f) => pages.push(f));
for (const page of pages) {
  for (const [, ref] of read(page).matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"#?]+)"/g)) {
    if (/^(https?:)?\/\//.test(ref)) continue;
    if (!exists(rel(page, ref))) fail(`${page}: ${ref} does not exist`);
  }
}

// 3. background worker boot (importScripts paths are relative to the worker file)
const worker = manifest.background && manifest.background.service_worker;
if (worker && exists(worker)) {
  const noop = () => {};
  const event = { addListener: noop, removeListener: noop, hasListener: () => false };
  const chromeStub = new Proxy({}, { get: () => new Proxy(noop, { get: (_, key) => (key === 'then' ? undefined : event) }) });
  const sandbox = { chrome: chromeStub, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise, importScripts };
  const context = vm.createContext(sandbox);
  function importScripts(...files) {
    for (const file of files) {
      const target = file.startsWith('/') ? file.slice(1) : rel(worker, file);
      if (!exists(target)) {
        fail(`${worker}: importScripts('${file}') -> ${target} does not exist`);
        continue;
      }
      vm.runInContext(read(target), context, { filename: target });
    }
  }
  try {
    vm.runInContext(read(worker), context, { filename: worker });
    for (const name of ['AnswerStore', 'CloudSync']) {
      if (vm.runInContext(`typeof ${name}`, context) === 'undefined') fail(`${worker}: ${name} is not defined after boot`);
    }
  } catch (err) {
    fail(`${worker}: failed to boot: ${err.message}`);
  }
}

// 4. hardcoded extension paths in code
for (const file of allFiles.filter((f) => f.endsWith('.js'))) {
  for (const [, ref] of read(file).matchAll(/\b(?:url|iconUrl)\s*:\s*'([^']+\.(?:html|png|svg|js))'/g)) {
    if (!exists(ref.replace(/^\//, ''))) fail(`${file}: path '${ref}' (relative to the extension root) does not exist`);
  }
}

// 5. content scripts of one match pattern share a world (MAIN scripts have their own)
const worlds = {};
for (const group of manifest.content_scripts || []) {
  const key = `${(group.matches || []).join(',')}|${group.world || 'ISOLATED'}`;
  (worlds[key] = worlds[key] || []).push(...(group.js || []));
}
for (const [key, files] of Object.entries(worlds)) {
  try {
    new vm.Script(files.filter(exists).map(read).join('\n;\n'), { filename: key });
  } catch (err) {
    fail(`content scripts [${key}] do not parse together: ${err.message}`);
  }
}
for (const file of allFiles.filter((f) => f.endsWith('.js'))) {
  try {
    new vm.Script(read(file), { filename: file });
  } catch (err) {
    fail(`${file}: ${err.message}`);
  }
}

if (problems.length) {
  console.error(`check-extension: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`check-extension: ok (${manifestFiles.size} manifest files, ${pages.length} pages, ${allFiles.filter((f) => f.endsWith('.js')).length} scripts)`);
