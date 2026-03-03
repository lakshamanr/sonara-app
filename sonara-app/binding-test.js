console.log('=== Testing Electron Bindings ===\n');

// Method 1: Check for process.electronBinding
if (typeof process.electronBinding === 'function') {
  console.log('✓ process.electronBinding exists');
  try {
    const { app } = process.electronBinding('electron_browser_app');
    console.log('✓ Got app via process.electronBinding');
    console.log('✓ App methods:', Object.keys(app).slice(0, 10));
  } catch (e) {
    console.log('✗ Error:', e.message);
  }
} else {
  console.log('✗ process.electronBinding not found');
}

// Method 2: Check for process._linkedBinding
if (typeof process._linkedBinding === 'function') {
  console.log('\n✓ process._linkedBinding exists');
  try {
    const electron = process._linkedBinding('electron_common_v8_util');
    console.log('✓ Got electron via _linkedBinding');
  } catch (e) {
    console.log('✗ Error:', e.message);
  }
} else {
  console.log('\n✗ process._linkedBinding not found');
}

// Method 3: Check module cache
console.log('\n=== Module Cache ===');
const electronInCache = Object.keys(require.cache).find(k => k.includes('electron'));
console.log('Electron in cache?:', electronInCache || 'NO');

// Method 4: Try to find where electron API should be
console.log('\n=== Process Properties ===');
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);
