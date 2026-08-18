'use strict';

// dsh-desktop app self-update via electron-updater.
//
// The packaged app checks GitHub Releases (owner/repo from electron-builder
// `publish` config) for a newer version. When one is found it downloads the
// new dmg/zip and applies it on quit — the standard "app auto-update" flow.
//
// Auto-update can be disabled at build time. The release workflow writes a
// build config `src/main/auto-update-config.json` (`{"enabled": false}`) for
// unsigned macOS builds, because electron-updater cannot update an unsigned
// app. When the file is absent (local dev, signed builds) updates stay on.

const fs = require('node:fs');
const path = require('node:path');

function readAutoUpdateEnabled() {
  try {
    const cfgPath = path.join(__dirname, 'auto-update-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return cfg.enabled !== false;
    }
  } catch { /* default enabled */ }
  return true;
}

/**
 * Set up electron-updater for the packaged app. No-op in dev (electron-updater
 * refuses to run unpackaged). Returns a disposer.
 * @param {object} deps - {app, autoUpdater, onStatus, onUpdateDownloaded}
 * @returns {() => void} disposer that stops timers.
 */
function setupAppUpdater({ app, autoUpdater, onStatus, onUpdateDownloaded }) {
  if (!app.isPackaged) {
    onStatus({ kind: 'no-updater', message: 'dev mode: app self-update disabled' });
    return () => {};
  }
  if (!autoUpdater) {
    onStatus({ kind: 'no-updater', message: 'electron-updater not installed' });
    return () => {};
  }
  if (!readAutoUpdateEnabled()) {
    onStatus({ kind: 'no-updater', message: 'auto-update disabled for this build (unsigned)' });
    return () => {};
  }

  const notify = (kind, message) => onStatus({ kind, message });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => notify('checking', 'Checking for updates…'));
  autoUpdater.on('update-available', (info) => notify('available', `New version ${info.version} available`));
  autoUpdater.on('update-not-available', () => notify('not-available', 'You are up to date'));
  autoUpdater.on('download-progress', (p) => {
    if (p && typeof p.percent === 'number') {
      notify('downloading', `Downloading ${p.percent.toFixed(0)}%`);
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    notify('downloaded', `Update ${info.version} downloaded — restart to apply`);
    if (onUpdateDownloaded) onUpdateDownloaded(info);
  });
  autoUpdater.on('error', (err) => notify('error', `Update error: ${err && err.message ? err.message : String(err)}`));

  const check = () => {
    try {
      autoUpdater.checkForUpdates().catch((e) => notify('error', `Check failed: ${e.message}`));
    } catch (e) {
      notify('error', `Check failed: ${e.message}`);
    }
  };

  // Check shortly after launch, then periodically (every 6h).
  const first = setTimeout(check, 30 * 1000);
  const interval = setInterval(check, 6 * 60 * 60 * 1000);

  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}

module.exports = { setupAppUpdater };
