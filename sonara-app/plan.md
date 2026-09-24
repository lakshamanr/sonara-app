# Sonara — UI/UX Fix Implementation Plan

## Phase 1: CSS Foundation Fixes (Priority: CRITICAL)
### 1.1 Fix CSS Variable Shadow Bug
- File: `css/app.css`
- Remove duplicate `--radius-sm` on line 59 (keep line 22 as the single source of truth)
- Add new utility variables for commonly used inline values

### 1.2 Fix Hardcoded Theme Colors
- Replace `rgba(18, 18, 24, .96)` on voice-group-label with `var(--surface)` based value
- Replace PDF highlight hardcoded colors with theme-adaptable CSS custom properties
- Fix `.lc-format-badge` dark background
- Add theme-aware scrollbar variables

### 1.3 Add Utility Classes (for replacing inline styles)
- `.hidden` / `.visible` — for display toggles
- `.flex-row` / `.flex-col` — for flex layouts
- `.gap-6`, `.gap-8`, `.gap-10`, `.gap-12`, `.gap-16` — for spacing
- `.items-center`, `.items-start` — for align-items
- `.p-6`, `.p-8`, `.p-10`, `.p-12` — for padding
- `.m-0`, `.mb-8`, `.mb-10` — for margins
- `.text-ellipsis` — for overflow text
- `.rounded-sm`, `.rounded-md` — for border-radius
- `.text-muted`, `.text-dim` — for opacity/color text
- `.border-muted` — for border colors
- `.w-full`, `.flex-1`, `.flex-auto`, `.flex-none` — for sizing

### 1.4 Fix Collection Swatches (remove inline styles)
- Create `.col-swatch-[color]` CSS classes instead of inline `style="background:#..."`

## Phase 2: HTML Cleanup (Priority: CRITICAL)
### 2.1 Replace All `style="display:none"` with `class="hidden"`
- Use Edit tool to systematically replace each occurrence
- Elements: `generatingOverlay`, `readerWelcome`, `chapterTitlebar`, `readerTextWrap`, `readerPdfWrap`, `readerAudio`, `navBook`, `libEmptyHero`, `libEmpty`, `bookList`, `libStatsMini`, `rpNotesWrap`, `exportBadge`, `bulkActionBar`, `modalFormatPicker`, `modalSetCover`, etc.

### 2.2 Replace Inline Flex/Layout Styles with CSS Classes
- Export format radio buttons (lines 546-553)
- Font button group (line 508-509)
- Export cover row (line 555-563)
- Note tag select row (line 582-589)
- And other inline styles throughout

### 2.3 Add Accessibility Attributes
- `aria-label` on all icon-only buttons (settings, fullscreen, backup, shortcuts, mini-player, pin, volume, etc.)
- `role="button"` on clickable divs
- `aria-expanded` on collapsible elements
- `aria-pressed` on toggle buttons
- `aria-hidden="true"` on decorative icons

## Phase 3: JavaScript Fixes (Priority: CRITICAL)
### 3.1 Fix Toast Memory Leak
- Add max queue limit (5 toasts)
- Add deduplication (same message within 2s gets skipped)
- Fix `toastTimer` object usage
- Add `toast-wrap` DOM cleanup

### 3.2 Fix Claude Model Name
- Change `claude-sonnet-4-5` to `claude-3-5-sonnet-20241022`

### 3.3 Create File URL Helper
- Add `toFileUrl(path)` function in `app.js` UI module
- Replace all `file:///` + `replace(/\\/g, '/')` patterns with the helper

### 3.4 Replace Silent Error Catches
- Change `catch (_) {}` to `catch (err) { console.warn('[Section] error:', err.message); }`
- At minimum, log the error so debugging is possible

### 3.5 Add Loading State for App Startup
- Show a loading overlay while `App.init()` runs
- Hide after `Library.load()` completes or fails

## Phase 4: Icon System (Priority: HIGH)
### 4.1 Create SVG Icon Sprite
- Add `<svg style="display:none">` with `<symbol>` definitions for all common icons
- Icons: play, pause, add, book, export, check, close, settings, fullscreen, pin, volume, next, prev, etc.

### 4.2 Replace Inline SVGs with `<use>`
- Replace all repeated SVGs with `<svg><use href="#icon-name"/></svg>`
- Keep unique/dynamic SVGs inline (e.g., waveform, custom icons)

## Phase 5: Polish & Transitions (Priority: MEDIUM)
### 5.1 Add Mode Transition
- Fade transition between library and reader modes
- CSS transition on opacity for `.layout` and `#libraryView`

### 5.2 Add Modal Exit Animation
- Add `.modal-overlay.closing` class with reverse animation
- JS adds `.closing` before removing `.open`, then removes after animation

### 5.3 Add Library Card Stagger
- CSS `animation-delay` based on nth-child for `.lib-card` elements

### 5.4 Add PDF Keyboard Navigation
- Add `PageUp` / `PageDown` handlers for PDF prev/next page

## Phase 6: Testing & Verification
- Test all three themes (black, white, blue)
- Test modal open/close animations
- Test toast system (spam toasts, check no leak)
- Test keyboard shortcuts
- Test accessibility with screen reader (NVDA/VoiceOver)
- Test on different screen sizes

---

## Files to Modify
1. `css/app.css` — CSS fixes, utility classes, theme fixes, animations
2. `index.html` — Remove inline styles, add accessibility, add icon sprite
3. `js/app.js` — Toast fix, file URL helper, claude model fix, loading state
4. `js/library.js` — Replace file URL patterns, add console.warn for errors
5. `js/reader.js` — Replace file URL patterns, add PDF keyboard nav
6. `js/notes.js` — Minor accessibility improvements

---

## Success Criteria
- [ ] Zero inline `style="..."` attributes in HTML (except dynamic JS ones)
- [ ] All CSS variables work across all three themes
- [ ] Toast system doesn't leak memory (test: fire 50 toasts, DOM node count stable)
- [ ] Modal has proper focus trap and exit animation
- [ ] All icon-only buttons have `aria-label`
- [ ] App startup shows loading state (no blank flash)
- [ ] Claude API calls work with correct model name
- [ ] Library/reader mode switch has smooth transition
- [ ] All `catch (_) {}` blocks log to console (no silent failures)
