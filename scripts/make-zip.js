// Zip dist/win-unpacked into a release archive with a clean top-level folder.
// electron-builder's own zip/nsis target needs winCodeSign (fails without
// Developer Mode), so we package the unpacked app ourselves with bundled 7za.
//   usage: npm run dist   (builds dist/win-unpacked)
//          npm run zip     (this script)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sevenZip = require('7zip-bin').path7za;
const pkg = require('../package.json');

const dist = path.join(__dirname, '..', 'dist');
const unpacked = path.join(dist, 'win-unpacked');
if (!fs.existsSync(unpacked)) {
  console.error('dist/win-unpacked not found — run "npm run dist" first.');
  process.exit(1);
}

// Give the zip a nice top-level folder instead of "win-unpacked".
const folder = path.join(dist, 'onions-true-listener');
fs.rmSync(folder, { recursive: true, force: true });
fs.renameSync(unpacked, folder);

const out = path.join(dist, `onions-true-listener-${pkg.version}-win-x64.zip`);
fs.rmSync(out, { force: true });
execFileSync(sevenZip, ['a', '-tzip', '-mx=5', out, folder], { stdio: 'inherit' });

console.log('\nCreated', out);
