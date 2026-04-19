/**
 * retag-m4b.js
 * ─────────────────────────────────────────────────────────────
 * Re-encodes all existing .m4b files in the Sonara books directory
 * to 128k AAC and writes correct metadata (title, artist, album,
 * album_artist, genre) so they play correctly in Apple Books / iPhone.
 *
 * Reads title/artist from the file's existing embedded metadata
 * (no native modules needed — works with any Node.js version).
 *
 * Usage (run from the sonara-app folder):
 *   node retag-m4b.js
 *
 * Optional — point to a specific books folder:
 *   node retag-m4b.js --books "C:\path\to\books"
 *
 * Dry-run (preview without changing files):
 *   node retag-m4b.js --dry-run
 */

'use strict';

const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { spawnSync } = require('child_process');

// ── Resolve ffmpeg (same logic as main.js) ─────────────────────
function resolveFfmpeg() {
  let p;
  try { p = require('ffmpeg-static'); } catch (_) { p = null; }
  if (p && p.includes('app.asar' + path.sep))
    p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  if (!p || !fs.existsSync(p)) {
    const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    p = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', bin);
  }
  if (!fs.existsSync(p)) throw new Error('ffmpeg not found. Make sure npm deps are installed.');
  return p;
}

// ── Read existing metadata from an M4B using ffmpeg stderr ─────
function probeMetadata(ffmpeg, filePath) {
  const result = spawnSync(ffmpeg, ['-i', filePath], { encoding: 'utf8', windowsHide: true });
  // ffmpeg writes file info to stderr even on "error" (no output given)
  const output = result.stderr || '';
  const meta   = {};
  const metaBlock = output.match(/Metadata:([\s\S]*?)(?:\n\s{0,2}[A-Z]|Duration:)/);
  if (metaBlock) {
    for (const line of metaBlock[1].split('\n')) {
      const m = line.match(/^\s{4}(\w+)\s*:\s*(.+)$/);
      if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  return meta;
}

// ── Parse CLI args ─────────────────────────────────────────────
const cliArgs = process.argv.slice(2);
function getArg(name) {
  const i = cliArgs.indexOf(name);
  return i !== -1 ? cliArgs[i + 1] : null;
}
const DRY_RUN = cliArgs.includes('--dry-run');

// ── Default paths ──────────────────────────────────────────────
const appData  = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dataDir  = path.join(appData, 'Sonara', 'Sonara-Data');
const booksDir = getArg('--books') || path.join(dataDir, 'books');

console.log('');
console.log('══════════════════════════════════════════');
console.log('  Sonara M4B Retagger');
if (DRY_RUN) console.log('  MODE: DRY RUN (no files will be changed)');
console.log('══════════════════════════════════════════');
console.log('  Books dir:', booksDir);
console.log('');

if (!fs.existsSync(booksDir)) {
  console.error('ERROR: Books directory not found at:', booksDir);
  console.error('Use --books "path/to/books" to specify a custom location.');
  process.exit(1);
}

// ── Find all .m4b files on disk ────────────────────────────────
const m4bFiles = fs.readdirSync(booksDir)
  .filter(f => f.toLowerCase().endsWith('.m4b'))
  .map(f => path.join(booksDir, f));

console.log(`Found ${m4bFiles.length} .m4b file(s) in books directory.\n`);

if (!m4bFiles.length) {
  console.log('Nothing to retag. Export some books first.');
  process.exit(0);
}

const ffmpeg = resolveFfmpeg();
let ok = 0, skipped = 0, failed = 0;

for (const src of m4bFiles) {
  // Read existing embedded metadata from the file
  const existing = probeMetadata(ffmpeg, src);

  const title  = existing.title  || path.basename(src, '.m4b');
  const artist = existing.artist || existing.album_artist || 'Unknown';

  // Skip if album and album_artist are already correctly set
  if (existing.album && existing.album_artist) {
    process.stdout.write(`  [${title.slice(0, 50)}] ... SKIP (already tagged)\n`);
    skipped++;
    continue;
  }

  process.stdout.write(`  [${title.slice(0, 50)}]\n`);
  console.log(`    artist="${artist}"  album="${title}"`);

  if (DRY_RUN) {
    console.log('    → dry-run, skipping write');
    ok++;
    continue;
  }

  const tmp = src + '.retag.tmp.m4b';

  const result = spawnSync(ffmpeg, [
    '-y',
    '-i',            src,
    '-c:a',          'aac', '-b:a', '128k',  // re-encode to 128k AAC (iPhone-compatible)
    '-c:v',          'copy',
    '-map_metadata', '0',      // preserve chapters + existing tags
    '-metadata',     `title=${title}`,
    '-metadata',     `artist=${artist}`,
    '-metadata',     `album=${title}`,
    '-metadata',     `album_artist=${artist}`,
    '-metadata',     'genre=Audiobook',
    '-f',            'mp4',
    tmp,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 100 * 1024 * 1024 });

  if (result.status === 0 && fs.existsSync(tmp)) {
    try {
      fs.renameSync(tmp, src);
      console.log('    → OK\n');
      ok++;
    } catch (e) {
      console.log('    → FAIL (rename error: ' + e.message + ')\n');
      try { fs.unlinkSync(tmp); } catch (_) {}
      failed++;
    }
  } else {
    console.log('    → FAIL');
    const errLines = (result.stderr || '').split('\n').filter(l => l.includes('Error') || l.includes('error')).slice(-3).join('\n');
    if (errLines) console.error('    ' + errLines);
    console.log('');
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    failed++;
  }
}

console.log('══════════════════════════════════════════');
console.log(`  Done — ${ok} retagged, ${skipped} skipped, ${failed} failed`);
console.log('══════════════════════════════════════════');
console.log('');
