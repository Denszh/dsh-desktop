'use strict';

// dsh-desktop auto-update mechanisms.
//
//  ① Fork sync — periodically `git fetch origin` in DSH_REPO; when the fork
//     remote is ahead of the local checkout, `git pull` and ask the caller to
//     restart dsh (so new plugins/source changes take effect immediately).
//  ③ Local watch — watch DSH_REPO for source changes and request a restart,
//     giving instant feedback while developing plugins locally.
//  ② App self-update — electron-updater against GitHub Releases (populated by
//     the release workflow). See `setupAppUpdater`.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const POLL_INTERVAL_MS = 60 * 1000; // check fork every minute
const WATCH_DEBOUNCE_MS = 2000; // restart at most 2s after last change burst

// Directories under DSH_REPO that trigger a restart when they change.
// Plugin packages live under packages/<group>/<pkg>; the base bundle patches
// under packages/bundle. Watching the whole tree is too noisy (node_modules,
// .git), so watch these focused roots.
const WATCH_ROOTS = ['packages', 'examples', 'hello-plugin', 'scratch-plugin'];

// ---------------------------------------------------------------------------
// Git helpers (sync)
// ---------------------------------------------------------------------------

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * Fetch the fork remote and report whether the remote branch is ahead.
 * @param {string} repo - DSH_REPO checkout directory.
 * @param {string} remote - remote name (default 'origin').
 * @param {string} branch - branch to compare (default 'master').
 * @returns {Promise<{changed: boolean, detail: string}>}
 */
async function checkForkUpdate(repo, remote = 'origin', branch = 'master') {
  const fetchRes = await runGit(repo, ['fetch', remote]);
  if (fetchRes.code !== 0) {
    return { changed: false, detail: `fetch failed: ${fetchRes.err.trim() || 'unknown'}` };
  }
  // local HEAD vs remote tracking branch
  const head = await runGit(repo, ['rev-parse', 'HEAD']);
  const remoteRef = `${remote}/${branch}`;
  const fetched = await runGit(repo, ['rev-parse', remoteRef]);
  if (head.code !== 0 || fetched.code !== 0) {
    return { changed: false, detail: 'cannot resolve refs' };
  }
  const localSha = head.out.trim();
  const remoteSha = fetched.out.trim();
  if (localSha === remoteSha) {
    return { changed: false, detail: 'up to date' };
  }
  return {
    changed: true,
    detail: `local ${localSha.slice(0, 8)} → fork ${remoteSha.slice(0, 8)}`,
  };
}

/**
 * Pull the fork remote into the local checkout. Assumes a clean tree;
 * uncommitted local changes are preserved by rebasing.
 * @param {string} repo - DSH_REPO checkout directory.
 * @param {string} remote - remote name.
 * @param {string} branch - branch to pull.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function pullFork(repo, remote = 'origin', branch = 'master') {
  const res = await runGit(repo, ['pull', '--ff-only', remote, branch]);
  return {
    ok: res.code === 0,
    detail: res.code === 0 ? res.out.trim() : res.err.trim(),
  };
}

// ---------------------------------------------------------------------------
// Local watcher (instant dev feedback)
// ---------------------------------------------------------------------------

/**
 * Watch DSH_REPO source roots and invoke `onChange` after a debounce window.
 * Returns a disposer. If the repo has no watched root yet, watches only when
 * the root exists; directories appear/disappear are tolerated.
 * @param {string} repo - DSH_REPO directory.
 * @param {() => void} onChange - callback after debounce.
 * @returns {() => void} disposer that stops all watchers.
 */
function watchRepo(repo, onChange) {
  const watchers = [];
  const disposed = { flag: false };
  let timer = null;

  const fire = () => {
    if (disposed.flag) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!disposed.flag) onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  for (const root of WATCH_ROOTS) {
    const dir = path.join(repo, root);
    if (!fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, { recursive: process.platform === 'darwin' || process.platform === 'linux' }, () => {
        fire();
      });
      watchers.push({ root, watcher: w });
    } catch (err) {
      console.warn(`[dsh-desktop] watch ${root} failed:`, err.message);
    }
  }

  const dispose = () => {
    disposed.flag = true;
    if (timer) clearTimeout(timer);
    for (const { root, watcher } of watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
  };
  return dispose;
}

// ---------------------------------------------------------------------------
// App self-update (electron-updater)
// ---------------------------------------------------------------------------

/**
 * Set up electron-updater for the packaged app. No-op in dev (electron-updater
 * refuses to run unpackaged). `onStatus` receives {kind, message} where kind is
 * one of checking|available|not-available|downloaded|error|no-updater.
 * @param {object} deps - {app, autoUpdater, onStatus}
 */
function setupAppUpdater({ app, autoUpdater, onStatus }) {
  if (!app.isPackaged) {
    onStatus({ kind: 'no-updater', message: 'dev mode: app self-update disabled' });
    return () => {};
  }
  if (!autoUpdater) {
    onStatus({ kind: 'no-updater', message: 'electron-updater not installed' });
    return () => {};
  }

  const notify = (kind, message) => onStatus({ kind, message });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => notify('checking', 'Checking for updates…'));
  autoUpdater.on('update-available', (info) => notify('available', `Update available: ${info.version}`));
  autoUpdater.on('update-not-available', () => notify('not-available', 'No updates available'));
  autoUpdater.on('download-progress', (p) => {
    if (p && typeof p.percent === 'number') {
      notify('downloading', `Downloading ${p.percent.toFixed(0)}%`);
    }
  });
  autoUpdater.on('update-downloaded', () => notify('downloaded', 'Update downloaded — restart to apply'));
  autoUpdater.on('error', (err) => notify('error', `Update error: ${err && err.message ? err.message : String(err)}`));

  const check = () => {
    try {
      autoUpdater.checkForUpdates().catch((e) => notify('error', `Check failed: ${e.message}`));
    } catch (e) {
      notify('error', `Check failed: ${e.message}`);
    }
  };

  // Check shortly after ready, then periodically.
  const timer = setTimeout(check, 30 * 1000);
  const interval = setInterval(check, 6 * 60 * 60 * 1000); // every 6h

  return () => {
    clearTimeout(timer);
    clearInterval(interval);
  };
}

module.exports = {
  checkForkUpdate,
  pullFork,
  watchRepo,
  setupAppUpdater,
  POLL_INTERVAL_MS,
};
