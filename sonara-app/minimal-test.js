// Ultra-minimal Electron test
console.log('=== Minimal Electron Test ===');
console.log('Process versions:', JSON.stringify(process.versions, null, 2));
console.log('\nTrying to require electron...');

const electronModule = require('electron');
console.log('Type:', typeof electronModule);
console.log('Value:', electronModule);

if (typeof electronModule === 'object') {
  console.log('SUCCESS! Got Electron API');
  console.log('Keys:', Object.keys(electronModule));

  const { app } = electronModule;
  app.whenReady().then(() => {
    console.log('App is ready!');
    app.quit();
  });
} else {
  console.log('FAILED! Got:', electronModule);
  process.exit(1);
}
