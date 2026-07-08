#!/bin/bash
#
# One-shot publish for @npmsai/agentmint.
#
#   ./publish.sh                 # full gate, then prompt before publishing
#   ./publish.sh --yes           # full gate, publish without prompting (CI)
#   ./publish.sh --dry-run       # run the gate + pack, but never publish
#   ./publish.sh patch --yes     # bump version (patch|minor|major|x.y.z) first
#
# Auth: run `npm login` first, or set NPM_TOKEN in the environment.
set -euo pipefail

BUMP=""
ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)      ASSUME_YES=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) echo "  ✗ unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo ""
echo "🌿 AgentMint — one-shot publish"
echo ""

# 0. Auth (skip the hard check on a dry run)
if [[ $DRY_RUN -eq 0 ]]; then
  if ! npm whoami >/dev/null 2>&1; then
    echo "  ✗ not logged in to npm. Run 'npm login' or set NPM_TOKEN." >&2
    exit 1
  fi
  echo "  ✓ authenticated as $(npm whoami)"
fi

# 1. Optional version bump (writes package.json; commit yourself afterwards)
if [[ -n "$BUMP" ]]; then
  echo "  → npm version $BUMP"
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi

PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")

# 2. Refuse to republish an existing version
PUBLISHED=$(npm view "${PKG_NAME}@${PKG_VERSION}" version 2>/dev/null || true)
if [[ "$PUBLISHED" == "$PKG_VERSION" ]]; then
  echo "  ✗ ${PKG_NAME}@${PKG_VERSION} is already on npm. Bump the version first" >&2
  echo "    (e.g. ./publish.sh patch)." >&2
  exit 1
fi

# 3. Clean install + the verification gate
echo "  → npm ci"
npm ci --silent

echo "  → tsc --noEmit"
npx tsc --noEmit
echo "  ✓ typecheck"

echo "  → vitest"
npm test -- --silent 2>&1 | tail -3
echo "  ✓ tests"

echo "  → integration tests"
npx tsx --test tests/integration.test.ts 2>&1 | grep "^# " | tail -3
echo "  ✓ integration"

echo "  → build"
npm run build --silent
echo "  ✓ build"

# 4. Smoke-test the built artifact
echo "  → CLI smoke test"
node dist/cli/entry.js version
node dist/cli/entry.js demo 1 >/dev/null 2>&1
echo "  ✓ CLI works"

echo "  → ESM/CJS + subpath check"
node -e 'import("./dist/index.js").then(m => { if(typeof m.harden !== "function") throw new Error("missing harden (ESM)"); console.log("  ✓ ESM root") })'
node -e 'if(typeof require("./dist/index.cjs").harden !== "function") throw new Error("missing harden (CJS)"); console.log("  ✓ CJS root")'
node -e 'if(!require("./dist/exports/notary.cjs").Notary) throw new Error("missing /notary export"); console.log("  ✓ /notary subpath")'

# 5. Confirm the tarball is sane
echo "  → pack contents"
PACK=$(npm pack --dry-run 2>&1)
echo "$PACK" | grep -E "total files|npm notice name" || true
echo "$PACK" | grep -qi "SESSION-PREAMBLE\|PLAN.md" && { echo "  ✗ session residue in tarball" >&2; exit 1; } || echo "  ✓ no residue in tarball"
echo ""

# 6. Publish (scoped package → must be --access public)
echo "══════════════════════════════════════════"
echo "  Ready to publish ${PKG_NAME}@${PKG_VERSION}"
echo "══════════════════════════════════════════"
echo ""

if [[ $DRY_RUN -eq 1 ]]; then
  echo "  --dry-run: gate passed, nothing published."
  exit 0
fi

if [[ $ASSUME_YES -eq 0 ]]; then
  read -p "  Publish to npm? (y/n) " -n 1 -r
  echo ""
  [[ $REPLY =~ ^[Yy]$ ]] || { echo "  Aborted."; exit 0; }
fi

npm publish --access public
echo ""
echo "  ✓ Published ${PKG_NAME}@${PKG_VERSION}"
echo "    Test with: npx @npmsai/agentmint demo a"
echo ""
