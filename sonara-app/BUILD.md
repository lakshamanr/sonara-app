# Sonara - Production Build Instructions

## Version 2.0.0 - Production Release

### 📋 Pre-Build Checklist

Before building, ensure you have:

- [x] **Node.js** (v16 or higher)
- [x] **npm** (v8 or higher)
- [x] All dependencies installed (`npm install`)
- [x] Updated version number in `package.json`
- [x] Updated `CHANGELOG.md` with release notes
- [x] All changes committed to git
- [x] Code tested on target platforms

### 🚀 Quick Build Commands

#### Development Build
```bash
npm start                    # Run in development mode
npm run dev                  # Run with NODE_ENV=development
```

#### Production Builds

**Windows (Recommended)**
```bash
npm run build               # Build for Windows (NSIS installer + portable)
npm run build:win           # Windows installer only (x64)
npm run build:win:portable  # Windows portable only (x64)
```

**macOS**
```bash
npm run build:mac           # macOS DMG + ZIP (x64 + ARM64)
```

**Linux**
```bash
npm run build:linux         # AppImage + DEB + tar.gz (x64)
```

**All Platforms**
```bash
npm run build:all           # Build for Windows, macOS, and Linux
```

**Clean Build**
```bash
npm run clean               # Remove dist folder
npm run build:prod          # Clean + build Windows production
```

### 📦 Build Outputs

All builds are created in the `dist/` folder:

#### Windows
- `Sonara-Setup-2.0.0.exe` - NSIS installer (recommended)
- `Sonara-Portable-2.0.0.exe` - Portable executable
- `Sonara 2.0.0.exe` - Unpacked executable (for testing)
- Various metadata files (.blockmap, .yml)

#### macOS
- `Sonara-2.0.0.dmg` - DMG installer
- `Sonara-2.0.0-mac.zip` - ZIP archive
- Universal build (x64 + ARM64)

#### Linux
- `Sonara-2.0.0.AppImage` - AppImage (portable)
- `Sonara_2.0.0_amd64.deb` - Debian package
- `Sonara-2.0.0.tar.gz` - Compressed archive

### 🔧 Build Configuration

The build is configured in `package.json` under the `build` section:

#### Features Enabled
- ✅ **Maximum Compression** - Smallest file sizes
- ✅ **ASAR Packaging** - Single-file app archive
- ✅ **Code Signing Ready** - Prepared for signing (add certificates)
- ✅ **Auto-Updates Ready** - Configured (requires publisher setup)
- ✅ **Smart File Filtering** - Excludes dev files automatically
- ✅ **Multi-Architecture** - x64 for Windows/Linux, Universal for macOS

#### Excluded from Build
- `.claude/` - AI assistant cache
- `.git/` - Version control
- `.vscode/` - Editor settings
- `dist/` - Previous builds
- `*.map` - Source maps
- `*.md` - Documentation (except packaged)
- `*.log` - Log files
- Active database files

### 🎯 Build Optimizations

#### Performance
- **ASAR Archive**: Faster loading, smaller size
- **Maximum Compression**: ~40% size reduction
- **Smart Dependencies**: Only runtime dependencies included
- **Better-sqlite3**: Properly unpacked for native module

#### Security
- **Hardened Runtime** (macOS)
- **Code Signing Ready** (all platforms)
- **Gatekeeper Compatible** (macOS)
- **UAC Aware** (Windows)

#### User Experience
- **Installer Options**: Custom install location
- **Desktop Shortcuts**: Created automatically
- **Start Menu Integration**: Windows
- **Application Menu**: macOS
- **Launch on Install**: Optional

### 📝 Build Process Details

1. **Clean** (`npm run clean`)
   - Removes `dist/` folder
   - Ensures fresh build

2. **Install Dependencies** (`npm install`)
   - Installs production dependencies
   - Rebuilds native modules (better-sqlite3)

3. **Package** (`electron-builder`)
   - Bundles app into ASAR
   - Copies renderer files
   - Includes database schema
   - Packs node_modules

4. **Compress**
   - Maximum compression applied
   - 7-Zip used for Windows
   - DMG optimized for macOS

5. **Sign** (optional)
   - Windows: Authenticode
   - macOS: Apple Developer ID
   - Linux: GPG signatures

6. **Create Installers**
   - NSIS for Windows
   - DMG for macOS
   - DEB/AppImage for Linux

### 🔐 Code Signing (Optional but Recommended)

#### Windows
```json
"win": {
  "certificateFile": "path/to/cert.pfx",
  "certificatePassword": "password"
}
```

#### macOS
```bash
# Set environment variables
export CSC_LINK="path/to/cert.p12"
export CSC_KEY_PASSWORD="password"
export APPLE_ID="your@email.com"
export APPLE_ID_PASSWORD="app-specific-password"
```

#### Linux
```bash
# GPG signing
gpg --detach-sign --armor Sonara-2.0.0.AppImage
```

### 🧪 Testing Built Packages

#### Windows
1. Install from `Sonara-Setup-2.0.0.exe`
2. Test in `Program Files/Sonara`
3. Verify uninstall works
4. Test portable version

#### macOS
1. Mount `Sonara-2.0.0.dmg`
2. Drag to Applications
3. Test first launch (Gatekeeper)
4. Verify permissions

#### Linux
1. Run `chmod +x Sonara-2.0.0.AppImage`
2. Test AppImage directly
3. Install DEB: `sudo dpkg -i Sonara_2.0.0_amd64.deb`
4. Check desktop integration

### 📊 Build Sizes (Approximate)

| Platform | Type | Size |
|----------|------|------|
| Windows | NSIS Installer | ~85 MB |
| Windows | Portable | ~190 MB |
| macOS | DMG | ~95 MB |
| macOS | ZIP | ~85 MB |
| Linux | AppImage | ~95 MB |
| Linux | DEB | ~85 MB |

### 🐛 Troubleshooting

#### Build Fails
```bash
npm run clean
rm -rf node_modules
npm install
npm run build
```

#### Better-sqlite3 Error
```bash
npm run postinstall
```

#### ASAR Unpacking Issues
Check `asarUnpack` in package.json includes all native modules.

#### Icon Not Showing
Ensure icon files exist in `assets/`:
- `icon.ico` (Windows)
- `icon.icns` (macOS)
- `icon.png` (Linux, 512x512)

### 📤 Distribution

#### Windows
- Upload `.exe` installer to website/GitHub releases
- Provide both installer and portable versions
- Include virus scan results (VirusTotal)

#### macOS
- Upload `.dmg` to website/GitHub releases
- Notarize with Apple (recommended)
- Provide checksums (SHA256)

#### Linux
- Upload AppImage, DEB, and tar.gz
- Add to package repositories (optional)
- Provide installation instructions

### 🎉 Release Workflow

1. **Update Version**
   ```bash
   # Update package.json version to 2.0.0
   # Update CHANGELOG.md with release notes
   ```

2. **Commit Changes**
   ```bash
   git add .
   git commit -m "Release v2.0.0 - PDF Highlighting & Responsive Design"
   git tag -a v2.0.0 -m "Version 2.0.0"
   ```

3. **Build All Platforms**
   ```bash
   npm run build:all
   ```

4. **Test Installers**
   - Install on clean Windows, macOS, Linux VMs
   - Verify all features work
   - Check for errors

5. **Create Release**
   - Upload to GitHub Releases
   - Add release notes from CHANGELOG.md
   - Include download links

6. **Announce**
   - Social media
   - Website
   - Email newsletter

### 📞 Support

For build issues, check:
- [Electron Builder Docs](https://www.electron.build/)
- [Better-sqlite3 Issues](https://github.com/WiseLibs/better-sqlite3)
- Project GitHub Issues

---

**Happy Building! 🚀**
