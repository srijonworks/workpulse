// WorkPulse desktop shell: starts the bundled server on a fixed local port and shows the app in a window.
// The port is fixed on purpose: saved data (localStorage) belongs to the address, so it must not change.
const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage, ipcMain, screen } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// A test copy (WORKPULSE_USER_DATA set) keeps its data, its single-instance lock and, with WORKPULSE_TEST_PORT, its address
// apart from the installed app. The installed app never sets either.
const TEST_PROFILE = Boolean(process.env.WORKPULSE_USER_DATA);
if (TEST_PROFILE) app.setPath('userData', process.env.WORKPULSE_USER_DATA);
const PORT = TEST_PROFILE && Number(process.env.WORKPULSE_TEST_PORT) > 0 ? Number(process.env.WORKPULSE_TEST_PORT) : 38417;
const ORIGIN = `http://localhost:${PORT}`;
const PRELOAD = path.join(__dirname, 'preload.cjs');

process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.NODE_ENV = 'production';
process.env.WORKPULSE_DIST = path.join(__dirname, 'app', 'dist');
// Tells the bundled server it runs inside this app: it passes start-up errors on to the dialog below instead of exiting.
process.env.WORKPULSE_DESKTOP = '1';

let win = null;
let tray = null;
let quitting = false;
// True once the window and the tray are up. Before that an error means the app cannot start (say why, then quit).
// After that the tray app keeps running: a stray error must not end a day of tracking.
let started = false;
// The shell's own decisions (src/shell, bundled into app/shell.cjs by scripts/build-desktop.mjs).
let policy = null;

function showStartError(err) {
  dialog.showErrorBox(
    'WorkPulse could not start',
    err && err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Close the other program using it (or another copy of WorkPulse) and open WorkPulse again.`
      : String((err && err.message) || err),
  );
  quitting = true;
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  process.on('uncaughtException', (err) => {
    if (started) {
      console.error('WorkPulse error (the app keeps running):', err);
      return;
    }
    showStartError(err);
  });
  process.on('unhandledRejection', (reason) => console.error('WorkPulse unhandled rejection (the app keeps running):', reason));
  app.whenReady().then(() => start().catch(showStartError));
}

// Waits (up to `ms`) for the server to answer. Each try has its own short timeout, so one connection that never
// answers cannot stall the start.
function waitForServer(ms = 20000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const retry = () => (Date.now() >= deadline ? reject(new Error('The WorkPulse server did not start.')) : setTimeout(attempt, 200));
      const req = http.get(`${ORIGIN}/api/health`, { timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('timeout', () => req.destroy());
      req.on('error', retry);
    };
    attempt();
  });
}

async function start() {
  policy = require(path.join(__dirname, 'app', 'shell.cjs'));
  require(path.join(__dirname, 'app', 'server.cjs'));
  await waitForServer();
  createWindow({ show: !policy.isHiddenStart(process.argv) });
  createTray();
  setupUpdates();
  setupPowerFlush();
  ensureLoginItem();
  started = true;
}

// ---- Updates ----
// `npm run desktop:build` writes the new installer and latest.yml to UPDATE_DIR. A tiny server (this PC only)
// hands them to the updater, which downloads the new version and asks before restarting.
const UPDATE_DIR = path.join(os.homedir(), 'wp-release');
const UPDATE_PORT = 38418;

function serveUpdates() {
  const server = http.createServer((req, res) => {
    // Any program on this PC can send a request here, and the folder can change while a build writes it:
    // a bad address or a vanished file is an answer (400, 404), never an error that reaches the app.
    let name = '';
    try {
      name = path.basename(decodeURIComponent((req.url || '').split('?')[0]));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const file = path.join(UPDATE_DIR, name);
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = -1;
    }
    if (!/^(latest\.yml|.*\.(exe|blockmap))$/i.test(name) || size < 0) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': size });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  server.on('error', () => {});
  server.listen(UPDATE_PORT, '127.0.0.1');
}

// What Settings -> App updates shows. status: idle | checking | current | downloading | ready | error | unavailable.
let updateState = { status: app.isPackaged ? 'idle' : 'unavailable', version: app.getVersion(), message: '' };
let updater = null;

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('wp:update', updateState);
}

function installUpdate() {
  quitting = true;
  updater.quitAndInstall();
}

function setupUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  serveUpdates();
  autoUpdater.autoDownload = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking', message: '' }));
  autoUpdater.on('update-available', (info) => setUpdateState({ status: 'downloading', newVersion: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'ready', newVersion: info.version });
    dialog
      .showMessageBox(win && win.isVisible() ? win : undefined, {
        type: 'info',
        title: 'WorkPulse update',
        message: `WorkPulse ${info.version} is ready.`,
        detail: 'Restart now to update? Your data stays as it is. You can also do it later from Settings.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0) installUpdate();
      });
  });
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'current', checkedAt: Date.now() }));
  autoUpdater.on('error', () =>
    setUpdateState({ status: 'error', message: 'Could not check for updates. Close and reopen WorkPulse, then try again.' }),
  );
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 30 * 60 * 1000);
  checkNow = () => {
    if (updateState.status === 'checking' || updateState.status === 'downloading') return;
    check();
  };
}

ipcMain.handle('wp:update-state', (event) => (fromOurPage(event) ? updateState : null));
ipcMain.on('wp:update-check', (event) => {
  if (fromOurPage(event)) checkNow();
});
ipcMain.on('wp:update-install', (event) => {
  if (fromOurPage(event) && updater && updateState.status === 'ready') installUpdate();
});

let checkNow = () => {};

function createWindow(opts = {}) {
  win = new BrowserWindow({
    show: opts.show !== false,
    width: 1360,
    height: 880,
    minWidth: 380,
    minHeight: 600,
    title: 'WorkPulse',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: PRELOAD },
  });
  Menu.setApplicationMenu(null);
  win.loadURL(ORIGIN);
  watchPage(win);
  // Links to other sites (WhatsApp Web, the phone link, docs) open in the normal browser.
  // Only a web or mail link is handed over (never a file or a program-launching address), and a failure to open
  // it is logged, not thrown.
  const external = (url) => {
    if (policy.isOurUrl(url, ORIGIN)) return false;
    if (policy.isSafeExternal(url)) shell.openExternal(url).catch((err) => console.error('Could not open a link:', err && err.message));
    return true;
  };
  win.webContents.setWindowOpenHandler(({ url }) => (external(url) ? { action: 'deny' } : { action: 'allow' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (external(url)) e.preventDefault();
  });
  // Closing the window keeps WorkPulse (and running timers) in the tray; "Quit" in the tray really quits.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// ---- Keeping the page alive ----
// The page is where the day is tracked. If it crashes, hangs or fails to load, bring it back (waiting a little longer
// each time) and say so in the log; if it keeps crashing, stop and tell the user instead of looping.
const crashTimes = [];
function watchPage(w) {
  const wc = w.webContents;
  wc.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    console.error('WorkPulse page crashed:', details.reason);
    const d = policy.crashDecision(crashTimes, Date.now());
    crashTimes.push(Date.now());
    if (d.action === 'give-up') {
      dialog.showErrorBox('WorkPulse keeps closing', 'The WorkPulse window crashed several times in a row. Your data is saved. Choose Quit in the tray menu and open WorkPulse again.');
      return;
    }
    setTimeout(() => {
      if (!w.isDestroyed() && !quitting) w.webContents.reload();
    }, d.delayMs);
  });
  // A page that does not answer for 30 s is restarted.
  let hangTimer = null;
  w.on('unresponsive', () => {
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      if (!w.isDestroyed() && !quitting) {
        console.error('WorkPulse page not responding: reloading');
        w.webContents.forcefullyCrashRenderer();
      }
    }, 30000);
  });
  w.on('responsive', () => clearTimeout(hangTimer));
  // The server was not ready, or went away for a moment: try again shortly.
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3 || quitting) return; // -3 = cancelled by a navigation
    console.error('WorkPulse page failed to load:', code, url);
    setTimeout(() => {
      if (!w.isDestroyed() && !quitting) w.loadURL(ORIGIN);
    }, 3000);
  });
}

// ---- Saving before the app stops ----
// Before quitting, sleeping, locking or signing out, the page is asked to write everything it holds in memory (running
// timers, anything that was not saved). It answers on 'wp:flushed'; we wait at most 1.5 s, then go on.
let flushWaiter = null;
function flushPage() {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return resolve();
    const done = () => {
      clearTimeout(timer);
      flushWaiter = null;
      Promise.resolve()
        .then(() => win && !win.isDestroyed() && win.webContents.session.flushStorageData())
        .catch(() => {})
        .then(resolve);
    };
    const timer = setTimeout(done, 1500);
    flushWaiter = done;
    win.webContents.send('wp:flush');
  });
}
ipcMain.on('wp:flushed', (event) => {
  if (fromOurPage(event) && flushWaiter) flushWaiter();
});

function showWindow() {
  // If the window was ever lost (it is only ever hidden), make a new one instead of leaving a tray with nothing behind it.
  if (!win || win.isDestroyed()) {
    if (!started) return;
    createWindow();
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(process.execPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('WorkPulse');
  const build = () =>
    Menu.buildFromTemplate([
      { label: 'Open WorkPulse', click: showWindow },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS });
        },
      },
      {
        label: 'Time widget',
        type: 'checkbox',
        checked: widgetConfig.time.on,
        click: (item) => setWidgetFromTray('time', item.checked),
      },
      {
        label: 'Tasks widget',
        type: 'checkbox',
        checked: widgetConfig.tasks.on,
        click: (item) => setWidgetFromTray('tasks', item.checked),
      },
      {
        label: 'Check for updates',
        click: () => {
          showWindow();
          checkNow();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
  tray.setContextMenu(build());
  rebuildTrayMenu = () => tray && tray.setContextMenu(build());
  tray.on('click', showWindow);
}

// The tray's widget checkboxes follow the widget settings. The settings live in the main window, so a click is
// handed to it as a command (it saves the choice and sends the new config back); the checkbox is redrawn then.
let rebuildTrayMenu = () => {};
function setWidgetFromTray(kind, on) {
  if (win && !win.isDestroyed()) win.webContents.send('wp:command', { type: 'set-widget', kind, on });
  rebuildTrayMenu();
}

// ---- Desktop widgets ----
// Two small frameless windows (time, tasks) that show the same page in widget mode (`?widget=`). The main window
// owns the data: it sends snapshots here, we pass them on, and button presses go back the same way.
const WIDGET_SIZE = { time: { width: 232, height: 148 }, tasks: { width: 300, height: 340 } };
const widgetWins = { time: null, tasks: null };
let widgetConfig = { time: { on: false, top: true }, tasks: { on: false, top: true } };
let lastSnapshot = null;
const POS_FILE = () => path.join(app.getPath('userData'), 'widget-positions.json');

function readPositions() {
  try {
    return JSON.parse(fs.readFileSync(POS_FILE(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function savePosition(kind, win) {
  const [x, y] = win.getPosition();
  const all = readPositions();
  all[kind] = { x, y };
  try {
    fs.writeFileSync(POS_FILE(), JSON.stringify(all));
  } catch {
    // position is a nicety
  }
}

// Remembered spot if it is still on a screen; else the top-right corner, time above tasks.
function widgetPosition(kind) {
  const size = WIDGET_SIZE[kind];
  const saved = readPositions()[kind];
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: size.width, height: size.height }).workArea;
    const inside = saved.x + 40 > area.x && saved.x < area.x + area.width - 40 && saved.y + 40 > area.y && saved.y < area.y + area.height - 40;
    if (inside) return saved;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const x = area.x + area.width - size.width - 16;
  return { x, y: kind === 'time' ? area.y + 16 : area.y + 16 + WIDGET_SIZE.time.height + 12 };
}

function openWidget(kind, top) {
  const size = WIDGET_SIZE[kind];
  const pos = widgetPosition(kind);
  const w = new BrowserWindow({
    ...size,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: top,
    focusable: true,
    title: 'WorkPulse widget',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, preload: PRELOAD },
  });
  if (top) w.setAlwaysOnTop(true, 'floating');
  w.loadURL(`${ORIGIN}/?widget=${kind}`);
  w.webContents.on('did-finish-load', () => {
    if (lastSnapshot) w.webContents.send('wp:state', lastSnapshot);
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('moved', () => savePosition(kind, w));
  w.on('closed', () => {
    if (widgetWins[kind] === w) widgetWins[kind] = null;
  });
  widgetWins[kind] = w;
}

function applyWidgets(config) {
  widgetConfig = config;
  rebuildTrayMenu();
  for (const kind of ['time', 'tasks']) {
    const want = config[kind];
    const w = widgetWins[kind];
    if (!want.on) {
      if (w) w.close();
    } else if (!w) {
      openWidget(kind, want.top);
    } else {
      w.setAlwaysOnTop(want.top, want.top ? 'floating' : 'normal');
    }
  }
}

const fromOurPage = (event) => {
  try {
    return policy.isOurUrl(event.senderFrame && event.senderFrame.url, ORIGIN);
  } catch {
    return false;
  }
};

const cleanConfig = (c) => {
  const one = (x) => ({ on: !!(x && x.on === true), top: !(x && x.top === false) });
  return { time: one(c && c.time), tasks: one(c && c.tasks) };
};

ipcMain.on('wp:widget-config', (event, config) => {
  if (fromOurPage(event)) applyWidgets(cleanConfig(config));
});

ipcMain.on('wp:state', (event, snapshot) => {
  if (!fromOurPage(event) || typeof snapshot !== 'object' || snapshot === null) return;
  lastSnapshot = snapshot;
  for (const w of Object.values(widgetWins)) if (w && !w.isDestroyed()) w.webContents.send('wp:state', snapshot);
});

ipcMain.on('wp:command', (event, cmd) => {
  if (!fromOurPage(event) || typeof cmd !== 'object' || cmd === null) return;
  if (cmd.type === 'open') return showWindow();
  if (win && !win.isDestroyed()) win.webContents.send('wp:command', cmd);
});

let flushedForQuit = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (flushedForQuit || !started) return;
  e.preventDefault();
  flushedForQuit = true;
  flushPage().then(() => app.quit());
});

function setupPowerFlush() {
  const { powerMonitor } = require('electron');
  for (const ev of ['suspend', 'lock-screen']) powerMonitor.on(ev, () => void flushPage());
  // Windows is signing out or shutting down: ask the page to save at once (it saves synchronously; we cannot wait here).
  if (win) win.on('session-end', () => win && !win.isDestroyed() && win.webContents.send('wp:flush'));
}

// WorkPulse starts with Windows, hidden in the tray. This is set once (a later choice in the tray menu is kept).
const LOGIN_ARGS = ['--hidden'];
function ensureLoginItem() {
  if (TEST_PROFILE || !app.isPackaged) return;
  const marker = path.join(app.getPath('userData'), 'login-item-set');
  if (fs.existsSync(marker)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS });
    fs.writeFileSync(marker, '1');
  } catch (err) {
    console.error('Could not set start with Windows:', err && err.message);
  }
}

// Electron quits when its last window closes. WorkPulse lives in the tray, so a lost window must not end it:
// only "Quit" in the tray does.
app.on('window-all-closed', () => {});
