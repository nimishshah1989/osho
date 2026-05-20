'use strict';

/**
 * Osho Archives — desktop app, main process.
 *
 * Phase 1: a dedicated window onto the live Osho Archives app. This
 * intentionally keeps the surface tiny — it exists to prove out the
 * Electron build + packaging + CI pipeline before Phase 2 adds the
 * bundled-offline corpus.
 *
 * Phase 2 (planned): ship a static copy of the frontend and the
 * compressed corpus inside the installer, served over a local
 * `app://` protocol, so the app works fully offline from first launch
 * with no download and no file-load step.
 */
const { app, BrowserWindow, shell } = require('electron');

const SITE_URL = 'https://oshoarchives.com';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#0c0a09',
    title: 'Osho Archives',
    autoHideMenuBar: true,
    webPreferences: {
      // No Node in the renderer — it's just loading the web app.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(SITE_URL);

  // Links to other sites (sannyas.wiki, etc.) open in the user's real
  // browser rather than trapping them inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SITE_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

app.whenReady().then(() => {
  createWindow();
  // macOS: re-open a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS where apps
// conventionally stay running until explicitly quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
