"""
Configuration. Nothing secret is hard-coded — everything comes from the
environment (see .env). This keeps the database password out of source
control and lets you point staging and production at different servers.
"""

import os
from datetime import timedelta
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))


def _normalise(url: str) -> str:
    """SQLAlchemy 2 wants postgresql+psycopg2://, Neon hands out postgresql://."""
    if not url:
        return ""
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
    # psycopg2 does not understand this Neon-specific query parameter
    url = url.replace("&channel_binding=require", "").replace("?channel_binding=require&", "?")
    return url


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "change-me-in-production")

    SQLALCHEMY_DATABASE_URI = _normalise(
        os.environ.get("DATABASE_URL")
        or f"sqlite:///{os.path.join(BASE_DIR, 'venus_dev.db')}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Connection pooling matters on Neon: it closes idle connections, so we
    # recycle before that happens and check liveness before handing one out.
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 280,
        "pool_size": int(os.environ.get("DB_POOL_SIZE", 10)),
        "max_overflow": int(os.environ.get("DB_MAX_OVERFLOW", 20)),
        "pool_timeout": 30,
    }

    # Session cookies
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"
    PERMANENT_SESSION_LIFETIME = timedelta(hours=12)

    # Idle timeouts, in minutes, enforced on the server as well as in the UI
    IDLE_MINUTES = {
        "admin": int(os.environ.get("IDLE_ADMIN_MIN", 2)),
        "supervisor": int(os.environ.get("IDLE_SUPERVISOR_MIN", 10)),
    }

    MAX_CONTENT_LENGTH = 24 * 1024 * 1024      # mortality photo uploads
    JSON_SORT_KEYS = False


class ProductionConfig(Config):
    SESSION_COOKIE_SECURE = True


class TestConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SQLALCHEMY_ENGINE_OPTIONS = {}
