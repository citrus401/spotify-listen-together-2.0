#!/usr/bin/env bash
# puts a built listenTogether.js on the build branch. used by the build workflow, runs fine locally too:
#   RUN=<build number> REMOTE=<git url> bash .github/publish-build.sh path/to/listenTogether.js
set -euo pipefail

FILE="$1"
RUN="${RUN:?need RUN, the build number}"
KEEP="${KEEP:-30}"
VERSION=$(node -p "require('./package.json').version")
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
REMOTE="${REMOTE:-https://x-access-token:${TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"

# sanity check, a broken build going out would hit everyone on auto update
SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 10000 ]; then echo "build is only $SIZE bytes, not publishing that"; exit 1; fi

WORK=$(mktemp -d)
cp "$FILE" "$WORK/new.js"
cd "$WORK"
git init -q
git remote add origin "$REMOTE"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# first ever run there's no build branch yet
if git fetch -q --depth 1 origin build 2>/dev/null; then
  git checkout -q -b build FETCH_HEAD
else
  git checkout -q --orphan build
fi

mkdir -p builds
mv new.js "builds/$RUN.js"
cp "builds/$RUN.js" listenTogether.js
# only the last $KEEP builds, the branch would just keep growing otherwise
ls builds | sed 's/\.js$//' | sort -n | head -n "-$KEEP" | while read -r old; do rm -f "builds/$old.js"; done

cat > version.json <<EOF
{ "version": "$VERSION", "build": $RUN, "sha": "$SHA", "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
EOF

git add -A
git commit -q -m "build $RUN (v$VERSION) from ${SHA:0:7}"
git push -q origin build
echo "published build $RUN (v$VERSION)"
