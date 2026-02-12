#!/usr/bin/env node
/**
 * Pre-Build Verification Script
 * Checks that everything is ready for production build
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Sonara Pre-Build Verification\n');
console.log('='.repeat(50) + '\n');

let hasErrors = false;
let hasWarnings = false;

// Check 1: Node.js version
console.log('✓ Checking Node.js version...');
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
if (majorVersion < 16) {
  console.error('❌ ERROR: Node.js 16 or higher required. Current:', nodeVersion);
  hasErrors = true;
} else {
  console.log(`  ✅ Node.js ${nodeVersion}`);
}

// Check 2: package.json exists and is valid
console.log('\n✓ Checking package.json...');
try {
  const pkg = require('./package.json');
  console.log(`  ✅ Name: ${pkg.name}`);
  console.log(`  ✅ Version: ${pkg.version}`);
  console.log(`  ✅ Description: ${pkg.description}`);

  // Check version format
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    console.warn('  ⚠️  WARNING: Version should follow semver (X.Y.Z)');
    hasWarnings = true;
  }
} catch (err) {
  console.error('❌ ERROR: package.json is missing or invalid');
  hasErrors = true;
}

// Check 3: Required files exist
console.log('\n✓ Checking required files...');
const requiredFiles = [
  'main/main.js',
  'renderer/index.html',
  'renderer/css/app.css',
  'renderer/js/app.js',
  'renderer/js/reader.js',
  'database/db.js'
];

requiredFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`  ✅ ${file}`);
  } else {
    console.error(`  ❌ MISSING: ${file}`);
    hasErrors = true;
  }
});

// Check 4: node_modules exists
console.log('\n✓ Checking dependencies...');
if (fs.existsSync('node_modules')) {
  console.log('  ✅ node_modules/ exists');

  // Check critical dependencies
  const criticalDeps = ['electron', 'better-sqlite3', 'ws'];
  criticalDeps.forEach(dep => {
    if (fs.existsSync(`node_modules/${dep}`)) {
      console.log(`  ✅ ${dep} installed`);
    } else {
      console.error(`  ❌ MISSING: ${dep}`);
      hasErrors = true;
    }
  });
} else {
  console.error('  ❌ ERROR: node_modules not found. Run: npm install');
  hasErrors = true;
}

// Check 5: Icons (warnings only)
console.log('\n✓ Checking assets...');
const iconFiles = [
  { file: 'assets/icon.ico', platform: 'Windows' },
  { file: 'assets/icon.icns', platform: 'macOS' },
  { file: 'assets/icon.png', platform: 'Linux' }
];

iconFiles.forEach(({ file, platform }) => {
  if (fs.existsSync(file)) {
    console.log(`  ✅ ${file} (${platform})`);
  } else {
    console.warn(`  ⚠️  WARNING: ${file} not found - ${platform} build may use default icon`);
    hasWarnings = true;
  }
});

// Check 6: Database schema
console.log('\n✓ Checking database...');
if (fs.existsSync('database/schema.sql')) {
  console.log('  ✅ database/schema.sql');
} else {
  console.warn('  ⚠️  WARNING: database/schema.sql not found');
  hasWarnings = true;
}

// Check 7: Disk space
console.log('\n✓ Checking disk space...');
try {
  const stats = fs.statfsSync('.');
  const freeSpace = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024); // GB
  if (freeSpace < 2) {
    console.warn(`  ⚠️  WARNING: Low disk space (${freeSpace.toFixed(1)} GB free). Need ~2 GB for build.`);
    hasWarnings = true;
  } else {
    console.log(`  ✅ ${freeSpace.toFixed(1)} GB free`);
  }
} catch (err) {
  console.warn('  ⚠️  Could not check disk space');
}

// Check 8: Changelog
console.log('\n✓ Checking documentation...');
if (fs.existsSync('CHANGELOG.md')) {
  console.log('  ✅ CHANGELOG.md');
} else {
  console.warn('  ⚠️  WARNING: CHANGELOG.md not found');
  hasWarnings = true;
}

if (fs.existsSync('BUILD.md')) {
  console.log('  ✅ BUILD.md');
}

// Final summary
console.log('\n' + '='.repeat(50));
console.log('\n📊 Verification Summary:\n');

if (hasErrors) {
  console.error('❌ BUILD CANNOT PROCEED - Errors found!');
  console.error('   Fix the errors above and try again.\n');
  process.exit(1);
} else if (hasWarnings) {
  console.warn('⚠️  BUILD CAN PROCEED - Warnings found');
  console.warn('   Review warnings above. Build may be incomplete.\n');
  process.exit(0);
} else {
  console.log('✅ ALL CHECKS PASSED!');
  console.log('   Ready to build production release.\n');
  console.log('   Run: npm run build:prod\n');
  process.exit(0);
}
