const fs = require('fs');
const path = require('path');

// Create assets directory if it doesn't exist
if (!fs.existsSync('assets')) {
  fs.mkdirSync('assets');
  console.log('✓ Created assets directory');
}

// Copy logo to icon.png
try {
  fs.copyFileSync('main/logo/logo.png', 'assets/icon.png');
  console.log('✓ Copied icon.png');
} catch (err) {
  console.error('✗ Failed to copy icon:', err.message);
}

console.log('\n✅ Assets setup complete!');
console.log('Note: For production, you should create proper .ico and .icns files');
