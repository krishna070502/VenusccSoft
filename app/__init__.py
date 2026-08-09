"""Application factory."""

import os

from flask import Flask, g, jsonify, render_template, request, session
from sqlalchemy.exc import IntegrityError

from .config import Config
from .extensions import db
from .security import load_current_user


def create_app(config_object=Config) -> Flask:
    app = Flask(__name__, instance_relative_config=False)
    app.config.from_object(config_object)

    db.init_app(app)

    from . import models  # noqa: F401  (registers the tables)
    from .api import bp as api_bp
    app.register_blueprint(api_bp)

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
        """A non-numeric value arrived where a number belongs."""
        db.session.rollback()
        return jsonify({"error": "validation",
                        "message": f"'{e.field}' must be a number."}), 422

    @app.errorhandler(IntegrityError)
    def _integrity(e):
        """A constraint fired — report it as a conflict, never a crash."""
        db.session.rollback()
        app.logger.warning("Integrity conflict: %s", e.orig)
        return jsonify({"error": "conflict",
                        "message": "That record already exists or conflicts with "
                                   "another. Refresh and try again."}), 409

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
