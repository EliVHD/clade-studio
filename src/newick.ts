import type { Annotation, Source, SourceNode } from './types.ts';

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Single-tree Newick, quoted labels, nested comments, scientific notation. Never normalizes stored bytes. */
export async function parseNewick(text: string): Promise<Source> {
  if (text.length > 20_000_000) throw new Error('Newick input exceeds the 20 MB limit.');
  let pos = 0;
  const nodes: Record<string, SourceNode> = {}, order: string[] = [];
  const fail = (message: string): never => { throw new Error(`${message} at character ${pos + 1}.`); };
  const whitespace = () => { while (/\s/.test(text[pos] ?? '') && pos < text.length) pos++; };
  const comment = (position: Annotation['position']): Annotation => {
    pos++;
    const start = pos; let depth = 1;
    while (pos < text.length && depth) { if (text[pos] === '[') depth++; if (text[pos] === ']') depth--; pos++; }
    if (depth) fail('Unterminated comment');
    return { text: text.slice(start, pos - 1), position };
  };
  const parse = (depth: number): string => {
    if (depth > 800) fail('Tree nesting exceeds the supported depth of 800');
    if (order.length >= 100_000) fail('Tree exceeds the supported 100,000 nodes');
    const id = `n${String(order.length).padStart(6, '0')}`;
    const node: SourceNode = { id, children: [], rawLabel: '', label: '', length: null, lengthToken: null, annotations: [] };
    nodes[id] = node; order.push(id);
    const leading = pos; whitespace();
    while (text[pos] === '[') { node.annotations.push(comment('before')); whitespace(); }
    const prefix = text.slice(leading, pos).includes('[') ? '' : text.slice(leading, pos);
    if (text[pos] === '(') {
      pos++; whitespace();
      if (text[pos] === ')') fail('An internal node must have descendants');
      while (true) {
        node.children.push(parse(depth + 1)); whitespace();
        if (text[pos] === ',') { pos++; continue; }
        if (text[pos] !== ')') fail('Expected a comma or closing parenthesis');
        pos++; break;
      }
    }
    whitespace();
    if (text[pos] === "'") {
      pos++; let label = '', closed = false;
      while (pos < text.length) {
        const char = text[pos++];
        if (char === "'") {
          if (text[pos] === "'") { label += "'"; pos++; } else { closed = true; break; }
        } else label += char;
      }
      if (!closed) fail('Unterminated quoted label');
      node.rawLabel = label; node.label = label;
    } else {
      const start = pos;
      while (pos < text.length && !':,();[]'.includes(text[pos])) pos++;
      node.rawLabel = (node.children.length ? '' : prefix) + text.slice(start, pos);
      node.label = node.rawLabel.trim();
    }
    whitespace();
    while (text[pos] === '[') { node.annotations.push(comment('label')); whitespace(); }
    if (text[pos] === ':') {
      pos++; whitespace(); const start = pos;
      while (pos < text.length && !',();[]'.includes(text[pos])) pos++;
      const token = text.slice(start, pos).trim();
      if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|Infinity|NaN)$/i.test(token)) fail('Invalid branch length');
      node.lengthToken = token; node.length = Number(token);
      whitespace();
      while (text[pos] === '[') { node.annotations.push(comment('length')); whitespace(); }
    }
    if (!node.children.length && !node.label) fail('An unnamed terminal is not supported; give each tip a label');
    return id;
  };
  whitespace(); const rootId = parse(0); whitespace();
  if (text[pos] !== ';') fail('Expected a final semicolon');
  pos++; whitespace();
  if (pos !== text.length) fail('Only one tree is supported; unexpected trailing content');
  const tips = order.filter(id => !nodes[id].children.length);
  const warnings: string[] = [];
  const invalid = order.filter(id => id !== rootId && (nodes[id].length === null || !Number.isFinite(nodes[id].length) || nodes[id].length! < 0));
  if (invalid.length) warnings.push(`${invalid.length} edges have missing, negative, or nonfinite lengths. Distance-based collapse is disabled; manual collapse remains available.`);
  const zero = order.filter(id => id !== rootId && nodes[id].length === 0).length;
  if (zero) warnings.push(`${zero} zero-length edges are retained; distance distortion is undefined on these edges.`);
  if (new Set(tips.map(id => nodes[id].label)).size !== tips.length) warnings.push('Duplicate terminal names are present; source node IDs distinguish their identities.');
  if (order.some(id => nodes[id].rawLabel !== nodes[id].label)) warnings.push('Raw labels contain surrounding whitespace; original strings are preserved.');
  for (const n of Object.values(nodes)) { Object.freeze(n.children); Object.freeze(n.annotations); Object.freeze(n); }
  return { text, sha256: await sha256(text), nodes: Object.freeze(nodes), order, rootId, tips, warnings, distanceUsable: invalid.length === 0 };
}

export function quoteLabel(label: string): string { return `'${label.replaceAll("'", "''")}'`; }
