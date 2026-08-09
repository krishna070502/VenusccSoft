"""
Authentication, session handling and role-based authorisation.

The browser hides what a supervisor may not see, but hiding is not security —
every endpoint re-checks the caller's role and branch access here, on the
server, before touching data.
"""

from datetime import datetime, timezone
from functools import wraps

from flask import current_app, g, jsonify, request, session

from .extensions import db
from .models import ActivityLog, Branch, User


# --------------------------------------------------------------------------
# Audit
# --------------------------------------------------------------------------
def log_activity(action: str, detail: str = "", user: User | None = None,
                 branch_code: str | None = None) -> None:
    u = user or getattr(g, "user", None)
    db.session.add(ActivityLog(
        user_id=u.id if u else None,
        user_name=u.name if u else "(anonymous)",
        role=u.role if u else None,
        branch_code=branch_code or session.get("branch"),
        action=action,
        detail=detail[:2000] if detail else "",
        ip_address=(request.headers.get("X-Forwarded-For", request.remote_addr) or "")[:64],
    ))


# --------------------------------------------------------------------------
# Session
# --------------------------------------------------------------------------
def idle_limit_minutes(role: str) -> int:
    return current_app.config["IDLE_MINUTES"].get(role, 10)


def start_session(user: User) -> None:
    session.clear()
    session["uid"] = user.id
    session["role"] = user.role
    session["last_seen"] = datetime.now(timezone.utc).timestamp()
    session.permanent = True
    codes = user.branch_codes()
    session["branch"] = codes[0] if codes else None


def end_session() -> None:
    session.clear()


def load_current_user() -> tuple[User | None, str | None]:
    """
    Returns (user, expiry_reason). A user is only returned when the session is
    live and inside the idle window for their role.
    """
    uid = session.get("uid")
    if not uid:
        return None, None

    user = db.session.get(User, uid)
    if not user or not user.is_active:
        end_session()
        return None, "account_disabled"

    limit = idle_limit_minutes(user.role) * 60
    last = session.get("last_seen", 0)
    now = datetime.now(timezone.utc).timestamp()
    if now - last > limit:
        log_activity("Auto logout", f"Idle for {idle_limit_minutes(user.role)} minutes", user=user)
        db.session.commit()
        end_session()
        return None, "idle_timeout"

    session["last_seen"] = now
    return user, None


# --------------------------------------------------------------------------
# Decorators
# --------------------------------------------------------------------------
def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not getattr(g, "user", None):
            reason = getattr(g, "session_expired", None)
            return jsonify({
                "error": "not_authenticated",
                "reason": reason,
                "message": "Your session has ended. Please sign in again."
                           if reason == "idle_timeout" else "Sign in required.",
            }), 401
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrapper(*args, **kwargs):
        if not g.user.is_admin:
            log_activity("Blocked: admin only", f"{request.method} {request.path}")
            db.session.commit()
            return jsonify({"error": "forbidden",
                            "message": "Administrator access required."}), 403
        return fn(*args, **kwargs)
    return wrapper


def branch_allowed(code: str) -> bool:
    return bool(code) and code in (g.user.branch_codes() if getattr(g, "user", None) else [])


def require_branch(code: str):
    """Returns an error response when the caller may not touch that branch."""
    if not branch_allowed(code):
        log_activity("Blocked: branch access", f"attempted {code}")
        db.session.commit()
        return jsonify({"error": "forbidden",
                        "message": f"You do not have access to branch {code}."}), 403
    return None


def branch_by_code(code: str) -> Branch | None:
    return Branch.query.filter_by(code=code).first()
