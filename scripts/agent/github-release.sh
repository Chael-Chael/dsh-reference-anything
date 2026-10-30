#!/usr/bin/env bash
set -euo pipefail
RELEASE_SHA="${RELEASE_SHA:-$GITHUB_SHA}"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  const pkg = JSON.parse(readFileSync("package.json"));
  const dir = process.env.RUNNER_TEMP + "/candidate/";
  const [pack] = JSON.parse(readFileSync(dir + "pack.json"));
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(dir + "candidate.tgz")).digest("base64");
  if (pkg.name !== pack.name || pkg.version !== pack.version || integrity !== pack.integrity) throw new Error("Release artifact does not match source or integrity");
'
version=$(node -p "require('./package.json').version")
tag="v$version"
notes="docs/release/$version/README.md"
test -s "$notes"
if git show-ref --verify --quiet "refs/tags/$tag"; then
  test "$(git rev-parse "refs/tags/$tag^{commit}")" = "$RELEASE_SHA"
fi
asset="$RUNNER_TEMP/candidate/dsh-reference-anything-$tag.tgz"
cp "$RUNNER_TEMP/candidate/candidate.tgz" "$asset"
if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" --target "$RELEASE_SHA" --draft --title "$tag" --notes-file "$notes"
fi
gh release upload "$tag" "$asset" --clobber
prerelease=false
latest=true
if [[ "$version" == *-* ]]; then prerelease=true; latest=false; fi
gh release edit "$tag" --draft=false --title "$tag" --notes-file "$notes" --prerelease="$prerelease" --latest="$latest"
