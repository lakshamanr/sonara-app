'use strict';
const path = require('path');
const fs   = require('fs');
const { execFile } = require('child_process');
const https = require('https');
const http  = require('http');

// ?????????????????????????????????????????????????????????????
//  FFMPEG HELPER
//  Downloads a static ffmpeg binary if not already present,
//  and provides helpers to run ffmpeg commands.
// ?????????????????????????????????????????????????????????????

// Platform-specific download URLs for static ffmpeg builds
const FFMPEG_URLS = {
  win32:  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  darwin: 'https://evermeet.cx/ffmpeg/getrelease/zip',
  linux:  'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
};

let _ffmpegDir  = null; // directory where ffmpeg is stored
let _ffmpegPath = null; // full path to the ffmpeg binary

/**
 * Initialise the helper — sets the directory where ffmpeg will be stored.
 * Call this once from main.js during app bootstrap.
 * @param {string} userDataDir - app.getPath('userData')
 */
function init(userDataDir) {
  _ffmpegDir = path.join(userDataDir, 'ffmpeg');
  fs.mkdirSync(_ffmpegDir, { recursive: true });

  const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  _ffmpegPath = path.join(_ffmpegDir, bin);
}

/** @returns {string|null} Full path to ffmpeg binary, or null if not available */
function getPath() {
  // 1. Check our managed copy
  if (_ffmpegPath && fs.existsSync(_ffmpegPath)) return _ffmpegPath;

  // 2. Check system PATH
  const systemBin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const pathDirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of pathDirs) {
    const candidate = path.join(dir, systemBin);
    try {
      if (fs.existsSync(candidate)) {
        _ffmpegPath = candidate;
        return candidate;
      }
    } catch {}
  }

  return null;
}

/** @returns {boolean} Whether ffmpeg is ready to use */
function isAvailable() {
  return !!getPath();
}

/**
 * Download ffmpeg if not already present.
 * @param {function} [onProgress] - callback(percent: number, status: string)
 * @returns {Promise<string>} path to ffmpeg binary
 */
async function ensureAvailable(onProgress) {
  const existing = getPath();
  if (existing) {
    if (onProgress) onProgress(100, 'ffmpeg ready');
    return existing;
  }

  if (onProgress) onProgress(0, 'Downloading ffmpeg…');

  const platform = process.platform;
  const url = FFMPEG_URLS[platform];
  if (!url) throw new Error('No ffmpeg download available for platform: ' + platform);

  const tmpDir = path.join(_ffmpegDir, '_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    if (platform === 'win32') {
      await _downloadAndExtractWin(url, tmpDir, onProgress);
    } else if (platform === 'darwin') {
      await _downloadAndExtractMac(url, tmpDir, onProgress);
    } else {
      await _downloadAndExtractLinux(url, tmpDir, onProgress);
    }
  } finally {
    // Clean up tmp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  if (!fs.existsSync(_ffmpegPath)) {
    throw new Error('Failed to install ffmpeg — binary not found after extraction');
  }

  // Make executable on unix
  if (platform !== 'win32') {
    try { fs.chmodSync(_ffmpegPath, 0o755); } catch {}
  }

  if (onProgress) onProgress(100, 'ffmpeg ready');
  return _ffmpegPath;
}

// ?? Download helpers ????????????????????????????????????????

function _downloadFile(url, destPath, onProgress, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers: { 'User-Agent': 'Sonara/2.0' } }, (res) => {
      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return _downloadFile(res.headers.location, destPath, onProgress, maxRedirects - 1)
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error('Download failed: HTTP ' + res.statusCode));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;

      const ws = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalBytes > 0 && onProgress) {
          const pct = Math.round((downloaded / totalBytes) * 80); // 0-80% for download
          onProgress(pct, `Downloading ffmpeg… ${Math.round(downloaded / 1024 / 1024)}MB`);
        }
      });
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

async function _downloadAndExtractWin(url, tmpDir, onProgress) {
  const zipPath = path.join(tmpDir, 'ffmpeg.zip');
  await _downloadFile(url, zipPath, onProgress);

  if (onProgress) onProgress(82, 'Extracting ffmpeg…');

  // Use Node.js to extract — look for ffmpeg.exe inside the zip
  const yauzl = (() => {
    try { return require('yauzl'); } catch { return null; }
  })();

  if (yauzl) {
    await _extractWithYauzl(yauzl, zipPath);
  } else {
    // Fallback: use PowerShell to extract
    await _runCommand('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`
    ]);

    // Find ffmpeg.exe recursively
    const found = _findFileRecursive(tmpDir, 'ffmpeg.exe');
    if (found) {
      fs.copyFileSync(found, _ffmpegPath);
    }
  }

  if (onProgress) onProgress(95, 'Finalising…');
}

async function _downloadAndExtractMac(url, tmpDir, onProgress) {
  const zipPath = path.join(tmpDir, 'ffmpeg.zip');
  await _downloadFile(url, zipPath, onProgress);

  if (onProgress) onProgress(82, 'Extracting ffmpeg…');

  await _runCommand('unzip', ['-o', zipPath, '-d', tmpDir]);
  const found = _findFileRecursive(tmpDir, 'ffmpeg');
  if (found) fs.copyFileSync(found, _ffmpegPath);

  if (onProgress) onProgress(95, 'Finalising…');
}

async function _downloadAndExtractLinux(url, tmpDir, onProgress) {
  const tarPath = path.join(tmpDir, 'ffmpeg.tar.xz');
  await _downloadFile(url, tarPath, onProgress);

  if (onProgress) onProgress(82, 'Extracting ffmpeg…');

  await _runCommand('tar', ['-xf', tarPath, '-C', tmpDir]);
  const found = _findFileRecursive(tmpDir, 'ffmpeg');
  if (found && !found.endsWith('.xz')) fs.copyFileSync(found, _ffmpegPath);

  if (onProgress) onProgress(95, 'Finalising…');
}

function _extractWithYauzl(yauzl, zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = path.basename(entry.fileName);
        if (name === 'ffmpeg.exe' || name === 'ffmpeg') {
          zipfile.openReadStream(entry, (err2, readStream) => {
            if (err2) return reject(err2);
            const ws = fs.createWriteStream(_ffmpegPath);
            readStream.pipe(ws);
            ws.on('finish', () => { ws.close(); resolve(); });
            ws.on('error', reject);
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });
}

function _findFileRecursive(dir, target) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === target) return full;
      if (entry.isDirectory()) {
        const found = _findFileRecursive(full, target);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function _runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/**
 * Run an ffmpeg command with the managed binary.
 * @param {string[]} args - ffmpeg arguments (without the ffmpeg binary itself)
 * @param {object}   [opts] - options
 * @param {number}   [opts.timeout] - timeout in ms (default 600000 = 10 min)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function run(args, opts) {
  const ffmpeg = getPath();
  if (!ffmpeg) return Promise.reject(new Error('ffmpeg is not available — call ensureAvailable() first'));

  const timeout = (opts && opts.timeout) || 600000;

  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Convert an MP3 file to M4B audiobook format.
 * Steps:
 *   1. Extract clean audio: ffmpeg -i input.mp3 -c:a pcm_s16le temp.wav
 *   2. Re-encode: ffmpeg -i temp.wav [-i cover.jpg] -c:a aac ... output.m4b
 *
 * @param {object} opts
 * @param {string} opts.inputPath  - source MP3 file
 * @param {string} opts.outputPath - destination .m4b file
 * @param {string} [opts.coverPath] - optional cover image (jpg/png)
 * @param {string} [opts.title]     - metadata title
 * @param {string} [opts.artist]    - metadata artist/author
 * @param {string} [opts.album]     - metadata album
 * @param {string} [opts.genre]     - metadata genre (default: Audiobook)
 * @param {function} [opts.onProgress] - callback(percent, status)
 * @returns {Promise<{success: true, outputPath: string}>}
 */
async function convertToM4B(opts) {
  const { inputPath, outputPath, coverPath, title, artist, album, genre, onProgress } = opts;

  if (!fs.existsSync(inputPath)) throw new Error('Input file not found: ' + inputPath);

  const ffmpeg = getPath();
  if (!ffmpeg) throw new Error('ffmpeg not available');

  const tmpWav = path.join(path.dirname(outputPath), '_sonara_temp_' + Date.now() + '.wav');

  try {
    // ?? Step 1: Extract clean audio to WAV ??
    if (onProgress) onProgress(5, 'Extracting clean audio…');

    await run([
      '-y', '-i', inputPath,
      '-c:a', 'pcm_s16le',
      tmpWav
    ], { timeout: 1200000 });

    if (onProgress) onProgress(40, 'Encoding audiobook…');

    // ?? Step 2: Re-encode WAV ? M4B with AAC ??
    const args = ['-y', '-i', tmpWav];

    // Add cover image if available
    const hasCover = coverPath && fs.existsSync(coverPath);
    if (hasCover) {
      args.push('-i', coverPath);
    }

    // Audio codec settings
    args.push(
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-movflags', '+faststart'
    );

    // Cover image handling
    if (hasCover) {
      args.push(
        '-c:v', 'copy',
        '-map', '0:a', '-map', '1',
        '-disposition:v', 'attached_pic'
      );
    }

    // Metadata
    if (title)  args.push('-metadata', 'title=' + title);
    if (artist) args.push('-metadata', 'artist=' + artist);
    if (album)  args.push('-metadata', 'album=' + (album || title || ''));
    args.push('-metadata', 'genre=' + (genre || 'Audiobook'));

    args.push(outputPath);

    await run(args, { timeout: 1200000 });

    if (onProgress) onProgress(95, 'Finalising…');

    if (!fs.existsSync(outputPath)) {
      throw new Error('M4B file was not created');
    }

    if (onProgress) onProgress(100, 'Done');
    return { success: true, outputPath };

  } finally {
    // Clean up temp WAV
    try { if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav); } catch {}
  }
}

module.exports = {
  init,
  getPath,
  isAvailable,
  ensureAvailable,
  run,
  convertToM4B,
};
