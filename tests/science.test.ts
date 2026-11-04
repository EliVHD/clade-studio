import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce, HUG_SHA, reducedNewick } from '../src/science.ts';

const text = await readFile(new URL('../data/source_tree.nwk', import.meta.url), 'utf8');
const source = await parseNewick(text);
const audit = JSON.parse(await readFile(new URL('../reports/source_audit.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('../data/example_reduction_recipe.json', import.meta.url), 'utf8'));

test('exact Hug bytes, raw whitespace, IDs, all tips and all comments survive import', () => {
  assert.equal(source.sha256, HUG_SHA); assert.equal(source.tips.length, 3083); assert.equal(source.order.length, 6164);
  assert.equal(Object.values(source.nodes).reduce((n, x) => n + x.annotations.length, 0), 3080);
  assert.equal(source.nodes.n005483.rawLabel, audit.label_anomaly_candidates[0].raw_label);
  assert.ok(source.tips.some(id => source.nodes[id].rawLabel.startsWith(' ')));
  assert.equal(Object.isFrozen(source.nodes.n000001), true);
});
test('every uniform audit frontier replays exactly, including strict 0.65 count of 224', () => {
  const recipe = defaultRecipe(source), rooted = orient(source, recipe.root);
  for (const sweep of audit.uniform_sweeps) {
    recipe.globalThreshold = sweep.threshold;
    const result = reduce(source, rooted, recipe);
    assert.equal(result.frontier.length, sweep.endpoints);
    assert.deepEqual(result.frontier.map(x => x.id), sweep.frontier_source_node_ids);
    assert.equal(result.tipCount, 3083);
  }
});
test('regional fixture replays all 150 exact IDs and covers each original tip once', () => {
  const recipe = { ...defaultRecipe(source), ...fixture }, rooted = orient(source, recipe.root), result = reduce(source, rooted, recipe, true);
  assert.equal(result.frontier.length, 150); assert.deepEqual(result.counts, { Bacteria: 61, Eukaryota: 54, Archaea: 35 });
  assert.equal(new Set(result.frontier.flatMap(x => x.members)).size, 3083);
});
test('edge-rooting preserves original splits, total lengths and support provenance', () => {
  const recipe = defaultRecipe(source), tree = orient(source, recipe.root);
  const edges = tree.order.filter(id => tree.nodes[id].sourceEdgeId === 'e-n000001');
  assert.equal(edges.length, 2); assert.equal(edges.reduce((sum, id) => sum + tree.nodes[id].length!, 0), source.nodes.n000001.length);
  for (const id of source.order) {
    if (id === source.rootId || id === 'n000001') continue;
    const originalMembers: string[] = [], stack = [id];
    while (stack.length) { const next = stack.pop()!; if (!source.nodes[next].children.length) originalMembers.push(next); else stack.push(...source.nodes[next].children); }
    const oriented = tree.order.find(x => tree.nodes[x].sourceEdgeId === `e-${id}`)!;
    const members = tree.nodes[oriented].members;
    const actual = new Set(members), original = new Set(originalMembers);
    assert.ok(source.tips.every(tip => actual.has(tip) === original.has(tip)) || source.tips.every(tip => actual.has(tip) !== original.has(tip)));
    assert.deepEqual(tree.nodes[oriented].annotations, source.nodes[id].annotations);
  }
});
test('weighted mean uses original tip counts; strict equality does not collapse', async () => {
  const s = await parseNewick('((A:1,B:3):2,C:10);'), recipe = defaultRecipe(s), tree = orient(s, recipe.root);
  assert.equal(tree.nodes.n000000.mean, 6); assert.equal(tree.nodes.n000001.mean, 2);
  recipe.globalThreshold = 2; assert.equal(reduce(s, tree, recipe).frontier.length, 3);
  recipe.globalThreshold = 2.00001; assert.equal(reduce(s, tree, recipe).frontier.length, 2);
});
test('nested overrides protect paths and explicit conflicts are rejected', async () => {
  const s = await parseNewick('(((A:1,B:1):1,C:1):1,D:1);'), recipe = defaultRecipe(s), tree = orient(s, recipe.root);
  recipe.globalThreshold = 100; recipe.thresholdOverrides = [{ sourceNodeId: 'n000002', threshold: .1 }];
  assert.equal(reduce(s, tree, recipe).frontier.length, 4);
  recipe.collapse = ['n000001']; assert.throws(() => reduce(s, tree, recipe), /Contradictory/);
  recipe.collapse = ['n000002']; recipe.protect = ['n000002']; assert.throws(() => reduce(s, tree, recipe), /Contradictory/);
});
test('missing, negative, and nonfinite lengths disable distance collapse but permit manual decisions', async () => {
  for (const token of ['', ':-1', ':NaN', ':Infinity']) {
    const s = await parseNewick(`((A${token},B:1):1,C:1);`), recipe = defaultRecipe(s), tree = orient(s, recipe.root);
    recipe.globalThreshold = 100; assert.equal(s.distanceUsable, false); assert.equal(reduce(s, tree, recipe).frontier.length, 3);
    recipe.collapse = ['n000001']; assert.equal(reduce(s, tree, recipe).frontier.length, 2);
  }
});
test('zero lengths and polytomies are preserved without fabricated bifurcations', async () => {
  const s = await parseNewick('((A:0,B:0,C:0):0,D:1);'), recipe = defaultRecipe(s), tree = orient(s, recipe.root);
  recipe.globalThreshold = 0; assert.equal(reduce(s, tree, recipe).frontier.length, 4);
  recipe.globalThreshold = .1; assert.equal(reduce(s, tree, recipe).frontier.length, 2);
  assert.equal(tree.nodes.n000001.children.length, 3);
});
test('quoted labels, escaped quotes, nested annotations and scientific notation parse', async () => {
  const s = await parseNewick("[&R]('A, B':1e-2[90][x[y]],'O''Brien':.5)internal;");
  assert.equal(s.nodes.n000001.label, 'A, B'); assert.equal(s.nodes.n000002.label, "O'Brien");
  assert.equal(s.nodes.n000001.length, .01); assert.equal(s.nodes.n000001.annotations[1].text, 'x[y]');
  assert.equal(s.nodes.n000000.annotations[0].text, '&R');
});
test('parser rejects malformed syntax and extra trees', async () => {
  for (const text of ['(A:1,B:1)', '(A:wat,B:1);', "('unfinished:1,B:1);", '(A:1,B:1);(C:1,D:1);', '(A:1,B:1[bad);', '(,B:1);']) await assert.rejects(parseNewick(text));
});
test('replay rejects changed source, unknown IDs, policies and modified frontiers', () => {
  const recipe = { ...defaultRecipe(source), ...fixture }, tree = orient(source, recipe.root);
  assert.throws(() => reduce(source, tree, { ...recipe, sourceSha256: 'bad' }));
  assert.throws(() => reduce(source, tree, { ...recipe, protect: ['unknown'] }));
  assert.throws(() => reduce(source, tree, { ...recipe, resolvedFrontierSourceNodeIds: ['n000001'] }, true), /does not replay/);
});
test('reduced Newick parses with the true endpoint count and retained edge annotations', async () => {
  const recipe = { ...defaultRecipe(source), ...fixture }, tree = orient(source, recipe.root), result = reduce(source, tree, recipe);
  const imported = await parseNewick(reducedNewick(source, tree, result));
  assert.equal(imported.tips.length, 150); assert.ok(imported.nodes.n000001.annotations.some(x => x.text.includes('source_edge=')));
});
