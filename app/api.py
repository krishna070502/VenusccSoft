"""
REST API.

Every response the browser needs is served from here. Authorisation is
re-checked per endpoint; buying prices and profit figures are stripped from
payloads sent to supervisors rather than merely hidden by CSS.
"""

import calendar
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal, InvalidOperation

from flask import Blueprint, g, jsonify, request, session
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import joinedload, selectinload, undefer

from .calc import (PRODUCTS, compute_entry, costing_gaps, months_in_range,
                   price_hotel_line, validate_for_submission)
from .extensions import db
from .models import (ActivityLog, Branch, Customer, CustomerPayment, CustomerSale,
                     DailyEntry, DayClose, LabourLedger, MortalityPhoto, Overhead,
                     Purchase, Setting, User, Worker, utcnow)
from .security import (admin_required, branch_by_code, log_activity,
                       login_required, require_branch, idle_limit_minutes,
                       start_session, end_session)

bp = Blueprint("api", __name__, url_prefix="/api")

DEFAULT_SETTINGS = {"waste_broiler": "31", "waste_parents": "21",
                    "tolerance": "2", "day_wage": "700"}

# How much history the first load pulls, and the ceiling on any one page.
# The browser widens the window on demand rather than being handed everything.
BOOTSTRAP_DAYS = 120
MAX_PAGE = 1000
DEFAULT_PAGE_SIZE = 200


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
    What this one day carries of the branch's overheads:

      * a DATED overhead (a repair, a delivery charge) lands on its own day in
        full;
      * an undated monthly one (rent, power, salary) is spread evenly across
        the days of that month, so no single day carries the whole rent.
    """
    month = day.strftime("%Y-%m")
    rows = Overhead.query.filter_by(branch_id=branch_id, period_month=month,
                                    status="approved").all()
    days_in_month = calendar.monthrange(day.year, day.month)[1] or 1
    total = 0.0
    for o in rows:
        if o.spend_date is None:
            total += float(o.amount) / days_in_month
        elif o.spend_date == day:
            total += float(o.amount)
    return total


def day_costs_for(branch_id: int, day: date) -> dict:
    """
    Labour and overheads for one branch-day, divided between the entries that
    share that day. Without the split, broiler and parents on the same day
    would each be charged the whole day's wages.

    Single-day use only — for a list of entries use DayCostIndex, which does
    the same arithmetic in three queries instead of three per entry.
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


SHOP_KINDS = ("tea", "tiffin", "other")


class DayCostIndex:
    """
    Labour and overhead costs for MANY branch-days, resolved up front.

    The naive version calls day_costs_for() once per entry, which is three
    queries each — 6,000 round trips for 2,000 entries. This does three
    grouped queries for the whole set and then answers from memory.
    """

    EMPTY = {"wages": 0.0, "advances": 0.0, "other": 0.0, "manDays": 0.0,
             "overheads": 0.0, "shared": 1}

    def __init__(self, entries):
        self.labour = {}
        self.counts = {}
        self.overheads = {}
        pairs = {(e.branch_id, e.business_date) for e in entries}
        if not pairs:
            return

        branch_ids = {b for b, _ in pairs}
        days = [d for _, d in pairs]
        lo, hi = min(days), max(days)

        # 1) labour, grouped by branch + day + kind
        rows = (db.session.query(LabourLedger.branch_id, LabourLedger.entry_date,
                                 LabourLedger.kind,
                                 func.sum(LabourLedger.amount), func.sum(LabourLedger.days))
                .filter(LabourLedger.branch_id.in_(branch_ids),
                        LabourLedger.entry_date >= lo, LabourLedger.entry_date <= hi)
                .group_by(LabourLedger.branch_id, LabourLedger.entry_date,
                          LabourLedger.kind).all())
        for bid, day, kind, amount, ndays in rows:
            slot = self.labour.setdefault(
                (bid, day), {"wages": 0.0, "advances": 0.0, "other": 0.0, "manDays": 0.0})
            amount = float(amount or 0)
            if kind == "work":
                slot["wages"] += amount
                slot["manDays"] += float(ndays or 0)
            elif kind == "advance":
                slot["advances"] += amount
            elif kind in SHOP_KINDS:
                slot["other"] += amount

        # 2) how many entries share each branch-day
        for bid, day, n in (db.session.query(
                DailyEntry.branch_id, DailyEntry.business_date, func.count(DailyEntry.id))
                .filter(DailyEntry.branch_id.in_(branch_ids),
                        DailyEntry.business_date >= lo, DailyEntry.business_date <= hi)
                .group_by(DailyEntry.branch_id, DailyEntry.business_date).all()):
            self.counts[(bid, day)] = int(n or 1)

        # 3) overheads for every month the range touches
        months = sorted({d.strftime("%Y-%m") for d in days})
        ov = (Overhead.query
              .filter(Overhead.branch_id.in_(branch_ids),
                      Overhead.period_month.in_(months),
                      Overhead.status == "approved").all())
        monthly, dated = {}, {}
        for o in ov:
            if o.spend_date is None:
                monthly.setdefault((o.branch_id, o.period_month), 0.0)
                monthly[(o.branch_id, o.period_month)] += float(o.amount)
            else:
                dated.setdefault((o.branch_id, o.spend_date), 0.0)
                dated[(o.branch_id, o.spend_date)] += float(o.amount)
        for bid, day in pairs:
            per_month = monthly.get((bid, day.strftime("%Y-%m")), 0.0)
            dim = calendar.monthrange(day.year, day.month)[1] or 1
            self.overheads[(bid, day)] = per_month / dim + dated.get((bid, day), 0.0)

    def for_entry(self, entry) -> dict:
        key = (entry.branch_id, entry.business_date)
        lab = self.labour.get(key)
        share = self.counts.get(key, 1) or 1
        overheads = self.overheads.get(key, 0.0)
        if not lab:
            return {**self.EMPTY, "overheads": overheads / share, "shared": share}
        return {"wages": lab["wages"] / share, "advances": lab["advances"] / share,
                "other": lab["other"] / share, "manDays": lab["manDays"] / share,
                "overheads": overheads / share, "shared": share}


SUPERVISOR_HIDDEN = ("buyAmt", "openValue", "availValue", "avgRate", "meatCostKg",
                     "cogs", "grossProfit", "labour", "advances", "otherExp",
                     "overheads", "netProfit",
                     "closeValue", "openMeatValue", "mortValue", "damageValue",
                     "shortValue", "bonusValue")


def entry_payload(entry: DailyEntry, settings: dict, costs=None,
                  include_photos: bool = True) -> dict:
    """
    Entry plus its server-computed figures, filtered by role.

    `costs` is a pre-resolved dict from DayCostIndex. Passing it avoids three
    queries per entry; leaving it None falls back to a single-entry lookup.
    """
    show_costs = g.user.is_admin
    # serialise once, then strip — the maths always runs on the true figures,
    # only what leaves the server is trimmed
    data = entry.to_dict(include_costs=True, include_photos=include_photos)
    if costs is None:
        costs = day_costs_for(entry.branch_id, entry.business_date)
    calc = compute_entry(data, settings, costs)
    if not show_costs:
        data["openRate"] = 0
        for p in data.get("purchases") or []:
            p["rate"] = 0
        for key in SUPERVISOR_HIDDEN:
            calc.pop(key, None)
    data["calc"] = calc
    return data


def entry_list_payload(entries: list, settings: dict) -> list:
    """A whole list of entries, costed in three queries and without photos."""
    index = DayCostIndex(entries)
    return [entry_payload(e, settings, index.for_entry(e), include_photos=False)
            for e in entries]


def entries_query(base=None):
    """
    A DailyEntry query with every relationship to_dict() touches pulled in one
    round trip each, instead of one per row. Without this, serialising 56
    entries fired ~200 follow-up SELECTs for purchases, photos, hotel lines and
    user names.
    """
    q = base if base is not None else DailyEntry.query
    return q.options(
        joinedload(DailyEntry.branch),
        joinedload(DailyEntry.created_by),
        joinedload(DailyEntry.reviewed_by),
        selectinload(DailyEntry.purchases),
        selectinload(DailyEntry.photos),          # data_url stays deferred
        selectinload(DailyEntry.hotel_sales).joinedload(CustomerSale.customer),
    )


def visible_branch_ids() -> list[int]:
    codes = g.user.branch_codes()
    if not codes:
        return []
    return [b.id for b in Branch.query.filter(Branch.code.in_(codes)).all()]


CLOSE_FIELD_COL = {"closeBirds": "close_birds", "closeWtG": "close_weight_g",
                   "closeMeatG": "close_meat_g"}


def _manual_close_keys(d: dict) -> set:
    """
    Which of closeBirds/closeWtG/closeMeatG (if any) the client is asking to
    set by hand this save, rather than have the server compute.

    Only an admin gets this — a supervisor's screen never shows the fields as
    editable, so nothing they send here is trusted even if present. The
    client signals per-field via `closeAuto: {birds, wt, meat}`; a field is
    manual only when its flag is explicitly False AND the matching value is
    present in the payload.
    """
    if not g.user.is_admin:
        return set()
    auto = d.get("closeAuto") or {}
    manual = set()
    if auto.get("birds") is False and "closeBirds" in d:
        manual.add("closeBirds")
    if auto.get("wt") is False and "closeWtG" in d:
        manual.add("closeWtG")
    if auto.get("meat") is False and "closeMeatG" in d:
        manual.add("closeMeatG")
    return manual


def _apply_entry_fields(entry: DailyEntry, d: dict, manual_close: set | None = None) -> None:
    """
    Copy the editable numeric fields from a client payload onto the row.

    closeBirds/closeWtG/closeMeatG are handled separately: normally the
    server works them out (see _recompute_closing_stock), but an admin can
    switch any one of the three to manual and type a figure by hand — for a
    physical recount that does not match the formula, say. `manual_close`
    (from _manual_close_keys) says which ones, if any, to honor here.
    """
    ints = {
        "liveSoldCount": "live_sold_count", "liveSoldWtG": "live_sold_weight_g",
        "mortCount": "mortality_count", "mortWtG": "mortality_weight_g",
        "damageG": "damage_meat_g", "dressedCount": "dressed_count",
        "dressedWtG": "dressed_weight_g", "actualMeatG": "actual_meat_g",
        "skinSoldG": "skin_sold_g", "skinlessSoldG": "skinless_sold_g",
        "liverSoldG": "liver_sold_g",
    }
    for src, col in ints.items():
        if src in d:
            setattr(entry, col, to_int(d.get(src), src))

    for src in (manual_close or ()):
        setattr(entry, CLOSE_FIELD_COL[src], to_int(d.get(src), src))

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

    # Opening birds/weight/meat and the buying price are admin-only, in the
    # payload and in the database write — a supervisor's opening figures are
    # never taken from what they submit, whether that's a fresh mistake or a
    # stale readonly field; see _carry_forward_opening() for how a new entry
    # gets them instead, and get_entry()'s comment for why editing them later
    # isn't reachable by a supervisor at all (today-only).
    if g.user.is_admin:
        for src, col in (("openBirds", "open_birds"), ("openWtG", "open_weight_g"),
                         ("openMeatG", "open_meat_g")):
            if src in d:
                setattr(entry, col, to_int(d.get(src), src))
        if "openRate" in d:
            entry.open_rate = to_dec(d.get("openRate"), "openRate")


def _previous_approved(branch_id: int, category: str) -> DailyEntry | None:
    """The most recent APPROVED entry for this branch+category, or None."""
    return (DailyEntry.query.filter_by(branch_id=branch_id, category=category, status="approved")
            .order_by(DailyEntry.business_date.desc()).first())


def _carry_forward_opening(entry: DailyEntry) -> None:
    """
    Set a brand-new entry's opening birds/weight/meat from the previous
    approved day, server-side — a supervisor never gets to type these in (see
    _apply_entry_fields above), so this is what actually carries them
    forward for a supervisor-created entry. An admin's own submission already
    carries the same client-fetched figures in the payload (see
    entries_carry_forward()), so this only needs to run for a supervisor;
    it's a no-op — and harmless — on the very first entry for a branch, where
    opening figures are optional anyway.
    """
    # entry.branch.id, not entry.branch_id — the object was constructed with
    # `branch=branch` (see create_entry()), so the relationship is populated
    # immediately but the FK column only resolves at flush; entry.branch is
    # the one that's safe to read before that.
    prev = _previous_approved(entry.branch.id, entry.category)
    if prev:
        entry.open_birds = prev.close_birds
        entry.open_weight_g = prev.close_weight_g
        entry.open_meat_g = prev.close_meat_g


def _recompute_closing_stock(entry: DailyEntry, manual_close: set | None = None) -> None:
    """
    Set closing birds, closing bird weight and closing meat weight from the
    formula, not from a hand count — except any field an admin just put in
    manual mode (`manual_close`), which _apply_entry_fields() already set and
    this leaves alone. Call this after opening stock, purchases, counter
    sales and hotel/hostel sales are all in place on `entry` — it reads them
    straight off the object via to_dict(), so purchases/hotel_sales only need
    to be appended to the in-memory relationship, not flushed.

    Day-close reconciliation (see day_close()) may still nudge close_meat_g
    afterwards, when what was actually collected in cash/UPI doesn't match
    what the day's entry says was sold — that happens after this, not instead
    of it.
    """
    manual_close = manual_close or set()
    data = entry.to_dict(include_costs=True)
    calc = compute_entry(data, get_settings())
    if "closeBirds" not in manual_close:
        entry.close_birds = calc["expBirds"]
    if "closeWtG" not in manual_close:
        entry.close_weight_g = calc["expCloseWtG"]
    if "closeMeatG" not in manual_close:
        entry.close_meat_g = calc["expCloseMeatG"]


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
        "rateLiver": entry.rate_liver, "rateLive": entry.rate_live})
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
            # only a live line carries a head count
            birds=(to_int(r.get("birds"), f"hotelSales[{i}].birds")
                   if product == "live" else 0),
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
    rows = (Customer.query.options(joinedload(Customer.branch))
            .filter(Customer.branch_id.in_(branch_ids))
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
    # A supervisor only ever has today — a rejected entry from a past date
    # (say, reviewed a day late) is not reachable for correction either;
    # that now has to go through an admin.
    return (entry.status in ("draft", "rejected") and entry.created_by_id == g.user.id
            and entry.business_date == date.today())


def day_is_closed(branch_id: int, day: date) -> bool:
    """
    True once an admin has declared the cash handover for this branch+day.
    Wages and overheads feed straight into that reconciliation (see
    save_dayclose()/expected_cash()), so once it's declared a supervisor can
    no longer add or edit either for that day — it would quietly throw the
    already-reconciled figures out of step with what was actually recorded.
    An admin can still amend after the fact, same as everywhere else.
    """
    return DayClose.query.filter_by(branch_id=branch_id, business_date=day).first() is not None


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

    # A bounded window instead of "the newest 2,000, and quietly lose the rest".
    # The browser asks for more when a date range reaches past it — see
    # /api/entries — so nothing is ever silently missing from a report.
    window_days = max(7, min(int(request.args.get("days", BOOTSTRAP_DAYS)), 730))
    win_from = date.today() - timedelta(days=window_days)

    q = DailyEntry.query.filter(DailyEntry.branch_id.in_(bids)) if bids else DailyEntry.query.filter(False)
    if not g.user.is_admin:
        # A supervisor only ever works today — no browsing their own past
        # submissions either, so the Records list and the window/total figures
        # below only ever reflect today for them. See also list_entries()
        # and get_entry(), which apply the same floor.
        q = q.filter(DailyEntry.created_by_id == g.user.id,
                     DailyEntry.business_date == date.today())
    total_entries = q.count()
    q = entries_query(q)
    q = q.filter(DailyEntry.business_date >= win_from)
    entries = q.order_by(DailyEntry.business_date.desc()).limit(MAX_PAGE).all()

    # Explicit joinedload on every one of these — to_dict() below reads
    # .branch (and, for DayClose, .declared_by/.verified_by too) on every
    # row. Branches happen to already be warm in the session from the query
    # above, so skipping this mostly got away with it, but declared_by/
    # verified_by were not warm for anyone but an admin (and only after the
    # "users" key, further down, which was too late to help). Making it
    # explicit here means this isn't quietly depending on load order.
    workers = (Worker.query.options(joinedload(Worker.branch))
              .filter(Worker.branch_id.in_(bids)).all()) if bids else []
    ledger = (LabourLedger.query.options(joinedload(LabourLedger.branch))
              .filter(LabourLedger.branch_id.in_(bids),
                      LabourLedger.entry_date >= win_from)
              .order_by(LabourLedger.entry_date.desc()).limit(MAX_PAGE).all()) if bids else []
    customers, cust_totals = customers_payload(bids)
    receipts = (CustomerPayment.query.options(joinedload(CustomerPayment.branch))
                .filter(CustomerPayment.branch_id.in_(bids))
                .order_by(CustomerPayment.pay_date.desc()).limit(2000).all()) if bids else []
    closes = (DayClose.query.options(joinedload(DayClose.branch), joinedload(DayClose.declared_by),
                                     joinedload(DayClose.verified_by))
              .filter(DayClose.branch_id.in_(bids),
                      DayClose.business_date >= win_from)
              .order_by(DayClose.business_date.desc()).all()) if bids else []

    oq = (Overhead.query.options(joinedload(Overhead.branch), joinedload(Overhead.created_by))
          .filter(Overhead.branch_id.in_(bids))) if bids else Overhead.query.filter(False)
    if not g.user.is_admin:
        # Same narrower view list_overheads() already enforces: a supervisor
        # only ever sees their own overhead, and only a dated one for today —
        # never another user's, and never a stale past-dated one of their
        # own either. This filter was missing here, so a supervisor's very
        # first page load (before they ever open the Overheads screen) could
        # hand over overhead entries that were never meant to be visible to
        # them.
        oq = oq.filter(Overhead.created_by_id == g.user.id,
                       or_(Overhead.spend_date.is_(None), Overhead.spend_date == date.today()))
    # Capped like entries/ledger above rather than left to grow forever — no
    # eager loading was applied here either, so every row used to cost an
    # extra query apiece for .branch and .created_by once the identity map
    # ran cold (see Overhead.to_dict()).
    overheads = oq.order_by(Overhead.period_month.desc()).limit(MAX_PAGE).all()

    payload = {
        "user": g.user.to_dict(),
        "idleMinutes": idle_limit_minutes(g.user.role),
        "branches": {b.code: b.name for b in branches},
        "settings": {"wasteBroiler": settings["waste_broiler"],
                     "wasteParents": settings["waste_parents"],
                     "tolerance": settings["tolerance"],
                     "dayWage": settings["day_wage"]},
        "entries": entry_list_payload(entries, settings),
        "window": {"from": win_from.isoformat(), "to": date.today().isoformat(),
                   "days": window_days, "loaded": len(entries),
                   "total": total_entries},
        "workers": [w.to_dict() for w in workers],
        "ledger": [l.to_dict() for l in ledger],
        "overheads": [o.to_dict() for o in overheads],
        "customers": customers,
        "customerTotals": cust_totals,
        "receipts": [p.to_dict() for p in receipts],
        "closes": [c.to_dict() for c in closes],
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
    # A supervisor can only ever create today's entry — the date field on
    # their form is locked client-side, but a direct API call could still
    # send anything, so pin the date here too. Keep whatever time-of-day
    # they entered; only the date is forced.
    if not g.user.is_admin and bdate != date.today():
        today = date.today()
        bstamp = bstamp.replace(year=today.year, month=today.month, day=today.day)
        bdate = today
    category = d.get("category") if d.get("category") in ("broiler", "parents") else "broiler"
    status = "pending" if d.get("submit") else "draft"

    clash = DailyEntry.query.filter_by(branch_id=branch.id, category=category,
                                       business_date=bdate).first()
    if clash:
        log_activity("Blocked duplicate entry", f"{category} · {bdate} · existing is {clash.status}")
        db.session.commit()
        return jsonify({"error": "duplicate",
                        "message": f"A {clash.status} entry already exists for {bdate}."}), 409

    # `branch=branch`, not `branch_id=branch.id` — _recompute_closing_stock()
    # below calls entry.to_dict(), which reads entry.branch.code, and that
    # relationship is otherwise unpopulated (None) until the object is
    # flushed and reloaded. Assigning the object directly sets branch_id AND
    # makes entry.branch usable immediately, no round trip needed.
    manual_close = _manual_close_keys(d)
    entry = DailyEntry(branch=branch, category=category, business_date=bdate,
                       entered_at=bstamp, created_by_id=g.user.id, status="draft")
    _apply_entry_fields(entry, d, manual_close)
    # Opening birds/weight/meat are admin-only in _apply_entry_fields above —
    # a supervisor never gets to type these in, so this is what actually
    # fills them in for a supervisor-created entry, straight from the
    # previous approved day, ignoring anything sent in the payload.
    if not g.user.is_admin:
        _carry_forward_opening(entry)
    _replace_purchases(entry, d.get("purchases"))
    _replace_photos(entry, d.get("photos"))
    _replace_hotel_sales(entry, d.get("hotelSales"))
    db.session.add(entry)
    db.session.flush()
    # after the flush, not before: any numeric field the client left out is
    # still None in memory until the INSERT resolves the column's default —
    # to_dict() (which _recompute_closing_stock calls) needs the real 0s.
    _recompute_closing_stock(entry, manual_close)

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

    manual_close = _manual_close_keys(d)
    _apply_entry_fields(entry, d, manual_close)
    if "purchases" in d:
        _replace_purchases(entry, d.get("purchases"))
    # Photos are only replaced when the client says it actually had them
    # loaded. Lists no longer carry the images, so a save from a screen that
    # never fetched them must not be read as "delete all photos".
    if "photos" in d and d.get("photosLoaded") is True:
        _replace_photos(entry, d.get("photos"))
    if "hotelSales" in d:
        _replace_hotel_sales(entry, d.get("hotelSales"))
    else:
        # the selling rates may have just changed; the hotel bills follow them
        _reprice_hotel_sales(entry)
    _recompute_closing_stock(entry, manual_close)
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


@bp.get("/entries/carry-forward")
@login_required
def entries_carry_forward():
    """
    Just enough of the most recent APPROVED day for this branch+category to
    start tomorrow's entry — closing stock and the going rates — without
    handing over the whole record. This is what lets a supervisor's opening
    figures still carry forward from yesterday even though they can no
    longer see or open yesterday's entry itself (today-only, see can_edit()
    and get_entry()); an admin uses the same endpoint so there is only one
    code path to keep correct.
    """
    branch_code = request.args.get("branch")
    err = require_branch(branch_code)
    if err:
        return err
    branch = branch_by_code(branch_code)
    category = request.args.get("category") if request.args.get("category") in ("broiler", "parents") else "broiler"

    prev = _previous_approved(branch.id, category)
    if not prev:
        return jsonify({"found": False})

    calc = compute_entry(prev.to_dict(include_costs=True), get_settings())
    return jsonify({
        "found": True,
        "date": prev.business_date.isoformat(),
        "closeBirds": prev.close_birds,
        "closeWtG": prev.close_weight_g,
        "closeMeatG": prev.close_meat_g,
        "avgRate": calc.get("avgRate", 0),
        "rateSkin": float(prev.rate_skin), "rateSkinless": float(prev.rate_skinless),
        "rateLiver": float(prev.rate_liver), "rateLive": float(prev.rate_live),
    })


@bp.get("/entries")
@login_required
def list_entries():
    """
    Paged, filtered entries.

    Returns a bare list when no paging is asked for, so older callers keep
    working, and an object with page metadata when `page` or `pageSize` is
    supplied. Either way the result is capped, and `total` tells the caller
    whether it is seeing everything.
    """
    settings = get_settings()
    bids = visible_branch_ids()
    q = DailyEntry.query.filter(DailyEntry.branch_id.in_(bids)) if bids else DailyEntry.query.filter(False)
    if not g.user.is_admin:
        # Same floor as bootstrap(): today only, no browsing history.
        q = q.filter(DailyEntry.created_by_id == g.user.id,
                     DailyEntry.business_date == date.today())
    if request.args.get("from"):
        q = q.filter(DailyEntry.business_date >= parse_date(request.args["from"], field="from"))
    if request.args.get("to"):
        q = q.filter(DailyEntry.business_date <= parse_date(request.args["to"], field="to"))
    if request.args.get("status"):
        q = q.filter(DailyEntry.status == request.args["status"])
    if request.args.get("branch"):
        b = branch_by_code(request.args["branch"])
        q = q.filter(DailyEntry.branch_id == (b.id if b else -1))
    if request.args.get("category") in ("broiler", "parents"):
        q = q.filter(DailyEntry.category == request.args["category"])

    paged = "page" in request.args or "pageSize" in request.args
    size = max(1, min(to_int(request.args.get("pageSize"), "pageSize") or DEFAULT_PAGE_SIZE,
                      MAX_PAGE))
    page = max(1, to_int(request.args.get("page"), "page") or 1)

    total = q.count()
    rows = (entries_query(q).order_by(DailyEntry.business_date.desc(), DailyEntry.id)
            .offset((page - 1) * size).limit(size if paged else MAX_PAGE).all())
    payload = entry_list_payload(rows, settings)
    if not paged:
        return jsonify(payload)
    return jsonify({"rows": payload, "total": total, "page": page,
                    "pageSize": size, "pages": max(1, -(-total // size))})


@bp.get("/entries/<entry_id>")
@login_required
def get_entry(entry_id):
    """One entry in full, photos included — what the edit screen loads."""
    entry = db.session.get(DailyEntry, entry_id)
    if not entry:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(entry.branch.code)
    if err:
        return err
    if not g.user.is_admin and entry.created_by_id != g.user.id:
        return jsonify({"error": "forbidden"}), 403
    # Today only for a supervisor — even one of their own past entries (a
    # rejected one included) is out of reach now, not just uneditable.
    if not g.user.is_admin and entry.business_date != date.today():
        return jsonify({"error": "forbidden",
                        "message": "Only today's entry is available to you."}), 403
    return jsonify(entry_payload(entry, get_settings()))


@bp.get("/entries/<entry_id>/photos")
@login_required
def entry_photos(entry_id):
    """
    The mortality images, fetched only when someone actually looks at the
    entry. They are base64 JPEGs and have no business travelling with a list.
    """
    entry = db.session.get(DailyEntry, entry_id)
    if not entry:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(entry.branch.code)
    if err:
        return err
    if not g.user.is_admin and entry.created_by_id != g.user.id:
        return jsonify({"error": "forbidden"}), 403
    photos = (MortalityPhoto.query.filter_by(entry_id=entry.id)
              .options(undefer(MortalityPhoto.data_url))
              .order_by(MortalityPhoto.id).all())
    return jsonify({"photos": [p.data_url for p in photos]})


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
    if d.get("kind") in ("hotel", "hostel", "function"):
        c.kind = d["kind"]
    if d.get("mode") in ("less", "fixed"):
        c.price_mode = d["mode"]
    # less_* can go negative on purpose — that flips a concession into a
    # premium above market (see price_hotel_line() in calc.py), so a
    # supervisor or admin can charge a customer more than the counter as
    # easily as less. rate_* is a flat contract figure with no market to be
    # relative to, so it still has to be a real, non-negative price.
    for key, col in (("lessSkin", "less_skin"), ("lessSkinless", "less_skinless"),
                     ("lessLiver", "less_liver"), ("lessLive", "less_live")):
        if key in d:
            setattr(c, col, to_dec(d.get(key), key))
    for key, col in (("rateSkin", "rate_skin"), ("rateSkinless", "rate_skinless"),
                     ("rateLiver", "rate_liver"), ("rateLive", "rate_live")):
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


def _adj_txt(v) -> str:
    # A negative less_* is a premium, not a concession — say so rather than
    # printing a confusing "less ₹-20". v can still be None here: this runs
    # before the row is flushed, so a column left out of the payload hasn't
    # picked up its database default yet (see create_customer()).
    v = float(v or 0)
    return f"less ₹{v}" if v >= 0 else f"plus ₹{-v}"


def _price_summary(c: Customer) -> str:
    if c.price_mode == "fixed":
        return (f"fixed ₹{c.rate_skin} skin / ₹{c.rate_skinless} skinless "
                f"/ ₹{c.rate_liver} liver / ₹{c.rate_live} live")
    return (f"market {_adj_txt(c.less_skin)} skin / {_adj_txt(c.less_skinless)} skinless "
            f"/ {_adj_txt(c.less_liver)} liver / {_adj_txt(c.less_live)} live")


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
            "birds": sale.birds,
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
    if to_dec(d.get("dayWage"), "dayWage") <= 0:
        return jsonify({"error": "validation", "message": "Enter the daily wage."}), 422

    branch = branch_by_code(d["branch"])
    name = d["name"].strip()[:160]
    # A double-tap on "Save worker" would otherwise create the same dresser
    # twice, and every attendance mark afterwards would be ambiguous.
    twin = (Worker.query.filter(Worker.branch_id == branch.id,
                                func.lower(Worker.name) == name.lower()).first())
    if twin:
        return jsonify({"error": "duplicate", "existingId": twin.id,
                        "message": f'"{name}" is already on this branch\'s list.'}), 409

    w = Worker(branch_id=branch.id, name=name,
               role=d.get("role", "dresser"), day_wage=to_dec(d.get("dayWage"), "dayWage"),
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

    # A correction to the balance-due figure — admin only. Logged with the
    # before/after so it shows up distinctly in the activity log rather than
    # blending into an ordinary "edited worker" line.
    if g.user.is_admin and "balanceAdjustment" in d:
        before = float(w.balance_adjustment)
        w.balance_adjustment = to_dec(d.get("balanceAdjustment"), "balanceAdjustment")
        if "balanceNote" in d:
            w.balance_note = (d.get("balanceNote") or "")[:500]
        if float(w.balance_adjustment) != before:
            log_activity("Adjusted worker balance",
                         f"{w.name} · ₹{before:.2f} → ₹{float(w.balance_adjustment):.2f}"
                         + (f" — {w.balance_note}" if w.balance_note else ""),
                         branch_code=w.branch.code)

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


@bp.get("/ledger")
@admin_required
def list_ledger():
    """
    Itemized worker ledger — wages, advances, deductions, tea/tiffin, other
    payments — over a date range, with optional worker and type filters.
    This is the "monitor advances/deductions over time" screen.

    Admin only, same as every other historical Workers view (the day-wise
    table, the old month-only transaction log): a supervisor's Workers
    screen only ever shows today, never a browsable past — see
    add_ledger()/update_ledger() below for the matching write-side floor.
    """
    bids = visible_branch_ids()
    if not bids:
        return jsonify({"rows": [], "summary": {}, "from": None, "to": None})
    if request.args.get("branch"):
        b = branch_by_code(request.args["branch"])
        err = require_branch(request.args["branch"])
        if err:
            return err
        bids = [b.id] if b else []

    to_day = parse_date(request.args.get("to"), date.today(), field="to")
    from_day = parse_date(request.args.get("from"), to_day.replace(day=1), field="from")
    if from_day > to_day:
        from_day, to_day = to_day, from_day

    q = (LabourLedger.query
         .options(joinedload(LabourLedger.branch), joinedload(LabourLedger.worker))
         .filter(LabourLedger.branch_id.in_(bids),
                 LabourLedger.entry_date >= from_day,
                 LabourLedger.entry_date <= to_day))
    if request.args.get("workerId"):
        q = q.filter(LabourLedger.worker_id == request.args["workerId"])
    if request.args.get("type") in ("work", "paid", "advance", "tea", "tiffin", "other"):
        q = q.filter(LabourLedger.kind == request.args["type"])

    rows = (q.order_by(LabourLedger.entry_date.desc(), LabourLedger.created_at.desc())
            .limit(MAX_PAGE).all())

    kinds = ("work", "paid", "advance", "tea", "tiffin", "other")
    summary = {k: 0.0 for k in kinds}
    for r in rows:
        summary[r.kind] += float(r.amount)
    for k in kinds:
        summary[k] = round(summary[k], 2)
    # "work" is what was earned; everything else is money that left the shop
    # against a worker's name (a payment, an advance, or a shop-paid extra).
    summary["deducted"] = round(summary["paid"] + summary["advance"]
                                + summary["tea"] + summary["tiffin"] + summary["other"], 2)
    summary["net"] = round(summary["work"] - summary["deducted"], 2)
    summary["count"] = len(rows)

    return jsonify({
        "rows": [dict(r.to_dict(), workerName=r.worker.name) for r in rows],
        "summary": summary,
        "from": from_day.isoformat(), "to": to_day.isoformat(),
    })


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
    # A supervisor only ever works today's attendance/wages — the date picker
    # driving this on the Workers screen is disabled for them client-side, so
    # this is the matching server-side floor: whatever date sneaks in on a
    # direct API call, an admin gets it, anyone else gets overridden to today.
    if not g.user.is_admin:
        day = date.today()
    branch = branch_by_code(d["branch"])
    # Once an admin has declared today's handover, its wages are already
    # baked into that reconciliation — a supervisor can no longer add to or
    # change them; only an admin can still amend at that point.
    if not g.user.is_admin and day_is_closed(branch.id, day):
        return jsonify({"error": "forbidden",
                        "message": "Today's handover is already declared — ask an admin to make changes."}), 403

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
        # A supervisor or admin may quote this worker a different rate for the
        # day (e.g. a Sunday surge rate) instead of the worker's standard
        # day_wage — send "wageOverride" and it wins; otherwise the usual
        # day_wage * days applies.
        override = d.get("wageOverride")
        if override not in (None, ""):
            row.amount = to_dec(override, "wageOverride")
        else:
            row.amount = Decimal(str(float(worker.day_wage) * days))
        default_note = "Half day" if days == 0.5 else "Full day"
        row.note = (d.get("note") or "").strip()[:500] or (
            default_note if override in (None, "") else f"{default_note} · custom rate")
        row.created_by_id = g.user.id
        log_activity("Attendance",
                     f"{worker.name} · {day} · {'half day' if days == 0.5 else 'full day'}"
                     + (f" · custom rate ₹{row.amount}" if override not in (None, "") else ""),
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
            row.amount = (to_dec(override, "wageOverride") if override not in (None, "")
                         else Decimal(str(float(worker.day_wage) * days)))
            row.note = (d.get("note") or "").strip()[:500] or default_note
            db.session.commit()
        return jsonify(row.to_dict()), 201

    amount = to_dec(d.get("amount"), "amount")
    if amount <= 0:
        return jsonify({"error": "validation", "message": "Enter an amount."}), 422

    # A second click on "Save" would post the same advance again. An identical
    # worker + day + kind + amount recorded moments ago is a double submission,
    # not a genuine second payment.
    recent = (LabourLedger.query
              .filter(LabourLedger.worker_id == worker.id,
                      LabourLedger.entry_date == day,
                      LabourLedger.kind == kind,
                      LabourLedger.amount == amount)
              .order_by(LabourLedger.created_at.desc()).first())
    if recent and recent.created_at:
        # SQLite hands back a naive datetime, Postgres an aware one. Assume UTC
        # for the naive case rather than letting the subtraction explode.
        created = recent.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        age = (utcnow() - created).total_seconds()
        if age < 20 and not d.get("confirmDuplicate"):
            return jsonify({
                "error": "duplicate", "existingId": recent.id,
                "message": (f"₹{amount} was just recorded for {worker.name} "
                            f"{int(age)}s ago. Sending it twice looks like a "
                            f"double click — recorded once.")}), 409

    row = LabourLedger(branch_id=branch.id, worker_id=worker.id, entry_date=day,
                       kind=kind, days=0, amount=amount,
                       note=d.get("note"), created_by_id=g.user.id)
    db.session.add(row)
    log_activity(f"Ledger {kind}", f"₹{row.amount} · {worker.name}", branch_code=branch.code)
    db.session.commit()
    return jsonify(row.to_dict()), 201


@bp.put("/ledger/<row_id>")
@login_required
def update_ledger(row_id):
    """
    Correct an already-recorded wage/deduction row instead of deleting and
    re-adding it. An admin can edit any row, any date — this is the "change
    or undo a transaction" ability. A supervisor may only touch a 'work'
    (wage) row for their own branch, only its amount/days/note, and only if
    it is dated TODAY — they have no reach into any other day's records at
    all, matching the rest of the Workers screen. No separate history is
    kept; this simply overwrites the row, same as any other edit in the app.
    """
    row = db.session.get(LabourLedger, row_id)
    if not row:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(row.branch.code)
    if err:
        return err
    if not g.user.is_admin and row.kind != "work":
        return jsonify({"error": "forbidden",
                        "message": "Only an admin can edit a paid/advance/deduction entry."}), 403
    if not g.user.is_admin and row.entry_date != date.today():
        return jsonify({"error": "forbidden",
                        "message": "Only today's entries can be edited."}), 403
    if not g.user.is_admin and day_is_closed(row.branch_id, row.entry_date):
        return jsonify({"error": "forbidden",
                        "message": "Today's handover is already declared — ask an admin to make changes."}), 403

    d = request.get_json(silent=True) or {}
    before = f"{row.kind} · ₹{row.amount}"

    if g.user.is_admin and d.get("type") in ("work", "paid", "advance", "tea", "tiffin", "other"):
        row.kind = d["type"]

    if row.kind == "work" and ("days" in d or "amount" in d or "wageOverride" in d):
        days = float(d.get("days", row.days) or 0)
        if days <= 0:
            return jsonify({"error": "validation", "message": "Days must be greater than zero."}), 422
        row.days = Decimal(str(days))
        override = d.get("wageOverride", d.get("amount"))
        if override not in (None, ""):
            row.amount = to_dec(override, "amount")
        else:
            row.amount = Decimal(str(float(row.worker.day_wage) * days))
    elif "amount" in d:
        amt = to_dec(d.get("amount"), "amount")
        if amt <= 0:
            return jsonify({"error": "validation", "message": "Enter an amount."}), 422
        row.amount = amt

    if "note" in d:
        row.note = (d.get("note") or "")[:500]
    if g.user.is_admin and "date" in d:
        row.entry_date = parse_date(d.get("date"), row.entry_date)

    log_activity("Edited ledger entry", f"{before} → {row.kind} · ₹{row.amount}",
                 branch_code=row.branch.code)
    db.session.commit()
    return jsonify(row.to_dict())


@bp.delete("/ledger/<row_id>")
@admin_required
def delete_ledger(row_id):
    # Admin only — the one UI path to this (the ledger transaction log's
    # trash icon) is itself an admin-only screen; attendance's "un-mark" goes
    # through POST /ledger with days=0 instead, not here.
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

    # A dated overhead is spent on one day and charged there in full; an
    # undated one is a standing monthly cost spread across the month.
    spend = parse_date(d.get("date"), None, field="date") if d.get("date") else None
    # A supervisor only ever logs today's dated costs — same floor as
    # entries and ledger rows. A standing monthly cost has no "date" to pin,
    # so it is unaffected (and stays admin-only to edit afterwards).
    if spend and not g.user.is_admin:
        spend = date.today()
    month = (spend.strftime("%Y-%m") if spend
             else (d.get("month") or date.today().strftime("%Y-%m"))[:7])

    branch = branch_by_code(d["branch"])
    if spend and not g.user.is_admin and day_is_closed(branch.id, spend):
        return jsonify({"error": "forbidden",
                        "message": "Today's handover is already declared — ask an admin to make changes."}), 403

    o = Overhead(branch_id=branch.id,
                 period_month=month, spend_date=spend,
                 category=d.get("category", "other"),
                 amount=to_dec(d.get("amount"), "amount"),
                 note=d.get("note"),
                 status="approved" if g.user.is_admin else "pending",
                 created_by_id=g.user.id,
                 reviewed_by_id=g.user.id if g.user.is_admin else None,
                 reviewed_at=utcnow() if g.user.is_admin else None)
    db.session.add(o)
    log_activity("Added overhead",
                 f"{o.category} · {spend or o.period_month} · ₹{o.amount}"
                 + (" (charged to the day)" if spend else " (spread over the month)")
                 + (" (auto-approved)" if g.user.is_admin else " (pending)"),
                 branch_code=d["branch"])
    db.session.commit()
    return jsonify(o.to_dict()), 201


@bp.put("/overheads/<ov_id>")
@login_required
def update_overhead(ov_id):
    """
    An admin can edit any overhead, any date, any time — the usual "change or
    undo" ability. A supervisor may only correct one of their own DATED
    overheads, dated exactly today, and only while it is still pending —
    once an admin approves or rejects it, or once today's handover is
    declared, it is out of their reach, same as everywhere else on this
    screen. A standing monthly cost has no "today" to pin it to, so it stays
    admin-only to touch, as before.
    """
    o = db.session.get(Overhead, ov_id)
    if not o:
        return jsonify({"error": "not_found"}), 404
    err = require_branch(o.branch.code)
    if err:
        return err
    if not g.user.is_admin:
        if (o.created_by_id != g.user.id or o.status != "pending"
                or o.spend_date != date.today()):
            return jsonify({"error": "forbidden",
                            "message": "Only your own pending overhead for today can be edited."}), 403
        if day_is_closed(o.branch_id, o.spend_date):
            return jsonify({"error": "forbidden",
                            "message": "Today's handover is already declared — ask an admin to make changes."}), 403

    d = request.get_json(silent=True) or {}
    if "amount" in d:
        o.amount = to_dec(d.get("amount"), "amount")
    if "category" in d:
        o.category = d.get("category") or "other"
    if "note" in d:
        o.note = (d.get("note") or "")[:2000]
    # Moving the date, or off a date entirely, reshapes what this overhead
    # even is (a one-day cost vs. a standing monthly one) — admin only.
    if g.user.is_admin and "date" in d:
        o.spend_date = parse_date(d.get("date"), None, field="date") if d.get("date") else None
        if o.spend_date:
            o.period_month = o.spend_date.strftime("%Y-%m")
    if g.user.is_admin and "month" in d and not o.spend_date:
        o.period_month = (d.get("month") or o.period_month)[:7]
    log_activity("Edited overhead", f"{o.category} · ₹{o.amount}", branch_code=o.branch.code)
    db.session.commit()
    return jsonify(o.to_dict())


@bp.get("/overheads")
@login_required
def list_overheads():
    """
    Overheads for reporting: one branch or every branch at once, over a date
    range, with each row resolved to the day it actually lands on.
    """
    bids = visible_branch_ids()
    if not bids:
        return jsonify({"rows": [], "byDay": [], "byBranch": [], "total": 0})
    if request.args.get("branch"):
        b = branch_by_code(request.args["branch"])
        err = require_branch(request.args["branch"])
        if err:
            return err
        bids = [b.id] if b else []

    to_day = parse_date(request.args.get("to"), date.today(), field="to")
    from_day = parse_date(request.args.get("from"),
                          to_day.replace(day=1), field="from")
    months = months_in_range(from_day, to_day)

    rows = (Overhead.query.filter(Overhead.branch_id.in_(bids),
                                  Overhead.period_month.in_(months))
            .order_by(Overhead.period_month.desc()).all()) if bids else []

    # The by-day/by-branch totals below are computed from every APPROVED row
    # regardless of role — that is a branch-level figure, not a browsable
    # history, so it stays accurate for a supervisor too. The itemized list
    # they actually see is narrower: their own, and — like the rest of the
    # Workers/Overheads screens — only today's dated ones, never a past
    # day's; a standing monthly cost has no date to be "past", so it stays
    # visible either way.
    approved_rows = rows
    if not g.user.is_admin:
        rows = [o for o in rows if o.created_by_id == g.user.id
                and (o.spend_date is None or o.spend_date == date.today())]
    if request.args.get("status"):
        rows = [o for o in rows if o.status == request.args["status"]]

    by_day, by_branch, total = {}, {}, 0.0
    span = (to_day - from_day).days + 1
    for o in approved_rows:
        if o.status != "approved":
            continue
        code = o.branch.code
        if o.spend_date is not None:
            if not (from_day <= o.spend_date <= to_day):
                continue
            share = [(o.spend_date, float(o.amount))]
        else:
            y, m = int(o.period_month[:4]), int(o.period_month[5:7])
            dim = calendar.monthrange(y, m)[1]
            per = float(o.amount) / dim
            share = []
            for n in range(dim):
                day = date(y, m, 1) + timedelta(days=n)
                if from_day <= day <= to_day:
                    share.append((day, per))
        for day, amount in share:
            key = day.isoformat()
            slot = by_day.setdefault(key, {"date": key, "total": 0.0, "branches": {}})
            slot["total"] += amount
            slot["branches"][code] = slot["branches"].get(code, 0.0) + amount
            by_branch.setdefault(code, {"branch": code, "name": o.branch.name,
                                        "total": 0.0, "dated": 0.0, "monthly": 0.0})
            by_branch[code]["total"] += amount
            by_branch[code]["dated" if o.spend_date else "monthly"] += amount
            total += amount

    for slot in by_day.values():
        slot["total"] = round(slot["total"], 2)
        slot["branches"] = {k: round(v, 2) for k, v in slot["branches"].items()}
    for slot in by_branch.values():
        for k in ("total", "dated", "monthly"):
            slot[k] = round(slot[k], 2)

    return jsonify({
        "rows": [o.to_dict() for o in rows],
        "byDay": sorted(by_day.values(), key=lambda r: r["date"], reverse=True),
        "byBranch": sorted(by_branch.values(), key=lambda r: -r["total"]),
        "total": round(total, 2),
        "from": from_day.isoformat(), "to": to_day.isoformat(), "days": span,
    })


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
    if not g.user.is_admin:
        if o.status == "approved" or o.created_by_id != g.user.id:
            return jsonify({"error": "forbidden",
                            "message": "Approved overheads can only be removed by an admin."}), 403
        if o.spend_date is not None and o.spend_date != date.today():
            return jsonify({"error": "forbidden",
                            "message": "Only today's dated overhead can be removed."}), 403
    log_activity("Deleted overhead", f"{o.category} · {o.period_month} · ₹{o.amount}",
                 branch_code=o.branch.code)
    db.session.delete(o)
    db.session.commit()
    return jsonify({"ok": True})


# ==========================================================================
# end-of-day cash handover
# ==========================================================================
def expected_cash(branch_id: int, day: date) -> dict:
    """
    What should be in the supervisor's hands at close.

    Revenue is the wrong yardstick: a hotel buying on account puts nothing in
    the till, and an advance handed to a cutter takes money out of it. So:

        counter meat + live sales + cutting charges     sold over the counter
      + hotel/function sales marked PAID on the day
      + receipts collected against old hotel bills
      − wages, advances, tea, tiffin and shop costs paid out
      = what should be handed over

    Credit sales are excluded entirely — they land on the customer's ledger
    instead, and turn into cash on the day a receipt is recorded.
    """
    settings = get_settings()
    entries = DailyEntry.query.filter_by(branch_id=branch_id, business_date=day).all()

    counter = live = cutting = hotel_cash = 0.0
    hotel_credit = revenue = 0.0
    for e in entries:
        c = compute_entry(e.to_dict(include_costs=True, include_photos=False),
                          settings, DayCostIndex.EMPTY)
        counter += c["counterSaleAmt"]
        live += c["liveAmt"]
        cutting += c["cutAmt"]
        hotel_cash += c["hotelCash"]
        hotel_credit += c["hotelCredit"]
        revenue += c["revenue"]

    receipts = sum(float(p.amount) for p in CustomerPayment.query.filter_by(
        branch_id=branch_id, pay_date=day).all())

    lab = LabourLedger.query.filter_by(branch_id=branch_id, entry_date=day).all()
    wages_paid = sum(float(r.amount) for r in lab if r.kind in ("paid", "advance"))
    shop_costs = sum(float(r.amount) for r in lab if r.kind in SHOP_KINDS)
    paid_out = wages_paid + shop_costs

    expected = counter + live + cutting + hotel_cash + receipts - paid_out
    return {
        "date": day.isoformat(),
        "counterSales": round(counter, 2), "liveSales": round(live, 2),
        "cuttingCharges": round(cutting, 2), "hotelCash": round(hotel_cash, 2),
        "hotelCredit": round(hotel_credit, 2), "receipts": round(receipts, 2),
        "wagesPaid": round(wages_paid, 2), "shopCosts": round(shop_costs, 2),
        "paidOut": round(paid_out, 2),
        "revenue": round(revenue, 2),
        "expected": round(expected, 2),
        "entries": len(entries),
        "approved": len([e for e in entries if e.status == "approved"]),
    }


# A previous version of this endpoint silently credited or removed meat
# sales on the day's entry to force cash + UPI + wages + overheads to match
# recorded revenue — including on an already-APPROVED entry, well after
# whoever approved it had signed off on its figures. That surprised people
# (an entry's skin/skinless numbers would change on their own days later,
# just from someone declaring the till count) and bypassed the normal
# admin-edit path entirely, so it has been removed. Declaring a handover now
# only ever records what was declared; any mismatch against expected cash is
# still reported (see "difference"/"revenueDifference" in close_payload()
# below) for a human to look at and, if it's genuinely wrong, correct
# through the entry's own edit screen — not something this endpoint does to
# it silently. meat_adjust_* on DayClose is kept on the model purely so any
# handover declared before this change still displays what it recorded.


def close_payload(branch, day: date, exp=None, wages_today=None, overheads_today=None) -> dict:
    """
    `exp`/`wages_today`/`overheads_today` can be passed in already computed.
    save_dayclose() does this with the figures measured at the moment of
    declaration, so the response reports what was actually declared against
    rather than a fresh recompute. Every other caller (a plain GET) leaves
    them out and gets the current, live numbers — if entries were edited
    since the last declaration, that drift should show.
    """
    if exp is None:
        exp = expected_cash(branch.id, day)
    if wages_today is None:
        wages_today = labour_for(branch.id, day)["wages"]
    if overheads_today is None:
        overheads_today = overhead_day_share(branch.id, day)
    row = DayClose.query.filter_by(branch_id=branch.id, business_date=day).first()
    declared = float(row.cash_amount) + float(row.upi_amount) if row else 0.0
    collected_total = declared + wages_today + overheads_today
    return {
        "branch": branch.code, "branchName": branch.name,
        "expectedBreakdown": exp,
        "expected": exp["expected"],
        "close": row.to_dict() if row else None,
        "declared": declared if row else None,
        "difference": round(declared - exp["expected"], 2) if row else None,
        # cash + UPI + that day's wages + that day's overheads, vs the day's
        # recorded revenue — purely informational (see the comment above
        # save_dayclose()'s former meat-adjustment functions).
        "wagesToday": round(wages_today, 2),
        "overheadsToday": round(overheads_today, 2),
        "revenueToday": exp["revenue"],
        "collectedTotal": round(collected_total, 2) if row else None,
        "revenueDifference": round(collected_total - exp["revenue"], 2) if row else None,
    }


@bp.get("/dayclose")
@admin_required
def get_dayclose():
    """One branch-day, or every visible branch for that day. Admin only — a
    supervisor no longer has any view onto the cash handover at all, not even
    read-only; the whole Day Close screen is hidden from them client-side and
    this is the matching server-side lock."""
    day = parse_date(request.args.get("date"), date.today(), field="date")
    if request.args.get("branch"):
        err = require_branch(request.args["branch"])
        if err:
            return err
        branches = [branch_by_code(request.args["branch"])]
    else:
        codes = g.user.branch_codes()
        branches = (Branch.query.filter(Branch.code.in_(codes))
                    .order_by(Branch.code).all()) if codes else []
    return jsonify({"date": day.isoformat(),
                    "branches": [close_payload(b, day) for b in branches if b]})


@bp.post("/dayclose")
@admin_required
def save_dayclose():
    # Only an admin declares or edits a handover now — management is who
    # physically receives and counts the cash, so they are who enters it.
    # A supervisor can still see everything via GET /api/dayclose; they just
    # cannot write to it any more.
    d = request.get_json(silent=True) or {}
    err = require_branch(d.get("branch"))
    if err:
        return err
    branch = branch_by_code(d["branch"])
    day = parse_date(d.get("date"), date.today(), field="date")

    cash = to_dec(d.get("cash"), "cash")
    upi = to_dec(d.get("upi"), "upi")
    if cash < 0 or upi < 0:
        return jsonify({"error": "validation",
                        "message": "Amounts cannot be negative."}), 422

    row = DayClose.query.filter_by(branch_id=branch.id, business_date=day).first()
    # the "already verified, only an admin may overwrite" lock is gone: this
    # whole endpoint is admin-only now, so it never applied to anyone else

    if not row:
        row = DayClose(branch_id=branch.id, business_date=day)
        db.session.add(row)

    exp = expected_cash(branch.id, day)
    row.cash_amount = cash
    row.upi_amount = upi
    row.expected_amount = Decimal(str(exp["expected"]))
    row.note = (d.get("note") or "")[:1000]
    row.declared_by_id = g.user.id
    row.declared_at = utcnow()

    diff = float(cash + upi) - exp["expected"]
    log_activity("Cash handover",
                 f"{day} · cash ₹{cash} + UPI ₹{upi} vs expected "
                 f"₹{exp['expected']:.2f} · "
                 + ("balanced" if abs(diff) < 0.5
                    else f"{'over' if diff > 0 else 'short'} ₹{abs(diff):.2f}"),
                 branch_code=branch.code)

    # cash + UPI handed over, plus that day's wages and overheads (paid out of
    # the same day's takings before the handover), against what the day's
    # entry says was actually sold. Just reported below, never acted on — see
    # the comment above this function for why it no longer touches the entry.
    wages_today = labour_for(branch.id, day)["wages"]
    overheads_today = overhead_day_share(branch.id, day)

    try:
        db.session.commit()
    except IntegrityError:
        # two devices closed the same day at once — take whichever landed
        db.session.rollback()
        row = DayClose.query.filter_by(branch_id=branch.id, business_date=day).first()
        if not row:
            raise
        row.cash_amount, row.upi_amount = cash, upi
        row.expected_amount = Decimal(str(exp["expected"]))
        db.session.commit()
    # Report against the figures this declaration was actually measured
    # against, rather than a fresh recompute — entries can keep changing
    # after a handover is declared (an admin correction, a late edit), and
    # this response should reflect what was true at the moment of
    # declaration, not drift with whatever the entry says right now.
    return jsonify(close_payload(branch, day, exp=exp, wages_today=wages_today,
                                 overheads_today=overheads_today)), 201


@bp.post("/dayclose/<close_id>/verify")
@admin_required
def verify_dayclose(close_id):
    row = db.session.get(DayClose, close_id)
    if not row:
        return jsonify({"error": "not_found"}), 404
    reopen = bool((request.get_json(silent=True) or {}).get("reopen"))
    row.verified_by_id = None if reopen else g.user.id
    row.verified_at = None if reopen else utcnow()
    log_activity("Reopened handover" if reopen else "Verified handover",
                 f"{row.business_date} · declared ₹{float(row.cash_amount) + float(row.upi_amount):.2f}",
                 branch_code=row.branch.code)
    db.session.commit()
    return jsonify(close_payload(row.branch, row.business_date))


@bp.get("/dayclose/history")
@admin_required
def dayclose_history():
    """A run of days with what was declared against what was expected. Admin
    only, same as get_dayclose() above."""
    to_day = parse_date(request.args.get("to"), date.today(), field="to")
    from_day = parse_date(request.args.get("from"), to_day - timedelta(days=29),
                          field="from")
    if (to_day - from_day).days > 180:
        from_day = to_day - timedelta(days=180)

    codes = g.user.branch_codes()
    if request.args.get("branch"):
        err = require_branch(request.args["branch"])
        if err:
            return err
        codes = [request.args["branch"]]
    branches = (Branch.query.filter(Branch.code.in_(codes))
                .order_by(Branch.code).all()) if codes else []

    out = []
    day = to_day
    while day >= from_day:
        for b in branches:
            exp = expected_cash(b.id, day)
            row = DayClose.query.filter_by(branch_id=b.id, business_date=day).first()
            if not row and exp["entries"] == 0 and abs(exp["expected"]) < 0.005:
                continue                      # nothing traded, nothing to close
            declared = (float(row.cash_amount) + float(row.upi_amount)) if row else None
            out.append({
                "date": day.isoformat(), "branch": b.code, "branchName": b.name,
                "expected": exp["expected"], "revenue": exp["revenue"],
                "cash": float(row.cash_amount) if row else None,
                "upi": float(row.upi_amount) if row else None,
                "declared": declared,
                "difference": round(declared - exp["expected"], 2) if row else None,
                "verified": bool(row and row.verified_by_id),
                "declaredByName": row.declared_by.name if row and row.declared_by else "",
                "missing": row is None,
                "meatAdjustG": row.meat_adjust_g if row else 0,
                "meatAdjustAmount": float(row.meat_adjust_amount) if row else 0.0,
            })
        day -= timedelta(days=1)
    return jsonify({"from": from_day.isoformat(), "to": to_day.isoformat(),
                    "rows": out})


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


