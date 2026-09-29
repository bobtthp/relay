import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const frontendArgs = process.argv.slice(2);
const services = [
  ['backend', ['run', 'dev:backend']],
  ['frontend', ['run', 'dev', ...(frontendArgs.length ? ['--', ...frontendArgs] : [])]],
];

const children = services.map(([name, args]) => {
  const child = spawn(npm, args, { stdio: 'inherit' });
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
});

let stopping = false;

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

console.log('Relay frontend and backend are starting. Press Ctrl+C to stop both.');
