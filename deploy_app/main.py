"""
Databricks Apps entry point — thin wrapper around agent.server.create_app().
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from agent.server import create_app  # noqa: E402

app = create_app(
    frontend_dirs=[
        Path(__file__).parent / "static",
        Path(__file__).parent / "frontend" / "dist",
    ],
)
