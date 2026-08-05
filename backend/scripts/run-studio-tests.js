import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const playwrightArgs = ['test'];

if (!live) {
  playwrightArgs.push('tests/studio-smoke.spec.js');
  playwrightArgs.push('tests/studio-edge.spec.js');
}

const child = spawn(
  process.execPath,
  [path.join(backendRoot, 'node_modules', '@playwright', 'test', 'cli.js'), ...playwrightArgs],
  {
    cwd: backendRoot,
    env: {
      ...process.env,
      FACTLENS_RUN_LIVE: live ? '1' : process.env.FACTLENS_RUN_LIVE || '',
    },
    stdio: 'inherit',
  },
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
