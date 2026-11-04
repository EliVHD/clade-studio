import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, contentDigest, sha256Text, verifyBuildIdentity } from '../src/provenance/identity.ts';
import type { BuildInfo, BuildManifest } from '../src/provenance/identity.ts';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, validateGeometry } from '../src/geometry.ts';
import { exportFiles, svgPair } from '../src/export.ts';
import type { Project } from '../src/types.ts';

test('canonical identity sorts UTF-16 keys and preserves ordered arrays and JSON numbers', async () => {
  const fixture = { z: [-0, true, null, 'a\nb'], a: { '\ue000': 2, '😀': 1 } };
  assert.equal(canonicalJSON(fixture), '{"a":{"😀":1,"\ue000":2},"z":[0,true,null,"a\\nb"]}');
  assert.equal(await sha256Text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await contentDigest({ b: 2, a: 1 }), await contentDigest({ a: 1, b: 2 }));
  assert.notEqual(await contentDigest([1, 2]), await contentDigest([2, 1]));
});
test('non-JSON, cyclic, sparse and nonfinite identities cannot silently lose information', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [NaN, Infinity, undefined, { a: undefined }, new Date(), BigInt(1), new Array(2), cyclic, { [Symbol('x')]: 1 }]) assert.throws(() => canonicalJSON(value));
});
test('build identity has no clock/self-reference and detects changed or malformed inventories', async () => {
  const manifest: BuildManifest = { format: 'clade-build-manifest', version: 1, appVersion: '0.1.0', files: [{ path: 'app/app.js', bytes: 3, sha256: await sha256Text('abc') }] };
  const info: BuildInfo = { format: 'clade-build-info', version: 1, appVersion: '0.1.0', buildId: await contentDigest(manifest), manifest: 'build-manifest.json' };
  await verifyBuildIdentity(info, manifest);
  await assert.rejects(verifyBuildIdentity(info, { ...manifest, files: [{ ...manifest.files[0], bytes: 4 }] }), /does not match/);
  for (const path of ['../private', '/absolute', 'app\\private', 'build-info.json', 'build-manifest.json']) await assert.rejects(verifyBuildIdentity(info, { ...manifest, files: [{ ...manifest.files[0], path }] }), /inventory/);
  await assert.rejects(verifyBuildIdentity(info, { ...manifest, files: [...manifest.files, ...manifest.files] }), /inventory/);
});
test('export stamp identifies the exporter without rewriting source, geometry or unknown history', async () => {
  const source = await parseNewick('(A:1,B:1);'), recipe = defaultRecipe(source);
  recipe.globalThreshold = 0;
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe), presentation = structuredClone(DEFAULT_PRESENTATION);
  recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(entry => entry.id);
  const project: Project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'Independent input', sourceText: source.text, sourceSha256: source.sha256, provenance: { license: 'Unknown' }, corrections: [], recipe, layout: generateLayout(rooted, reduction, presentation, 'organic'), presentation };
  const before = structuredClone(project), qa = validateGeometry(source, rooted, recipe, reduction, project.layout, presentation);
  const info: BuildInfo = { format: 'clade-build-info', version: 1, appVersion: '0.1.0', buildId: 'a'.repeat(64), manifest: 'build-manifest.json' };
  const unknown = exportFiles(source, rooted, reduction, project, qa);
  assert.equal(JSON.parse(unknown['software_build.json']).exportingBuild, null);
  const known = exportFiles(source, rooted, reduction, project, qa, info);
  assert.deepEqual(JSON.parse(known['software_build.json']).exportingBuild, info);
  assert.equal(JSON.parse(known['software_build.json']).authoringHistory, 'not-recorded-in-version-1');
  const group = (svg: string) => svg.match(/<g id="tree-artwork"[\s\S]*?<\/g>/)![0];
  assert.equal(group(known['tree_unlabeled.svg']), group(unknown['tree_unlabeled.svg']));
  assert.equal(group(known['tree_labeled.svg']), group(known['tree_unlabeled.svg']));
  assert.deepEqual(project, before);
  assert.deepEqual(JSON.parse(known['source_manifest.json']).license, 'Unknown');
  assert.ok(!known['source_manifest.json'].includes('Hug'));
  assert.throws(() => svgPair(rooted, reduction, project, qa, { ...info, buildId: 'wrong' }), /identity/);
});
