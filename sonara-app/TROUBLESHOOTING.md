# Sonara - Troubleshooting Guide

## File Upload Issues Fixed

### Problem
- Files were not updating in the library after upload
- App showed "Processing..." indefinitely
- Large files (>100MB) caused the app to freeze

### Solutions Implemented

1. **File Size Validation**
   - Files > 200MB are rejected
   - Files > 50MB show a warning prompt
   - File sizes are logged in console for debugging

2. **Enhanced Error Handling**
   - Comprehensive logging throughout the app
   - Better error messages in UI
   - Automatic error recovery

3. **Database & Library Updates**
   - Fixed library refresh after adding books
   - Added database transaction logging
   - Improved error handling in SQLite operations

4. **Developer Tools**
   - DevTools now open automatically to show console logs
   - All operations are logged with `[Main]`, `[App]`, `[Parser]` prefixes
   - Easy debugging of any issues

### How to Use

1. **Start the app:**
   ```bash
   npm start
   ```

2. **Add a book:**
   - Click "Add Book" button
   - Select a PDF or EPUB file (recommended < 50MB)
   - Wait for processing to complete
   - Book will appear in library

3. **Monitor progress:**
   - Watch the console in DevTools for detailed logs
   - Progress overlay shows current step
   - Errors are shown both in console and UI toasts

### File Size Recommendations

| File Size | Status | Notes |
|-----------|--------|-------|
| < 10MB | ✅ Optimal | Fast processing, smooth experience |
| 10-50MB | ⚠️ Good | May take 30-60 seconds |
| 50-200MB | ⚠️ Warning | 1-3 minutes, high memory usage |
| > 200MB | ❌ Rejected | Split into smaller files |

### Common Issues

#### Issue: "Processing..." never completes
**Cause:** File is too large (>100MB) or contains complex formatting
**Solution:** 
- Try a smaller file (< 50MB recommended)
- Check console for specific errors
- Restart the app and try again

#### Issue: "undefined" error
**Cause:** File read failed or parser error
**Solution:**
- Check console logs for the specific error
- Verify file is a valid PDF/EPUB
- Try re-downloading the file (may be corrupted)

#### Issue: Book doesn't appear in library
**Cause:** Database write failed or library didn't refresh
**Solution:**
- Check console for database errors
- Restart the app
- File should be in `<UserData>/books/` folder

### Debug Mode

The app now runs with DevTools open automatically, showing:
- `[Main]` - Electron main process logs (file I/O, database)
- `[App]` - Renderer process application logs
- `[Parser]` - PDF/EPUB parsing logs
- `[Library]` - Library management logs

### Getting Help

If issues persist:
1. Check the console logs in DevTools
2. Look for error messages (red text)
3. Note the last successful log message
4. Check the file size and format

### Performance Tips

- Use smaller files when possible (< 20MB ideal)
- Close other applications to free memory
- EPUBs are generally faster than PDFs
- First 3 chapters use Claude AI (if configured) - this adds time
