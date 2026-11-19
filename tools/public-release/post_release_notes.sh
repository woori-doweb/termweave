#!/bin/zsh
# Post a version's update notes as its GitHub Release body. Every update gets this post.
# The notes come from the public export's CHANGELOG.termweave.md, which already passed the leak
# scan. GitHub's --generate-notes keeps only its "Full Changelog" compare link.
# Usage: post_release_notes.sh v0.3.36
set -euo pipefail
tag=$1 ver=${1#v}
pub=${0:A:h:h:h}/.local/public
entry=$(awk -v v="$ver" 'index($0, "## [" v "]") == 1 { f = 1; next } /^## \[/ { if (f) exit } f' "$pub/CHANGELOG.termweave.md")
first=$(print -r -- "$entry" | grep -m1 '^- ' || true)
[[ -n $first ]] || { print "FAIL[release-notes]: no changelog entry for $tag"; exit 1; }
cd "$pub"
compare=$(gh release view "$tag" --json body -q .body | grep '^\*\*Full Changelog\*\*' || true)
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
{ print "## 업데이트 내역 / Changes"; print -r -- "$entry"; [[ -z $compare ]] || { print; print -r -- "$compare"; } } > "$notes"
gh release edit "$tag" --notes-file "$notes" >/dev/null
gh release view "$tag" --json body -q .body | grep -qF -- "$first" || { print "FAIL[release-notes]: $tag body does not show the notes"; exit 1; }
print "PASS[release-notes]: $tag"
