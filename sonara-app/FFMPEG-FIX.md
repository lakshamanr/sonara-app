# Fix: M4B Bulk Export — FFmpeg ENOENT in Packaged App

## Problem

When running the packaged Electron app, bulk M4B conversion failed with:

```
Error: Error invoking remote method 'export:packageM4B':
Error: spawn C:\Users\User\AppData\Local\Programs\Sonara\resources\app\static\ffmpeg.exe ENOENT
```

Both `export:packageM4B` and `export:reencodeToM4B` IPC handlers were affected, causing the entire bulk export queue to fail for all books.

## Root Cause

`require('ffmpeg-static')` returns a virtual path **inside** the `.asar` archive:

```
resources\app.asar\node_modules\ffmpeg-static\ffmpeg.exe
```

`fs.existsSync()` passes because Electron patches the `fs` module to resolve asar paths. However, `child_process.spawn()` bypasses Electron's asar patching and tries to access the raw path on disk — which does not exist. This results in `ENOENT`.

The `ffmpeg-static` package is correctly listed in `asarUnpack` in `package.json`, so the real binary **is** available at:

```
resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe
```

It just wasn't being reached because the path wasn't being rewritten.

## Fix

**File:** `main/main.js`

Added a shared helper function `_resolveFfmpegPath()` that:

1. Gets the raw path from `require('ffmpeg-static')`
2. If the path contains `app.asar\`, rewrites it to `app.asar.unpacked\` so `spawn()` gets the real on-disk path
3. Falls back to constructing the path directly from `process.resourcesPath` if the rewritten path still doesn't exist (handles edge cases in older installs)
4. Throws a clear error with the attempted path if the binary is genuinely missing

```js
function _resolveFfmpegPath() {
  let p;
  try { p = require('ffmpeg-static'); } catch (e) { p = null; }
  // Fix for asar: replace virtual 'app.asar/' with 'app.asar.unpacked/'
  if (p && p.includes('app.asar' + path.sep)) {
    p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  }
  // Fallback: build path from resourcesPath (works in packaged app)
  if (!p || !fs.existsSync(p)) {
    const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    p = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', bin);
  }
  if (!fs.existsSync(p)) throw new Error('FFmpeg binary not found at: ' + p);
  return p;
}
```

Both handlers now call this helper instead of calling `require('ffmpeg-static')` directly:

```js
// Before
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  throw new Error('ffmpeg-static not installed');
}
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  throw new Error('FFmpeg binary not found');
}

// After
const ffmpegPath = _resolveFfmpegPath();
```

## Tests

Four unit tests were run against the fix:

| # | Test | Result |
|---|------|--------|
| 1 | `_resolveFfmpegPath()` resolves without error | PASS |
| 2 | Resolved binary exists on disk | PASS |
| 3 | `spawn(ffmpegPath, ['-version'])` executes successfully (ffmpeg v6.1.1) | PASS |
| 4 | Asar path rewrite logic (`app.asar\` → `app.asar.unpacked\`) is correct | PASS |

## Files Changed

| File | Change |
|------|--------|
| `main/main.js` | Added `_resolveFfmpegPath()` helper; updated `export:packageM4B` and `export:reencodeToM4B` handlers to use it |
