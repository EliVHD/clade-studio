import type { Source, Layout, Presentation } from './types.ts';
import { HUG_SHA, defaultRecipe, orient, reduce } from './science.ts';
import { DEFAULT_PRESENTATION, generateLayout } from './geometry.ts';

/** A small, fully source-derived routing demonstration, deliberately not a final design. */
export function routingDemo(source: Source): { recipe: ReturnType<typeof defaultRecipe>; layout: Layout; presentation: Presentation } {
  if (source.sha256 !== HUG_SHA) throw new Error('The routing demonstration uses the bundled Hug source.');
  const recipe = defaultRecipe(source); recipe.globalThreshold = 10;
  recipe.expand = ['n000001', 'n000000', 'n005368', 'n006158'];
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe);
  recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(x => x.id);
  const presentation = { ...structuredClone(DEFAULT_PRESENTATION), junctionMm: 2 };
  const layout = generateLayout(rooted, reduction, presentation, 'organic');
  const points = {
    'virtual-root': { x: 40, y: 128 }, n000001: { x: 24, y: 72 }, n000002: { x: 8, y: 30 }, n003653: { x: 36, y: 25 },
    n000000: { x: 54, y: 90 }, n005368: { x: 64, y: 65 }, n005369: { x: 78, y: 28 },
    n006158: { x: 59, y: 158 }, n006159: { x: 45, y: 190 }, n006162: { x: 78, y: 185 }, n006163: { x: 25, y: 180 },
  };
  layout.nodes = points;
  for (const id of reduction.visible) {
    const parent = rooted.nodes[id].parent; if (!parent) continue;
    const a = layout.nodes[parent], b = layout.nodes[id];
    if (!a || !b) throw new Error('Bundled routing fixture no longer matches the source.');
    layout.routes[id] = { segments: [{ c1: { x: a.x + (b.x - a.x) * .3, y: a.y + (b.y - a.y) * .3 }, c2: { x: a.x + (b.x - a.x) * .7, y: a.y + (b.y - a.y) * .7 }, end: { ...b } }] };
  }
  layout.routes.n006158 = { segments: [{ c1: { x: 85, y: 82 }, c2: { x: 73, y: 130 }, end: { ...points.n006158 } }] };
  layout.routes.n006163 = { segments: [{ c1: { x: 61, y: 112 }, c2: { x: 34, y: 150 }, end: { ...points.n006163 } }] };
  presentation.labelOffsets.n006159 = { x: -3, y: 3 };
  return { recipe, layout, presentation };
}
