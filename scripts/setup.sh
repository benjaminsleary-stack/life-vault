#!/usr/bin/env bash
# Cloud-environment setup script (result cached between routine runs).
set -euo pipefail
python3 -m pip install --quiet --disable-pip-version-check -r "$(dirname "$0")/requirements.txt"
echo "setup ok"
