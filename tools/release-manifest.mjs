import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { filesUnder } from './distribution-policy.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');

export async function readRegular(root, path) {
  if (!safePath(path)) throw new Error(`Unsafe release path: ${path}`);
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const stats = await lstat(join(root, ...parts.slice(0, i + 1)));
    if (stats.isSymbolicLink() || (i < parts.length - 1 ? !stats.isDirectory() : !stats.isFile())) throw new Error(`Release inputs may not contain symlinks or special files: ${path}`);
  }
  return readFile(join(root, path));
}

export function indexReview(review) {
  if (review?.format !== 'clade-component-review' || review.version !== 1 || !Array.isArray(review.components)) throw new Error('Invalid component review.');
  const files = new Map(), ids = new Set();
  for (const component of review.components) {
    if (!component.id || ids.has(component.id) || component.decision !== 'include' || typeof component.licenseExpression !== 'string' || !component.licenseExpression || !Array.isArray(component.files) || !Array.isArray(component.obligations) || !component.evidence?.length) throw new Error('Every included component needs a unique reviewed identity, license and evidence.');
    ids.add(component.id);
    for (const file of component.files) {
      if (!safePath(file) || files.has(file)) throw new Error(`Unreviewed or duplicate release path: ${file}`);
      if (component.role === 'third-party-data' && !/^[0-9a-f]{64}$/.test(component.sha256?.[file] ?? '')) throw new Error(`Upstream asset needs an exact reviewed hash: ${file}`);
      files.set(file, component);
    }
  }
  return files;
}

export function dependencyInventory(pkg, lock, lockBytes, review) {
  if (sha256(lockBytes) !== review.reviewedDependencyLockSha256) throw new Error('Dependency lock changed; review component licenses before building a release.');
  if (pkg.license !== '0BSD' || lock.packages?.['']?.license !== '0BSD') throw new Error('The original software grant must match the reviewed 0BSD policy.');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) if (Object.keys(pkg[field] ?? {}).length) throw new Error('New runtime dependencies need an explicit bundling/license review.');
  if (JSON.stringify(pkg.devDependencies) !== JSON.stringify(lock.packages?.['']?.devDependencies)) throw new Error('Package declarations do not match the reviewed lockfile.');
  return Object.entries(lock.packages).filter(([path]) => path).map(([path, dep]) => {
    if (dep.dev !== true || !['MIT', 'Apache-2.0'].includes(dep.license)) throw new Error(`Unreviewed dependency scope/license: ${path}`);
    return { package: path.replace(/^node_modules\//, ''), version: dep.version, licenseDeclared: dep.license, optional: !!dep.optional, integrity: dep.integrity, relationship: 'build-dependency-declaration', distributed: false };
  }).sort((a, b) => a.package < b.package ? -1 : a.package > b.package ? 1 : 0);
}

export async function loadReleaseReview(root = '.') {
  const review = JSON.parse(await readRegular(root, 'release/components.json'));
  const index = indexReview(review);
  const pkg = JSON.parse(await readRegular(root, 'package.json'));
  const lockBytes = await readRegular(root, 'package-lock.json');
  const dependencies = dependencyInventory(pkg, JSON.parse(lockBytes), lockBytes, review);
  for (const dir of ['src', 'public', 'tools', 'tests', 'release']) {
    for (const name of await filesUnder(join(root, dir))) {
      const path = `${dir}/${name}`;
      if (!index.has(path) && !review.excludedFiles.includes(path)) throw new Error(`New release input needs a rights decision: ${path}`);
    }
  }
  for (const [path, component] of index) {
    const bytes = await readRegular(root, path);
    if (component.sha256?.[path] && sha256(bytes) !== component.sha256[path]) throw new Error(`Reviewed upstream asset changed: ${path}`);
  }
  return { review, index, pkg, dependencies };
}

export function releaseManifest(profile, entries, context, buildId) {
  const used = new Set();
  const files = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(entry => {
    const component = context.index.get(entry.origin);
    if (!safePath(entry.path) || entry.path === 'release-manifest.json' || !component) throw new Error(`No reviewed component for ${entry.path}`);
    used.add(component.id);
    return { path: entry.path, bytes: entry.bytes.length, sha256: sha256(entry.bytes), component: component.id, licenseExpression: component.licenseExpression, origin: entry.origin };
  });
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate distribution path.');
  return {
    format: 'clade-release-manifest', version: 1, profile, appVersion: context.pkg.version, buildId,
    softwareLicense: '0BSD', licenseScope: 'Original software only; included third-party material retains the file-level terms below.',
    components: context.review.components.filter(c => used.has(c.id)).map(({ files: _files, sha256: _hashes, ...record }) => record),
    files, dependencies: context.dependencies,
    dependencyScope: 'Lockfile declarations, including optional platforms; not a list of packages installed on this machine. No listed dependency payload is distributed.',
    excluded: context.review.excludedMaterial,
  };
}

export async function verifyReleaseFiles(root, manifest) {
  if (manifest?.format !== 'clade-release-manifest' || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest.');
  const paths = manifest.files.map(file => file.path);
  if (new Set(paths).size !== paths.length || paths.some(path => !safePath(path) || path === 'release-manifest.json')) throw new Error('Invalid release paths.');
  const expected = [...paths, 'release-manifest.json'].sort();
  if (JSON.stringify(await filesUnder(root)) !== JSON.stringify(expected)) throw new Error('Release inventory does not match the directory.');
  for (const file of manifest.files) {
    const bytes = await readRegular(root, file.path);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Release file changed: ${file.path}`);
  }
}

export async function verifyBuildInputs(root, inputs, context) {
  if (inputs?.format !== 'clade-build-inputs' || inputs.version !== 1 || !Array.isArray(inputs.files)) throw new Error('Invalid build input inventory.');
  const expected = [...context.index.keys()].sort();
  if (JSON.stringify(inputs.files.map(file => file.path)) !== JSON.stringify(expected)) throw new Error('Build inputs changed; rebuild before packaging.');
  for (const file of inputs.files) {
    const bytes = await readRegular(root, file.path);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Build input changed; rebuild before packaging: ${file.path}`);
  }
}
