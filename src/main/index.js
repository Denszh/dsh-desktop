'use strict';

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  setupAppUpdater,
} = require('./updater.js');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// dsh 来源：
//  - 默认：dsh-desktop 自带的 @deepseek-ai/dsh npm 依赖（可分发）
//  - 可选：DSH_SOURCE=repo + DSH_REPO 指向本地源码（开发调试）
const DSH_USE_REPO = process.env.DSH_SOURCE === 'repo';
const DSH_REPO = process.env.DSH_REPO || path.join(os.homedir(), 'personal', 'deepseek-harness');
const DSH_PROFILE = process.env.DSH_PROFILE || 'web';
const STATE_FILE = path.join(app.getPath('userData'), 'dsh-state.json');

// 使用安装的 @deepseek-ai/dsh 包里的 dsh bin（随 dsh-desktop 一起打包分发）
function dshBinPath() {
  // Electron 打包后 node_modules 在 app.asar 内（或 unpacked）
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.resourcesPath || '', 'app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function dshCommand() {
  if (DSH_USE_REPO) {
    // 本地源码调试：pnpm dsh
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    return { cmd: pnpm, args: ['dsh', '--profile', DSH_PROFILE, '--port', '0'], cwd: DSH_REPO };
  }
  // 分发包：直接 node 运行安装的 dsh bin。
  // dev 模式用系统 node（process.execPath 是 Electron，不兼容 dsh）；
  // 打包模式用 Electron 自带的 node（process.execPath）。
  const bin = dshBinPath();
  if (bin) {
    const runner = app.isPackaged ? process.execPath : (process.env.npm_node_execpath || 'node');
    return { cmd: runner, args: [bin, '--profile', DSH_PROFILE, '--port', '0'], cwd: app.getAppPath() };
  }
  // 回退：npx（需联网）
  return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '@deepseek-ai/dsh', '--profile', DSH_PROFILE, '--port', '0'], cwd: app.getAppPath() };
}

// Icon lookup: prefer the packaged extraResources dir (process.resourcesPath),
// fall back to the dev-tree resources/ folder.
function resourcePath(name) {
  const packaged = path.join(process.resourcesPath || '', 'dsh-desktop-resources', name);
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'resources', name);
}

// ---------------------------------------------------------------------------
// Orphan cleanup — if a previous Electron instance was force-killed, its dsh
// child survives. We record the spawned process-group pid on every start and
// terminate any still-running one from a prior launch before starting fresh.
// ---------------------------------------------------------------------------

function readPrevState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(data) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[dsh-desktop] failed to write state:', err.message);
  }
}

function clearState() {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }
}

function killProcessGroup(pid, signal) {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch { /* already gone */ }
}

function cleanupOrphanDsh() {
  const prev = readPrevState();
  if (!prev || !prev.groupPid) return;
  const { groupPid, port } = prev;
  if (!Number.isInteger(groupPid) || groupPid <= 0) return;
  // Check whether the recorded process-group leader is still alive.
  let alive = true;
  try { process.kill(-groupPid, 0); } catch { alive = false; }
  if (alive) {
    console.log(`[dsh-desktop] cleaning up orphaned dsh from a previous launch (pgid=${groupPid}, port=${port})`);
    killProcessGroup(groupPid, 'SIGTERM');
    setTimeout(() => killProcessGroup(groupPid, 'SIGKILL'), 4000).unref();
  }
}

// ---------------------------------------------------------------------------
// Dsh process manager — spawns `pnpm dsh web --port 0` and discovers the port
// from the stdout line `dsh web: http://127.0.0.1:<port>`.
// ---------------------------------------------------------------------------

class DshProcess extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.url = null;
    this.port = null;
    this._buffer = '';
    this._exited = false;
  }

  start() {
    if (this.child) return;

    const { cmd, args, cwd } = dshCommand();
    this._exited = false;
    this.url = null;
    this.port = null;

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so stop() can terminate the whole tree
      // (node → dsh) instead of only the parent.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 0); } catch { /* not yet */ }
    }
    // Persist the process-group leader so a future launch can reap us if we
    // are force-killed (macOS Electron ignores SIGTERM, so this is the only
    // reliable cross-launch cleanup).
    writeState({ groupPid: child.pid, port: null, url: null, startedAt: Date.now() });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      process.stdout.write(`[dsh:err] ${chunk}`);
    });

    child.on('error', (err) => {
      this.emit('error', err);
    });

    child.on('exit', (code, signal) => {
      this._exited = true;
      this.child = null;
      clearState();
      this.emit('exit', { code, signal });
    });

    this.emit('spawned', { cmd, cwd });
  }

  _onStdout(chunk) {
    process.stdout.write(`[dsh:out] ${chunk}`);
    this._buffer += chunk;

    // The URL line: `dsh web: http://127.0.0.1:<port>`
    const match = this._buffer.match(/dsh web:\s*(http:\/\/[^\s]+)/);
    if (match && !this.url) {
      this.url = match[1];
      try {
        const u = new URL(this.url);
        this.port = Number(u.port);
      } catch {
        this.port = null;
      }
      if (this.child && this.child.pid) {
        writeState({ groupPid: this.child.pid, port: this.port, url: this.url, startedAt: Date.now() });
      }
      this.emit('ready', { url: this.url, port: this.port });
    }

    // Keep only the tail to avoid unbounded growth.
    if (this._buffer.length > 65536) {
      this._buffer = this._buffer.slice(-65536);
    }
  }

  isRunning() {
    return Boolean(this.child) && !this._exited;
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    const pid = child.pid;

    // Terminate the whole process group (pnpm → node → dsh web).
    if (pid && process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    } else {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }

    // Fallback: hard kill if it does not exit in 5s.
    const timer = setTimeout(() => {
      try {
        if (pid && process.platform !== 'win32') {
          process.kill(-pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* already gone */ }
    }, 5000);
    timer.unref();
  }

  async waitForExit(timeoutMs = 8000) {
    if (!this.child) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let trayIcon = null;
let isQuitting = false;
const dsh = new DshProcess();

function createWindow(url) {
  if (mainWindow) {
    mainWindow.loadURL(url);
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness',
    icon: resourcePath('app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Ensure the window comes to the foreground even if another app held focus
  // while dsh was still booting.
  mainWindow.on('show', () => {
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (url) {
    mainWindow.loadURL(url);
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function buildTrayMenu() {
  const isRunning = dsh.isRunning();
  return Menu.buildFromTemplate([
    {
      label: isRunning ? '运行中' : '未运行',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '打开 DeepSeek Harness',
      click: () => {
        if (dsh.url) {
          createWindow(dsh.url);
        } else {
          startDsh();
        }
      },
    },
    {
      label: '在浏览器中打开',
      enabled: Boolean(dsh.url),
      click: () => {
        if (dsh.url) shell.openExternal(dsh.url);
      },
    },
    {
      label: dsh.url ? `端口: ${dsh.port ?? '?'}` : '端口: -',
      enabled: false,
    },
    {
      label: `App 更新: ${lastUpdateStatus}`,
      enabled: false,
    },
    { type: 'separator' },
    isRunning
      ? {
          label: '重启 dsh',
          click: () => {
            dsh.stop();
            dsh.waitForExit().then(() => startDsh());
          },
        }
      : {
          label: '启动 dsh',
          click: () => startDsh(),
        },
    {
      label: '检查 App 更新',
      click: () => {
        if (appUpdater) {
          setUpdateStatus('checking', 'checking…');
          appUpdater.checkForUpdates().catch((e) => {
            setUpdateStatus('error', `check failed: ${e.message}`);
          });
        } else {
          setUpdateStatus('no-updater', 'dev mode: disabled');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        dsh.stop();
        app.quit();
      },
    },
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(dsh.url ? `DeepSeek Harness — ${dsh.url}` : 'DeepSeek Harness');
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const iconPath = resourcePath('tray-icon.png');
  trayIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    // Template image: macOS adapts it to light/dark menu bar automatically.
    trayIcon.setTemplateImage(true);
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (dsh.url) createWindow(dsh.url);
  });
}

// ---------------------------------------------------------------------------
// dsh lifecycle wiring
// ---------------------------------------------------------------------------

function startDsh() {
  if (dsh.isRunning()) return;

  // Reap any dsh left behind by a force-killed previous Electron instance.
  cleanupOrphanDsh();

  // Drop stale listeners from any previous run so restart does not stack them.
  dsh.removeAllListeners('ready');
  dsh.removeAllListeners('exit');
  dsh.removeAllListeners('error');

  dsh.start();
  dsh.once('ready', ({ url }) => {
    createWindow(url);
    updateTray();
  });
  dsh.on('exit', () => {
    updateTray();
    if (!isQuitting && mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `document.body.setAttribute('data-dsh-status', 'stopped')`,
      );
    }
  });
  dsh.on('error', (err) => {
    console.error('[dsh-desktop] failed to start dsh:', err.message);
    if (mainWindow) {
      mainWindow.webContents.send('dsh:error', String(err.message));
    }
  });
  updateTray();
}

// ---------------------------------------------------------------------------
// App self-update — electron-updater against GitHub Releases.
// ---------------------------------------------------------------------------

let lastUpdateStatus = 'idle';
let appUpdater = null; // set once packaged; used by the tray "检查 App 更新" item

function setUpdateStatus(kind, message) {
  lastUpdateStatus = `${kind}: ${message}`;
  console.log(`[dsh-desktop][update] ${lastUpdateStatus}`);
  if (mainWindow) {
    mainWindow.webContents.send('dsh:update-status', { kind, message });
  }
  updateTray();
}

// ② App self-update via electron-updater (packaged builds only).
function startAppUpdater() {
  let autoUpdater = null;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    autoUpdater = null;
  }
  appUpdater = autoUpdater;
  return setupAppUpdater({
    app,
    autoUpdater,
    onStatus: ({ kind, message }) => {
      if (kind !== 'downloading') setUpdateStatus(kind, message);
    },
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dsh.url) createWindow(dsh.url);
  });

  app.whenReady().then(() => {
    // Register IPC handlers exactly once (ipcMain.handle rejects duplicates).
    ipcMain.handle('dsh:get-status', () => ({
      running: dsh.isRunning(),
      url: dsh.url,
      port: dsh.port,
      profile: DSH_PROFILE,
      source: DSH_USE_REPO ? `repo:${DSH_REPO}` : 'bundled-npm',
    }));

    createTray();
    startDsh();

    // ② App self-update via electron-updater.
    const stopAppUpdater = startAppUpdater();

    app.on('will-quit', () => {
      stopAppUpdater();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && dsh.url) {
        createWindow(dsh.url);
      }
    });
  });

  app.on('before-quit', (event) => {
    if (!isQuitting) {
      // A plain quit request (window close, Cmd+Q) without a prior explicit
      // "退出" or SIGTERM keeps dsh alive in the tray.
      event.preventDefault();
      if (mainWindow) mainWindow.destroy();
    }
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray (macOS/others); dsh stays alive.
    // On macOS the standard behavior is to keep the app alive.
  });

  // Single teardown point: whatever triggered quit (tray "退出", Cmd+Q,
  // SIGTERM, system shutdown), stop dsh and wait for its children to settle
  // before the app exits — never leave an orphaned dsh web server.
  let teardownStarted = false;
  app.on('will-quit', async (event) => {
    if (teardownStarted) return;
    if (dsh.isRunning()) {
      event.preventDefault();
      teardownStarted = true;
      dsh.stop();
      await dsh.waitForExit();
      app.exit(0);
    }
  });

  // External termination (system shutdown, `kill`): bypass the tray-keepalive
  // and go straight to teardown so the dsh child cannot be orphaned. We handle
  // the signal explicitly (no default handler) so the async cleanup can finish.
  const terminate = async () => {
    if (isQuitting) return;
    console.log('[dsh-desktop] terminate requested (SIGTERM/SIGHUP)');
    isQuitting = true;
    if (tray) tray.destroy();
    if (mainWindow) mainWindow.destroy();
    if (dsh.isRunning()) {
      console.log('[dsh-desktop] stopping dsh...');
      dsh.stop();
      await dsh.waitForExit();
    }
    console.log('[dsh-desktop] done, exiting');
    app.exit(0);
  };
  process.on('SIGTERM', () => { void terminate(); });
  process.on('SIGHUP', () => { void terminate(); });

  app.on('quit', () => {
    if (tray) tray.destroy();
  });
}
