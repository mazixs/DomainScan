import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotes } from '../scripts/release-notes.mjs';

test('release notes select only the exact requested version and preserve subheadings', () => {
  const changelog = '# Changelog\n\n## [0.8.10] - 2026-10-07\n\nFuture\n\n## [0.8.1] - 2026-10-06\n\n### Fixed\n\n- Passive mode.\n\n## [0.8.0] - 2026-09-26\n\nPrevious\n';
  assert.equal(releaseNotes(changelog, '0.8.1'), '### Fixed\n\n- Passive mode.\n');
});

test('release notes reject a missing or empty entry before publication', () => {
  assert.throws(() => releaseNotes('## [0.8.0] - 2026-09-26\nPrevious', '0.8.1'), /missing/);
  assert.throws(() => releaseNotes('## [0.8.1] - 2026-10-06\n\n## [0.8.0] - 2026-09-26\nPrevious', '0.8.1'), /empty/);
});

test('release notes reject unsafe version values and normalize Windows line endings', () => {
  assert.throws(() => releaseNotes('', '../release'), /Invalid/);
  assert.equal(releaseNotes('## [0.8.1] - 2026-10-06\r\n\r\nNotes\r\n', '0.8.1'), 'Notes\n');
});
