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
//  - 默认（打包分发）：首次运行从 GitHub Releases 下载预打包的 dsh 运行时，
//    解压到 userData/dsh-runtime，用 Electron 的 node 运行（可分发，壳不打包 dsh）
//  - 可选：DSH_SOURCE=repo + DSH_REPO 指向本地源码（开发调试）
//  - dev 模式：直接使用项目内 node_modules（本地开发）
const DSH_USE_REPO = process.env.DSH_SOURCE === 'repo';
const DSH_REPO = process.env.DSH_REPO || path.join(os.homedir(), 'personal', 'deepseek-harness');
const DSH_PROFILE = process.env.DSH_PROFILE || 'web';
const STATE_FILE = path.join(app.getPath('userData'), 'dsh-state.json');

// dsh 运行时发行版下载源（GitHub Releases 资产）
const DSH_RELEASE_OWNER = process.env.DSH_RELEASE_OWNER || 'Denszh';
const DSH_RELEASE_REPO = process.env.DSH_RELEASE_REPO || 'dsh-desktop';
const DSH_RUNTIME_VERSION = process.env.DSH_RUNTIME_VERSION || '0.1.0-rc.6';
function dshRuntimeArchiveName() {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `dsh-runtime-${os}-${arch}.zip`;
}
function dshRuntimeDownloadUrl(version = DSH_RUNTIME_VERSION) {
  return `https://github.com/${DSH_RELEASE_OWNER}/${DSH_RELEASE_REPO}/releases/download/dsh-runtime-v${version}/${dshRuntimeArchiveName()}`;
}

// 本地已安装的 dsh 运行时版本（记录在 dsh-runtime/.version，供内核自愈对比）
function readInstalledDshVersion() {
  try {
    const p = path.join(dshRuntimeDir(), '.version');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch { /* ignore */ }
  return null;
}
function writeInstalledDshVersion(version) {
  try {
    fs.writeFileSync(path.join(dshRuntimeDir(), '.version'), version);
  } catch (err) {
    console.warn('[dsh-desktop] failed to write runtime version:', err.message);
  }
}

/**
 * 查询 GitHub Releases 中最新 dsh-runtime tag 的版本号（如 "0.1.0-rc.6"）。
 * 失败/离线返回 null（调用方保留本地版本继续跑）。
 */
function latestDshRuntimeVersion() {
  return new Promise((resolve) => {
    https.get(`https://api.github.com/repos/${DSH_RELEASE_OWNER}/${DSH_RELEASE_REPO}/releases?per_page=100`, {
      headers: { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const releases = JSON.parse(data);
          const tags = (Array.isArray(releases) ? releases : [])
            .map((r) => r.tag_name || '')
            .filter((t) => /^dsh-runtime-v.+/.test(t))
            .map((t) => t.replace(/^dsh-runtime-v/, ''))
            .sort();
          resolve(tags.length > 0 ? tags[tags.length - 1] : null);
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// dsh 运行时目录：userData/dsh-runtime（解压后 node_modules/@deepseek-ai/dsh/lib/bin.js）
function dshRuntimeDir() {
  return path.join(app.getPath('userData'), 'dsh-runtime');
}
function dshRuntimeBinPath() {
  return path.join(dshRuntimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
function dshRuntimeInstalled() {
  return fs.existsSync(dshRuntimeBinPath());
}

// 本项目 dev 模式使用的 dsh bin
function devDshBinPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node 运行时解析：dsh 需要 Node >= 22（node:module stripTypeScriptTypes 等）。
// 优先 userData 里的独立 node，其次系统 node；系统没有/版本低则提示。
// ---------------------------------------------------------------------------

const NODE_MIN_MAJOR = 22;

function nodeBinInRuntime() {
  const binName = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  const p = path.join(app.getPath('userData'), 'node-runtime', binName);
  return fs.existsSync(p) ? p : null;
}

function nodeRuntimeArchiveName() {
  const version = `v${process.env.DSH_NODE_VERSION || '22.23.1'}`;
  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win' : 'linux';
  const archName = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `node-${version}-${osName}-${archName}.${ext}`;
}

function nodeRuntimeDownloadUrl() {
  const version = `v${process.env.DSH_NODE_VERSION || '22.23.1'}`;
  return `https://nodejs.org/dist/${version}/${nodeRuntimeArchiveName()}`;
}

async function ensureNodeRuntime(onProgress) {
  if (nodeBinInRuntime()) return { installed: true, message: 'node runtime ready' };
  const url = nodeRuntimeDownloadUrl();
  const archive = nodeRuntimeArchiveName();
  const userData = app.getPath('userData');
  const archivePath = path.join(userData, archive);
  const extractTmp = path.join(userData, '.node-extract-tmp');
  const runtimeDir = path.join(userData, 'node-runtime');

  console.log(`[dsh-desktop] downloading Node runtime: ${url}`);
  await downloadFile(url, archivePath, onProgress);
  fs.rmSync(extractTmp, { recursive: true, force: true });
  fs.mkdirSync(extractTmp, { recursive: true });
  if (archive.endsWith('.zip')) {
    await extractZip(archivePath, extractTmp);
  } else {
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', archivePath, '-C', extractTmp], (err) => {
        if (err) return reject(new Error(`解压 Node 失败: ${err.message}`));
        resolve();
      });
    });
  }
  fs.rmSync(archivePath, { force: true });

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  // node 压缩包顶层目录如 node-v22.23.1-darwin-arm64/
  const entries = fs.readdirSync(extractTmp);
  const root = entries.length === 1 ? path.join(extractTmp, entries[0]) : extractTmp;
  for (const entry of fs.readdirSync(root)) {
    fs.renameSync(path.join(root, entry), path.join(runtimeDir, entry));
  }
  fs.rmSync(extractTmp, { recursive: true, force: true });

  const bin = nodeBinInRuntime();
  if (!bin) throw new Error('Node runtime 下载后仍缺失可执行文件');
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return { installed: true, message: `node runtime installed: ${path.basename(bin)}` };
}

function systemNodeInfo() {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    const candidates = [
      process.env.DSH_NODE,
      path.join(os.homedir(), '.local', 'bin', 'node'),
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      'node',
    ].filter(Boolean);

    const check = (index) => {
      if (index >= candidates.length) return resolve(null);
      const nodePath = candidates[index];
      execFile(nodePath, ['--version'], { timeout: 3000 }, (err, stdout) => {
        if (err) return check(index + 1);
        const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(stdout).trim());
        if (!m) return check(index + 1);
        resolve({
          path: nodePath,
          major: Number(m[1]),
          minor: Number(m[2]),
          patch: Number(m[3]),
        });
      });
    };
    check(0);
  });
}

async function resolveNode(onProgress) {
  const bundled = nodeBinInRuntime();
  if (bundled) return { path: bundled, source: 'bundled' };
  if (process.env.DSH_DISABLE_SYSTEM_NODE !== '1') {
    const sys = await systemNodeInfo();
    if (sys && sys.major >= NODE_MIN_MAJOR) {
      return { path: sys.path, source: `system v${sys.major}.${sys.minor}` };
    }
  }
  // 无合格系统 Node，自动下载独立 Node 运行时
  await ensureNodeRuntime(onProgress);
  const downloaded = nodeBinInRuntime();
  if (downloaded) return { path: downloaded, source: 'downloaded' };
  return { path: null, source: `system node missing or < v${NODE_MIN_MAJOR}` };
}

function dshCommand(nodeBin) {
  if (DSH_USE_REPO) {
    // 本地源码调试：pnpm dsh
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    return { cmd: pnpm, args: ['dsh', '--profile', DSH_PROFILE, '--port', '0'], cwd: DSH_REPO };
  }
  if (app.isPackaged) {
    // 打包分发：用解析出的 node（>=22）运行下载的 dsh bin
    if (!nodeBin) {
      throw new Error('未找到 Node.js 运行时（需要 v22+），无法启动 dsh');
    }
    return {
      cmd: nodeBin,
      args: [dshRuntimeBinPath(), '--profile', DSH_PROFILE, '--port', '0'],
      cwd: dshRuntimeDir(),
    };
  }
  // dev 模式：用系统 node 跑项目内 dsh
  const bin = devDshBinPath();
  if (bin) {
    const runner = process.env.npm_node_execpath || path.join(os.homedir(), '.local', 'bin', 'node');
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
// Dsh runtime downloader — 方案 1：壳不打包 dsh，运行时从 GitHub Releases 下载
// 预打包的 dsh 运行时 zip，解压到 userData/dsh-runtime 后用 Electron node 运行。
// ---------------------------------------------------------------------------

const https = require('node:https');
const { execFile } = require('node:child_process');

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const request = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain
          return request(new URL(res.headers.location, u).href);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败: HTTP ${res.statusCode} (${u})`));
        }
        const file = fs.createWriteStream(dest);
        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress(Math.min(100, Math.round((received / total) * 100)));
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(dest); });
        file.on('error', (err) => { fs.rmSync(dest, { force: true }); reject(err); });
        res.on('error', (err) => { file.close(); fs.rmSync(dest, { force: true }); reject(err); });
      }).on('error', reject);
    };
    request(url);
  });
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-o', '-q', zipPath, '-d', destDir], (err) => {
      if (err) return reject(new Error(`解压失败: ${err.message}`));
      resolve();
    });
  });
}

/**
 * 确保 dsh 运行时已就绪并保持最新（内核自愈）：
 *  - 未安装 → 下载最新版
 *  - 已安装但本地版本 < 最新版 → 自动升级（离线时保留本地）
 * @returns {Promise<{installed: boolean, message: string}>}
 */
async function ensureDshRuntime(onProgress) {
  const installed = dshRuntimeInstalled();
  const localVersion = readInstalledDshVersion();

  // 查询最新版本（失败=离线/限流，保留本地）
  const latest = await latestDshRuntimeVersion();
  if (installed && !latest) {
    // 离线或 API 不可达：保留本地。若本地没有版本记录，补写当前基线版本。
    if (!localVersion) writeInstalledDshVersion(DSH_RUNTIME_VERSION);
    return { installed: true, message: `dsh runtime v${localVersion || DSH_RUNTIME_VERSION} (offline, keep local)` };
  }
  const target = latest || DSH_RUNTIME_VERSION;

  // 已安装且版本匹配（或本地无记录视为基线）→ 直接用
  if (installed && (!localVersion || localVersion === target)) {
    if (!localVersion) writeInstalledDshVersion(target);
    return { installed: true, message: `dsh runtime v${target} ready` };
  }

  const url = dshRuntimeDownloadUrl(target);
  const archive = dshRuntimeArchiveName();
  const runtimeDir = dshRuntimeDir();
  const zipPath = path.join(app.getPath('userData'), archive);

  console.log(`[dsh-desktop] downloading dsh runtime v${target}: ${url}`);
  await downloadFile(url, zipPath, onProgress);
  // 解压到临时目录，再移动内层 dsh-runtime 内容到目标（zip 内带 dsh-runtime/ 顶层目录）
  const extractTmp = path.join(app.getPath('userData'), '.dsh-extract-tmp');
  fs.rmSync(extractTmp, { recursive: true, force: true });
  fs.mkdirSync(extractTmp, { recursive: true });
  await extractZip(zipPath, extractTmp);
  fs.rmSync(zipPath, { force: true });

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const nested = path.join(extractTmp, 'dsh-runtime');
  const src = fs.existsSync(nested) ? nested : extractTmp;
  for (const entry of fs.readdirSync(src)) {
    fs.renameSync(path.join(src, entry), path.join(runtimeDir, entry));
  }
  fs.rmSync(extractTmp, { recursive: true, force: true });

  if (!dshRuntimeInstalled()) {
    throw new Error('dsh runtime 下载后仍缺失 bin.js');
  }
  writeInstalledDshVersion(target);
  return { installed: true, message: `dsh runtime v${target} installed` };
}

// ---------------------------------------------------------------------------
// Dsh process manager — spawns dsh web and discovers the port
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

  start(nodeBin) {
    if (this.child) return;

    const { cmd, args, cwd, env: extraEnv } = dshCommand(nodeBin);
    this._exited = false;
    this.url = null;
    this.port = null;

    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        // 打包模式用 Electron 二进制跑 dsh（纯 Node 代码）时必须，否则
        // Electron 会以 GUI 模式启动而非 node 模式。
        ...(app.isPackaged && cmd === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...(extraEnv || {}),
      },
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
// 当前窗口是否是首次下载/安装的 setup 进度窗口（true 时 createWindow 应切换为 dsh 页面）
let isSetupWindow = false;
const dsh = new DshProcess();

function ensureRegularDockApp() {
  if (process.platform !== 'darwin') return;
  app.setActivationPolicy?.('regular');
  app.dock?.show();
}

// 把窗口置前并激活应用。`open`/Launchpad 启动时应用可能尚未完全激活，
// app.focus({steal:true}) 偶尔被忽略，因此重试数次直至成功。
function bringToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    ensureRegularDockApp();
    // 强制窗口进入所有 Space 并置顶，解决"窗口存在但离屏（在其他 Space/隐藏）"
    // 导致用户看不到的问题。用户从 Dock 点开恢复窗口时特别需要。
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    app.focus({ steal: true });
  } catch (err) {
    console.error('[dsh-desktop] bringToFront error:', err.message);
  }
  // 重试几次，覆盖应用激活延迟
  let attempts = 0;
  const retry = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.moveTop();
      app.focus({ steal: true });
    } catch { /* ignore */ }
    attempts += 1;
    if (attempts < 5) setTimeout(retry, 500);
  };
  setTimeout(retry, 500);
}

// 显示首次下载/安装的进度窗口（加载 renderer/index.html）。
// 下载完成后由 createWindow(url) 切到 dsh 界面。
function showSetupWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    bringToFront();
    return;
  }
  isSetupWindow = true;
  mainWindow = null;
  mainWindow = new BrowserWindow({
    width: 560,
    height: 360,
    minWidth: 480,
    minHeight: 300,
    show: false,
    title: 'DeepSeek Harness',
    icon: resourcePath('app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on('show', bringToFront);
  mainWindow.on('closed', () => { mainWindow = null; isSetupWindow = false; });
  const setupHtml = path.join(__dirname, '..', 'renderer', 'index.html');
  mainWindow.loadFile(setupHtml);
  mainWindow.webContents.once('did-finish-load', () => {
    // 页面就绪后补发当前进度（早期 IPC 事件可能因页面未加载而丢失）
    if (lastSetupProgress) {
      emitSetupProgress(lastSetupProgress.stage, lastSetupProgress.message, lastSetupProgress.percent);
    }
  });
  mainWindow.show();
  bringToFront();
}

// 向 setup 窗口推送下载进度（IPC 事件）
// 最近一次 setup 进度（供窗口加载完成后补发）
let lastSetupProgress = null;

function emitSetupProgress(stage, message, percent) {
  lastSetupProgress = { stage, message, percent };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('setup:progress', { stage, message, percent });
  }
}

function createWindow(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (isSetupWindow) {
      // 首次下载的 setup 进度窗口已完成使命：切换到 dsh 页面
      console.log('[dsh-desktop] setup done, loading dsh UI:', url);
      isSetupWindow = false;
      mainWindow.setSize(1280, 860);
      mainWindow.loadURL(url);
      bringToFront();
    } else {
      // 正常窗口已存在：只置前，不重新 loadURL（否则页面闪动/重载）
      if (mainWindow.isMinimized()) mainWindow.restore();
      console.log('[dsh-desktop] window exists, bringToFront only (no reload)');
      bringToFront();
    }
    return;
  }
  mainWindow = null;
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

  mainWindow.on('show', bringToFront);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链在系统浏览器打开，不在应用内新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关键：立即显示窗口，不依赖 ready-to-show（它可能因页面渲染时机而
  // 不触发，导致窗口永远不弹）。页面加载中先显示，完成自动填充。
  if (url) {
    console.log('[dsh-desktop] creating new window, loadURL:', url);
    mainWindow.loadURL(url);
  }
  mainWindow.show();
  bringToFront();

  // 兜底：即使上述 show 被系统延迟，did-finish-load 后再确保显示置前
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      bringToFront();
    }
  });
  mainWindow.webContents.once('did-fail-load', (e, code, desc) => {
    console.error('[dsh-desktop] did-fail-load:', code, desc);
  });
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

// dsh lifecycle wiring
// ---------------------------------------------------------------------------

// 打包模式：dsh 运行时 + node 已就绪标记（避免重复下载/解析）
let runtimePrepared = false;
let preparedNodeBin = null;

function startDsh(nodeBin) {
  if (dsh.isRunning()) return;

  // Reap any dsh left behind by a force-killed previous Electron instance.
  cleanupOrphanDsh();

  // Drop stale listeners from any previous run so restart does not stack them.
  dsh.removeAllListeners('ready');
  dsh.removeAllListeners('exit');
  dsh.removeAllListeners('error');

  // 打包分发：首次先准备 dsh 运行时（下载解压）+ 解析 node（>=22），
  // 之后复用 runtimePrepared / preparedNodeBin，避免重复下载。
  if (app.isPackaged && !DSH_USE_REPO && !runtimePrepared) {
    // 仅在 dsh 未就绪时显示 setup 进度窗口；dsh 已装则后台准备，直接开主窗口
    const needSetup = !dshRuntimeInstalled();

    if (needSetup) {
      // 需要下载：显示进度窗口
      showSetupWindow();
      emitSetupProgress('check', '检查 dsh 运行时…', 0);
    }

    const onDshProgress = (p) => emitSetupProgress('dsh', `正在下载 dsh 运行时 ${p}%`, p);
    const onNodeProgress = (p) => emitSetupProgress('node', `正在下载 Node 运行时 ${p}%`, p);

    dsh.removeAllListeners('download-progress');
    (async () => {
      const rt = await ensureDshRuntime(onDshProgress);
      console.log(`[dsh-desktop] ${rt.message}`);
      const node = await resolveNode(onNodeProgress);
      if (!node.path) {
        throw new Error(`无法启动 dsh：${node.source}`);
      }
      return node;
    })()
      .then((node) => {
        runtimePrepared = true;
        preparedNodeBin = node.path;
        startDsh(preparedNodeBin);
      })
      .catch((err) => {
        console.error('[dsh-desktop] dsh runtime download failed:', err.message);
        dsh.emit('error', err);
      });
    return;
  }

  const bin = nodeBin || (app.isPackaged ? preparedNodeBin : undefined);
  dsh.start(bin);
  dsh.once('ready', ({ url }) => {
    try {
      createWindow(url);
    } catch (err) {
      console.error('[dsh-desktop] createWindow failed:', err);
    }
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

// 单实例锁：防止多实例。若拿不到锁，可能是上次异常退出残留的锁文件
// （SingletonLock/SingletonSocket 无对应存活主进程）。清理残留后重试一次，
// 避免"打开没反应"（新实例静默退出，却无主实例可聚焦）。
let gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 检查是否真的有存活主实例（Dock 上的应用在跑）
  const hasLiveInstance = process.platform !== 'darwin'
    ? false
    : (() => {
        try {
          // macOS 上 Electron 用 SingletonSocket；若 socket 对应的进程已死，
          // 锁是残留。这里直接清理 userData 的锁文件后重试。
          const { execFileSync } = require('node:child_process');
          execFileSync('pgrep', ['-f', 'DshDesktop.app/Contents/MacOS'], { stdio: 'ignore' });
          return true; // 有主进程在跑
        } catch {
          return false; // 无主进程，锁是残留
        }
      })();

  if (hasLiveInstance) {
    // 真有主实例：让它聚焦窗口（发 second-instance 语义——新实例退出前通知）
    app.quit();
  } else {
    // 无存活主实例：清理残留锁文件，重新获取锁
    try {
      const userData = app.getPath('userData');
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.rmSync(path.join(userData, f), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
    }
  }
}

if (gotLock) {
  // 用户再次打开（Dock 点击 / 启动台 / 第二实例）时：恢复并置前主窗口。
  // 关键：窗口可能已存在但离屏（在另一 Space / 最小化 / 隐藏），必须强制
  // 带回当前 Space 并显示，否则用户看到"打开了但没页面"。
  const restoreMainWindow = () => {
    if (!dsh.url) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 窗口已存在：只置前，不重新 loadURL（否则页面闪动/重载）
      if (mainWindow.isMinimized()) mainWindow.restore();
      bringToFront();
    } else {
      createWindow(dsh.url);
    }
  };

  app.on('second-instance', restoreMainWindow);

  app.whenReady().then(() => {
    // Keep this as a regular foreground app. The tray is an additional control
    // surface; it must not turn the app into a menu-bar-only process.
    ensureRegularDockApp();

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
      } else {
        restoreMainWindow();
      }
    });
  });

  // Dock 右键退出 / Cmd+Q：真正退出（macOS 标准行为）。
  // 红点关闭窗口走 window-all-closed，保留托盘驻留。
  app.on('before-quit', () => {
    if (!isQuitting) isQuitting = true;
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
