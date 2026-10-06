import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseNotes(changelog, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  const heading = `## [${version}] - `;
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) throw new Error(`Changelog entry is missing for ${version}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim();
  if (!body) throw new Error(`Changelog entry is empty for ${version}`);
  return `${body}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  process.stdout.write(releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), manifest.version));
}
