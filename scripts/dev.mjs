import { spawn } from 'node:child_process';
const env = {
  ...process.env,
  PORT: '4174',
  DEV_ORIGIN: 'http://127.0.0.1:5173',
};
const api = spawn(
  process.execPath,
  ['--env-file-if-exists=.env', 'server/index.mjs'],
  { stdio: 'inherit', env },
);
const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
  stdio: 'inherit',
});
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  api.kill('SIGTERM');
  ui.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
api.on('exit', (code) => close(code ?? 0));
ui.on('exit', (code) => close(code ?? 0));
