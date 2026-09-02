// Turns dist/release.json (written by build-release.mjs) into the markdown
// body of a GitHub Release. Used by .github/workflows/release.yml.
//
// Usage: node tools/release-notes.mjs dist/release.json > dist/NOTES.md

import fs from 'node:fs';

const file = process.argv[2] || 'dist/release.json';
const release = JSON.parse(fs.readFileSync(file, 'utf8'));
const version = release.version || 'unknown';
const isPre = /-/.test(version);

const lines = [];
lines.push(`StickOS ${version}${isPre ? ' (pre-release, for testing on a stick)' : ''}`);
lines.push('');
lines.push('Start Button downloads the zip for its platform from this release, then fetches the engine, the model, and the voices on first run.');
lines.push('');
lines.push('| file | size | sha256 |');
lines.push('|---|---|---|');
for (const f of release.files || []) {
  const mb = (f.size / 1048576).toFixed(1);
  lines.push(`| ${f.name} | ${mb} MB | ${f.sha256} |`);
}
lines.push('');
lines.push('installer.html is the single-file installer page for the website. release.json is the same table as JSON.');
process.stdout.write(lines.join('\n') + '\n');
