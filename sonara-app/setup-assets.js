const fs = require('fs');
const path = require('path');

// Create assets directory if it doesn't exist
if (!fs.existsSync('assets')) {
  fs.mkdirSync('assets');
  console.log('✓ Created assets directory');
}

const iconPng = path.join('assets', 'icon.png');
const legacyLogo = path.join('main', 'logo', 'logo.png');

// Keep user-provided assets/icon.png as source of truth.
// Only seed from legacy logo when icon.png is missing.
if (fs.existsSync(iconPng)) {
  console.log('✓ assets/icon.png already exists (kept as-is)');
} else {
  try {
    fs.copyFileSync(legacyLogo, iconPng);
    console.log('✓ Seeded assets/icon.png from main/logo/logo.png');
  } catch (err) {
    console.error('✗ Failed to create assets/icon.png:', err.message);
  }
}

console.log('\n✅ Assets setup complete!');
console.log('Note: For production, provide assets/icon.ico (Windows) and assets/icon.icns (macOS)');
