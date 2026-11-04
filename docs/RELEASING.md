# Preparing the first private GitHub release

Version: **0.1.0** · Tag: **v0.1.0** · Repository: **[EliVHD/clade-studio](https://github.com/EliVHD/clade-studio)**.

The repository was created privately on 4 November 2026. Keep it **Private** and prepare the first release as a **draft** for review. The commands below document the initial setup and release procedure; `npm run release` only creates local files. `"private": true` in `package.json` prevents accidental npm publication; GitHub visibility is a separate repository setting.

## 1. Check and package

From the source directory:

```sh
npm ci
npm run check
npm run release
```

The release command builds the app, runs the regression suite and checks exact file inventories, source hashes and component licenses. It creates:

```text
outputs/releases/clade-studio-0.1.0-browser.zip
outputs/releases/clade-studio-0.1.0-browser.zip.sha256
outputs/releases/clade-studio-0.1.0-source.zip
outputs/releases/clade-studio-0.1.0-source.zip.sha256
outputs/releases/browser-manifest.json
outputs/releases/source-manifest.json
```

The browser ZIP is the built app; the source ZIP is a reviewed buildable subset with an image-free README. Each includes its own manifest. Extract the source ZIP into a temporary directory and run `npm ci`, `npm run check` and `npm run build` there to verify a clean checkout. Start either build and follow the in-app Guide for an interactive smoke check when browser access is available.

## 2. Start from a clean repository directory

Use the prepared `clade-studio-0.1.0-repository.zip` snapshot supplied with this handoff, or extract the reviewed source ZIP into a new directory and add only these repository documentation files from the workspace:

```text
README.md                         (replace the source ZIP's shorter README)
docs/screenshots/README.md
docs/screenshots/editor.png
docs/screenshots/explore.png
```

The changelog, this guide and release notes are already in the source ZIP. The prepared repository snapshot includes the files above and a refreshed `SHA256SUMS.txt`. It is a source snapshot for initializing Git, rather than an additional application download; attach the browser/source ZIPs to the GitHub release.

When assembling the directory manually, leave the archive's root `release-manifest.json` out of Git: it inventories the original source ZIP, and replacing its README changes that inventory. The prepared repository snapshot already omits it. Keep `release/components.json`, which is required to build and package the app.

Keep `private/`, generated `outputs/`, `dist/`, `node_modules/`, personal project files and research reference assets outside the initial commit. `.gitignore` covers these, local credentials and common editor/OS files. Existing handoff plans, historical reports and technical notes remain in the original workspace; the source snapshot includes the required `reports/source_audit.json` only. Never initialize/push the whole handoff workspace as the first repository.

In the clean directory, inspect the initial staging list before committing:

```sh
git init -b main
git add .
git diff --cached --stat
git diff --cached --name-only
git commit -m "Prepare Clade Studio 0.1.0"
```

## 3. Connect the private repository

The empty repository already exists. With GitHub CLI installed and authenticated, verify its visibility, then connect and push from the clean Git directory:

```sh
gh repo view EliVHD/clade-studio --json nameWithOwner,visibility,isPrivate,url
git remote add origin https://github.com/EliVHD/clade-studio.git
git push -u origin main
```

Verify that the response reports **PRIVATE** and **isPrivate: true** before pushing or uploading release assets. If `origin` is already configured, inspect it with `git remote -v` instead of adding it again. Leave visibility private during review. [GitHub CLI documents the repository inspection options](https://cli.github.com/manual/gh_repo_view).

## 4. Tag and create a draft release

Copy the four browser/source ZIP and checksum files from step 1 into the clean repository's ignored `outputs/releases/` directory. The asset paths below refer to those exact files. Run the release commands from the clean repository so the tag names its reviewed commit:

```sh
git tag -a v0.1.0 -m "Clade Studio 0.1.0"
git push origin v0.1.0
gh release create v0.1.0 \
  outputs/releases/clade-studio-0.1.0-browser.zip \
  outputs/releases/clade-studio-0.1.0-browser.zip.sha256 \
  outputs/releases/clade-studio-0.1.0-source.zip \
  outputs/releases/clade-studio-0.1.0-source.zip.sha256 \
  --repo EliVHD/clade-studio \
  --verify-tag --draft \
  --title "Clade Studio 0.1.0" \
  --notes-file release/v0.1.0.md
```

`--verify-tag` requires the tag to exist remotely. `--draft` leaves the release unpublished. Review the rendered notes, four uploaded assets and repository visibility in GitHub before publishing the release within the private repository. [GitHub CLI documents draft releases and asset uploads](https://cli.github.com/manual/gh_release_create).

Making the repository public is a separate later decision; it is not part of these steps.
