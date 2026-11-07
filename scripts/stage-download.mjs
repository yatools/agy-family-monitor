import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const exe = root + 'artifacts/AgyFamilyMonitor.exe';
if (existsSync(exe)) {
  const publicDownloads = root + 'apps/web/public/downloads/';
  mkdirSync(publicDownloads, { recursive: true });
  copyFileSync(exe, publicDownloads + 'AgyFamilyMonitor.exe');
  const output = root + 'apps/web/dist/downloads/';
  mkdirSync(output, { recursive: true });
  copyFileSync(exe, output + 'AgyFamilyMonitor.exe');
  for (const [source, name] of [
    ['LICENSE', 'LICENSE.txt'],
    ['licenses/CC-Switch-MIT.txt', 'CC-Switch-MIT.txt'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ['docs/INSTALLATION.md', 'INSTALLATION.md'],
    ['docs/MONITORING.md', 'MONITORING.md'],
    ['docs/MEMBERS.md', 'MEMBERS.md'],
  ])
    copyFileSync(root + source, output + name);
  const bytes = readFileSync(exe);
  writeFileSync(
    output + 'release.json',
    JSON.stringify(
      {
        version: JSON.parse(readFileSync(root + 'package.json', 'utf8')).version,
        platform: 'windows-x64',
        file: 'AgyFamilyMonitor.exe',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      },
      null,
      2,
    ),
  );
  console.log('Windows client and license notices staged for download.');
}
