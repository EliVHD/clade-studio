import type { Source, Rooted, Reduction, Project, QA } from './types.ts';
import { edgeWidth, pathData, labelPosition } from './geometry.ts';
import { displayLabel, reducedNewick } from './science.ts';
import { validateBuildInfo } from './provenance/identity.ts';
import type { BuildInfo } from './provenance/identity.ts';
import { documentFromWorking, serializeProject, treeRevision } from './project-v2.ts';
import { hasAuthoring } from './provenance/operations.ts';
import { provenanceFiles, addArtifactManifest } from './export-provenance.ts';
import { exportStructuredFiles } from './structured/export.ts';
import { activeStructuredView } from './structured/view.ts';
import { basisCaption } from './model/basis.ts';
import { METHOD_REGISTRY } from './provenance/registry.ts';

export const escapeXML = (value: unknown): string => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function artworkGroup(rooted: Rooted, reduction: Reduction, project: Project): string {
  return `<g id="tree-artwork" fill="none" stroke="#111111" stroke-linecap="round" stroke-linejoin="round">\n` + reduction.visible.filter(id => rooted.nodes[id].parent).map(id =>
    `  <path id="edge-${id}" data-source-edge="${rooted.nodes[id].sourceEdgeId}" data-parent="${rooted.nodes[id].parent}" data-child="${id}" stroke-width="${edgeWidth(rooted, id, project.presentation)}" d="${pathData(rooted, project.layout, id)}"/>`
  ).join('\n') + '\n</g>';
}
export function svgPair(rooted: Rooted, reduction: Reduction, project: Project, qa: QA, exportingBuild?: BuildInfo): { unlabeled: string; labeled: string } {
  if (exportingBuild) validateBuildInfo(exportingBuild);
  const p = project.presentation, artwork = artworkGroup(rooted, reduction, project);
  const documentIdentity = hasAuthoring(project) ? { treeRevision: treeRevision(documentFromWorking(project)), activeViewId: project.authoring.activeViewId, basis: project.authoring.basis, biologicalRoot: project.authoring.root } : {};
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${p.widthMm}mm" height="${p.heightMm}mm" viewBox="0 0 ${p.widthMm} ${p.heightMm}">\n<title>${escapeXML(project.title)}</title>\n<metadata>${escapeXML(JSON.stringify({ ...documentIdentity, sourceSha256: project.sourceSha256, root: project.recipe.root, provenance: project.provenance, modifications: 'Reproducible clade collapse and artistic geometry; scientific lengths unchanged.', qaStatus: qa.status, artistReviewed: false, appVersion: project.appVersion, exportingBuild: exportingBuild ?? null }))}</metadata>\n`;
  const labels = `<g id="annotations" fill="#444444" font-family="Arial, sans-serif" font-size="2">\n` + reduction.frontier.map((entry, i) => { const pos = labelPosition(project.layout, p, entry.id); return `<text x="${pos.x}" y="${pos.y}" data-source-node="${entry.id}">${i + 1}</text>`; }).join('\n') + '\n</g>\n';
  return { unlabeled: header + artwork + '\n</svg>\n', labeled: header + artwork + '\n' + labels + '</svg>\n' };
}
function csvCell(value: unknown): string {
  let s = String(value ?? '');
  // Spreadsheet formula protection is confined to exported display fields; raw labels remain in JSON.
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
}
export function mappingCSV(source: Source, rooted: Rooted, reduction: Reduction, project: Project): string {
  return ['number,source_node_id,display_label,parent_source_node,member_count,mean_original_distance,threshold,rule', ...reduction.frontier.map((entry, i) => [i + 1, entry.id, displayLabel(source, entry.id, project.corrections), rooted.nodes[entry.id].parent, entry.members.length, entry.mean, entry.threshold, entry.rule].map(csvCell).join(','))].join('\r\n') + '\r\n';
}
export function exportFiles(source: Source, rooted: Rooted, reduction: Reduction, project: Project, qa: QA, exportingBuild?: BuildInfo): Record<string, string> {
  if(hasAuthoring(project)&&activeStructuredView(project))return exportStructuredFiles(source,project,exportingBuild);
  const pair = svgPair(rooted, reduction, project, qa, exportingBuild);
  const rows = reduction.frontier.map((entry, i) => `<tr><td>${i + 1}</td><td>${escapeXML(displayLabel(source, entry.id, project.corrections))}</td><td>${entry.id}</td><td>${entry.members.length}</td></tr>`).join('\n');
  const notes = (hasAuthoring(project) ? `<p>${escapeXML(basisCaption(project.authoring.basis))}</p>` : '') + `<p>${source.tips.length.toLocaleString()} sampled source tips, exhaustively represented by ${reduction.frontier.length} endpoints. Root: ${escapeXML(JSON.stringify(project.recipe.root))}. Source SHA256: ${source.sha256}.</p><p>QA status: ${qa.status}. ${qa.issues.length + qa.omittedIssueCount} reported issues. Original scientific lengths are preserved in Newick; artistic branch lengths are not a chronogram. Taxonomic names of collapsed groups remain neutral unless established. See annotation_review.json for source label corrections and unresolved placement.</p>`;
  const html = (title: string, content: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeXML(title)}</title><style>body{font:14px/1.5 system-ui;margin:24px;color:#222}h1{font-size:24px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #ccc;overflow-wrap:anywhere}td:nth-child(2){max-width:500px}.calibration{width:50mm;border-top:1px solid;margin:12mm 0 3mm}@media print{@page{margin:10mm}body{margin:0}tr{break-inside:avoid}svg{display:block;margin:auto}}</style><h1>${escapeXML(title)}</h1>${content}</html>`;
  const files: Record<string, string> = {
    'software_build.json': JSON.stringify({ exportingBuild: exportingBuild ?? null, status: exportingBuild ? 'identified' : 'not-supplied', scope: 'Software used to export this package. Does not establish which methods or builds produced the stored geometry.', authoringHistory: project.authoring?.compatibility.historyStatus ?? 'not-recorded-in-version-1' }, null, 2),
    'source_tree.nwk': source.text,
    'source_manifest.json': JSON.stringify({ ...project.provenance, sourceSha256: source.sha256, root: project.recipe.root, ...(hasAuthoring(project) ? { scientificBasis: project.authoring.basis } : {}) }, null, 2),
    'reduced_tree.nwk': reducedNewick(source, rooted, reduction),
    'reduction_recipe.json': JSON.stringify(project.recipe, null, 2),
    'clade_mapping.csv': mappingCSV(source, rooted, reduction, project),
    'clade_members.json': JSON.stringify(reduction.frontier.map(e => ({ sourceNodeId: e.id, members: e.members.map(id => ({ sourceNodeId: id, rawLabel: source.nodes[id].rawLabel })) })), null, 2),
    'annotation_review.json': JSON.stringify(project.corrections, null, 2),
    'tree.treeproject.json': hasAuthoring(project) ? serializeProject(project, exportingBuild ?? null) : JSON.stringify(project, null, 2),
    'tree_unlabeled.svg': pair.unlabeled,
    'tree_labeled.svg': pair.labeled,
    'legend.html': html('Scientific reference', notes + (project.authoring ? '<p><a href="sources-and-methods.html">Sources &amp; Methods</a></p>' : '') + '<table><thead><tr><th>No.</th><th>Display label</th><th>Source node</th><th>Tips</th></tr></thead><tbody>' + rows + '</tbody></table>'),
    'print-sheet.html': html('Actual-size draft', `${hasAuthoring(project) ? `<p>${escapeXML(basisCaption(project.authoring.basis))}</p>` : ''}<p>Print at 100% scale, with page scaling disabled. Check the 50 mm calibration line with a ruler. This is a draft for artist review.</p><div class="calibration"></div><p>50 mm</p>${pair.unlabeled.replace(/<\?xml[^>]*\?>/, '')}`),
    'qa_report.json': JSON.stringify({ ...(hasAuthoring(project) ? { treeRevision: treeRevision(documentFromWorking(project)), activeViewId: project.authoring.activeViewId, validationMethod: 'geometry-validation@1.0.0', validationMethodDefinition: METHOD_REGISTRY['geometry-validation@1.0.0'], exportingBuild: exportingBuild ?? null } : {}), ...qa, sourceWarnings: source.warnings, annotationReview: project.corrections, provenance: project.provenance, numberedEndpointOrder: reduction.frontier.map(x => x.id) }, null, 2),
    'README.txt': `Phylogenetic Tree Studio 0.1.0\n\n${qa.status.toUpperCase()} export. Artist review: not performed.\nSource tips: ${source.tips.length}; displayed endpoints: ${reduction.frontier.length}.\n\nOpen tree.treeproject.json in the local editor to recover exact geometry.\nBoth SVG files share byte-identical tree-artwork groups and physical dimensions.\nOpen legend.html for the numbered reference; clade_members.json contains every original raw label.\nOpen print-sheet.html and print at 100%; measure its 50 mm calibration mark.\nSVG edits outside this editor are export-only and cannot be reimported as verified projects.\n\n${qa.limitations.join('\n')}\n\nAttribution and modifications: see source_manifest.json and SVG metadata.\n`,
  };
  if (hasAuthoring(project)) { Object.assign(files, provenanceFiles(project)); addArtifactManifest(files, project); }
  return files;
}

/** Dependency-free ZIP with stored UTF-8 files and CRC32. */
export function zipFiles(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder(), parts: Uint8Array[] = [], directory: Uint8Array[] = []; let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  for (const [name, value] of Object.entries(files)) {
    const filename = encoder.encode(name), data = encoder.encode(value); let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + filename.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, filename.length, true); local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, filename.length, true); c.setUint32(42, offset, true); central.set(filename, 46);
    parts.push(local, data); directory.push(central); offset += local.length + data.length;
  }
  const size = directory.reduce((s, x) => s + x.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, directory.length, true); e.setUint16(10, directory.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const output = new Uint8Array(offset + size + end.length); let position = 0;
  for (const part of [...parts, ...directory, end]) { output.set(part, position); position += part.length; }
  return output;
}
