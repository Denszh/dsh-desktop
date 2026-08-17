'use strict';

// dsh-desktop app self-update via electron-updater.
//
// The packaged app checks GitHub Releases (owner/repo from electron-builder
// `publish` config) for a newer version. When one is found it downloads the
// new dmg/zip and applies it on quit — the standard "app auto-update" flow,
// exactly like mkagent's electron-updater usage.

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
