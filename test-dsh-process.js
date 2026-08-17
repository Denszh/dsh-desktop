// Standalone test for the DshProcess spawn/kill logic (no Electron GUI).
// Usage: node test-dsh-process.js
'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const DSH_REPO = process.env.DSH_REPO || path.join(os.homedir(), 'personal', 'deepseek-harness');
const DSH_PROFILE = process.env.DSH_PROFILE || 'web';
const DEFAULT_DSH_ARGS = ['dsh', '--profile', DSH_PROFILE, '--port', '0'];

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
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    this._exited = false;
    const child = spawn(pnpm, DEFAULT_DSH_ARGS, {
      cwd: DSH_REPO,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stdout.write(`[dsh:err] ${chunk}`));
    child.on('error', (err) => this.emit('error', err));
    child.on('exit', (code, signal) => {
      this._exited = true;
      this.child = null;
      this.emit('exit', { code, signal });
    });
  }

  _onStdout(chunk) {
    process.stdout.write(`[dsh:out] ${chunk}`);
    this._buffer += chunk;
    const match = this._buffer.match(/dsh web:\s*(http:\/\/[^\s]+)/);
    if (match && !this.url) {
      this.url = match[1];
      try { this.port = Number(new URL(this.url).port); } catch { this.port = null; }
      this.emit('ready', { url: this.url, port: this.port });
    }
    if (this._buffer.length > 65536) this._buffer = this._buffer.slice(-65536);
  }

  isRunning() { return Boolean(this.child) && !this._exited; }

  stop() {
    if (!this.child) return;
    const child = this.child;
    const pid = child.pid;
    console.log(`[test] stop(): child pid=${pid}`);
    if (pid && process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGTERM'); } catch (e) { console.log(`[test] kill(-${pid}) group failed: ${e.message}`); }
    } else {
      try { child.kill('SIGTERM'); } catch (e) { console.log(`[test] child.kill failed: ${e.message}`); }
    }
    const timer = setTimeout(() => {
      try {
        if (pid && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    }, 5000);
    timer.unref();
  }

  async waitForExit(timeoutMs = 8000) {
    if (!this.child) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
  }
}

async function main() {
  const dsh = new DshProcess();
  dsh.start();
  await new Promise((resolve) => {
    dsh.once('ready', resolve);
    dsh.once('error', (e) => { console.error('start error:', e.message); process.exit(1); });
  });
  console.log(`[test] READY url=${dsh.url}`);
  const { execSync } = require('node:child_process');
  const port = dsh.port;
  const check = () => {
    try { execSync(`lsof -iTCP:${port} -sTCP:LISTEN -n -P 2>/dev/null`); return true; } catch { return false; }
  };
  console.log(`[test] before stop, port ${port} listening: ${check()}`);

  // Find all descendant pids before kill
  const pgrep = (pat) => {
    try { return execSync(`ps aux | grep -E "${pat}" | grep -v grep | awk '{print $2}'`).toString().trim().split('\n').filter(Boolean); } catch { return []; }
  };
  console.log(`[test] dsh-related pids before: ${JSON.stringify(pgrep('bin.ts.*profile web|pnpm.mjs dsh'))}`);

  dsh.stop();
  // Poll for port release instead of relying on the exit event (detached
  // process groups do not always emit 'exit' on the parent handle).
  const deadline = Date.now() + 8000;
  let exited = false;
  while (Date.now() < deadline) {
    const { execSync } = require('node:child_process');
    try { execSync(`lsof -iTCP:${port} -sTCP:LISTEN -n -P 2>/dev/null`); } catch { exited = true; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`[test] stop() done, port released: ${exited}`);
  console.log(`[test] after stop, port ${port} listening: ${check()}`);
  const after = pgrep('bin.ts.*profile web|pnpm.mjs dsh');
  console.log(`[test] dsh-related pids after: ${JSON.stringify(after)}`);
  if (after.length > 0) {
    console.log('[test] FAIL: orphaned processes remain');
    after.forEach(pid => { try { process.kill(Number(pid), 'SIGKILL'); } catch {} });
    process.exit(1);
  }
  console.log('[test] PASS: clean teardown');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
