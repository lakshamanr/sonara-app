# Sonara iOS — Build & Deploy Guide

## Prerequisites
- Node.js 18+ (upgrade from 16 if needed)
- Expo CLI: `npm install -g expo-cli`
- EAS CLI: `npm install -g eas-cli`
- Xcode 15+ (macOS required for actual iOS build)
- Apple Developer Account ($99/year for device testing & App Store)

---

## 1. Install Dependencies

```bash
cd sonara-ios
npm install
```

---

## 2. Development (iOS Simulator or Device)

### Option A: Expo Go (quickest — no Xcode needed)
```bash
npx expo start
# Scan QR code with Expo Go app on iPhone
```

### Option B: iOS Simulator (requires macOS + Xcode)
```bash
npx expo run:ios --simulator
```

### Option C: Real Device (requires Apple Developer account)
```bash
npx expo run:ios --device
```

---

## 3. Build Installable IPA with EAS Build

EAS Build uses Expo's cloud infrastructure (macOS runners) — works from Windows!

### Step 1: Login to Expo account
```bash
eas login
```

### Step 2: Configure your project
```bash
eas build:configure
```

### Step 3: Build Preview IPA (internal testing — no App Store needed)
```bash
eas build --platform ios --profile preview
```
This generates an `.ipa` file downloadable from expo.dev.
Install via:
- **TestFlight** (requires Apple Dev account)
- **AltStore** (free, for personal device)
- **Sideloadly** (for development)

### Step 4: Build Production IPA (for App Store)
```bash
eas build --platform ios --profile production
```

### Step 5: Submit to App Store
```bash
eas submit --platform ios
```

---

## 4. Local Xcode Build (macOS only)

```bash
npx expo prebuild --platform ios
cd ios
pod install
open Sonara.xcworkspace
# Press Run in Xcode
```

---

## 5. Environment Setup

Before building, update `eas.json` with your Apple credentials:
```json
{
  "submit": {
    "production": {
      "ios": {
        "appleId": "your@email.com",
        "ascAppId": "YOUR_APP_STORE_APP_ID",
        "appleTeamId": "YOUR_TEAM_ID"
      }
    }
  }
}
```

---

## App Features

| Feature | iOS Implementation |
|---|---|
| Library (PDF/EPUB/Audio) | expo-document-picker + expo-file-system |
| PDF Reading | react-native-pdf (native PDFKit) |
| EPUB Reading | Custom JS parser + WebView |
| Text-to-Speech (TTS) | expo-speech (AVSpeechSynthesizer) |
| Edge Neural TTS | WebSocket → Microsoft |
| Word Highlighting | Custom word-span renderer |
| Audio Playback | react-native-track-player (background) |
| Lock Screen Controls | react-native-track-player |
| Collections | expo-sqlite |
| Progress Sync | expo-sqlite |
| Notes & Highlights | expo-sqlite |
| Claude AI Q&A | Anthropic REST API |
| Dark/Warm Themes | React Native theme system |

---

## Troubleshooting

**"Module not found" errors:**
```bash
npm install
npx expo install
```

**iOS build fails on EAS:**
- Ensure Apple Developer account is connected in expo.dev
- Check bundle ID matches `com.sonara.audiobook`

**react-native-track-player not working:**
- Must use bare workflow (not Expo Go)
- Requires `npx expo prebuild` before Xcode build

**PDF not rendering:**
- react-native-pdf requires native build (not Expo Go)
- Use `eas build` or `npx expo run:ios`
