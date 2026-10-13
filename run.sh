#!/usr/bin/env bash
# Create a Python 3.12 environment (usd-brep ships cp312 wheels) and start the app.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
    if command -v uv >/dev/null; then
        uv venv -p 3.12 .venv
        uv pip install -p .venv/bin/python -e ".[dev,step]"
    else
        python3.12 -m venv .venv
        .venv/bin/pip install -e ".[dev,step]"
    fi
fi
exec .venv/bin/python -m cad3d.server --open "$@"
