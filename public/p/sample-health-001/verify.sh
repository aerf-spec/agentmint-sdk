#!/usr/bin/env bash
set -euo pipefail
EXPECTED="8d48e9f63b48299aeadb28b323ea29a5edf0c89c2bdec45ebb54ef36cee1fa8b"
URL="https://agentmint.run/p/sample-health-001/packet.json"
ACTUAL=$(curl -s "$URL" | sha256sum | cut -d' ' -f1)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "OK  packet matches attested hash $EXPECTED";
else echo "FAIL  expected $EXPECTED"; echo "      got      $ACTUAL"; exit 1; fi
