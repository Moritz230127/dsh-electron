/**
 * preload: sandbox-safe bridge for the local error page.
 *
 * Exposes only retry/quit (no Node objects), and the main process validates
 * the sender frame is a file:// page inside src/renderer before acting.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const RETRY_CHANNEL = 'dsh-shell:retry';
const QUIT_CHANNEL = 'dsh-shell:quit';

try {
  contextBridge.exposeInMainWorld('dshShell', {
    retry: () => ipcRenderer.invoke(RETRY_CHANNEL),
    quit: () => ipcRenderer.invoke(QUIT_CHANNEL),
  });
} catch {
  // contextBridge unavailable (plain Node tests); the module stays a no-op.
}
