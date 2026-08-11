"""
WSGI entry point for PythonAnywhere.

Paste the contents of this file into the WSGI configuration file that
PythonAnywhere creates for you (Web tab -> "WSGI configuration file"),
replacing everything that is already in it.

Change USERNAME and PROJECT below if your paths differ.

IMPORTANT — a free PythonAnywhere account cannot reach an external database.
Outbound connections are limited to HTTP(S) to an allow-list of sites, and a
Postgres connection is neither. Neon will NOT work on the free tier; this file
therefore defaults to a local SQLite file, which is fine for testing. On a paid
account, set DATABASE_URL to your Neon string and it will be used instead.
"""

import os
import sys

USERNAME = "srinivasareddy"
PROJECT = "venus"

PROJECT_DIR = f"/home/{USERNAME}/{PROJECT}"
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

# --- settings -------------------------------------------------------------
# Anything already set in the environment (Web tab -> Environment variables,
# or a .env file in the project) wins over these defaults.
os.environ.setdefault("SECRET_KEY", "CHANGE-ME-generate-with-secrets-token-hex")
os.environ.setdefault("DATABASE_URL", f"sqlite:////home/{USERNAME}/{PROJECT}/venus.db")
os.environ.setdefault("COOKIE_SECURE", "1")        # PythonAnywhere serves HTTPS
os.environ.setdefault("FLASK_DEBUG", "0")
os.environ.setdefault("AUTO_UPGRADE_DB", "1")      # creates/updates tables on boot

# Free accounts run a single worker, so keep the pool small.
os.environ.setdefault("DB_POOL_SIZE", "2")
os.environ.setdefault("DB_MAX_OVERFLOW", "1")

from app import create_app                                    # noqa: E402
from app.config import ProductionConfig                       # noqa: E402

application = create_app(ProductionConfig)
