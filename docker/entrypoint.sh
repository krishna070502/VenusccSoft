#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# Container entrypoint: wait for the database, create tables, then hand over
# to whatever CMD asked for (gunicorn by default).
# ---------------------------------------------------------------------------
set -e

log() { echo "[entrypoint] $*"; }

if [ "${WAIT_FOR_DB:-1}" = "1" ]; then
  log "waiting for the database to accept connections..."
  python - <<'PY'
import os, sys, time
from sqlalchemy import create_engine, text
sys.path.insert(0, "/app")
from app.config import Config

url = Config.SQLALCHEMY_DATABASE_URI
deadline = time.time() + int(os.environ.get("DB_WAIT_SECONDS", 60))
last = None
while time.time() < deadline:
    try:
        create_engine(url, pool_pre_ping=True).connect().execute(text("SELECT 1"))
        print("[entrypoint] database is up")
        sys.exit(0)
    except Exception as exc:
        last = exc
        time.sleep(2)
print(f"[entrypoint] database did not respond in time: {last}", file=sys.stderr)
sys.exit(1)
PY
fi

if [ "${AUTO_INIT_DB:-1}" = "1" ]; then
  log "ensuring tables exist"
  python manage.py init-db
  python manage.py upgrade-db
fi

if [ -n "${ADMIN_USERNAME}" ] && [ -n "${ADMIN_PASSWORD}" ]; then
  log "ensuring an administrator account exists"
  python - <<'PY'
import os, sys
sys.path.insert(0, "/app")
from app import create_app
from app.extensions import db
from app.models import Branch, User

app = create_app()
with app.app_context():
    if User.query.filter_by(role="admin").first():
        print("[entrypoint] an admin already exists, leaving it alone")
    else:
        u = User(name=os.environ.get("ADMIN_NAME", "System Admin"),
                 username=os.environ["ADMIN_USERNAME"], role="admin")
        u.set_password(os.environ["ADMIN_PASSWORD"])
        u.branches = Branch.query.all()
        db.session.add(u)
        db.session.commit()
        print(f"[entrypoint] created admin '{u.username}'")
PY
fi

log "starting: $*"
exec "$@"
