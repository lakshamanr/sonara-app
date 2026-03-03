/**
 * Electron API Fix/Workaround
 *
 * In this environment, require('electron') returns the CLI path instead of the API.
 * This module provides a workaround to access Electron APIs via process bindings.
 */

'use strict';

// Try to get Electron API using available methods
function getElectronAPI() {
  //Try standard require first
  const electronModule = require('electron');

  // If it's an object (not a string), it worked!
  if (typeof electronModule === 'object' && electronModule.app) {
    return electronModule;
  }

  // Fallback: Use process._linkedBinding to access Electron internals
  if (typeof process._linkedBinding === 'function') {
    console.log('[electron-fix] Using process._linkedBinding workaround');

    // This is an internal Electron API that gives us access to the modules
    // We need to manually construct the electron object
    try {
      const { app } = process._linkedBinding('electron_browser_app');
      const { BrowserWindow } = process._linkedBinding('electron_browser_window');
      const { ipcMain } = process._linkedBinding('electron_browser_ipc');
      const { dialog } = process._linkedBinding('electron_browser_dialog');
      const { shell } = process._linkedBinding('electron_common_shell');
      const { Menu } = process._linkedBinding('electron_browser_menu');

      return { app, BrowserWindow, ipcMain, dialog, shell, Menu };
    } catch (err) {
      console.error('[electron-fix] Failed to use _linkedBinding:', err);
    }
  }

  throw new Error('Cannot access Electron API - neither require("electron") nor process._linkedBinding work');
}

module.exports = getElectronAPI();
