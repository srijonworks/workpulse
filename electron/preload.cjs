// Bridge between the app pages (main window and widget windows) and the Electron shell.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => {
  const fn = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('workpulseDesktop', {
  isDesktop: true,
  // main window -> shell -> widgets
  pushState: (snapshot) => ipcRenderer.send('wp:state', snapshot),
  setWidgets: (config) => ipcRenderer.send('wp:widget-config', config),
  onState: (cb) => listen('wp:state', cb),
  // widgets -> shell -> main window
  command: (cmd) => ipcRenderer.send('wp:command', cmd),
  onCommand: (cb) => listen('wp:command', cb),
  // app updates (Settings -> App updates)
  getUpdateState: () => ipcRenderer.invoke('wp:update-state'),
  checkForUpdates: () => ipcRenderer.send('wp:update-check'),
  installUpdate: () => ipcRenderer.send('wp:update-install'),
  onUpdateState: (cb) => listen('wp:update', cb),
  // the shell asks the page to save everything before quit, sleep, lock or sign-out; the page answers when done
  onFlush: (cb) => listen('wp:flush', cb),
  flushed: () => ipcRenderer.send('wp:flushed'),
  // the last push to the Google Sheet before Windows shuts down (the Sheet sends the day's email from it)
  setSheetPending: (pending) => ipcRenderer.send('wp:sheet-pending', pending === true),
  onFinalPush: (cb) => listen('wp:final-push', cb),
  finalPushed: () => ipcRenderer.send('wp:final-pushed'),
  // seconds since the last keyboard or mouse input anywhere on the PC (for the automatic clock-out)
  getIdleSeconds: () => ipcRenderer.invoke('wp:idle-seconds'),
});
