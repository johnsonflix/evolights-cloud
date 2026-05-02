#!/usr/bin/env bash
#
# Generate the Ed25519 keypair used to sign OTA firmware manifests.
#
# Run ONCE per environment (dev / staging / production). The PRIVATE key
# (ota-signing.key) belongs ONLY on the cloud panel host (mounted into the
# api container at OTA_SIGNING_KEY_PATH). The PUBLIC key (32 raw bytes,
# base64-encoded) gets compiled into firmware/wled00/wled_cloud_auth.cpp
# under the OTA_PUBKEY_B64 macro.
#
# If the private key ever leaks, every device shipping with the matching
# public key trusts whatever firmware that key signs. Plan accordingly:
# - Production keys live in a secrets manager (Vault, 1Password, AWS SM)
# - Dev/staging keys can sit on the host filesystem
#
# Usage:
#   bash tools/generate-ota-keys.sh ./secrets/ota-dev
#
# Produces:
#   secrets/ota-dev.key   PEM private key (mount into the api container)
#   secrets/ota-dev.pub   PEM public key  (humans)
#   secrets/ota-dev.b64   raw 32-byte pubkey, base64 (paste into firmware)

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <output-prefix>" >&2
  echo "Example: $0 ./secrets/ota-dev" >&2
  exit 1
fi

PREFIX="$1"
mkdir -p "$(dirname "$PREFIX")"

KEY="${PREFIX}.key"
PUB="${PREFIX}.pub"
B64="${PREFIX}.b64"

if [ -e "$KEY" ]; then
  echo "Refusing to overwrite existing $KEY" >&2
  exit 1
fi

echo "Generating Ed25519 keypair..."
openssl genpkey -algorithm ed25519 -out "$KEY"
chmod 600 "$KEY"

openssl pkey -in "$KEY" -pubout -out "$PUB"

# Extract the raw 32-byte public key from the SubjectPublicKeyInfo DER.
# Ed25519 SPKI is always: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
openssl pkey -in "$KEY" -pubout -outform DER \
  | tail -c 32 | base64 -w0 > "$B64"
echo >> "$B64"

echo
echo "Done."
echo "  Private key (cloud-only):  $KEY"
echo "  Public key (PEM):          $PUB"
echo "  Public key (raw b64):      $B64  -> $(cat "$B64")"
echo
echo "Next:"
echo "  1. Set OTA_SIGNING_KEY_PATH=$KEY in evolights-cloud/.env (or production secret)"
echo "  2. Paste the raw b64 into firmware/wled00/wled_cloud_auth.cpp:"
echo "       static const char OTA_PUBKEY_B64[] PROGMEM = \"$(cat "$B64")\";"
