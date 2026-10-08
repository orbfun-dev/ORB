#!/usr/bin/env bash
# Boots the local demo validator (roadmap 7.5):
#  - the compiled SBF program at its deployed address
#  - the genesis-preloaded mock randomness account (Phase 3 finding: real
#    validators cannot set_account mid-test; the 408-byte Switchboard-shaped
#    mock must exist at genesis via --account).
#
# Usage: npm run demo:validator
set -euo pipefail
cd "$(dirname "$0")/../.."

PROGRAM_ID="G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R"
SO_FILE="target/deploy/orbit_jackpot.so"
LEDGER="target/local-demo/ledger"
RANDOMNESS_FILE="scripts/local-demo/randomness-account.json"
RANDOMNESS_PUBKEY="$(node -e '
const {PublicKey} = require("@solana/web3.js");
const oracle = PublicKey.findProgramAddressSync([Buffer.from("demo_oracle")], PublicKey.default)[0];
console.log(PublicKey.findProgramAddressSync([Buffer.from("demo_randomness","ascii")], oracle)[0].toBase58());')"

if [[ ! -f "$SO_FILE" ]]; then
  echo "missing $SO_FILE — build first: cargo build-sbf --manifest-path programs/orbit_jackpot/Cargo.toml" >&2
  exit 1
fi
if [[ ! -f "$RANDOMNESS_FILE" ]]; then
  echo "missing $RANDOMNESS_FILE — generate first: npm run demo:gen-randomness" >&2
  exit 1
fi

# A stale demo validator holds the ledger lock; stop only OUR instance.
pkill -f "solana-test-validator.*local-demo/ledger" 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"
mkdir -p "$(dirname "$LEDGER")"

echo "booting solana-test-validator…"
echo "  program   : $PROGRAM_ID"
echo "  randomness: $RANDOMNESS_PUBKEY (genesis-preloaded)"
exec solana-test-validator \
  --ledger "$LEDGER" \
  --reset \
  --bpf-program "$PROGRAM_ID" "$SO_FILE" \
  --account "$RANDOMNESS_PUBKEY" "$RANDOMNESS_FILE" \
  --rpc-port 8899
