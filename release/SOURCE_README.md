# Clade Studio

A local browser app for turning supplied phylogenetic trees and classification hierarchies into editable drawings with sources and methods attached. Import Newick, select organisms or groups, choose a layout, refine and export SVG artwork.

The app runs locally without accounts, a backend or file uploads. Relationships come from the supplied tree; there is no online organism lookup or relationship inference. Version 0.1.0 is the first release.

Repository: [EliVHD/clade-studio](https://github.com/EliVHD/clade-studio). Access is initially private.

## Quick start

Requires **Node.js 22.18 or later** and npm, installed separately. In this directory:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4173**. The app starts with the bundled Hug et al. tree-of-life example. Stop the server with **Ctrl+C**.

`npm ci` downloads locked build tools; the app has no third-party runtime packages. After installation and building, it works offline. `npm run dev` builds once, with no automatic rebuild. After source edits, run `npm run build` and reload. Use `npm start` to serve an existing build. Serve over HTTP; opening the HTML directly from disk is unsupported.

For the separate browser ZIP, extract it and serve that folder with a local static HTTP server. For example, with Python 3 installed:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

## Make your first drawing

1. Use **Datasets** for a bundled tree or **Open file** for Newick (`.nwk`, `.newick`, `.tree`, `.txt`) or a saved project (`.json`). **Layout → New synthetic sample tree** provides a small invented A–E example.
2. Open **Scientific basis · Edit** below the title to describe the source and relationship meaning. Bundled datasets have curated metadata.
3. In **Layout**, search for tips or use a selected clade. Choose the layout, page dimensions and appearance, then **Preview layout → Use layout**.
4. Refine junctions and labels, pin positions, try **Preview readability**, or **Create artistic copy** for free placement. Accept or discard previews explicitly.
5. **Save project** downloads an editable V4 checkpoint. **Export package** downloads paired labeled/unlabeled SVGs, the project, source mappings, QA, references and Sources & Methods. V1–V3 project imports retain stored artwork through migration.

**Save before closing: there is no persistent autosave.** Keep backup downloads requested when replacing unsaved work. Editing images remain embedded in projects, including projects inside export packages, although artwork SVGs omit them.

Use **Guide** in the app header for the full walkthrough and troubleshooting, or open http://127.0.0.1:4173/guide.html while the server is running. Its source is [public/guide.html](public/guide.html).

## Explore and choose layouts

**Explore** opens a separate read-only rectangular, circular or fan viewer of the complete source. Scroll to zoom, drag to pan, search any name/source ID and double-click to focus. Shaded groups show exact tip counts. **← Editor** returns to the unchanged artwork; export always uses accepted editor geometry.

Authoring supports rectangular/circular/fan cladograms, documented source-distance phylograms, supplied-rank classifications and unrooted equal-angle/daylight views. Artistic copies allow independent free placement. Organic additionally supports manual curves, endpoint borders, local image overlays and fitting previews.

Cladogram and Explore depth is nonmetric. Distance layouts require source units/evidence; classification links retain supplied membership meaning. The tool does not infer dates, ranks or missing relationships. Layout/fitting can leave overlaps. Draft findings remain visible; Checked refers to implemented geometry/coverage checks, not authentication of biological claims.

One source per project. Newick limits: 20 MB, 100,000 nodes, depth 800; project imports: 50 MB. These are input limits, not speed guarantees. Large trees are best explored in full and drawn as selected subsets.

## Development and release

```sh
npm run check      # strict TypeScript checking
npm test           # source, geometry, persistence, export and distribution checks
npm run build      # rebuild and verify dist/
npm run release    # build, test and create browser/source ZIPs with SHA256 records
npm run examples   # generate example exports under outputs/
npm run benchmark  # record structured-layout and search timings
```

Release files are created under `outputs/releases/`; no GitHub publication occurs. See [release instructions](docs/RELEASING.md), [release notes](release/v0.1.0.md) and [CHANGELOG.md](CHANGELOG.md). This image-free source bundle uses a shorter README than the repository's illustrated overview.

## License and bundled data

Original software and documentation: [0BSD](LICENSE). Bundled sources include Hug (2016, CC BY 4.0), Upham mammals (2019, CC0), dos Reis primates (2018, CC0) and Kew release 4.0 plants (CC BY 4.0). Each has source-specific credits and limitations. See [REDISTRIBUTION.md](REDISTRIBUTION.md), [release/components.json](release/components.json) and `release-manifest.json` for exact file-level terms and hashes.

No private reference photographs, research PDFs, installed development tools or personal projects are included. Check rights to your own inputs before sharing project files.
