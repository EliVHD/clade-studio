/** Application canonical JSON v1; not an implementation of RFC 8785. */
export function canonicalJSON(value: unknown): string {
  const active = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Content identity requires finite numbers.');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error('Content identity requires JSON values; undefined is not allowed.');
    if (active.has(item)) throw new Error('Content identity cannot contain cycles.');
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const values: string[] = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw new Error('Content identity cannot contain sparse arrays.');
          values.push(encode(item[i]));
        }
        return `[${values.join(',')}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Content identity requires plain objects.');
      if (Object.getOwnPropertySymbols(item).length) throw new Error('Content identity cannot contain symbol keys.');
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(',')}}`;
    } finally { active.delete(item); }
  };
  return encode(value);
}

export async function sha256Text(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function contentDigest(value: unknown): Promise<string> { return sha256Text(canonicalJSON(value)); }

export type BuildFile = { path: string; bytes: number; sha256: string };
export type BuildManifest = { format: 'clade-build-manifest'; version: 1; appVersion: string; files: BuildFile[] };
export type BuildInfo = { format: 'clade-build-info'; version: 1; appVersion: string; buildId: string; manifest: 'build-manifest.json' };
const hashPattern = /^[0-9a-f]{64}$/;

export function validateBuildInfo(value: unknown): asserts value is BuildInfo {
  const info = value as BuildInfo;
  if (!info || info.format !== 'clade-build-info' || info.version !== 1 || typeof info.appVersion !== 'string' || !hashPattern.test(info.buildId) || info.manifest !== 'build-manifest.json') throw new Error('Invalid software build identity.');
}

/** Verify the stamp/manifest pair. This is not authentication of the loaded executable. */
export async function verifyBuildIdentity(info: BuildInfo, manifest: BuildManifest): Promise<void> {
  validateBuildInfo(info);
  if (!manifest || manifest.format !== 'clade-build-manifest' || manifest.version !== 1 || manifest.appVersion !== info.appVersion || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid software build manifest.');
  let previous = '';
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path <= previous || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || ['build-info.json', 'build-manifest.json'].includes(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !hashPattern.test(file.sha256)) throw new Error('Invalid software build file inventory.');
    previous = file.path;
  }
  if (await contentDigest(manifest) !== info.buildId) throw new Error('Software build identity does not match its manifest.');
}
