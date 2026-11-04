import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient } from '../src/science.ts';
import { buildExploreIndex, fitBox, focusBox, selectDetail, sourcePath, visibleChildren, sectorBox, intersects, nodeBox, NODE_BUDGET } from '../src/explore/index.ts';
import { renderExplore } from '../src/explore/render.ts';
import type { ExploreMode } from '../src/explore/index.ts';
import { searchSource } from '../src/search.ts';
const modes: ExploreMode[] = ['rectangular', 'circular', 'fan'];
const balanced = (n: number): string => n === 1 ? 'Tip' : `(${balanced(Math.floor(n / 2))},${balanced(Math.ceil(n / 2))})`;
const render = (index: ReturnType<typeof buildExploreIndex>, frame: ReturnType<typeof selectDetail>, view: ReturnType<typeof fitBox>, selected?: number) => renderExplore(index, frame, view, 1000, 700, selected, i => index.ids[i], s => s.length * 7);

test('stable full-source index agrees with declared node and edge traversals without copying descendant memberships', async () => {
  const source = await parseNewick('(((A:0,B)85[&support=foo],C),D);');
  for (const root of [defaultRecipe(source).root, { kind: 'edge' as const, sourceEdge: ['n000002','n000003'] as [string,string], fraction: .3, status: 'declared_assumption' }]) {
    const reference = orient(source, root), index = buildExploreIndex(source, root, {}, 'rectangular');
    for (let i = 0; i < index.ids.length; i++) {
      const node = reference.nodes[index.ids[i]];
      assert.equal(index.count[i], node.count);
      assert.deepEqual(Array.from(index.children.slice(index.offsets[i], index.offsets[i + 1])).map(j => index.ids[j]), node.children);
    }
    const coords = [index.x.slice(), index.y.slice()];
    for (const factor of [1, 4, 64, 1024]) selectDetail(index, { x: 100, y: 300, w: 1000 / factor, h: 1000 / factor }, factor);
    assert.deepEqual([index.x, index.y], coords);
    assert.equal('members' in index, false);
  }
});

test('overview summaries and terminals are a disjoint exhaustive cover in all modes', async () => {
  const source = await parseNewick(balanced(8192) + ';');
  for (const mode of modes) {
    const index = buildExploreIndex(source, defaultRecipe(source).root, {}, mode), view = fitBox(index.extent, 1000, 700), frame = selectDetail(index, view, 1000 / view.w);
    assert(frame.summaries.size > 0); assert(frame.nodes.length <= NODE_BUDGET); assert.equal(frame.coveredTips, source.tips.length);
    const intervals = frame.nodes.filter(i => frame.summaries.has(i) || index.offsets[i] === index.offsets[i + 1]).map(i => [index.start[i], index.end[i]]).sort((a,b) => a[0] - b[0]);
    assert.equal(intervals[0][0], 0); assert.equal(intervals.at(-1)![1], source.tips.length);
    for (let j = 1; j < intervals.length; j++) assert.equal(intervals[j][0], intervals[j - 1][1]);
    assert.deepEqual(selectDetail(index, view, 1000 / view.w), frame);
  }
});

test('50,000-way polytomy culls ranges before budgeting and exposes late siblings in every mode', async () => {
  const source = await parseNewick('(' + Array.from({length:50000}, (_,i) => `T${i}`).join(',') + ');');
  for (const mode of modes) {
    const index = buildExploreIndex(source, defaultRecipe(source).root, {}, mode), view = fitBox(index.extent, 1000, 700), overview = selectDetail(index, view, 1000 / view.w);
    assert.equal(overview.summaries.get(index.root), 'budget'); assert.equal(overview.coveredTips, 50000);
    const i = index.ids.indexOf(source.tips[49000]), focus = focusBox(index, i, 1000, 700), frame = selectDetail(index, focus, 1000 / focus.w);
    assert(frame.nodes.includes(i)); assert(!frame.summaries.has(index.root)); assert(frame.nodes.length < 100);
    assert.equal(index.parent[i], index.root); assert.equal(index.offsets[index.root + 1] - index.offsets[index.root], 50000);
    const children = visibleChildren(index, index.root, focus)!;
    assert(children.includes(i)); assert(children.every(c => index.parent[c] === index.root));
    const svg = render(index, frame, focus, i).svg; assert(svg.includes('explore-path')); assert(svg.includes(`data-explore-node="${i}"`));
  }
});

test('99,997-node balanced tree stays bounded; source-ID search focuses the exact hidden tip', async () => {
  const source = await parseNewick(balanced(49999) + ';'), id = source.tips[45000];
  assert.equal(source.order.length, 99997); assert.equal(searchSource(source, id).results[0].id, id);
  for (const mode of modes) {
    const index = buildExploreIndex(source, defaultRecipe(source).root, {}, mode), i = index.ids.indexOf(id), focus = focusBox(index, i, 1000, 700), frame = selectDetail(index, focus, 1000 / focus.w);
    assert(frame.nodes.includes(i)); assert(frame.nodes.length <= NODE_BUDGET); assert(frame.visited < 500);
    assert(sourcePath(index, i).length > 10); assert.equal(index.ids[i], id);
  }
});

test('density hysteresis retains state between 9 and 14 CSS pixels', async () => {
  const source = await parseNewick('(A,B);'), index = buildExploreIndex(source, defaultRecipe(source).root, {}, 'rectangular'), view = {x:-1,y:-1,w:1002,h:1002};
  assert(selectDetail(index, view, .013).summaries.has(index.root));
  const expanded = selectDetail(index, view, .015).expanded; assert(expanded.has(index.root));
  assert(selectDetail(index, view, .010, expanded).expanded.has(index.root));
  assert(selectDetail(index, view, .008, expanded).summaries.has(index.root));
});

test('parent connectors and incident stems survive offscreen anchors, including radial arcs', async () => {
  const source = await parseNewick('(A,B,C,D);');
  for (const mode of modes) {
    const index = buildExploreIndex(source, defaultRecipe(source).root, {}, mode), i = index.ids.indexOf(source.tips[2]);
    const x = (index.x[i] + index.x[index.root]) / 2, y = (index.y[i] + (mode === 'rectangular' ? index.y[i] : index.y[index.root])) / 2;
    const view = { x:x - 5,y:y - 5,w:10,h:10 }, frame = selectDetail(index, view, 100);
    assert(frame.nodes.includes(i)); assert(frame.expanded.has(index.root));
    assert(render(index, frame, view).paths >= 2);
  }
  const box = sectorBox(20, 50, Math.PI * 1.9, Math.PI * 2.1); assert(box.x <= 20); assert.equal(box.x + box.w, 50); assert(box.y < 0 && box.y + box.h > 0);
});

test('radial bounds conservatively contain incoming stems, full descendant sectors and connector arcs', async () => {
  const source = await parseNewick('(((A,B,C),(D,E)),((F,G),H));');
  for (const mode of ['circular','fan'] as ExploreMode[]) {
    const index = buildExploreIndex(source, defaultRecipe(source).root, {}, mode);
    for (let i = 0; i < index.ids.length; i++) {
      const box = nodeBox(index, i), inner = index.parent[i] < 0 ? 0 : index.radius[index.parent[i]];
      for (let k = 0; k <= 20; k++) for (const r of [inner, index.radius[i], 1000]) {
        const angle = index.angleStart + index.angleSpan * (index.start[i] + (index.end[i] - index.start[i]) * k / 20) / index.tips;
        assert(intersects({x:box.x-1e-8,y:box.y-1e-8,w:box.w+2e-8,h:box.h+2e-8},{x:r*Math.cos(angle),y:r*Math.sin(angle),w:0,h:0}));
      }
    }
  }
});

test('deep comb and unary chains preserve source nodes and handle zero/missing lengths without inference', async () => {
  const comb = '(' .repeat(790) + 'A,B)' + ',C)'.repeat(789) + ';';
  const source = await parseNewick(comb), before = JSON.stringify(source), index = buildExploreIndex(source, defaultRecipe(source).root, {}, 'rectangular');
  assert.equal(index.tips, 791); assert.equal(index.ids.length, 1581);
  const view = fitBox(index.extent, 1000, 700), frame = selectDetail(index, view, 1000 / view.w);
  assert(frame.nodes.length <= NODE_BUDGET); assert.equal(frame.coveredTips, 791); assert.equal(JSON.stringify(source), before);
  const unary = await parseNewick('(((A:0,B)99));'), reroot = buildExploreIndex(unary, {kind:'node',sourceNodeId:'n000002',status:'unspecified'}, {}, 'rectangular');
  assert.equal(reroot.tips, 2); assert.equal(reroot.count[reroot.root], 2); assert.equal(reroot.ids.length, 5);
});

test('labels are bounded, escaped and selected identity survives overview summarization', async () => {
  const source = await parseNewick(balanced(2048) + ';'), index = buildExploreIndex(source, defaultRecipe(source).root, {}, 'circular'), view = fitBox(index.extent, 1000, 700), frame = selectDetail(index, view, 1000 / view.w), i = index.ids.length - 1;
  const result = renderExplore(index, frame, view, 1000, 700, i, () => '<script>&" very long label '.repeat(10), s => s.length * 7);
  assert(result.labels <= 160); assert(!result.svg.includes('<script>')); assert(result.svg.includes('&lt;script&gt;')); assert(result.svg.includes(`data-explore-node="${i}"`));
});

test('every bundled source has exhaustive overview and focuses its last exact tip in all modes', async () => {
  for (const path of ['source_tree.nwk','datasets/upham-2019.nwk','datasets/dos-reis-2018.nwk','datasets/kew-4-order.nwk','datasets/kew-4-family.nwk','datasets/kew-4-species.nwk']) {
    const source = await parseNewick(await readFile('data/' + path, 'utf8'));
    for (const mode of modes) {
      const index = buildExploreIndex(source, defaultRecipe(source).root, {}, mode), view = fitBox(index.extent, 1000, 700), frame = selectDetail(index, view, 1000 / view.w);
      assert.equal(frame.coveredTips, source.tips.length, `${path} ${mode}`); assert(frame.nodes.length <= NODE_BUDGET);
      const i = index.ids.indexOf(source.tips.at(-1)!), focus = focusBox(index, i, 1000, 700), focused = selectDetail(index, focus, 1000 / focus.w);
      assert(focused.nodes.includes(i), `${path} ${mode} hidden identity`);
    }
  }
});


test('single-tip and tiny sources focus at a useful navigable scale', async () => {
  for (const text of ['Only_tip;', '(A,B);']) for (const mode of modes) {
    const source = await parseNewick(text), index = buildExploreIndex(source, defaultRecipe(source).root, {}, mode), i = index.ids.indexOf(source.tips[0]), camera = focusBox(index, i, 1000, 700);
    assert(camera.h < 1000); assert(camera.h > .002);
    assert(selectDetail(index, camera, 1000 / camera.w).nodes.includes(i));
  }
});
