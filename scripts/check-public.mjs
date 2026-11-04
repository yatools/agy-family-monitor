// Validate only publishable Git files. Never print matched secret contents.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const issues = [];
const privatePath =
  /(^|\/)(\.local|\.upstream|node_modules|dist|artifacts|target|\.wrangler)(\/|$)|(^|\/)wrangler\.jsonc$|\.(?:db|db-shm|db-wal|exe|pfx|p12|pem|key|zip|log)$/i;
const signatures = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9_]{24,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/],
  ['cloudflare-oauth', /oauth_token\s*=\s*["'][^"']{20,}["']/],
  ['local-user-path', /[A-Z]:[\\/]Users[\\/][^\s"'<>]+/i],
];
for (const name of paths) {
  if (privatePath.test(name) || (/(^|\/)\.env(?:\.|$)/.test(name) && !name.endsWith('.example')))
    issues.push([name, 'private-path']);
  const path = resolve(root, name);
  if (relative(root, path).startsWith('..') || lstatSync(path).isSymbolicLink()) {
    issues.push([name, 'unsafe-path']);
    continue;
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const source = bytes.toString('utf8');
  for (const [type, pattern] of signatures) if (pattern.test(source)) issues.push([name, type]);
}
for (const name of ['README.md', 'README.en.md']) {
  const source = readFileSync(resolve(root, name), 'utf8');
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1].split('#')[0];
    if (!link || /^(?:https?:|mailto:)/.test(link)) continue;
    if (!existsSync(resolve(root, link))) issues.push([name, 'missing-link:' + link]);
  }
}
if (issues.length) {
  console.error(JSON.stringify({ issues }, null, 2));
  process.exit(1);
}
console.log(
  `Public file check passed: ${paths.length} files; both READMEs have valid local links.`,
);
