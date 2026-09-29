import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const frontendArgs = process.argv.slice(2);
const children = [];
let stopping = false;

function startService(name, args) {
  const child = spawn(npm, args, { stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => {
    console.error(`[${name}] failed to start:`, error.message);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[${name}] exited (${signal ?? code ?? 'unknown'}); stopping the other service.`);
      stop(code ?? 1);
    }
  });
  return child;
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  }))).then(() => process.exit(exitCode));
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function waitForBackend(child) {
  while (!stopping && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch('http://127.0.0.1:3000/api/health');
      if (response.ok) return true;
    } catch {
      // The backend is still building or starting; retry until it listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

console.log('Starting Relay backend. The frontend will start when the backend is ready. Press Ctrl+C to stop.');
const backend = startService('backend', ['run', 'dev:backend']);
if (await waitForBackend(backend)) {
  if (!stopping) {
    console.log('Backend is ready; starting Relay frontend.');
    startService('frontend', ['run', 'dev', ...(frontendArgs.length ? ['--', ...frontendArgs] : [])]);
  }
}
