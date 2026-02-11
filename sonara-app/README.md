# 🎧 Sonara — PDF & EPUB Audiobook Player

A beautiful desktop audiobook app built with Electron. Reads PDF and EPUB files aloud with word-by-word highlight, saves progress to a SQLite database, and supports your full voice library.

---

## ✨ Features

- **3-panel layout** — Library left · Reader center · Controls right
- **Word-by-word highlight** — Current word glows gold, current sentence has subtle background
- **Progress saved to SQLite** — Resume exactly where you left off, even after closing
- **Full voice picker** — Search, filter by language, preview any system voice
- **PDF + EPUB support** — Spine-order EPUB parsing with chapter detection
- **Optional Claude AI** — Smooth narration cleanup via Anthropic API
- **Speed + Pitch control** — 0.75× to 2.5× speed
- **Waveform visualizer** — Animated in the player bar

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 18+** — https://nodejs.org
- **npm 9+** (comes with Node)

### Run in Development
```bash
# 1. Install dependencies (already done if you got this as a zip)
npm install

# 2. Start the app
npm start
```

### Build for Distribution
```bash
# Windows .exe
npm run build:win

# macOS .dmg
npm run build:mac

# Linux .AppImage
npm run build:linux

# All three platforms
npm run build:all
```
Built files appear in the `dist/` folder.

---

## 📁 Project Structure

```
sonara-app/
├── main/
│   ├── main.js          ← Electron main process, IPC handlers, window
│   └── preload.js       ← Secure context bridge (main ↔ renderer)
├── database/
│   └── db.js            ← SQLite schema + all CRUD via better-sqlite3
├── renderer/
│   ├── index.html       ← 3-panel HTML shell
│   ├── css/app.css      ← Complete stylesheet
│   └── js/
│       ├── parser.js    ← PDF.js + JSZip EPUB parser
│       ├── reader.js    ← TTS engine, word highlight, waveform
│       ├── library.js   ← Book cards, add/delete, refresh
│       └── app.js       ← Main orchestrator, Claude, init
├── assets/icons/        ← App icons (add icon.png/icns/ico here)
└── package.json
```

---

## 🗄️ Database

SQLite file lives at:
- **macOS**: `~/Library/Application Support/sonara/sonara.db`
- **Windows**: `%APPDATA%\sonara\sonara.db`
- **Linux**: `~/.config/sonara/sonara.db`

**Tables:**
| Table | Purpose |
|---|---|
| `books` | Title, format, file path, status, total chunks |
| `progress` | Per-book: chunk index, word index, elapsed seconds, % |
| `settings` | Voice, speed, pitch, font size, Claude key |

---

## 🎙️ Voice Setup

Sonara uses your system's Web Speech API voices. To get more/better voices:

- **Windows**: Settings → Time & Language → Speech → Add voices
- **macOS**: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices
- **Linux**: Install `espeak` or `festival` — `sudo apt install espeak`

---

## 🤖 Claude AI (Optional)

1. Get an API key from https://console.anthropic.com
2. Click **Claude AI** pill in the top bar
3. Paste your `sk-ant-api03-…` key
4. The first 3 chapters/pages will be narration-optimized automatically

---

## 🔨 Icons

Add your app icons to `assets/icons/`:
- `icon.png` — 512×512px PNG (Linux + fallback)
- `icon.icns` — macOS (use `iconutil` or https://cloudconvert.com)
- `icon.ico` — Windows (use https://convertico.com)

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 28 |
| Database | SQLite via better-sqlite3 |
| PDF parsing | PDF.js 3.11 (CDN, loaded on demand) |
| EPUB parsing | JSZip 3.10 (CDN, loaded on demand) |
| Text-to-speech | Web Speech API (system voices) |
| Build | electron-builder 24 |

---

## 📝 Notes

- Files you add are **copied** to the app's data folder — safe to move/delete the originals
- Cloud voices (Google, Microsoft Azure) require internet — local voices work offline
- EPUB books must be text-based — scanned/image EPUBs are not supported
- The Claude API key is stored in your local SQLite DB — never sent anywhere except Anthropic's API
