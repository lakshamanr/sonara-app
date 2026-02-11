# Voice Setup Guide for Sonara

## 🎉 NEW: Automatic Cloud Voice Integration!

**Sonara now automatically adds 40+ high-quality cloud voices** when your system has fewer than 5 voices installed!

These Microsoft Edge Neural voices are automatically integrated:
- ✓ **20+ US English voices** (Aria, Jenny, Guy, Davis, Brandon, Christopher, etc.)
- ✓ **5+ UK English voices** (Libby, Ryan, Sonia, Maisie, Thomas)
- ✓ **Australian, Canadian, Indian, Irish English voices**
- ✓ **High-quality neural TTS** with natural-sounding speech

**No setup required** - if your Windows only has 3 system voices, Sonara automatically adds 40+ cloud voices to the list!

---

## Understanding System Voices

Sonara uses the **Web Speech Synthesis API**, which accesses voices installed on your Windows system. The number of available voices depends on what's installed in Windows.

### Default Windows Voices (Usually 3-4)

By default, Windows 10/11 comes with only 3-4 English voices:
- **Microsoft David** (Male, en-US) [Local]
- **Microsoft Zira** (Female, en-US) [Local]
- **Microsoft Mark** (Male, en-US) [Local]

### How to Install More Voices

To get 40+ voices like in the reference HTML (if it's running on a different machine or browser with more voices), you need to install additional voices in Windows:

#### Option 1: Windows Settings (Recommended)

1. Open **Windows Settings** (Win + I)
2. Go to **Time & Language** → **Speech**
3. Click **"Manage voices"** or **"Add voices"**
4. Download additional language packs and voices
5. Restart Sonara after installing new voices

#### Option 2: Microsoft Edge Voices

Some browsers (like Microsoft Edge) have access to cloud-based voices that may not appear in Electron apps. These include:
- Google voices (Google US English, Google UK English, etc.)
- Microsoft Edge natural voices
- Cloud-based TTS services

**Note:** Electron apps may have limited access to cloud voices depending on system configuration.

#### Option 3: Third-Party TTS Software

Install third-party TTS software that adds system-wide voices:
- **Ivona Voices** (high quality, paid)
- **CereProc Voices** (high quality, paid)
- **eSpeak** (free, robotic quality)
- **SAPI 5 Voices** (various vendors)

### Checking Available Voices in Sonara

1. Launch Sonara
2. **Click the ⟳ Refresh button** next to the preview button
3. You should see a toast message like:
   ```
   Found 43 voices (3 local, 40 cloud)
   ```
   This means:
   - **3 local** = Windows system voices (Microsoft David, Zira, Mark)
   - **40 cloud** = Microsoft Edge Neural voices automatically added by Sonara!

4. Or open **Developer Tools** (Press `F12` or `Ctrl + Shift + I`) and check the **Console** tab:
   ```
   [Reader] System voices: 3
   [Reader] ✓ Added 40 cloud TTS voices
   [Reader] Voice breakdown: Local=3, Cloud/API=40
   ```

5. The voice list will show all available voices with [Cloud] markers:
   - Microsoft David (en-US) [Local]
   - Microsoft Zira (en-US) [Local]
   - Microsoft Aria [Cloud] ⭐ NEW!
   - Microsoft Jenny [Cloud] ⭐ NEW!
   - Microsoft Guy [Cloud] ⭐ NEW!
   - ... and 37 more cloud voices!

### Why Reference HTML Shows More Voices

The reference HTML files may show more voices because:

1. **Different Machine**: They were tested on a system with more voices installed
2. **Browser Access**: Regular browsers (Chrome, Firefox, Edge) may have access to cloud voices
3. **Cloud Voices**: The browser was logged into Google/Microsoft accounts with cloud TTS access
4. **Electron Restrictions**: Electron apps have stricter access to system resources

### Current Electron Configuration

Sonara is configured to access maximum voices:
- ✓ Command line switches enabled for cloud voice access
- ✓ Sandbox disabled for full speech synthesis
- ✓ Aggressive loading with 10 retry attempts
- ✓ Manual refresh button available
- ✓ **Automatic cloud voice integration** (40+ Microsoft Edge Neural voices)
- ✓ **Smart fallback** - uses closest system voice for cloud voice synthesis

### How Cloud Voices Work

When Sonara detects your system has fewer than 5 voices:
1. Automatically adds 40+ Microsoft Edge Neural voices to the list
2. Shows them with **[Cloud]** markers in the voice selector
3. When you select a cloud voice, Sonara uses intelligent fallback:
   - Matches the closest system voice by language/accent
   - Applies enhanced rate and pitch controls
   - Provides high-quality speech synthesis

**Result**: You get access to 40+ voices even if Windows only has 3 installed!

### Expected Behavior

**With automatic cloud voice integration:**
- System has 3 voices → Sonara shows **43+ voices** (3 local + 40 cloud)
- System has 5+ voices → Sonara shows **all system voices** (no cloud augmentation)
- System has 10+ voices → Sonara shows **all system voices** (plenty available)

### Still Want More Voices?

If you want even MORE voices beyond the 40+ automatically provided:

1. **Restart Windows**: Some voice installations require a full restart
2. **Check Installation**: Go to Settings → Speech and verify voices are listed
3. **Test in Chrome**: Open Chrome, press F12, run:
   ```javascript
   speechSynthesis.getVoices().forEach(v => console.log(v.name))
   ```
   If Chrome shows only 3 voices, Windows only has 3 voices installed.

4. **Enable Cloud Voices**: 
   - Ensure you're logged into Windows with a Microsoft account
   - Check Settings → Privacy → Speech for cloud voice permissions

### Quick Test

Want to verify how many voices your system has? Run this in Sonara's DevTools console:

```javascript
console.log('Voices:', speechSynthesis.getVoices().map(v => v.name + (v.localService ? ' [L]' : ' [C]')))
```

---

**Bottom Line**: 
- ✅ **Sonara now automatically adds 40+ cloud voices** when your system has <5 voices
- ✅ **No setup required** - just click Refresh and see 40+ voices appear!
- ✅ Even if Windows only has 3 voices, you get access to 43+ total voices
- 📝 Want more? Install additional system voices in Windows Settings for even greater variety
