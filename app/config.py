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
    # pool_pre_ping means a real user request that lands after Neon has
    # scaled its compute to zero (autosuspend — see healthz() in
    # app/__init__.py for how that gets triggered far more than it should)
    # is not itself a failure: the stale pooled connection fails its ping,
    # SQLAlchemy transparently discards it and opens a fresh one, and the
    # request just carries a bit of extra latency while Neon wakes back up
    # — normally under a second or two — rather than erroring out. No data
    # is lost or left half-written; the request either waits and succeeds,
    # or (only if the database is genuinely unreachable, not merely asleep)
    # surfaces as the clean 503 the OperationalError handler returns.
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 280,
        "pool_size": int(os.environ.get("DB_POOL_SIZE", 10)),
        "max_overflow": int(os.environ.get("DB_MAX_OVERFLOW", 20)),
        "pool_timeout": 30,
    }
    # connect_timeout is a psycopg2-only keyword (SQLite's DBAPI has no such
    # argument and raises TypeError if it's handed one), so this only
    # applies when actually talking to Postgres. A bound here is about
    # predictability, not working around Neon's wake-up time specifically —
    # 10 seconds is generously above any normal autosuspend wake (well
    # under a second in practice) and just stops a genuinely unreachable
    # database from hanging a request indefinitely instead of failing fast.
    if SQLALCHEMY_DATABASE_URI.startswith("postgresql"):
        SQLALCHEMY_ENGINE_OPTIONS["connect_args"] = {"connect_timeout": 10}

    # Session cookies
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"
    PERMANENT_SESSION_LIFETIME = timedelta(hours=12)

    # Idle timeout, in minutes, enforced on the server as well as in the UI.
    # Admin has no entry here on purpose — idle_limit_minutes() in security.py
    # hardcodes admin to unlimited (no auto-logout at all), so this dict only
    # ever needs to cover roles that actually get timed out.
    #
    # Was 10 — far too tight for a supervisor actually doing the job this app
    # is for: weighing birds, counting stock, walking between the shed and
    # the counter, all with the phone in a pocket between taps. A phone
    # backgrounds or locks in well under 10 minutes on its own, so 10 minutes
    # of no taps was getting read as "walked away", logging people out mid
    # data-entry multiple times a shift. 30 still logs out a device left
    # unattended, just not one that's mid-form between physical steps.
    IDLE_MINUTES = {
        "supervisor": int(os.environ.get("IDLE_SUPERVISOR_MIN", 30)),
    }

    MAX_CONTENT_LENGTH = 24 * 1024 * 1024      # mortality photo uploads
    JSON_SORT_KEYS = False


class ProductionConfig(Config):
    SESSION_COOKIE_SECURE = True


class TestConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SQLALCHEMY_ENGINE_OPTIONS = {}
