'use strict';

/**
 * Osho Archives — desktop app, main process.
 *
 * The installer bundles a static copy of the frontend *and* the
 * compressed corpus (CI populates `desktop/app/`, with the corpus at
 * `desktop/app/corpus/osho.db.zst`). The main process serves that
 * whole directory from a local HTTP server on 127.0.0.1 and points the
 * window at it — so the renderer behaves exactly like the web app on a
 * real server (client routing, web workers, OPFS all work as already
 * tested in browsers).
 *
 * `preload.js` tells the frontend it's running in the desktop app;
 * OfflineProvider then fetches the bundled corpus from this local
 * server and installs it on first launch — so the app is fully offline
 * from the very first run, with no download step.
 */
const { app, BrowserWindow, shell } = require('electron');
const http = require('node:http');
const path = require('node:path');
const handler = require('serve-handler');

// The bundled static frontend (populated by CI before packaging).
const APP_DIR = path.join(__dirname, 'app');

let origin = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handler(req, res, {
        public: APP_DIR,
        cleanUrls: false,
        trailingSlash: true,
        directoryListing: false,
      });
    });
    server.on('error', reject);
    // Port 0 → the OS assigns a free local port.
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#1a1410',
    title: 'Osho Archives',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadURL(origin);

  // Links to other sites open in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(origin)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

app.whenReady().then(async () => {
  origin = await startServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
