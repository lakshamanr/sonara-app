# Sonara App — UI/UX Audit & Fix Plan

## Executive Summary

After reviewing the entire codebase (~1,310 lines HTML, ~4,971 lines CSS, ~1,863 lines app.js, ~1,510 lines library.js, ~2,371 lines reader.js, and more), I found a **visually impressive app** with real design talent, but several issues that will hurt its ability to sell for money. Below are critical issues found and the plan to fix them.

---

## 🔴 Critical Issues (Must Fix Before Release)

### 1. CSS Variable Shadow Bug — Duplicate `--radius-sm`
**File:** `css/app.css` lines 22 and 59
- Line 22: `--radius-sm: 6px;` (in border-radius scale)
- Line 59: `--radius-sm: 8px;` (in "Border radius aliases")
- The second declaration **overwrites the first**, causing inconsistent border radius across the app. This is a silent bug that makes the UI look inconsistent.

### 2. Hardcoded Theme Colors in CSS
Multiple places in CSS use hardcoded RGBA values that break the white/blue themes:
- Line 1297: `background: rgba(18, 18, 24, .96);` (voice group label — always dark)
- Line 1023-1037: PDF highlight colors hardcoded (won't adapt to theme)
- Line 225: Scrollbar thumb uses `rgba(200,169,110,0.25)` — only gold accent, not theme-aware
- Line 3700: `.lc-format-badge` has `background: rgba(13,14,17,0.85)` — always dark

### 3. Inline Styles Scattered in HTML (Anti-Pattern)
The HTML file has **>50 inline style attributes** that bypass the CSS system and make the app unprofessional:
- `style="display:none"` (appears 20+ times) — use CSS classes like `.hidden`
- `style="display:flex;gap:6px;"` on Voice section header (line 440)
- `style="margin-bottom:10px;align-items:flex-start;"` on Font row (line 508)
- `style="padding-top:4px"` on label (line 509)
- `style="flex:0 0 auto;padding:3px 8px;font-size:11px;"` on export button (line 561)
- `style="font-size:11px;opacity:0.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"` on export name (line 562)
- And many more...

**Why this matters:** Inline styles override CSS, make theming impossible, and make the code look amateur. A paying customer will notice this when they try to customize.

### 4. Toast Memory Leak — No Queue Limit
**File:** `app.js` line 11-22
```javascript
function toast(msg, type = '', duration = 3500) {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  // ...
  const id = setTimeout(() => { ... }, duration);
}
```
- `toastTimer` is declared as an object but never used as a map (the `id` variable is just a local, never stored in `toastTimer`)
- **No limit on number of toasts** — if the app fires toasts rapidly, DOM nodes accumulate
- **No deduplication** — the same error can stack 20 times

### 5. Missing Accessibility (A11y) — Blocks Sales
A professional app must be accessible. Current issues:
- No `aria-label` on most buttons (only voice items have some)
- No `role` attributes on interactive elements
- No focus trap in modals (Tab key escapes the modal)
- No `aria-expanded` on collapsible panels
- No `aria-pressed` on toggle buttons (pin, fullscreen, play/pause)
- Color contrast for some muted text may fail WCAG AA
- No `sr-only` labels for icon-only buttons

### 6. SVG Icon Duplication — Massive Repetition
The same SVGs are duplicated inline throughout the HTML:
- Play icon (polygon): appears **10+ times** in different sizes
- Plus/add icon (two lines): appears **6+ times**
- Book icon: appears **5+ times**
- Export icon: appears **4+ times**
- Check icon: appears **3+ times**
- **Every SVG icon has inline width/height/viewBox** — could be centralized

**Why this matters:** 300+ lines of HTML are just repeated SVG markup. This bloats the file, makes maintenance painful, and makes the app look unpolished under the hood.

### 7. Missing Loading States for App Startup
The app starts and shows a toast "Welcome to Sonara" but:
- No initial loading spinner while the database loads
- No skeleton state for the library while books are being fetched
- The generating overlay only shows during book processing, not on startup
- If the app takes >2s to load, the user sees a blank/flash state

### 8. JS Error Silencing — Hidden Failures
Multiple `try/catch` blocks swallow errors silently:
```javascript
try { ... } catch (_) { }
```
- Line 122, 126, 129, 132, 135, 139, 142, 153, 782, 790, 907, 1000, 1001... (many more)
- **Silent failures make debugging impossible for users**
- A professional app should log to a visible error panel or at least console.warn

### 9. Claude API Model Name Is Wrong
**File:** `app.js` line 635
```javascript
model: 'claude-sonnet-4-5',
```
This model identifier **does not exist** in the Anthropic API. It should be `claude-3-5-sonnet-20241022` or similar. The current value will cause 400 errors when users try to use Claude AI.

### 10. `file:///` Path Protocol Fragility
`file:///` is used throughout for local file access. This is **not reliable** across all platforms (Linux uses `file://` without the extra slash, and Electron typically uses `file:///` with three slashes). The code uses it inconsistently in some places. A utility function should normalize this.

---

## 🟡 Medium Issues (Should Fix for Professional Feel)

### 11. No CSS Class for `.hidden` / `.visible`
Instead of `style="display:none"` everywhere, a single `.hidden { display: none !important; }` class would clean up the HTML dramatically.

### 12. Missing Transition Between Library and Reader Modes
The mode switch happens instantly with `display: none` / `display: flex`. A fade/slide transition would make it feel premium.

### 13. Modal Close on Backdrop Click Missing for Some Modals
Most modals have `onclick="UI.closeModal('id')"` on the close button, but clicking outside the modal content (the overlay) doesn't close it for most modals. Only the Quick Text modal has a click listener for backdrop.

### 14. Bulk Export Buttons Are Inline-Styled in HTML
The export format radio buttons (lines 546-553) have full inline CSS:
```html
style="flex:1;display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--border-muted,#3a3a3a);border-radius:6px;cursor:pointer;font-size:12px;"
```
This is 150+ characters of inline CSS per button. Should be a CSS class.

### 15. `ontouchstart` Detection is Deprecated
```javascript
if ('ontouchstart' in window) {
  document.body.classList.add('touch-device');
}
```
Modern approach uses `@media (hover: none) and (pointer: coarse)` in CSS, which is already partially present. The JS detection adds a class that may not match modern devices (laptops with touchscreens).

### 16. No Empty State for "No Results" in Voice List
When filtering voices returns nothing, the voice list shows "No voices match your search." but this is plain text with no icon or helpful action. Could be a small illustration + "Clear filters" button.

### 17. The `generatingOverlay` Uses Inline Style Visibility
```javascript
overlay.style.display = 'flex';
overlay.style.display = 'none';
```
Should use a CSS class like `.generating-overlay.active` with transitions.

### 18. `_updateClaudeUI` Called Before Voice List Populated
The UI shows "Claude AI" pill before the voice list is ready. Not a bug, but feels like the app isn't fully loaded.

### 19. `libraryView` Shows Before `Library.load()` Completes
On startup, `body.mode-library` is added immediately, but the grid data loads asynchronously. The skeleton is shown, but if the load fails, the skeleton stays forever.

### 20. No Keyboard Shortcut for "Next/Prev Chapter" in PDF Mode
EPUB has PgUp/PgDn shortcuts, but PDF has no equivalent keyboard navigation. Inconsistent UX.

---

## 🟢 Polish Issues (Nice to Have for Premium Feel)

### 21. No Exit Animation for Modals
Modals open with `fadeIn` + `slideUp`, but close instantly by removing the `.open` class. A reverse animation would feel premium.

### 22. No Stagger Animation for Library Cards
When the library loads, all cards appear at once. A staggered fade-in (e.g., 30ms delay per card) would feel polished.

### 23. The Mini-Player and Pin Buttons Have No Tooltip on Mobile
On mobile, tooltips don't work (no hover). The buttons need `aria-label` at minimum.

### 24. Collection Color Swatches Use Inline `style="background:#..."`
Lines 975-980: Color swatches have inline background colors. These should be CSS classes or at least `data-color` attributes styled via CSS.

### 25. No "Recently Read" Section in Library Sidebar
The sidebar has "All Books", "Recently Added", "In Progress" but no "Recently Read" or "Favorites" quick filter. Common user expectation.

---

## 📋 Fix Implementation Plan

### Phase 1: Critical Fixes (CSS + HTML + JS Core)
1. Fix duplicate `--radius-sm` CSS variable
2. Replace hardcoded dark colors with theme CSS variables
3. Fix scrollbar to be theme-aware
4. Create `.hidden` utility class and replace all `style="display:none"`
5. Move all inline styles from HTML to CSS classes
6. Fix toast memory leak (add max queue, deduplication)
7. Fix Claude model name to valid API identifier
8. Create file URL normalization utility
9. Add error logging (replace silent `catch (_) {}` with `console.warn`)

### Phase 2: Accessibility & Icon System
10. Add `aria-label` to all icon-only buttons
11. Add `role` attributes to interactive elements
12. Add focus trap to all modals
13. Create SVG icon sprite system (single `<symbol>` definitions)
14. Replace all inline SVGs with `<use>` references

### Phase 3: Polish & Professional Touches
15. Add fade transition between library/reader modes
16. Add modal close animations (reverse of open)
17. Add stagger animation for library card grid
18. Add loading state for initial app startup
19. Add empty state illustrations/icons for voice list, no results, etc.
20. Add keyboard shortcut for PDF prev/next page

---

## 💰 Why These Fixes Matter for Revenue

1. **Professional first impression** — Inline styles and CSS bugs scream "hobby project"
2. **Accessibility compliance** — Many enterprise/educational buyers require WCAG compliance
3. **Performance** — Memory leaks and unoptimized SVGs cause lag on lower-end machines
4. **Maintainability** — Clean code lets you ship updates faster and fix bugs cheaper
5. **User trust** — A polished app with smooth animations feels worth paying for

---

## Estimated Impact
- **Before fixes:** App looks good but has ~15 visible bugs/glitches that users will notice
- **After fixes:** App feels like a $20-50 commercial product (audiobook players typically sell at $19-49)

