# Development guidance for Clade Studio

This file applies to the repository. Keep it focused on durable project rules; put user-facing instructions in [README.md](README.md) and [public/guide.html](public/guide.html).

## Purpose and scope

Clade Studio is a local browser authoring tool for supplied phylogenetic trees and classification hierarchies. It preserves source relationships while users select, arrange and export drawings with provenance. Teachers author their own materials.

The project is not actively maintained; owner development may be sporadic or absent. Preserve this notice and the recommendation to maintain independent forks. Do not promise ongoing support, response times or a release schedule.

- Keep the application usable offline after installation and building. There are no accounts, backend services, automatic uploads or third-party runtime packages.
- Search operates on the supplied source. Do not add online lookup, relationship inference, dating, trait analysis or cross-source comparison incidentally; those need an explicit product requirement.
- Use the checked-out repository as the working source. Builds must not depend on files in a parent handoff workspace or private research folders.

## Setup and commands

Requires Node.js 22.18 or later and npm. Use `npm ci` with the committed lockfile.

| Command | Use |
| --- | --- |
| `npm run dev` | Build once, then serve at `http://127.0.0.1:4173`. |
| `npm run check` | Strict TypeScript checking. |
| `npm test` | Run the automated regression suite. |
| `npm run build` | Recreate `dist/`, check distribution inputs and generate build identity. |
| `npm start` | Serve an existing build on loopback. |
| `npm run release` | Build, test and assemble local browser/source ZIPs; no publication. |
| `npm run examples` | Generate example export packages under `outputs/`. |
| `npm run benchmark` | Record structured-layout/search measurements. |

The development server has no automatic rebuild. Rebuild and reload after source changes. Serve over HTTP; opening HTML with `file://` is unsupported.

## Code map and conventions

| Area | Main files |
| --- | --- |
| Browser UI and assets | `src/app.ts`, `src/structured/ui.ts`, `public/` |
| Parsing, source identity, search and imports | `src/newick.ts`, `src/science.ts`, `src/search.ts`, `src/import.ts`, `src/datasets.ts` |
| Scientific meaning and persistence | `src/model/`, `src/project.ts`, `src/project-v2.ts`, `public/project-v*.schema.json` |
| Accepted edits and provenance | `src/commands.ts`, `src/provenance/` |
| Structured projection, layout and validation | `src/structured/` |
| Organic geometry, shaping and fitting | `src/geometry.ts`, `src/design.ts`, `src/fitting.ts`, `src/routing.ts`, `src/worker.ts` |
| Read-only source exploration | `src/explore/` |
| Exports and distribution | `src/export.ts`, `src/export-provenance.ts`, `src/structured/export.ts`, `tools/` |

- Follow the surrounding TypeScript style and strict compiler settings. Use ESM imports with `.ts` extensions and `import type` for type-only dependencies.
- Keep scientific/model logic separate from DOM code. Extend existing modules and contracts before introducing a new abstraction or framework.
- Change source files, not generated `dist/` or `outputs/` artifacts. Avoid unrelated formatting changes.

## Scientific and editing invariants

- Preserve original Newick bytes, checksums, source IDs and duplicate identities. Store display-label corrections separately. Never silently move, merge, discard or invent taxa or resolve polytomies.
- Keep exact represented/omitted memberships and original source-edge paths through projection, reduction, save/load and export.
- Separate drawing geometry and computational traversal from biological rooting. Cladogram/Explore depth is nonmetric; phylograms require declared units and evidence. Classification links describe supplied membership. Free artistic placement makes no calibrated distance claim.
- Accepted edits must validate before replacing the current state, respect pins and preserve undo/provenance behavior. Use the existing command pipeline where applicable. Reject stale worker results and keep failed imports or discarded previews from changing the document.
- Explore owns temporary navigation/detail state only. It must not mutate artwork, reduction, pins, QA, undo or unsaved state, and its temporary summaries must not become exported artwork.
- Preserve exact stored artwork during supported project migrations. The current saved format is V4 despite the legacy `project-v2.ts` filename. Keep unknown historical provenance and unverified user citations explicit.
- Keep labeled/unlabeled SVG branch artwork identical. Editing overlays stay out of artwork SVGs but can remain in the accompanying project; document that distinction.
- Keep unresolved contacts, unavailable font measurements and work limits visible as draft findings. Do not silently shrink labels, suppress findings or claim biological validation from geometry checks.

## Licensing and release inputs

- Original contributions use **0BSD**. Scientific data retain their component-specific **CC BY 4.0** or **CC0** terms; see [REDISTRIBUTION.md](REDISTRIBUTION.md).
- Preserve upstream data bytes, attributions, license links and modification notices. New or changed bundled data require exact provenance and a component review; a citation alone is not reuse permission.
- `release/components.json` is the reviewed source-package allowlist. Register new source/test/tool/document files intended for that package under the appropriate component. Runtime assets additionally use the explicit lists in `tools/distribution-policy.mjs`.
- A changed dependency lock requires reviewing package licenses and updating the reviewed lock hash. Do not bypass the dependency, source-hash, stale-build or distribution checks to make a build pass.
- Private reference pictures, research PDFs, personal project files, credentials and installed development tools stay out of commits and release archives. The two credited images in `docs/screenshots/` are repository documentation; browser/source release ZIPs remain image-free.
- Refresh the tracked `SHA256SUMS.txt` entries for changed files and include new tracked files. Do not inventory generated outputs or the checksum file itself. Release ZIP checksums and manifests are generated by the packaging tools.

## Validation and delivery

- For runtime changes, run `npm run check`, relevant existing tests and `npm run build`; run the full `npm test` suite before delivering a release candidate. Add regression tests for changed scientific, persistence, worker or export behavior.
- For packaging changes, run `node tests/release.test.mjs` and `node tests/distribution.test.mjs`, then build and verify the affected archive inventories. Documentation-only changes need link/inventory checks and a build if reviewed build inputs changed; they do not need new tests that repeat the prose.
- For UI changes, exercise the affected workflow in a browser when available. Report unavailable verification accurately. Font-dependent exports and draft status need browser measurement; CLI estimates are not a substitute.
- Update the README or offline guide when behavior changes. Report what changed, the checks performed and any unresolved limitation.
- Follow [docs/RELEASING.md](docs/RELEASING.md) for publication. Keep the GitHub repository private under the current owner instruction. Publishing a release or changing visibility requires an explicit owner request; local packaging does neither.
- Keep release tags and their assets tied to the reviewed commit. Later development changes do not silently replace an existing release's tag or downloads.
