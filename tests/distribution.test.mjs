import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkDistribution } from '../tools/distribution-policy.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'clade-distribution-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('distribution accepts only the exact reviewed inventory', () => fixture(async root => {
  await writeFile(join(root, 'index.html'), '<p>Original application</p>');
  assert.deepEqual(await checkDistribution(root, ['index.html']), ['index.html']);
  await writeFile(join(root, 'reference.png'), 'old build artifact');
  await assert.rejects(checkDistribution(root, ['index.html']), /Unexpected: reference.png/);
}));
test('distribution rejects missing notices and even explicitly listed image assets', () => fixture(async root => {
  await assert.rejects(checkDistribution(root, ['third-party-notices.html']), /Missing: third-party-notices.html/);
  await writeFile(join(root, 'figure.pdf'), 'research document');
  await assert.rejects(checkDistribution(root, ['figure.pdf']), /excluded from this release/);
}));
test('renaming or embedding excluded bytes does not evade content checking', () => fixture(async root => {
  const bytes = Buffer.from('synthetic private-image fixture');
  const hashes = new Set([createHash('sha256').update(bytes).digest('hex')]);
  await writeFile(join(root, 'app.js'), bytes);
  await assert.rejects(checkDistribution(root, ['app.js'], hashes), /Excluded reference content/);
  await writeFile(join(root, 'app.js'), `const image = "data:image/png;base64,${bytes.toString('base64')}";`);
  await assert.rejects(checkDistribution(root, ['app.js'], hashes), /Embedded excluded reference/);
}));
test('distribution cannot include a symlink to private files', () => fixture(async root => {
  await writeFile(join(root, 'private.txt'), 'private');
  await symlink(join(root, 'private.txt'), join(root, 'app.js'));
  await assert.rejects(checkDistribution(root, ['private.txt', 'app.js']), /symlinks/);
}));
