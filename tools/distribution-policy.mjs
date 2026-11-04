import { lstat, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const runtimePublicFiles = ['index.html', 'guide.html', 'style.css', 'third-party-notices.html', 'project-v2.schema.json', 'project-v3.schema.json', 'project-v4.schema.json'];
export const runtimeDataFiles = ['source_tree.nwk', 'annotation_review.json', 'example_reduction_recipe.json', 'source_manifest.json', 'datasets/upham-2019.nwk', 'datasets/dos-reis-2018.nwk', 'datasets/kew-4-order.nwk', 'datasets/kew-4-family.nwk', 'datasets/kew-4-species.nwk', 'datasets/audit.json'];
export const excludedReferenceHashes = new Set([
  'b42650bc5e99620edaad4b7e87ac505f1b52c7f96f5051a84328994b069ea4ba',
  '0d14906fe66dd655ea16eb73d77cb32603ed4366fe6e525ba4d182c770d84ae7',
  '045c68cb92c398a370dd467596a718a58597a86c320627afc8603ab9e5ebb500',
  'bfde1c301afb1d4c2714b2568a6266ef69c81520d77f7b88584b6373ebe41147',
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function filesUnder(root, relative = '') {
  if (!relative && !(await lstat(root)).isDirectory()) throw new Error(`Distribution root must be a real directory: ${root}`);
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Distribution inputs/output may not contain symlinks: ${name}`);
    if (entry.isDirectory()) files.push(...await filesUnder(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported distribution entry: ${name}`);
  }
  return files.sort();
}

export async function runtimeModuleFiles(sourceRoot) {
  return (await filesUnder(sourceRoot)).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).map(name => `app/${name.slice(0, -3)}.js`);
}

export async function checkDistribution(root, expectedFiles, forbiddenHashes = excludedReferenceHashes) {
  const files = await filesUnder(root), expected = new Set(expectedFiles);
  const unexpected = files.filter(file => !expected.has(file));
  const missing = expectedFiles.filter(file => !files.includes(file));
  if (unexpected.length || missing.length) throw new Error(`Distribution allowlist mismatch. Unexpected: ${unexpected.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}.`);
  for (const file of files) {
    if (/\.(png|jpe?g|webp|gif|pdf)$/i.test(file)) throw new Error(`Reference images/documents are excluded from this release: ${file}`);
    const bytes = await readFile(join(root, file));
    if (forbiddenHashes.has(sha(bytes))) throw new Error(`Excluded reference content found in ${file}`);
    for (const match of bytes.toString('utf8').matchAll(/data:image\/[^;,\s"']+;base64,([A-Za-z0-9+/=]+)/g)) {
      if (forbiddenHashes.has(sha(Buffer.from(match[1], 'base64')))) throw new Error(`Embedded excluded reference content found in ${file}`);
    }
  }
  return files;
}
