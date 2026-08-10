"""
REST API.

Every response the browser needs is served from here. Authorisation is
re-checked per endpoint; buying prices and profit figures are stripped from
payloads sent to supervisors rather than merely hidden by CSS.
"""

import calendar
from datetime import datetime, date, timezone
from decimal import Decimal, InvalidOperation

from flask import Blueprint, g, jsonify, request, session
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from .calc import (PRODUCTS, compute_entry, costing_gaps, months_in_range,
                   price_hotel_line, validate_for_submission)
from .extensions import db
from .models import (ActivityLog, Branch, Customer, CustomerPayment, CustomerSale,
                     DailyEntry, LabourLedger, MortalityPhoto, Overhead, Purchase,
                     Setting, User, Worker, utcnow)
from .security import (admin_required, branch_by_code, log_activity,
                       login_required, require_branch, idle_limit_minutes,
                       start_session, end_session)

bp = Blueprint("api", __name__, url_prefix="/api")

DEFAULT_SETTINGS = {"waste_broiler": "31", "waste_parents": "21",
                    "tolerance": "2", "day_wage": "700"}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def get_settings() -> dict:
    rows = {s.key: s.value for s in Setting.query.all()}
    merged = {**DEFAULT_SETTINGS, **rows}
    return {k: float(v) for k, v in merged.items()}


class FieldError(ValueError):
    """
    A client sent something the server cannot use. Without a message this
    reports as 'not a number', which is the common case; pass one when the
    problem is something else, such as an unknown customer.
    """

    def __init__(self, field, message=None):
        self.field = field
        self.message = message
        super().__init__(message or field)


def to_int(value, field):
    if value in (None, ""):
        return 0
    try:
        return int(float(value))
    except (TypeError, ValueError):
        raise FieldError(field) from None


def to_dec(value, field):
    if value in (None, ""):
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise FieldError(field) from None


def parse_stamp(value, field="datetime"):
    """
    Accept 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' and return (date, datetime).
    The time is kept so the record shows the hour the supervisor recorded,
    not the moment the server happened to receive it.
    """
    if not value:
        return None, None
    txt = str(value).strip().replace(" ", "T")
    try:
        d = datetime.strptime(txt[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise FieldError(field) from None
    hh, mm = 0, 0
    if len(txt) >= 16 and txt[10] == "T":
        try:
            hh, mm = int(txt[11:13]), int(txt[14:16])
        except (TypeError, ValueError):
            raise FieldError(field) from None
        if not (0 <= hh < 24 and 0 <= mm < 60):
            raise FieldError(field)
    return d, datetime(d.year, d.month, d.day, hh, mm, tzinfo=timezone.utc)


def parse_date(value, fallback=None, field="date"):
    """Parse YYYY-MM-DD. A malformed value is a 422, never a crash."""
    if not value:
        return fallback
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise FieldError(field) from None


def labour_for(branch_id: int, day: date) -> dict:
    """
    Labour money for one branch on one day.

      wages    — day wages earned by whoever was present
      advances — cash handed to workers that day; deducted from that day's
                 profit and shown on its own line, like an overhead
      other    — tea, tiffin and other shop-paid extras
    """
    rows = LabourLedger.query.filter_by(branch_id=branch_id, entry_date=day).all()
    wages = sum(float(r.amount) for r in rows if r.kind == "work")
    man_days = sum(float(r.days) for r in rows if r.kind == "work")
    advances = sum(float(r.amount) for r in rows if r.kind == "advance")
    other = sum(float(r.amount) for r in rows if r.kind in ("tea", "tiffin", "other"))
    return {"wages": wages, "advances": advances, "other": other, "manDays": man_days}


def overhead_day_share(branch_id: int, day: date) -> float:
    """
    A month's approved overheads spread evenly over the days of that month,
    so every trading day carries its share of rent, power and salary.
    """
    month = day.strftime("%Y-%m")
    total = sum(float(o.amount) for o in Overhead.query.filter_by(
        branch_id=branch_id, period_month=month, status="approved").all())
    days_in_month = calendar.monthrange(day.year, day.month)[1]
    return (total / days_in_month) if days_in_month else 0.0


def day_costs_for(branch_id: int, day: date) -> dict:
    """
    Labour and overheads for one branch-day, divided between the entries that
    share that day. Without the split, broiler and parents on the same day
    would each be charged the whole day's wages.
    """
    share = DailyEntry.query.filter_by(branch_id=branch_id, business_date=day).count() or 1
    lab = labour_for(branch_id, day)
    return {
        "wages": lab["wages"] / share,
        "advances": lab["advances"] / share,
        "other": lab["other"] / share,
        "manDays": lab["manDays"] / share,
        "overheads": overhead_day_share(branch_id, day) / share,
        "shared": share,
    }


def entry_payload(entry: DailyEntry, settings: dict) -> dict:
    """Entry plus its server-computed figures, filtered by role."""
    show_costs = g.user.is_admin
    data = entry.to_dict(include_costs=show_costs)
    calc = compute_entry(entry.to_dict(include_costs=True), settings,
                         day_costs_for(entry.branch_id, entry.business_date))
    if not show_costs:
        for key in ("buyAmt", "openValue", "availValue", "avgRate", "meatCostKg",
                    "cogs", "grossProfit", "labour", "advances", "otherExp",
                    "overheads", "netProfit",
                    "closeValue", "openMeatValue", "mortValue", "damageValue",
                    "shortValue", "bonusValue"):
            calc.pop(key, None)
    data["calc"] = calc
    return data


def visible_branch_ids() -> list[int]:
    codes = g.user.branch_codes()
    if not codes:
        return []
    return [b.id for b in Branch.query.filter(Branch.code.in_(codes)).all()]


def _apply_entry_fields(entry: DailyEntry, d: dict) -> None:
    """Copy the editable numeric fields from a client payload onto the row."""
    ints = {
        "openBirds": "open_birds", "openWtG": "open_weight_g", "openMeatG": "open_meat_g",
        "liveSoldCount": "live_sold_count", "liveSoldWtG": "live_sold_weight_g",
        "mortCount": "mortality_count", "mortWtG": "mortality_weight_g",
        "damageG": "damage_meat_g", "dressedCount": "dressed_count",
        "dressedWtG": "dressed_weight_g", "actualMeatG": "actual_meat_g",
        "skinSoldG": "skin_sold_g", "skinlessSoldG": "skinless_sold_g",
        "liverSoldG": "liver_sold_g", "closeBirds": "close_birds",
        "closeWtG": "close_weight_g", "closeMeatG": "close_meat_g",
    }
    for src, col in ints.items():
        if src in d:
            setattr(entry, col, to_int(d.get(src), src))

    money = {"rateSkin": "rate_skin", "rateSkinless": "rate_skinless",
             "rateLiver": "rate_liver", "rateLive": "rate_live",
             "cutCharges": "cutting_charges"}
    for src, col in money.items():
        if src in d:
            setattr(entry, col, to_dec(d.get(src), src))

    if "notes" in d:
        entry.notes = (d.get("notes") or "")[:2000]
    if "explanation" in d:
        entry.explanation = (d.get("explanation") or "")[:2000]

    # Buying prices are admin-only, in the payload and in the database write.
    if g.user.is_admin and "openRate" in d:
        entry.open_rate = to_dec(d.get("openRate"), "openRate")


def _replace_purchases(entry: DailyEntry, rows: list) -> None:
    existing_rates = [float(p.rate) for p in entry.purchases]
    entry.purchases.clear()
    for i, r in enumerate(rows or []):
        # a supervisor cannot set or change a rate; keep whatever the admin had
        if g.user.is_admin:
            rate = to_dec(r.get("rate"), f"purchase[{i}].rate")
        else:
            rate = Decimal(str(existing_rates[i])) if i < len(existing_rates) else Decimal("0")
        entry.purchases.append(Purchase(
            supplier=(r.get("supplier") or "")[:160],
            batch_no=(r.get("batch") or "")[:64],
            birds=to_int(r.get("birds"), f"purchase[{i}].birds"),
            weight_g=to_int(r.get("wtG"), f"purchase[{i}].wtG"),
            rate=rate,
        ))


def _snapshot_sale(sale: CustomerSale, entry: DailyEntry, customer: Customer) -> None:
    """
    Recompute one hotel line's market rate, charged rate and amount from the
    entry's current selling rates and the customer's agreed concession. Called
    on every save so an admin editing Section C reprices every hotel bill.
    """
    priced = price_hotel_line({
        "product": sale.product,
        "weightG": sale.weight_g,
        "mode": customer.price_mode,
        "less": customer.less_for(sale.product),
        "fixed": customer.fixed_for(sale.product),
        "rateOverride": (float(sale.rate_override)
                         if sale.rate_override is not None else None),
    }, {"rateSkin": entry.rate_skin, "rateSkinless": entry.rate_skinless,
        "rateLiver": entry.rate_liver})
    sale.market_rate = priced["market"]
    sale.rate = priced["rate"]
    sale.amount = priced["amount"]


def _replace_hotel_sales(entry: DailyEntry, rows: list) -> None:
    """Rebuild the hotel/hostel lines attached to this entry."""
    entry.hotel_sales.clear()
    kept = 0
    for i, r in enumerate(rows or []):
        cid = r.get("customerId")
        grams = to_int(r.get("weightG"), f"hotelSales[{i}].weightG")
        if not cid and grams <= 0:
            continue                                    # an empty row the user left behind
        customer = db.session.get(Customer, cid) if cid else None
        if not customer:
            raise FieldError(f"hotelSales[{i}].customerId",
                             f"Hotel/hostel line {i} — choose a customer from the list.")
        if customer.branch_id != entry.branch_id:
            raise FieldError(f"hotelSales[{i}].customerId",
                             f"{customer.name} belongs to a different branch.")

        product = r.get("product") if r.get("product") in PRODUCTS else "skin"
        override = r.get("rateOverride")
        sale = CustomerSale(
            customer=customer, branch_id=entry.branch_id, line_no=kept,
            product=product, weight_g=grams,
            rate_override=(to_dec(override, f"hotelSales[{i}].rateOverride")
                           if override not in (None, "") else None),
            settled=bool(r.get("settled")),
            note=(r.get("note") or "")[:500],
        )
        _snapshot_sale(sale, entry, customer)
        entry.hotel_sales.append(sale)
        kept += 1


def _reprice_hotel_sales(entry: DailyEntry) -> None:
    """Refresh the stored amounts after the selling rates may have moved."""
    for sale in entry.hotel_sales:
        if sale.customer:
            _snapshot_sale(sale, entry, sale.customer)


def customer_totals(customer_ids: list) -> dict:
    """
    Sales and receipts per customer, in one pair of grouped queries rather than
    a loop of them, so this stays cheap as the ledgers grow.

      credit   — approved, unpaid: this is what makes up the balance
      cash     — approved and settled on the day
      pending  — sold but the day is not approved yet, so it does not count
    """
    blank = {"credit": 0.0, "cash": 0.0, "pending": 0.0, "receipts": 0.0}
    out = {cid: dict(blank) for cid in customer_ids}
    if not customer_ids:
        return out

    rows = (db.session.query(CustomerSale.customer_id, DailyEntry.status,
                             CustomerSale.settled, func.sum(CustomerSale.amount))
            .join(DailyEntry, DailyEntry.id == CustomerSale.entry_id)
            .filter(CustomerSale.customer_id.in_(customer_ids))
            .group_by(CustomerSale.customer_id, DailyEntry.status, CustomerSale.settled)
            .all())
    for cid, status, settled, total in rows:
        if cid not in out:
            continue
        total = float(total or 0)
        if status != "approved":
            out[cid]["pending"] += total
        elif settled:
            out[cid]["cash"] += total
        else:
            out[cid]["credit"] += total

    pays = (db.session.query(CustomerPayment.customer_id, func.sum(CustomerPayment.amount))
            .filter(CustomerPayment.customer_id.in_(customer_ids))
            .group_by(CustomerPayment.customer_id).all())
    for cid, total in pays:
        if cid in out:
            out[cid]["receipts"] += float(total or 0)
    return out


def customers_payload(branch_ids: list) -> tuple:
    """Customers for these branches plus their running balances."""
    if not branch_ids:
        return [], {}
    rows = (Customer.query.filter(Customer.branch_id.in_(branch_ids))
            .order_by(Customer.branch_id, Customer.code).all())
    totals = customer_totals([c.id for c in rows])
    for c in rows:
        t = totals[c.id]
        t["opening"] = float(c.opening_balance)
        t["balance"] = t["opening"] + t["credit"] - t["receipts"]
    return [c.to_dict() for c in rows], totals


def _replace_photos(entry: DailyEntry, urls: list) -> None:
    entry.photos.clear()
    for u in (urls or []):
        if isinstance(u, str) and u.startswith("data:image"):
            entry.photos.append(MortalityPhoto(data_url=u))


def retime_entry(entry: DailyEntry, raw_stamp):
    """
    Move an entry to a different business date and/or time. Admin-only: the
    date decides which day's profit the figures land in and what carries
    forward. Returns an error response, or None when applied / a no-op.
    """
    if not raw_stamp:
        return None
    new_date, new_stamp = parse_stamp(raw_stamp, field="datetime")
    same_date = new_date == entry.business_date
    same_time = (entry.entered_at is not None
                 and entry.entered_at.strftime("%H:%M") == new_stamp.strftime("%H:%M"))
    if same_date and same_time:
        return None
    if not g.user.is_admin:
        log_activity("Blocked date change",
                     f"{entry.business_date} → {new_date} attempted by supervisor")
        db.session.commit()
        return jsonify({"error": "forbidden",
                        "message": "Only an admin can change the date of a saved entry."}), 403

    if not same_date:
        clash = DailyEntry.query.filter(
            DailyEntry.branch_id == entry.branch_id,
            DailyEntry.category == entry.category,
            DailyEntry.business_date == new_date,
            DailyEntry.id != entry.id).first()
        if clash:
            return jsonify({"error": "duplicate",
                            "message": f"A {clash.status} {entry.category} entry already "
                                       f"exists for {new_date}."}), 409

    was = f"{entry.business_date} {entry.entered_at.strftime('%H:%M') if entry.entered_at else '--:--'}"
    entry.business_date = new_date
    entry.entered_at = new_stamp
    log_activity("Changed record date/time",
                 f"{was} → {new_date} {new_stamp.strftime('%H:%M')} · "
                 f"{entry.category} · {entry.branch.name}",
                 branch_code=entry.branch.code)
    return None


def can_edit(entry: DailyEntry) -> bool:
    if g.user.is_admin:
        return True
    return entry.status in ("draft", "rejected") and entry.created_by_id == g.user.id


# ==========================================================================
# session
# ==========================================================================
@bp.post("/login")
def login():
    d = request.get_json(silent=True) or {}
    user = User.query.filter(func.lower(User.username) == str(d.get("username", "")).lower()).first()
    if not user or not user.is_active or not user.check_password(d.get("password", "")):
        log_activity("Failed sign in", f"username: {d.get('username','')}", user=user)
        db.session.commit()
        return jsonify({"error": "invalid_credentials",
                        "message": "Invalid username or password."}), 401

    start_session(user)
    g.user = user
    user.last_login_at = utcnow()
    log_activity("Sign in", f"{user.role} · idle limit {idle_limit_minutes(user.role)} min", user=user)
    db.session.commit()
    return jsonify({"user": user.to_dict(),
                    "idleMinutes": idle_limit_minutes(user.role)})


@bp.post("/logout")
@login_required
def logout():
    log_activity("Sign out", "manual")
    db.session.commit()
    end_session()
    return jsonify({"ok": True})


@bp.get("/me")
def me():
    if not getattr(g, "user", None):
        return jsonify({"user": None, "reason": getattr(g, "session_expired", None)})
    return jsonify({"user": g.user.to_dict(),
                    "idleMinutes": idle_limit_minutes(g.user.role)})


@bp.post("/heartbeat")
@login_required
def heartbeat():
    """Keeps the server-side idle clock in step with real user activity."""
    return jsonify({"ok": True, "idleMinutes": idle_limit_minutes(g.user.role)})


# ==========================================================================
# bootstrap — one call that fills the whole UI
# ==========================================================================
@bp.get("/bootstrap")
@login_required
def bootstrap():
    settings = get_settings()
    codes = g.user.branch_codes()
    branches = Branch.query.filter(Branch.code.in_(codes)).order_by(Branch.code).all() if codes else []
    bids = [b.id for b in branches]

    q = DailyEntry.query.filter(DailyEntry.branch_id.in_(bids)) if bids else DailyEntry.query.filter(False)
    if not g.user.is_admin:
        q = q.filter(DailyEntry.created_by_id == g.user.id)
    entries = q.order_by(DailyEntry.business_date.desc()).limit(2000).all()

    workers = Worker.query.filter(Worker.branch_id.in_(bids)).all() if bids else []
    ledger = LabourLedger.query.filter(LabourLedger.branch_id.in_(bids)).all() if bids else []
    customers, cust_totals = customers_payload(bids)
    receipts = (CustomerPayment.query.filter(CustomerPayment.branch_id.in_(bids))
                .order_by(CustomerPayment.pay_date.desc()).limit(3000).all()) if bids else []

    oq = Overhead.query.filter(Overhead.branch_id.in_(bids)) if bids else Overhead.query.filter(False)
    if not g.user.is_admin:
        oq = oq.filter(Overhead.branch_id.in_(bids))
    overheads = oq.all()

    payload = {
        "user": g.user.to_dict(),
        "idleMinutes": idle_limit_minutes(g.user.role),
        "branches": {b.code: b.name for b in branches},
        "settings": {"wasteBroiler": settings["waste_broiler"],
                     "wasteParents": settings["waste_parents"],
                     "tolerance": settings["tolerance"],
                     "dayWage": settings["day_wage"]},
        "entries": [entry_payload(e, settings) for e in entries],
        "workers": [w.to_dict() for w in workers],
        "ledger": [l.to_dict() for l in ledger],
        "overheads": [o.to_dict() for o in overheads],
        "customers": customers,
        "customerTotals": cust_totals,
        "receipts": [p.to_dict() for p in receipts],
        "users": [u.to_dict() for u in User.query.order_by(User.id).all()] if g.user.is_admin else [],
    }
    return jsonify(payload)


# ==========================================================================
# daily entries
# ==========================================================================
@bp.post("/entries")
@login_required
def create_entry():
    d = request.get_json(silent=True) or {}
    code = d.get("branch")
    err = require_branch(code)
    if err:
        return err
    branch = branch_by_code(code)
    bdate, bstamp = parse_stamp(d.get("datetime") or d.get("businessDate"))
    if bdate is None:
        bdate, bstamp = date.today(), utcnow()
    category = d.get("category") if d.get("category") in ("broiler", "parents") else "broiler"
    status = "pending" if d.get("submit") else "draft"

    clash = DailyEntry.query.filter_by(branch_id=branch.id, category=category,
                                       business_date=bdate).first()
    if clash:
        log_activity("Blocked duplicate entry", f"{category} · {bdate} · existing is {clash.status}")
        db.session.commit()
        return jsonify({"error": "duplicate",
                        "message": f"A {clash.status} entry already exists for {bdate}."}), 409

    entry = DailyEntry(branch_id=branch.id, category=category, business_date=bdate,
                       entered_at=bstamp, created_by_id=g.user.id, status="draft")
    _apply_entry_fields(entry, d)
    _replace_purchases(entry, d.get("purchases"))
    _replace_photos(entry, d.get("photos"))
    _replace_hotel_sales(entry, d.get("hotelSales"))
    db.session.add(entry)
    db.session.flush()

    if status == "pending":
        problems = _submission_problems(entry, d)
        if problems:
            db.session.rollback()
            return jsonify({"error": "validation", "missing": problems}), 422
        entry.status = "pending"

    log_activity("Submitted entry" if status == "pending" else "Saved draft",
                 f"{category} · {bdate} · {branch.name}", branch_code=code)
    db.session.commit()
    return jsonify(entry_payload(entry, get_settings())), 201


@bp.put("/entries/<entry_id>")
@login_required
def update_entry(entry_id):
    entry = db.session.get(DailyEntry, entry_id)
    if not entry:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(entry.branch.code)
    if err:
        return err
    if not can_edit(entry):
        log_activity("Blocked edit attempt",
                     f"{entry.category} · {entry.business_date} · status {entry.status}")
        db.session.commit()
        return jsonify({"error": "locked",
                        "message": f"This entry was {entry.status} — only an admin can modify it now."}), 403

    d = request.get_json(silent=True) or {}

    # an admin may correct the business date while reviewing
    err = retime_entry(entry, d.get("datetime") or d.get("businessDate"))
    if err:
        return err

    _apply_entry_fields(entry, d)
    if "purchases" in d:
        _replace_purchases(entry, d.get("purchases"))
    if "photos" in d:
        _replace_photos(entry, d.get("photos"))
    if "hotelSales" in d:
        _replace_hotel_sales(entry, d.get("hotelSales"))
    else:
        # the selling rates may have just changed; the hotel bills follow them
        _reprice_hotel_sales(entry)
    entry.updated_by_id = g.user.id
    db.session.flush()

    if d.get("submit"):
        problems = _submission_problems(entry, d)
        if problems:
            db.session.rollback()
            return jsonify({"error": "validation", "missing": problems}), 422
        if entry.status == "rejected" and not (entry.explanation or "").strip():
            db.session.rollback()
            return jsonify({"error": "validation",
                            "missing": ["Explanation for the returned entry"]}), 422
        entry.status = "pending"
        entry.reviewed_by_id = None
        entry.reviewed_at = None

    action = ("Submitted entry" if d.get("submit")
              else "Modified APPROVED record" if entry.status == "approved" else "Edited entry")
    log_activity(action, f"{entry.category} · {entry.business_date} · {entry.branch.name}",
                 branch_code=entry.branch.code)
    db.session.commit()
    return jsonify(entry_payload(entry, get_settings()))


def _submission_problems(entry: DailyEntry, raw: dict) -> list[str]:
    settings = get_settings()
    first = DailyEntry.query.filter(
        DailyEntry.branch_id == entry.branch_id,
        DailyEntry.category == entry.category,
        DailyEntry.status == "approved",
        DailyEntry.id != entry.id).count() == 0
    payload = entry.to_dict(include_costs=True)
    payload["businessDate"] = entry.business_date.isoformat()
    return validate_for_submission(payload, g.user.is_admin, first)


@bp.post("/entries/<entry_id>/decision")
@admin_required
def decide_entry(entry_id):
    entry = db.session.get(DailyEntry, entry_id)
    if not entry:
        return jsonify({"error": "not_found"}), 404
    d = request.get_json(silent=True) or {}
    verdict = d.get("verdict")
    if verdict not in ("approved", "rejected"):
        return jsonify({"error": "bad_verdict"}), 400

    # the admin may also correct the date in the same call
    err = retime_entry(entry, d.get("datetime") or d.get("businessDate"))
    if err:
        return err

    # admin may set the buying rates in the same call, at approval time
    if "openRate" in d:
        entry.open_rate = Decimal(str(d.get("openRate") or 0))
    for i, r in enumerate(d.get("rates") or []):
        if i < len(entry.purchases):
            entry.purchases[i].rate = Decimal(str(r or 0))
    db.session.flush()

    if verdict == "approved":
        gaps = costing_gaps(entry.to_dict(include_costs=True))
        if gaps:
            db.session.rollback()
            return jsonify({"error": "costing_missing", "gaps": gaps,
                            "message": "Enter the " + " and ".join(gaps) + " before approving."}), 422

    entry.status = verdict
    entry.reviewed_by_id = g.user.id
    entry.reviewed_at = utcnow()
    entry.reject_reason = (d.get("reason") or "") if verdict == "rejected" else ""
    log_activity("Approved entry" if verdict == "approved" else "Returned entry",
                 f"{entry.category} · {entry.business_date} · {entry.branch.name}"
                 + (f" — {entry.reject_reason}" if entry.reject_reason else ""),
                 branch_code=entry.branch.code)
    db.session.commit()
    return jsonify(entry_payload(entry, get_settings()))


@bp.put("/entries/<entry_id>/costing")
@admin_required
def update_costing(entry_id):
    """Live repricing while the admin types in the approval screen."""
    entry = db.session.get(DailyEntry, entry_id)
    if not entry:
        return jsonify({"error": "not_found"}), 404
    d = request.get_json(silent=True) or {}
    err = retime_entry(entry, d.get("datetime") or d.get("businessDate"))
    if err:
        return err
    if "openRate" in d:
        entry.open_rate = to_dec(d.get("openRate"), "openRate")
    for i, r in enumerate(d.get("rates") or []):
        if i < len(entry.purchases):
            entry.purchases[i].rate = to_dec(r, f"rates[{i}]")
    db.session.commit()
    return jsonify(entry_payload(entry, get_settings()))


@bp.delete("/entries/<entry_id>")
@admin_required
def delete_entry(entry_id):
    entry = db.session.get(DailyEntry, entry_id)
    if not entry:
        return jsonify({"error": "not_found"}), 404
    log_activity("Deleted entry", f"{entry.category} · {entry.business_date} · {entry.branch.name}",
                 branch_code=entry.branch.code)
    db.session.delete(entry)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/entries")
@login_required
def list_entries():
    settings = get_settings()
    bids = visible_branch_ids()
    q = DailyEntry.query.filter(DailyEntry.branch_id.in_(bids)) if bids else DailyEntry.query.filter(False)
    if not g.user.is_admin:
        q = q.filter(DailyEntry.created_by_id == g.user.id)
    if request.args.get("from"):
        q = q.filter(DailyEntry.business_date >= parse_date(request.args["from"]))
    if request.args.get("to"):
        q = q.filter(DailyEntry.business_date <= parse_date(request.args["to"]))
    if request.args.get("status"):
        q = q.filter(DailyEntry.status == request.args["status"])
    rows = q.order_by(DailyEntry.business_date.desc()).limit(2000).all()
    return jsonify([entry_payload(e, settings) for e in rows])


# ==========================================================================
# branches, users, settings  (admin)
# ==========================================================================
@bp.post("/branches")
@admin_required
def create_branch():
    d = request.get_json(silent=True) or {}
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "validation", "message": "Branch name is required."}), 422
    code = (d.get("code") or "").strip().upper()
    if not code:
        i = 1
        while Branch.query.filter_by(code=f"B{i:02d}").first():
            i += 1
        code = f"B{i:02d}"
    if Branch.query.filter_by(code=code).first():
        return jsonify({"error": "duplicate", "message": f'Code "{code}" already exists.'}), 409

    for attempt in range(5):
        branch = Branch(code=code, name=name, address=d.get("address"))
        db.session.add(branch)
        try:
            db.session.flush()
        except IntegrityError:
            # Someone else took this code between our check and our insert.
            db.session.rollback()
            if d.get("code"):
                return jsonify({"error": "duplicate",
                                "message": f'Code "{code}" already exists.'}), 409
            i = 1
            while Branch.query.filter_by(code=f"B{i:02d}").first():
                i += 1
            code = f"B{i:02d}"
            continue
        for u in User.query.filter_by(role="admin").all():
            u.branches.append(branch)
        log_activity("Created branch", f"{code} — {name}")
        db.session.commit()
        return jsonify(branch.to_dict()), 201
    return jsonify({"error": "conflict",
                    "message": "Could not allocate a branch code. Try again."}), 409


@bp.put("/branches/<code>")
@admin_required
def rename_branch(code):
    branch = branch_by_code(code)
    if not branch:
        return jsonify({"error": "not_found"}), 404
    d = request.get_json(silent=True) or {}
    if (d.get("name") or "").strip():
        branch.name = d["name"].strip()
    log_activity("Renamed branch", f"{code} → {branch.name}")
    db.session.commit()
    return jsonify(branch.to_dict())


@bp.delete("/branches/<code>")
@admin_required
def delete_branch(code):
    branch = branch_by_code(code)
    if not branch:
        return jsonify({"error": "not_found"}), 404
    if Branch.query.filter_by(is_active=True).count() <= 1:
        return jsonify({"error": "last_branch",
                        "message": "At least one branch must remain."}), 409
    n = DailyEntry.query.filter_by(branch_id=branch.id).count()
    log_activity("Deleted branch", f"{code} with {n} record(s)")
    db.session.delete(branch)
    db.session.commit()
    return jsonify({"ok": True, "deletedEntries": n})


@bp.post("/users")
@admin_required
def create_user():
    d = request.get_json(silent=True) or {}
    name, username = (d.get("name") or "").strip(), (d.get("username") or "").strip()
    password, role = d.get("password") or "", d.get("role", "supervisor")
    if not (name and username and password):
        return jsonify({"error": "validation",
                        "message": "Name, username and password are required."}), 422
    if role not in ("admin", "supervisor"):
        return jsonify({"error": "validation", "message": "Unknown role."}), 422
    if User.query.filter(func.lower(User.username) == username.lower()).first():
        return jsonify({"error": "duplicate", "message": "Username already taken."}), 409

    codes = d.get("branches") or []
    if role == "supervisor" and not codes:
        return jsonify({"error": "validation",
                        "message": "Assign at least one branch to a supervisor."}), 422

    user = User(name=name, username=username, role=role)
    user.set_password(password)
    picked = Branch.query.all() if role == "admin" else Branch.query.filter(Branch.code.in_(codes)).all()
    user.branches = picked
    db.session.add(user)
    log_activity("Created user", f"{username} ({role})")
    db.session.commit()
    return jsonify(user.to_dict()), 201


@bp.put("/users/<int:uid>/password")
@admin_required
def reset_password(uid):
    user = db.session.get(User, uid)
    if not user:
        return jsonify({"error": "not_found"}), 404
    pw = (request.get_json(silent=True) or {}).get("password") or ""
    if len(pw) < 4:
        return jsonify({"error": "validation", "message": "Password too short."}), 422
    user.set_password(pw)
    log_activity("Reset password", user.username)
    db.session.commit()
    return jsonify({"ok": True})


@bp.delete("/users/<int:uid>")
@admin_required
def delete_user(uid):
    user = db.session.get(User, uid)
    if not user:
        return jsonify({"error": "not_found"}), 404
    if user.id == g.user.id:
        return jsonify({"error": "self_delete",
                        "message": "You cannot delete your own account."}), 409
    log_activity("Deleted user", user.username)
    db.session.delete(user)
    db.session.commit()
    return jsonify({"ok": True})


@bp.put("/settings")
@admin_required
def save_settings():
    d = request.get_json(silent=True) or {}
    mapping = {"wasteBroiler": "waste_broiler", "wasteParents": "waste_parents",
               "tolerance": "tolerance", "dayWage": "day_wage"}
    for src, key in mapping.items():
        if src in d:
            row = db.session.get(Setting, key) or Setting(key=key, value="0")
            row.value = str(d[src])
            db.session.merge(row)
    log_activity("Changed settings", str(d))
    db.session.commit()
    return jsonify(get_settings())


# ==========================================================================
# hotels & hostels
#
# Both roles may add a customer and agree its price — the supervisor is the one
# standing at the counter when a new hotel starts buying. Only an admin can
# remove one, because a customer carries a ledger.
# ==========================================================================
def _customer_fields(c: Customer, d: dict) -> None:
    if (d.get("name") or "").strip():
        c.name = d["name"].strip()[:160]
    if d.get("kind") in ("hotel", "hostel"):
        c.kind = d["kind"]
    if d.get("mode") in ("less", "fixed"):
        c.price_mode = d["mode"]
    for key, col in (("lessSkin", "less_skin"), ("lessSkinless", "less_skinless"),
                     ("lessLiver", "less_liver"), ("rateSkin", "rate_skin"),
                     ("rateSkinless", "rate_skinless"), ("rateLiver", "rate_liver")):
        if key in d:
            value = to_dec(d.get(key), key)
            if value < 0:
                raise FieldError(key)
            setattr(c, col, value)
    if "contact" in d:
        c.contact_person = (d.get("contact") or "")[:160]
    if "phone" in d:
        c.phone = (d.get("phone") or "")[:32]
    if "address" in d:
        c.address = (d.get("address") or "")[:2000]
    if "active" in d:
        c.is_active = bool(d.get("active"))


def _price_summary(c: Customer) -> str:
    if c.price_mode == "fixed":
        return (f"fixed ₹{c.rate_skin} skin / ₹{c.rate_skinless} skinless "
                f"/ ₹{c.rate_liver} liver")
    return (f"market less ₹{c.less_skin} skin / ₹{c.less_skinless} skinless "
            f"/ ₹{c.less_liver} liver")


@bp.get("/customers")
@login_required
def list_customers():
    rows, totals = customers_payload(visible_branch_ids())
    return jsonify({"customers": rows, "totals": totals})


@bp.post("/customers")
@login_required
def create_customer():
    d = request.get_json(silent=True) or {}
    err = require_branch(d.get("branch"))
    if err:
        return err
    if not (d.get("name") or "").strip():
        return jsonify({"error": "validation",
                        "message": "Enter the hotel or hostel name."}), 422
    branch = branch_by_code(d["branch"])

    code = (d.get("code") or "").strip().upper()[:16]
    for attempt in range(5):
        if not code:
            i = 1
            while Customer.query.filter_by(branch_id=branch.id, code=f"H{i:02d}").first():
                i += 1
            code = f"H{i:02d}"
        if Customer.query.filter_by(branch_id=branch.id, code=code).first():
            return jsonify({"error": "duplicate",
                            "message": f'Code "{code}" is already used in this branch.'}), 409

        c = Customer(branch_id=branch.id, code=code, name=d["name"].strip()[:160],
                     opening_balance=to_dec(d.get("openingBalance"), "openingBalance"),
                     created_by_id=g.user.id)
        _customer_fields(c, d)
        db.session.add(c)
        log_activity(f"Added {c.kind}", f"{c.name} · {_price_summary(c)}",
                     branch_code=branch.code)
        try:
            db.session.commit()
        except IntegrityError:
            # two devices claimed the same auto-code at once; take the next one
            db.session.rollback()
            code = ""
            continue
        return jsonify(c.to_dict()), 201

    return jsonify({"error": "conflict",
                    "message": "Could not allocate a code. Try again."}), 409


@bp.put("/customers/<cid>")
@login_required
def update_customer(cid):
    c = db.session.get(Customer, cid)
    if not c:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(c.branch.code)
    if err:
        return err
    d = request.get_json(silent=True) or {}
    # the opening balance rewrites history, so it is the admin's to change
    if g.user.is_admin and "openingBalance" in d:
        c.opening_balance = to_dec(d.get("openingBalance"), "openingBalance")
    _customer_fields(c, d)
    log_activity(f"Edited {c.kind}", f"{c.name} · {_price_summary(c)}",
                 branch_code=c.branch.code)
    db.session.commit()

    # a changed concession reprices every unapproved bill for this customer
    touched = 0
    for sale in CustomerSale.query.filter_by(customer_id=c.id).all():
        if sale.entry and sale.entry.status != "approved":
            _snapshot_sale(sale, sale.entry, c)
            touched += 1
    if touched:
        log_activity("Repriced hotel bills",
                     f"{touched} open line(s) for {c.name}", branch_code=c.branch.code)
        db.session.commit()
    return jsonify(c.to_dict())


@bp.delete("/customers/<cid>")
@admin_required
def delete_customer(cid):
    c = db.session.get(Customer, cid)
    if not c:
        return jsonify({"error": "not_found"}), 404
    sales = CustomerSale.query.filter_by(customer_id=c.id).count()
    if sales and not request.args.get("force"):
        return jsonify({
            "error": "in_use", "sales": sales,
            "message": (f"{c.name} has {sales} sale line(s) on record. Mark them "
                        f"inactive instead, or repeat with ?force=1 to delete "
                        f"the customer and its ledger.")}), 409
    log_activity(f"Removed {c.kind}", f"{c.name} · {sales} sale line(s) deleted",
                 branch_code=c.branch.code)
    db.session.delete(c)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/customers/<cid>/ledger")
@login_required
def customer_ledger(cid):
    """Dated statement for one hotel or hostel, with a running balance."""
    c = db.session.get(Customer, cid)
    if not c:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(c.branch.code)
    if err:
        return err

    rows = []
    sales = (db.session.query(CustomerSale, DailyEntry)
             .join(DailyEntry, DailyEntry.id == CustomerSale.entry_id)
             .filter(CustomerSale.customer_id == c.id).all())
    for sale, entry in sales:
        rows.append({
            "kind": "sale", "id": sale.id,
            "date": entry.business_date.isoformat(),
            "status": entry.status, "entryId": entry.id,
            "product": sale.product, "weightG": sale.weight_g,
            "marketRate": float(sale.market_rate), "rate": float(sale.rate),
            "concession": round((float(sale.market_rate) - float(sale.rate))
                                * sale.weight_g / 1000.0, 2),
            "amount": float(sale.amount), "settled": sale.settled,
            "note": sale.note or "",
        })
    for p in CustomerPayment.query.filter_by(customer_id=c.id).all():
        rows.append({"kind": "receipt", "id": p.id, "date": p.pay_date.isoformat(),
                     "status": "approved", "amount": float(p.amount),
                     "mode": p.mode, "note": p.note or ""})

    rows.sort(key=lambda r: (r["date"], 0 if r["kind"] == "sale" else 1))

    # Only an approved, unsettled sale moves the balance. A cash sale is square
    # on the day, and an unapproved one is not a real sale yet.
    balance = float(c.opening_balance)
    for r in rows:
        if r["kind"] == "receipt":
            balance -= r["amount"]
            r["effect"] = -r["amount"]
        elif r["status"] == "approved" and not r["settled"]:
            balance += r["amount"]
            r["effect"] = r["amount"]
        else:
            r["effect"] = 0.0
        r["balance"] = round(balance, 2)

    totals = customer_totals([c.id])[c.id]
    totals["opening"] = float(c.opening_balance)
    totals["balance"] = round(balance, 2)
    return jsonify({"customer": c.to_dict(), "rows": rows, "totals": totals})


@bp.post("/customers/<cid>/payments")
@login_required
def add_payment(cid):
    c = db.session.get(Customer, cid)
    if not c:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(c.branch.code)
    if err:
        return err
    d = request.get_json(silent=True) or {}
    amount = to_dec(d.get("amount"), "amount")
    if amount <= 0:
        return jsonify({"error": "validation", "message": "Enter an amount."}), 422
    mode = d.get("mode") if d.get("mode") in ("cash", "upi", "bank", "cheque") else "cash"

    p = CustomerPayment(customer_id=c.id, branch_id=c.branch_id,
                        pay_date=parse_date(d.get("date"), date.today()),
                        amount=amount, mode=mode, note=(d.get("note") or "")[:500],
                        created_by_id=g.user.id)
    db.session.add(p)
    log_activity("Receipt from " + c.kind, f"₹{amount} {mode} · {c.name}",
                 branch_code=c.branch.code)
    db.session.commit()
    return jsonify(p.to_dict()), 201


@bp.delete("/payments/<pid>")
@admin_required
def delete_payment(pid):
    p = db.session.get(CustomerPayment, pid)
    if not p:
        return jsonify({"error": "not_found"}), 404
    log_activity("Deleted receipt", f"₹{p.amount} · {p.customer.name}",
                 branch_code=p.branch.code)
    db.session.delete(p)
    db.session.commit()
    return jsonify({"ok": True})


# ==========================================================================
# labour
# ==========================================================================
@bp.post("/workers")
@login_required
def create_worker():
    d = request.get_json(silent=True) or {}
    err = require_branch(d.get("branch"))
    if err:
        return err
    if not (d.get("name") or "").strip():
        return jsonify({"error": "validation", "message": "Name is required."}), 422
    if float(d.get("dayWage") or 0) <= 0:
        return jsonify({"error": "validation", "message": "Enter the daily wage."}), 422

    w = Worker(branch_id=branch_by_code(d["branch"]).id, name=d["name"].strip(),
               role=d.get("role", "dresser"), day_wage=Decimal(str(d.get("dayWage") or 0)),
               phone=d.get("phone"))
    db.session.add(w)
    log_activity("Added worker", f"{w.name} · {w.role} · ₹{w.day_wage}/day", branch_code=d["branch"])
    db.session.commit()
    return jsonify(w.to_dict()), 201


@bp.put("/workers/<worker_id>")
@login_required
def update_worker(worker_id):
    w = db.session.get(Worker, worker_id)
    if not w:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(w.branch.code)
    if err:
        return err
    d = request.get_json(silent=True) or {}
    if (d.get("name") or "").strip():
        w.name = d["name"].strip()
    if d.get("role"):
        w.role = d["role"]
    if d.get("dayWage") is not None:
        w.day_wage = Decimal(str(d["dayWage"]))
    if "phone" in d:
        w.phone = d["phone"]
    log_activity("Edited worker", w.name, branch_code=w.branch.code)
    db.session.commit()
    return jsonify(w.to_dict())


@bp.delete("/workers/<worker_id>")
@admin_required
def delete_worker(worker_id):
    w = db.session.get(Worker, worker_id)
    if not w:
        return jsonify({"error": "not_found"}), 404
    log_activity("Removed worker", w.name, branch_code=w.branch.code)
    db.session.delete(w)
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/ledger")
@login_required
def add_ledger():
    d = request.get_json(silent=True) or {}
    err = require_branch(d.get("branch"))
    if err:
        return err
    kind = d.get("type")
    if kind not in ("work", "paid", "advance", "tea", "tiffin", "other"):
        return jsonify({"error": "validation", "message": "Unknown ledger type."}), 422
    worker = db.session.get(Worker, d.get("workerId"))
    if not worker:
        return jsonify({"error": "not_found", "message": "Worker not found."}), 404

    day = parse_date(d.get("date"), date.today())
    branch = branch_by_code(d["branch"])

    if kind == "work":
        # attendance is one row per worker per day; re-marking replaces it
        row = LabourLedger.query.filter_by(worker_id=worker.id, entry_date=day, kind="work").first()
        days = float(d.get("days") or 0)
        if days <= 0:
            if row:
                db.session.delete(row)
                log_activity("Attendance", f"{worker.name} · {day} · absent", branch_code=branch.code)
                db.session.commit()
            return jsonify({"ok": True, "removed": True})
        if not row:
            row = LabourLedger(branch_id=branch.id, worker_id=worker.id,
                               entry_date=day, kind="work")
            db.session.add(row)
        row.days = Decimal(str(days))
        row.amount = Decimal(str(float(worker.day_wage) * days))
        row.note = "Half day" if days == 0.5 else "Full day"
        row.created_by_id = g.user.id
        log_activity("Attendance",
                     f"{worker.name} · {day} · {'half day' if days == 0.5 else 'full day'}",
                     branch_code=branch.code)
        try:
            db.session.commit()
        except IntegrityError:
            # Two clicks (or two devices) raced to create the same work row.
            # Fall back to updating whichever one won.
            db.session.rollback()
            row = LabourLedger.query.filter_by(worker_id=worker.id, entry_date=day,
                                               kind="work").first()
            if not row:
                raise
            row.days = Decimal(str(days))
            row.amount = Decimal(str(float(worker.day_wage) * days))
            row.note = "Half day" if days == 0.5 else "Full day"
            db.session.commit()
        return jsonify(row.to_dict()), 201

    row = LabourLedger(branch_id=branch.id, worker_id=worker.id, entry_date=day,
                       kind=kind, days=0, amount=to_dec(d.get("amount"), "amount"),
                       note=d.get("note"), created_by_id=g.user.id)
    if float(row.amount) <= 0:
        return jsonify({"error": "validation", "message": "Enter an amount."}), 422
    db.session.add(row)
    log_activity(f"Ledger {kind}", f"₹{row.amount} · {worker.name}", branch_code=branch.code)
    db.session.commit()
    return jsonify(row.to_dict()), 201


@bp.delete("/ledger/<row_id>")
@login_required
def delete_ledger(row_id):
    row = db.session.get(LabourLedger, row_id)
    if not row:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(row.branch.code)
    if err:
        return err
    log_activity("Deleted ledger entry", f"{row.kind} · ₹{row.amount}", branch_code=row.branch.code)
    db.session.delete(row)
    db.session.commit()
    return jsonify({"ok": True})


# ==========================================================================
# overheads
# ==========================================================================
@bp.post("/overheads")
@login_required
def add_overhead():
    d = request.get_json(silent=True) or {}
    err = require_branch(d.get("branch"))
    if err:
        return err
    if float(d.get("amount") or 0) <= 0:
        return jsonify({"error": "validation", "message": "Enter an amount."}), 422

    o = Overhead(branch_id=branch_by_code(d["branch"]).id,
                 period_month=(d.get("month") or date.today().strftime("%Y-%m"))[:7],
                 category=d.get("category", "other"),
                 amount=to_dec(d.get("amount"), "amount"),
                 note=d.get("note"),
                 status="approved" if g.user.is_admin else "pending",
                 created_by_id=g.user.id,
                 reviewed_by_id=g.user.id if g.user.is_admin else None,
                 reviewed_at=utcnow() if g.user.is_admin else None)
    db.session.add(o)
    log_activity("Added overhead",
                 f"{o.category} · {o.period_month} · ₹{o.amount}"
                 + (" (auto-approved)" if g.user.is_admin else " (pending)"),
                 branch_code=d["branch"])
    db.session.commit()
    return jsonify(o.to_dict()), 201


@bp.post("/overheads/<ov_id>/decision")
@admin_required
def decide_overhead(ov_id):
    o = db.session.get(Overhead, ov_id)
    if not o:
        return jsonify({"error": "not_found"}), 404
    d = request.get_json(silent=True) or {}
    verdict = d.get("verdict")
    if verdict not in ("approved", "rejected"):
        return jsonify({"error": "bad_verdict"}), 400
    o.status = verdict
    o.reviewed_by_id = g.user.id
    o.reviewed_at = utcnow()
    o.reject_reason = (d.get("reason") or "") if verdict == "rejected" else ""
    log_activity("Approved overhead" if verdict == "approved" else "Returned overhead",
                 f"{o.category} · {o.period_month} · ₹{o.amount}", branch_code=o.branch.code)
    db.session.commit()
    return jsonify(o.to_dict())


@bp.delete("/overheads/<ov_id>")
@login_required
def delete_overhead(ov_id):
    o = db.session.get(Overhead, ov_id)
    if not o:
        return jsonify({"error": "not_found"}), 404
    if not g.user.is_admin and (o.status == "approved" or o.created_by_id != g.user.id):
        return jsonify({"error": "forbidden",
                        "message": "Approved overheads can only be removed by an admin."}), 403
    log_activity("Deleted overhead", f"{o.category} · {o.period_month} · ₹{o.amount}",
                 branch_code=o.branch.code)
    db.session.delete(o)
    db.session.commit()
    return jsonify({"ok": True})


# ==========================================================================
# activity log (admin only)
# ==========================================================================
@bp.get("/activity")
@admin_required
def activity():
    q = ActivityLog.query
    if request.args.get("user"):
        q = q.filter(ActivityLog.user_name == request.args["user"])
    if request.args.get("action"):
        q = q.filter(ActivityLog.action == request.args["action"])
    rows = q.order_by(ActivityLog.at.desc()).limit(int(request.args.get("limit", 500))).all()
    return jsonify([r.to_dict() for r in rows])


@bp.delete("/activity")
@admin_required
def clear_activity():
    n = ActivityLog.query.delete()
    log_activity("Cleared activity log", f"{n} row(s)")
    db.session.commit()
    return jsonify({"ok": True, "cleared": n})


# ==========================================================================
# admin data tools
# ==========================================================================
@bp.post("/admin/seed")
@admin_required
def admin_seed():
    from .seed import load_demo
    counts = load_demo(g.user)
    log_activity("Loaded demo data", str(counts))
    db.session.commit()
    return jsonify({"ok": True, **counts})


@bp.post("/admin/wipe")
@admin_required
def admin_wipe():
    """Clears operational data. Users and branches survive so you can log back in."""
    ActivityLog.query.delete()
    Overhead.query.delete()
    LabourLedger.query.delete()
    Worker.query.delete()
    CustomerPayment.query.delete()
    CustomerSale.query.delete()
    Customer.query.delete()
    MortalityPhoto.query.delete()
    Purchase.query.delete()
    DailyEntry.query.delete()
    log_activity("Wiped operational data",
                 "entries, labour, hotels and overheads removed")
    db.session.commit()
    return jsonify({"ok": True})
