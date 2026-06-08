// One-command Windows build: clean -> electron-builder (dir) -> zip.
//
// electron-builder needs winCodeSign, whose archive contains macOS symlinks that
// 7-Zip can't create without the "create symbolic link" privilege (Developer Mode
// or admin). That makes electron-builder exit non-zero — but the unpacked app is
// produced anyway (signing isn't needed for a `dir` build). So we tolerate the
// error and continue to packaging as long as the .exe actually exists.
const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const exePath = path.join(dist, 'win-unpacked', "Onion's True Listener.exe");

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });

  try {
    await builder.build({
      targets: builder.Platform.WINDOWS.createTarget('dir', builder.Arch.x64),
    });
  } catch (e) {
    console.warn('\n[build] electron-builder reported an error (likely the ' +
      'winCodeSign symlink issue) — continuing if the app was produced.\n  ' + e.message + '\n');
  }

  if (!fs.existsSync(exePath)) {
    console.error('[build] dist/win-unpacked was not produced — aborting.');
    process.exit(1);
  }

  require('./make-zip.js'); // clean rename + zip via bundled 7za
}

main();
