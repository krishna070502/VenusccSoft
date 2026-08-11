"""Application factory."""

import os

from flask import Flask, g, jsonify, render_template, request, session
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError

from .config import Config
from .extensions import db
from .security import load_current_user

# What a database says when the code expects a column the table has not got.
SCHEMA_SIGNS = ("no such column", "undefinedcolumn", "does not exist",
                "unknown column", "no such table", "undefinedtable")


def create_app(config_object=Config) -> Flask:
    app = Flask(__name__, instance_relative_config=False)
    app.config.from_object(config_object)

    db.init_app(app)

    from . import models  # noqa: F401  (registers the tables)
    from .api import bp as api_bp
    app.register_blueprint(api_bp)

    # ---- keep the schema in step with the models -------------------------
    # An installation upgraded from an earlier release has the old tables but
    # not the newer columns. Left alone that surfaces as a 500 on the first
    # request after signing in, which tells the user nothing. Close the gap at
    # start-up instead. Set AUTO_UPGRADE_DB=0 to manage migrations yourself.
    if os.environ.get("AUTO_UPGRADE_DB", "1") == "1":
        from .schema import schema_gaps, upgrade_schema
        with app.app_context():
            try:
                gaps = schema_gaps()
                if gaps:
                    fresh = all(g.startswith("missing table") for g in gaps)
                    app.logger.warning("Creating the database tables"
                                       if fresh else
                                       "Database is behind the models — upgrading")
                    report = upgrade_schema(verbose=False)
                    app.logger.warning(
                        "Schema %s: %d table(s), %d column(s), %d index(es)",
                        "created" if fresh else "upgraded",
                        len(report["tablesCreated"]), len(report["columnsAdded"]),
                        len(report["indexesCreated"]))
                    for problem in report["problems"]:
                        app.logger.error("Schema upgrade problem: %s", problem)
            except Exception as exc:                       # pragma: no cover
                # never stop the app booting over this; the handlers below
                # will explain the problem on the first request that hits it
                app.logger.error("Could not check the schema: %s", exc)

    # ---- per-request user resolution ------------------------------------
    @app.before_request
    def _resolve_user():
        g.user = None
        g.session_expired = None
        if request.path.startswith("/static/"):
            return
        user, reason = load_current_user()
        g.user = user
        g.session_expired = reason

    # ---- the single-page UI ---------------------------------------------
    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def healthz():
        try:
            db.session.execute(db.text("SELECT 1"))
            return jsonify({"status": "ok", "database": "reachable"})
        except Exception as exc:                       # pragma: no cover
            return jsonify({"status": "degraded", "database": str(exc)}), 503

    # ---- JSON error handlers so the SPA never sees an HTML error page ----
    @app.errorhandler(404)
    def _404(e):
        if request.path.startswith("/api/"):
            return jsonify({"error": "not_found"}), 404
        return render_template("index.html"), 200

    from .api import FieldError

    @app.errorhandler(FieldError)
    def _field(e):
        """A value arrived that the server cannot use."""
        db.session.rollback()
        return jsonify({"error": "validation",
                        "field": e.field,
                        "message": e.message or f"'{e.field}' must be a number."}), 422

    @app.errorhandler(IntegrityError)
    def _integrity(e):
        """A constraint fired — report it as a conflict, never a crash."""
        db.session.rollback()
        app.logger.warning("Integrity conflict: %s", e.orig)
        return jsonify({"error": "conflict",
                        "message": "That record already exists or conflicts with "
                                   "another. Refresh and try again."}), 409

    def _schema_response(exc):
        """A driver error caused by a database that is behind the models."""
        db.session.rollback()
        from .schema import schema_gaps
        try:
            gaps = schema_gaps()
        except Exception:                                  # pragma: no cover
            gaps = []
        app.logger.error("Schema mismatch: %s", exc)
        detail = ("; ".join(gaps[:6]) + ("…" if len(gaps) > 6 else "")) if gaps else str(exc)
        return jsonify({
            "error": "schema_outdated",
            "gaps": gaps,
            "message": ("The database is missing something this version needs "
                        f"({detail}). Run  python manage.py upgrade-db  and sign "
                        "in again."),
        }), 503

    @app.errorhandler(OperationalError)
    @app.errorhandler(ProgrammingError)
    def _db_error(e):
        text = str(getattr(e, "orig", e)).lower()
        if any(sign in text for sign in SCHEMA_SIGNS):
            return _schema_response(e)
        db.session.rollback()
        app.logger.exception("Database error")
        return jsonify({"error": "database_error",
                        "message": "The database could not be reached or refused "
                                   "the request. Nothing was changed."}), 503

    @app.errorhandler(Exception)
    def _unhandled(e):
        """
        Anything not caught above. A bare 500 with no reason is useless when
        something goes wrong in the field, so log the traceback and say which
        request failed.
        """
        from werkzeug.exceptions import HTTPException
        if isinstance(e, HTTPException):
            return e
        db.session.rollback()
        app.logger.exception("Unhandled error on %s %s", request.method, request.path)
        return jsonify({"error": "server_error",
                        "message": f"Something went wrong handling {request.path}. "
                                   f"The change was rolled back. "
                                   f"({type(e).__name__})"}), 500

    @app.errorhandler(500)
    def _500(e):                                       # pragma: no cover
        db.session.rollback()
        return jsonify({"error": "server_error",
                        "message": "Something went wrong. The change was rolled back."}), 500

    @app.errorhandler(413)
    def _413(e):
        return jsonify({"error": "too_large",
                        "message": "Upload too large. Reduce the number of photos."}), 413

    return app
