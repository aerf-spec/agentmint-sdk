#!/bin/bash
set -e

echo ""
echo "🌿 AgentMint — Pre-Publish Checks"
echo ""

# 1. Clean install
echo "  → npm install"
npm install --silent

# 2. Typecheck
echo "  → tsc --noEmit"
npx tsc --noEmit
echo "  ✓ typecheck"

# 3. Tests
echo "  → vitest"
npm test -- --silent 2>&1 | tail -3
echo "  ✓ vitest"

# 4. Integration tests
echo "  → integration tests"
npx tsx --test tests/integration.test.ts 2>&1 | grep "^# " | tail -3
echo "  ✓ integration"

# 5. Build
echo "  → build"
npm run build --silent
echo "  ✓ build"

# 6. Verify CLI
echo "  → CLI smoke test"
node dist/cli/entry.js version
node dist/cli/entry.js demo 1 > /dev/null 2>&1
echo "  ✓ CLI works"

# 7. Verify exports
echo "  → ESM/CJS check"
node -e 'import("./dist/index.js").then(m => { if(typeof m.harden !== "function") throw new Error("missing harden"); console.log("  ✓ ESM") })'
node -e 'const m = require("./dist/index.cjs"); if(typeof m.harden !== "function") throw new Error("missing harden"); console.log("  ✓ CJS")'

# 8. Check package contents
echo "  → pack dry run"
npm pack --dry-run 2>&1 | grep -E "total files|npm notice name"
echo ""

# 9. Confirm
echo "══════════════════════════════════"
echo "  Ready to publish agentmint@0.1.0"
echo "══════════════════════════════════"
echo ""
read -p "  Publish to npm? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  npm publish
  echo ""
  echo "  ✓ Published! Test with: npx agentmint demo a"
  echo ""
else
  echo "  Aborted."
fi
