# Changelog

All notable changes to Sonara will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-03-05

### 🎉 New Features

#### System Tray
- Sonara now lives in the system tray — close the window without quitting the app
- Tray context menu: Play/Pause, Previous, Next, Show/Hide, Mini Player, Quit
- Tray menu updates live with current book title and play/pause state

#### Mini Floating Player
- 340×100px always-on-top frameless window (toggle via player bar or tray menu)
- Shows book title, chapter, progress bar, and Prev/Play-Pause/Next controls
- Drag anywhere on the top bar to reposition; close or open main window from it
- Spawns at bottom-right corner of screen; stays in sync with main window in real time

#### Pin / Always-on-Top
- New pin button in the player bar keeps the main window above all other windows
- Accent-coloured when active; persists until manually toggled off

#### Kindle Support (MOBI / AZW3)
- Open `.mobi` and `.azw3` Kindle files directly — no conversion needed
- PalmDOC LZ77 decompression for MOBI6; KF8/AZW3 HTML extraction
- DRM detection with a friendly error message
- Chapter detection, natural text chunking (~5 500 chars), same reader as EPUB

#### Reader Display Settings
- Font family picker: Serif · Sans · Georgia · Mono (segmented button group)
- Font size slider: 14–32 px (default 17 px)
- Line spacing slider: 1.4–2.8 (default 2.0)
- Reading width slider: 480–900 px (default 680 px)
- All settings persist across sessions via the settings database

#### Smart Auto-Classify
- Heuristics-first genre detection (title keywords) — instant, no network needed
- Falls back to Open Library API then Google Books API
- Up to 2 genre collections created and coloured automatically per book

#### Delete Collection Modal
- Dedicated modal confirms deletion, shows book count, and reassures books are kept

### 🐛 Bug Fixes
- Fixed `_pushPlayerState` missing definition causing all books to fail to load after tray feature commit
- Fixed mini player `ready-to-show` race condition (window never appeared on first open)
- Fixed unclickable close/open buttons in mini player (missing `no-drag` on corner button container)
- Fixed stale/empty book title in mini player (state pushed before `pbMetaTitle` was set)

---

## [2.0.0] - 2025-02-12

### 🎉 Major Features Added

#### PDF Highlighting System
- **Manual Text Selection**: Select and highlight text in PDF documents
- **5 Highlight Colors**: Yellow, Green, Blue, Pink, and Orange highlighters
- **Persistent Storage**: Highlights are saved per book and persist across sessions
- **Visual Toolbar**: Beautiful floating toolbar with color picker
- **Delete Function**: Remove highlights with one click
- **On-Page Rendering**: Highlights render directly on PDF pages
- **Touch-Optimized**: Works great on touch devices with proper target sizes

#### Comprehensive Responsive Design
- **8 Breakpoints**: Optimized for all screen sizes from 320px to 4K displays
- **Mobile-First**: Full mobile support with touch optimizations
- **Adaptive Layouts**: 3-panel desktop → stacked mobile layouts
- **Theme-Compatible**: Works across all themes (Black, White, Blue)
- **Smart Panels**: Auto-hiding non-essential sections on small screens
- **Touch Targets**: 44px minimum for Apple HIG compliance
- **Viewport Fixes**: iOS Safari toolbar height handling
- **Orientation Support**: Adapts to portrait/landscape rotation
- **Print Styles**: Professional print stylesheet for books

### 🔧 Technical Improvements
- **Production Build**: Optimized build configuration with compression
- **ASAR Packaging**: Improved security and load times
- **File Exclusions**: Smaller build size with smart file filtering
- **Cross-Platform**: Better Windows, macOS, and Linux support
- **Version Bump**: Updated to 2.0.0 reflecting major feature additions

### 📱 Responsive Breakpoints
- **>1600px**: Extra large desktop - spacious layout
- **1200-1600px**: Standard desktop - optimal experience
- **960-1200px**: Laptop/small desktop - compact layout
- **768-960px**: Tablet landscape - reduced panels
- **600-768px**: Tablet portrait - vertical stack
- **480-600px**: Mobile landscape - ultra-compact
- **360-480px**: Mobile portrait - full mobile
- **<360px**: Extra small - minimal layout

### 🎨 UI Enhancements
- **Mobile Voice Modal**: Voice selector opens in full modal on mobile
- **Compact Chapter Lists**: Optimized spacing for all screen sizes
- **Adaptive Font Sizes**: Text scales appropriately per device
- **Touch Optimization**: No hover effects on touch devices
- **Smooth Transitions**: Animated breakpoint changes

### 🐛 Bug Fixes
- Fixed UI cramping on small screens
- Fixed chapter/section panel height issues
- Fixed touch target sizes for mobile accessibility
- Fixed viewport height on iOS Safari

### 🔐 Security
- Improved ASAR packaging
- Better file permissions handling
- Cleaned up build artifacts

### 📚 Documentation
- Added comprehensive build instructions
- Documented all responsive features
- Created this changelog

## [1.0.0] - Initial Release

### Features
- PDF and EPUB support
- Text-to-speech with Microsoft Neural TTS
- Library management with collections
- Progress tracking and bookmarks
- Multi-voice support (300+ voices)
- Speed and pitch controls
- Chapter navigation
- Claude AI text enhancement
- Dark/light/blue themes
- Waveform visualization

---

## Version Numbering

- **Major (X.0.0)**: Breaking changes or major feature additions
- **Minor (0.X.0)**: New features, backwards compatible
- **Patch (0.0.X)**: Bug fixes, minor improvements
