# Preparing a Clade Studio release

Current version: **0.1.1** · Tag: **v0.1.1** · Repository: **[EliVHD/clade-studio](https://github.com/EliVHD/clade-studio)**.

The project is not actively maintained; a release does not promise ongoing support or a release schedule. `npm run release` only creates local files. Publishing a GitHub release requires an explicit owner request. Preserve the repository's configured visibility and all existing release tags and assets.

## 1. Prepare the source

Start from the reviewed, merged repository commit. Update `package.json`, the application version fields in `package-lock.json`, the changelog, README links and version-specific release notes. Register new notes in `release/components.json`.

Review any dependency-lock changes before refreshing `reviewedDependencyLockSha256`. An application-version-only bump may update the lock hash after confirming all dependency versions, integrity values, licenses and development-only scope are unchanged. CLI example exporters derive their software version from `package.json`. The internal legacy V1 project shim and historical fixtures retain their historical version values.

Refresh `SHA256SUMS.txt` for tracked files, including new release inputs and excluding the checksum file itself. Preserve upstream scientific-data bytes and component terms.

## 2. Check and package

```sh
npm ci
npm run check
npm run release
sha256sum -c SHA256SUMS.txt
```

The release command builds the app, runs the regression suite and verifies component licenses, build identity, stale inputs, exact file inventories and payload hashes. It creates:

```text
outputs/releases/clade-studio-0.1.1-browser.zip
outputs/releases/clade-studio-0.1.1-browser.zip.sha256
outputs/releases/clade-studio-0.1.1-source.zip
outputs/releases/clade-studio-0.1.1-source.zip.sha256
outputs/releases/browser-manifest.json
outputs/releases/source-manifest.json
```

Extract the source ZIP into a temporary directory and run `npm ci`, `npm run check` and `npm run build` there. Verify each archive against its internal `release-manifest.json`, and verify the companion download checksums. Exercise affected browser workflows when available; report any unavailable live-browser or font verification accurately.

Commit the reviewed version changes and refreshed source inventory. Build from that exact commit; do not include installed dependencies, generated outputs, private research, reference pictures or personal projects in Git. The two credited repository screenshots remain documentation only; browser/source release ZIPs are image-free.

## 3. Upload a draft tied to the reviewed commit

Verify the target repository and existing tags/releases before uploading. Use a new tag for each version. With the release commit checked out:

```sh
gh release create v0.1.1 \
  outputs/releases/clade-studio-0.1.1-browser.zip \
  outputs/releases/clade-studio-0.1.1-browser.zip.sha256 \
  outputs/releases/clade-studio-0.1.1-source.zip \
  outputs/releases/clade-studio-0.1.1-source.zip.sha256 \
  --repo EliVHD/clade-studio \
  --target "$(git rev-parse HEAD)" \
  --draft --prerelease \
  --title "Clade Studio 0.1.1" \
  --notes-file release/v0.1.1.md
```

When the tag does not exist, GitHub creates it at the specified commit. If an annotated tag is prepared separately, push that exact tag and use `--verify-tag` instead. Never move an existing release tag or silently replace its downloads.

## 4. Verify and publish

Review the draft's notes, target commit, prerelease status and four uploaded assets. Download the assets and compare their hashes with the verified local files. Only after those checks, and under the owner's release request, publish:

```sh
gh release edit v0.1.1 --repo EliVHD/clade-studio --draft=false --prerelease
```

Verify the published URL and asset sizes/hashes. Retain the prerelease classification unless the owner requests a stable release. [GitHub CLI release documentation](https://cli.github.com/manual/gh_release_create).
