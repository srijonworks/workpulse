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
});
