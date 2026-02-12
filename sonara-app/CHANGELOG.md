# Changelog

All notable changes to Sonara will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
