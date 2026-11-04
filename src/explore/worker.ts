import { parseNewick } from '../newick.ts';
import { buildExploreIndex } from './index.ts';
import type { ExploreMode } from './index.ts';
import type { RootSpec } from '../types.ts';

type Request = { sequence: number; sourceSha: string; sourceText: string; root: RootSpec; childOrder: Record<string, string[]>; mode: ExploreMode };
const scope = self as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage: (value: unknown, transfer?: Transferable[]) => void };
scope.onmessage = async ({ data }) => {
  try {
    const source = await parseNewick(data.sourceText);
    if (source.sha256 !== data.sourceSha) throw new Error('Explore source identity mismatch.');
    const began = performance.now(), index = buildExploreIndex(source, data.root, data.childOrder, data.mode);
    scope.postMessage({ sequence: data.sequence, sourceSha: data.sourceSha, mode: data.mode, index, indexMs: performance.now() - began },
      Object.values(index).filter(v => ArrayBuffer.isView(v)).map(v => (v as Uint32Array).buffer));
  } catch (error) { scope.postMessage({ sequence: data.sequence, error: error instanceof Error ? error.message : String(error) }); }
};
