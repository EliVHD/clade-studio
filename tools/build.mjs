import { dirname } from 'node:path';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runtimePublicFiles, runtimeDataFiles, runtimeModuleFiles, checkDistribution } from './distribution-policy.mjs';
import { loadReleaseReview, releaseManifest, readRegular, sha256 } from './release-manifest.mjs';
import { contentDigest } from '../src/provenance/identity.ts';

const context = await loadReleaseReview();
// dist is generated output. Rebuild it so an old reference image cannot survive.
await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
await mkdir('dist/data', { recursive: true });
for (const name of runtimePublicFiles) await cp(`public/${name}`, `dist/${name}`);
await cp('LICENSE', 'dist/LICENSE');
await cp('REDISTRIBUTION.md', 'dist/REDISTRIBUTION.md');
for (const name of runtimeDataFiles.filter(name => name !== 'source_manifest.json')) { await mkdir(dirname(`dist/data/${name}`), { recursive: true }); await cp(`data/${name}`, `dist/data/${name}`); }
const manifest = JSON.parse(await readFile('data/source_manifest.json', 'utf8'));
// The research manifest also describes private publisher PDFs. Ship only the input used by the app.
manifest.files = manifest.files.filter(file => file.file === 'data/source_tree.nwk');
await writeFile('dist/data/source_manifest.json', JSON.stringify(manifest, null, 2) + '\n');
const modules = await runtimeModuleFiles('src');
const inputs = [...runtimePublicFiles.map(path => ({ path, origin: `public/${path}` })), ...runtimeDataFiles.map(name => ({ path: `data/${name}`, origin: `data/${name}` })), ...modules.map(path => ({ path, origin: `src/${path.slice(4, -3)}.ts` })), { path: 'LICENSE', origin: 'LICENSE' }, { path: 'REDISTRIBUTION.md', origin: 'REDISTRIBUTION.md' }];
const entries = await Promise.all(inputs.map(async entry => ({ ...entry, bytes: await readRegular('dist', entry.path) })));
const rights = { ...releaseManifest('browser-content', entries, context, null), format: 'clade-distribution-rights' };
await writeFile('dist/redistribution.json', JSON.stringify(rights, null, 2) + '\n');
const sourceInputs = await Promise.all([...context.index.keys()].sort().map(async path => { const bytes = await readRegular('.', path); return { path, bytes: bytes.length, sha256: sha256(bytes) }; }));
await writeFile('dist/build-inputs.json', JSON.stringify({ format: 'clade-build-inputs', version: 1, files: sourceInputs }, null, 2) + '\n');
const contentPaths = [...inputs.map(entry => entry.path), 'redistribution.json', 'build-inputs.json'].sort();
const files = await Promise.all(contentPaths.map(async path => { const bytes = await readRegular('dist', path); return { path, bytes: bytes.length, sha256: sha256(bytes) }; }));
const buildManifest = { format: 'clade-build-manifest', version: 1, appVersion: context.pkg.version, files };
const buildInfo = { format: 'clade-build-info', version: 1, appVersion: context.pkg.version, buildId: await contentDigest(buildManifest), manifest: 'build-manifest.json' };
await writeFile('dist/build-manifest.json', JSON.stringify(buildManifest, null, 2) + '\n');
await writeFile('dist/build-info.json', JSON.stringify(buildInfo, null, 2) + '\n');
const expected = [...contentPaths, 'build-manifest.json', 'build-info.json'];
await checkDistribution('dist', expected);
console.log(`Built and checked the image-free application in dist/. Build ${buildInfo.buildId}. Run npm start.`);
