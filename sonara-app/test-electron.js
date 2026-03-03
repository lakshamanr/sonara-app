console.log('Testing electron module...');
const electron = require('electron');
console.log('Type of electron:', typeof electron);
console.log('Electron value:', electron);
console.log('Electron.app:', electron.app);
console.log('Keys:', Object.keys(electron || {}));
