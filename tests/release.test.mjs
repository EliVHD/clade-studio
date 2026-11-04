import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexReview, dependencyInventory, releaseManifest, readRegular, verifyReleaseFiles, verifyBuildInputs, sha256 } from '../tools/release-manifest.mjs';

const component = { id: 'original', role: 'original-software', decision: 'include', licenseExpression: '0BSD', files: ['app.js'], evidence: ['user-policy'], obligations: [] };
const review = () => ({ format: 'clade-component-review', version: 1, components: [structuredClone(component)], excludedMaterial: ['private images'] });
async function fixture(action) { const root = await mkdtemp(join(tmpdir(), 'clade-release-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }

test('unresolved, duplicate and unpinned upstream components are rejected', () => {
  assert.equal(indexReview(review()).get('app.js').licenseExpression, '0BSD');
  for (const changes of [{ decision: 'needs-clarification' }, { licenseExpression: '' }, { files: ['../private'] }, { role: 'third-party-data' }]) assert.throws(() => indexReview({ ...review(), components: [{ ...component, ...changes }] }));
  assert.throws(() => indexReview({ ...review(), components: [component, { ...component, id: 'duplicate-path' }] }));
});
test('runtime dependencies and changes to the reviewed lock cannot enter silently', () => {
  const pkg = { license: '0BSD', devDependencies: { typescript: '7.0.2' } };
  const lock = { packages: { '': pkg, 'node_modules/typescript': { version: '7.0.2', dev: true, license: 'Apache-2.0', integrity: 'example-fixture' } } };
  const bytes = Buffer.from(JSON.stringify(lock)), policy = { reviewedDependencyLockSha256: sha256(bytes) };
  assert.equal(dependencyInventory(pkg, lock, bytes, policy)[0].distributed, false);
  assert.throws(() => dependencyInventory({ ...pkg, dependencies: { foreign: '1' } }, lock, bytes, policy), /runtime/);
  assert.throws(() => dependencyInventory(pkg, lock, Buffer.from('changed'), policy), /lock changed/);
  assert.throws(() => dependencyInventory({ ...pkg, devDependencies: {} }, lock, bytes, policy), /declarations/);
});
test('release inventory records separate terms and detects changed, missing and extra payloads', () => fixture(async root => {
  const data = { ...component, id: 'data', role: 'third-party-data', licenseExpression: 'CC-BY-4.0', files: ['source.nwk'], sha256: { 'source.nwk': sha256(Buffer.from('(A,B);')) }, obligations: ['attribution'] };
  const policy = { ...review(), components: [component, data] };
  const context = { review: policy, index: indexReview(policy), pkg: { version: '0.1.0' }, dependencies: [] };
  const entries = [{ path: 'app.js', origin: 'app.js', bytes: Buffer.from('app') }, { path: 'source.nwk', origin: 'source.nwk', bytes: Buffer.from('(A,B);') }];
  const manifest = releaseManifest('browser', entries, context, 'a'.repeat(64));
  assert.deepEqual(manifest.files.map(file => file.licenseExpression), ['0BSD', 'CC-BY-4.0']);
  assert.throws(() => releaseManifest('browser', [{ ...entries[0], origin: 'unknown' }], context, null), /reviewed/);
  for (const entry of entries) await writeFile(join(root, entry.path), entry.bytes);
  await writeFile(join(root, 'release-manifest.json'), JSON.stringify(manifest));
  await verifyReleaseFiles(root, manifest);
  await writeFile(join(root, 'source.nwk'), '(C,D);');
  await assert.rejects(verifyReleaseFiles(root, manifest), /file changed/);
  await writeFile(join(root, 'source.nwk'), '(A,B);');
  await writeFile(join(root, 'picture.png'), 'extra');
  await assert.rejects(verifyReleaseFiles(root, manifest), /inventory/);
  await rm(join(root, 'picture.png')); await rm(join(root, 'app.js'));
  await assert.rejects(verifyReleaseFiles(root, manifest), /inventory/);
}));
test('source packaging rejects both file and parent-directory symlinks', () => fixture(async root => {
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'private', 'secret.txt'), 'reference');
  await symlink(join(root, 'private'), join(root, 'public'));
  await symlink(join(root, 'private', 'secret.txt'), join(root, 'app.js'));
  await assert.rejects(readRegular(root, 'public/secret.txt'), /symlink/);
  await assert.rejects(readRegular(root, 'app.js'), /symlink/);
  await assert.rejects(readRegular(root, '../outside'), /Unsafe/);
}));
test('packaging rejects stale builds even when the old browser payload still matches its own stamp', () => fixture(async root => {
  const context = { index: new Map([['app.js', component]]) };
  const bytes = Buffer.from('original');
  const inputs = { format: 'clade-build-inputs', version: 1, files: [{ path: 'app.js', bytes: bytes.length, sha256: sha256(bytes) }] };
  await writeFile(join(root, 'app.js'), bytes);
  await verifyBuildInputs(root, inputs, context);
  await writeFile(join(root, 'app.js'), 'edited');
  await assert.rejects(verifyBuildInputs(root, inputs, context), /rebuild/);
  await assert.rejects(verifyBuildInputs(root, { ...inputs, files: [] }, context), /rebuild/);
}));
