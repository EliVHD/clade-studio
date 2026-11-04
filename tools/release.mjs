import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkDistribution } from './distribution-policy.mjs';
import { loadReleaseReview, readRegular, releaseManifest, verifyReleaseFiles, verifyBuildInputs, sha256 } from './release-manifest.mjs';
import { verifyBuildIdentity } from '../src/provenance/identity.ts';
import { zipFiles } from '../src/export.ts';

const context = await loadReleaseReview();
const info = JSON.parse(await readRegular('dist', 'build-info.json'));
const build = JSON.parse(await readRegular('dist', 'build-manifest.json'));
await verifyBuildIdentity(info, build);
if (info.appVersion !== context.pkg.version) throw new Error('Application version changed; rebuild before packaging.');
await verifyBuildInputs('.', JSON.parse(await readRegular('dist', 'build-inputs.json')), context);
const browserPaths = [...build.files.map(file => file.path), 'build-info.json', 'build-manifest.json'];
await checkDistribution('dist', browserPaths);
for (const file of build.files) {
  const bytes = await readRegular('dist', file.path);
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Rebuild before packaging: ${file.path}`);
}
const browserOrigin = path => path.startsWith('app/') ? `src/${path.slice(4, -3)}.ts`
  : path.startsWith('data/') ? path
  : path === 'LICENSE' ? 'LICENSE'
  : path === 'REDISTRIBUTION.md' ? path
  : ['build-info.json', 'build-manifest.json', 'build-inputs.json', 'redistribution.json'].includes(path) ? 'tools/build.mjs'
  : `public/${path}`;
const browser = await Promise.all(browserPaths.map(async path => ({ path, origin: browserOrigin(path), bytes: await readRegular('dist', path) })));
const source = await Promise.all([...context.index.keys()].map(async origin => ({ path: origin === 'release/SOURCE_README.md' ? 'README.md' : origin, origin, bytes: await readRegular('.', origin) })));
// Retain the README template too so source archives can reproduce themselves.
source.push({ path: 'release/SOURCE_README.md', origin: 'release/SOURCE_README.md', bytes: await readRegular('.', 'release/SOURCE_README.md') });
await mkdir('outputs/releases', { recursive: true });
for (const [profile, entries] of [['browser', browser], ['source', source]]) {
  const manifest = releaseManifest(profile, entries, context, info.buildId);
  const staging = await mkdtemp('outputs/releases/.check-');
  try {
    const texts = {};
    for (const entry of entries) {
      await mkdir(dirname(join(staging, entry.path)), { recursive: true });
      await writeFile(join(staging, entry.path), entry.bytes);
      texts[entry.path] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.bytes);
    }
    texts['release-manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(join(staging, 'release-manifest.json'), texts['release-manifest.json']);
    await checkDistribution(staging, Object.keys(texts));
    await verifyReleaseFiles(staging, manifest);
    const archive = `outputs/releases/clade-studio-${context.pkg.version}-${profile}.zip`;
    const zip = zipFiles(Object.fromEntries(Object.entries(texts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    await writeFile(archive, zip);
    await writeFile(`${archive}.sha256`, `${sha256(zip)}  ${archive.split('/').at(-1)}\n`);
    await writeFile(`outputs/releases/${profile}-manifest.json`, texts['release-manifest.json']);
    console.log(`${profile}: ${Object.keys(texts).length} files, ${zip.byteLength} bytes; ${archive}`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
console.log(`Exporting build ${info.buildId}; no publication performed.`);
