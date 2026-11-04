import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const logDirectory = fileURLToPath(new URL('../.local/wrangler-logs/', import.meta.url));
mkdirSync(logDirectory, { recursive: true });
const wranglerDirectory = dirname(require.resolve('wrangler/package.json'));
const args = process.argv.slice(2);
const privateBindings = fileURLToPath(new URL('../.local/email-bindings.json', import.meta.url));
if (['deploy', 'dev'].includes(args[0]) && existsSync(privateBindings)) {
  const index = args.indexOf('--config');
  const source = index >= 0 ? resolve(args[index + 1]) : resolve('wrangler.jsonc');
  const config = JSON.parse(readFileSync(source, 'utf8').replace(/,(\s*[}\]])/g, '$1'));
  const directory = dirname(source);
  config.main = resolve(directory, config.main);
  if (config.assets) config.assets.directory = resolve(directory, config.assets.directory);
  for (const binding of config.d1_databases ?? [])
    if (binding.migrations_dir) binding.migrations_dir = resolve(directory, binding.migrations_dir);
  config.send_email = JSON.parse(readFileSync(privateBindings, 'utf8'));
  const generated = fileURLToPath(
    new URL('../.local/deployment/wrangler-email.json', import.meta.url),
  );
  mkdirSync(dirname(generated), { recursive: true });
  writeFileSync(generated, JSON.stringify(config, null, 2));
  if (index >= 0) args[index + 1] = generated;
  else args.push('--config', generated);
}
const result = spawnSync(
  process.execPath,
  [resolve(wranglerDirectory, 'bin/wrangler.js'), ...args],
  {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_LOG_PATH: logDirectory, WRANGLER_SEND_METRICS: 'false' },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
