# Sonara — Audiobook & eBook Player for Windows

> Read more, retain more. A beautiful offline-first desktop app for PDF, EPUB and audiobook lovers.

---

## ✨ What Sonara Does

Sonara is a professional-grade desktop reading + listening app that puts your entire book collection — eBooks **and** audiobooks — in one gorgeous library. Import a file, hit play, and Sonara handles the rest.

---

## 🚀 Features at a Glance

### 📚 Unified Library
- Import **PDF · EPUB · MOBI · AZW3 · MP3 · M4A · M4B** — all formats, one library
- **Format grouping** — same book in PDF + audio shows as a single stacked card; pick your version on the fly
- **Auto-classify** — one click sorts every book into genre collections (Sci-Fi, History, Romance …) via Claude AI
- **Cover art** — embedded art extracted automatically from MP3/M4B; drag-drop or browse to set any image

### 🎧 Audiobook Player
- Play / pause, previous / next chapter, seek bar, variable speed (0.5× – 3×)
- **Mini Player** — compact floating overlay, always on top while you work
- System **tray** with playback controls and current track info

### 📖 eBook Reader
- Smooth paginated reader for PDF and EPUB/MOBI
- **PDF text highlighting** with persistent, colour-coded highlights
- Font size, line spacing and three themes: Black · White · Blue
- **AI chat** — ask Claude AI questions about any chapter (BYOK)
- **Text-to-Speech** — Microsoft neural voices read any section aloud; configurable skip-chars/words

### 🗂️ Collections & Notes
- Colour-coded collections; auto-classify populates them instantly
- Per-book reading progress + chapter position saved automatically
- Notes panel tied to each book; exportable as text

### ☁️ Sync & Backup
- **One-folder backup** — everything lives in `Sonara-Data/`; copy it anywhere
- Move the database into Dropbox / OneDrive / Google Drive for automatic sync
- **Turso cloud sync** — live SQLite replication (free tier available)
- Full JSON export / import

---

## 🖥️ System Requirements

| | Minimum |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| RAM | 4 GB |
| Disk | 250 MB free |
| Internet | Only needed for AI features & TTS voice download |

---

## 📦 Installation

### Option A — Installer *(recommended)*
1. Download **`Sonara-Setup-2.0.0.exe`**
2. Run it, choose your install folder
3. A desktop shortcut and Start Menu entry are created automatically

### Option B — Portable
1. Download **`Sonara-Portable-2.0.0.exe`**
2. Double-click to run — no installation, no admin rights needed
3. Works from a USB drive

---

## 🗂️ Where Your Data Lives

```
%AppData%\Sonara\Sonara-Data\
  books\              ← imported book & audio files
  covers\             ← cover images
  sonara.db           ← SQLite database (all progress, notes, collections)
  sonara-config.json  ← settings
```

Open it instantly: **Settings → Data Folder → Open Folder**

---

## 🛠️ Building from Source

**Requirements:** Node.js 18+, Windows

```bash
git clone https://github.com/your-org/sonara.git
cd sonara
npm install

# Development (hot-reloads on file change)
npm start

# Production build — creates installer + portable in dist/
npm run build:win
```

---

## 🧩 Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 28 |
| Database | better-sqlite3 (SQLite) |
| TTS | Edge-TTS (Microsoft neural voices) |
| AI | Claude API (Anthropic) |
| PDF rendering | PDF.js |
| EPUB / MOBI | Custom renderer + mobi-parser |

---

## 📋 Changelog

### v2.0.0 *(current)*
- Audiobook cover extraction (ID3v2 MP3 + MP4 M4B atoms)
- Format grouping — PDF + audio stacked into one library card
- **Classify All** — one-click genre auto-classification for entire library
- Unified `Sonara-Data/` folder for easy backup
- Mini Player floating overlay
- Turso cloud sync
- Tray crash fix on quit

### v1.0.0
- Initial release: PDF + EPUB reader, TTS, highlights, progress sync

---

## 📄 License

MIT © 2025 Sonara
