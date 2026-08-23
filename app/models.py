"""
Venus Chicken Centers — database models.

Design notes
------------
* All weights are stored as INTEGER GRAMS and all money as NUMERIC(14,2).
  Storing weights as integers removes every float rounding problem from the
  yield and reconciliation maths, which is the whole point of the system.
* Branches are rows, not an enum, so any number can be added at runtime.
* One daily entry per (branch, category, business_date) is enforced by a
  database unique constraint, not just by the UI.
* Every mutating action is written to activity_log for audit.
"""

from datetime import datetime, date, timezone
import uuid

from sqlalchemy import (
    CheckConstraint, Column, Date, DateTime, ForeignKey, Index, Integer,
    Numeric, String, Text, UniqueConstraint, Boolean, func, text
)
from sqlalchemy.orm import deferred, relationship
from werkzeug.security import generate_password_hash, check_password_hash

from .extensions import db


def _uuid() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# Reference / identity
# --------------------------------------------------------------------------
class Branch(db.Model):
    __tablename__ = "branches"

    id = Column(Integer, primary_key=True)
    code = Column(String(16), unique=True, nullable=False, index=True)
    name = Column(String(160), nullable=False)
    address = Column(Text)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    entries = relationship("DailyEntry", back_populates="branch", cascade="all, delete-orphan")
    workers = relationship("Worker", back_populates="branch", cascade="all, delete-orphan")
    overheads = relationship("Overhead", back_populates="branch", cascade="all, delete-orphan")
    customers = relationship("Customer", back_populates="branch", cascade="all, delete-orphan")

    def to_dict(self):
        return {"id": self.id, "code": self.code, "name": self.name,
                "address": self.address, "active": self.is_active}


user_branches = db.Table(
    "user_branches",
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("branch_id", Integer, ForeignKey("branches.id", ondelete="CASCADE"), primary_key=True),
)


class User(db.Model):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    name = Column(String(160), nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False)          # 'admin' | 'supervisor'
    is_active = Column(Boolean, nullable=False, default=True)
    last_login_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    branches = relationship("Branch", secondary=user_branches, lazy="joined")

    __table_args__ = (
        CheckConstraint("role IN ('admin','supervisor')", name="ck_users_role"),
    )

    # -- password handling -------------------------------------------------
    def set_password(self, raw: str) -> None:
        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw: str) -> bool:
        return check_password_hash(self.password_hash, raw)

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def branch_codes(self):
        """Admins implicitly see every branch."""
        if self.is_admin:
            return [b.code for b in Branch.query.filter_by(is_active=True).all()]
        return [b.code for b in self.branches if b.is_active]

    def to_dict(self):
        return {"id": self.id, "username": self.username, "name": self.name,
                "role": self.role, "active": self.is_active,
                "branches": self.branch_codes()}


# --------------------------------------------------------------------------
# Daily operations
# --------------------------------------------------------------------------
class DailyEntry(db.Model):
    __tablename__ = "daily_entries"

    id = Column(String(32), primary_key=True, default=_uuid)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"), nullable=False)
    category = Column(String(16), nullable=False)      # 'broiler' | 'parents'
    business_date = Column(Date, nullable=False)
    entered_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    # -- opening ----------------------------------------------------------
    open_birds = Column(Integer, nullable=False, default=0)
    open_weight_g = Column(Integer, nullable=False, default=0)
    open_meat_g = Column(Integer, nullable=False, default=0)
    open_rate = Column(Numeric(12, 2), nullable=False, default=0)   # admin only

    # -- selling rates -----------------------------------------------------
    rate_skin = Column(Numeric(12, 2), nullable=False, default=0)
    rate_skinless = Column(Numeric(12, 2), nullable=False, default=0)
    rate_liver = Column(Numeric(12, 2), nullable=False, default=0)
    rate_live = Column(Numeric(12, 2), nullable=False, default=0)

    # -- live retail sales -------------------------------------------------
    live_sold_count = Column(Integer, nullable=False, default=0)
    live_sold_weight_g = Column(Integer, nullable=False, default=0)
    cutting_charges = Column(Numeric(12, 2), nullable=False, default=0)

    # -- mortality & damage ------------------------------------------------
    mortality_count = Column(Integer, nullable=False, default=0)
    mortality_weight_g = Column(Integer, nullable=False, default=0)
    damage_meat_g = Column(Integer, nullable=False, default=0)

    # -- dressing ----------------------------------------------------------
    dressed_count = Column(Integer, nullable=False, default=0)
    dressed_weight_g = Column(Integer, nullable=False, default=0)
    actual_meat_g = Column(Integer, nullable=False, default=0)

    # -- meat sales --------------------------------------------------------
    skin_sold_g = Column(Integer, nullable=False, default=0)
    skinless_sold_g = Column(Integer, nullable=False, default=0)
    liver_sold_g = Column(Integer, nullable=False, default=0)

    # -- closing -----------------------------------------------------------
    close_birds = Column(Integer, nullable=False, default=0)
    close_weight_g = Column(Integer, nullable=False, default=0)
    close_meat_g = Column(Integer, nullable=False, default=0)

    notes = Column(Text)
    explanation = Column(Text)

    # -- workflow ----------------------------------------------------------
    status = Column(String(16), nullable=False, default="draft")
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    updated_at = Column(DateTime(timezone=True), onupdate=utcnow)
    reviewed_by_id = Column(Integer, ForeignKey("users.id"))
    reviewed_at = Column(DateTime(timezone=True))
    reject_reason = Column(Text)

    branch = relationship("Branch", back_populates="entries")
    created_by = relationship("User", foreign_keys=[created_by_id])
    reviewed_by = relationship("User", foreign_keys=[reviewed_by_id])
    purchases = relationship("Purchase", back_populates="entry",
                             cascade="all, delete-orphan", order_by="Purchase.id")
    photos = relationship("MortalityPhoto", back_populates="entry",
                          cascade="all, delete-orphan", order_by="MortalityPhoto.id")
    # ordered by line_no, NOT by id: the primary key is a random uuid, so
    # ordering by it would shuffle the rows and break the client's index-based
    # match between a form row and its computed figures
    hotel_sales = relationship("CustomerSale", back_populates="entry",
                               cascade="all, delete-orphan",
                               order_by="CustomerSale.line_no")

    __table_args__ = (
        UniqueConstraint("branch_id", "category", "business_date",
                         name="uq_entry_branch_category_date"),
        CheckConstraint("category IN ('broiler','parents')", name="ck_entry_category"),
        CheckConstraint("status IN ('draft','pending','approved','rejected')",
                        name="ck_entry_status"),
        Index("ix_entry_branch_date", "branch_id", "business_date"),
        Index("ix_entry_status", "status"),
    )

    def to_dict(self, include_costs: bool = True, include_photos: bool = True):
        """
        `include_photos=False` leaves the base64 JPEGs out and sends only a
        count. A list of 2,000 entries each carrying a 50 KB photo is a 100 MB
        response; the browser fetches the images only when an entry is opened.
        """
        d = {
            "id": self.id,
            "branch": self.branch.code,
            "category": self.category,
            "datetime": f"{self.business_date.isoformat()}T{self.entered_at.strftime('%H:%M')}",
            "businessDate": self.business_date.isoformat(),
            "openBirds": self.open_birds,
            "openWtG": self.open_weight_g,
            "openMeatG": self.open_meat_g,
            "rateSkin": float(self.rate_skin),
            "rateSkinless": float(self.rate_skinless),
            "rateLiver": float(self.rate_liver),
            "rateLive": float(self.rate_live),
            "liveSoldCount": self.live_sold_count,
            "liveSoldWtG": self.live_sold_weight_g,
            "cutCharges": float(self.cutting_charges),
            "mortCount": self.mortality_count,
            "mortWtG": self.mortality_weight_g,
            "damageG": self.damage_meat_g,
            "dressedCount": self.dressed_count,
            "dressedWtG": self.dressed_weight_g,
            "actualMeatG": self.actual_meat_g,
            "skinSoldG": self.skin_sold_g,
            "skinlessSoldG": self.skinless_sold_g,
            "liverSoldG": self.liver_sold_g,
            "closeBirds": self.close_birds,
            "closeWtG": self.close_weight_g,
            "closeMeatG": self.close_meat_g,
            "notes": self.notes or "",
            "explanation": self.explanation or "",
            "status": self.status,
            "createdBy": self.created_by_id,
            "createdByName": self.created_by.name if self.created_by else "",
            "reviewedBy": self.reviewed_by_id,
            "reviewedByName": self.reviewed_by.name if self.reviewed_by else "",
            "reviewedAt": self.reviewed_at.isoformat() if self.reviewed_at else None,
            "rejectReason": self.reject_reason or "",
            "photoCount": len(self.photos),
            "photosLoaded": include_photos,
            "purchases": [p.to_dict(include_costs) for p in self.purchases],
            "hotelSales": [s.to_dict() for s in self.hotel_sales],
        }
        d["photos"] = [p.data_url for p in self.photos] if include_photos else []
        # Buying prices are admin-only; strip them for supervisors.
        d["openRate"] = float(self.open_rate) if include_costs else 0
        return d


class Purchase(db.Model):
    """
    Birds bought in on a given day. Several suppliers per day are allowed.

    A row can also represent birds RETURNED to a supplier (kind='return') —
    e.g. birds bought yesterday that turned out unfit and were handed back.
    A return always points back at the original 'buy' row via return_of_id,
    and is priced at THAT row's rate (never a new one), so the supplier
    purchase ledger nets out correctly. Returns are excluded from
    compute_entry()'s bird/weight/cost totals — they only affect the
    ledger, not the day's own stock or P&L math.
    """
    __tablename__ = "purchases"

    id = Column(Integer, primary_key=True)
    entry_id = Column(String(32), ForeignKey("daily_entries.id", ondelete="CASCADE"),
                      nullable=False, index=True)
    supplier = Column(String(160))
    batch_no = Column(String(64))
    birds = Column(Integer, nullable=False, default=0)
    weight_g = Column(Integer, nullable=False, default=0)
    rate = Column(Numeric(12, 2), nullable=False, default=0)   # admin fills at approval
    kind = Column(String(10), nullable=False, default="buy")   # 'buy' | 'return'
    return_of_id = Column(Integer, ForeignKey("purchases.id"), nullable=True)

    entry = relationship("DailyEntry", back_populates="purchases")
    return_of = relationship("Purchase", remote_side=[id])

    def to_dict(self, include_costs: bool = True):
        return {"id": self.id, "supplier": self.supplier or "", "batch": self.batch_no or "",
                "birds": self.birds, "wtG": self.weight_g,
                "rate": float(self.rate) if include_costs else 0,
                "kind": self.kind or "buy", "returnOf": self.return_of_id}


class MortalityPhoto(db.Model):
    __tablename__ = "mortality_photos"

    id = Column(Integer, primary_key=True)
    entry_id = Column(String(32), ForeignKey("daily_entries.id", ondelete="CASCADE"),
                      nullable=False, index=True)
    # DEFERRED on purpose. Counting the photos on an entry must not drag ~50 KB
    # of base64 per row off the disk; the column is loaded only when something
    # actually reads data_url.
    data_url = deferred(Column(Text, nullable=False))
    uploaded_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    entry = relationship("DailyEntry", back_populates="photos")


# --------------------------------------------------------------------------
# Hotels & hostels — contract buyers priced off the day's market rate
#
# A hotel does not pay the counter price. The shop agrees a concession, e.g.
# "fifty rupees under market for skinless", and that is what gets billed. Both
# figures are kept on every sale line — the market rate of the day and the rate
# actually charged — so the discount handed out is always visible and can be
# added up, rather than silently disappearing into a lower revenue number.
#
# Each customer belongs to ONE branch and carries its own ledger.
# --------------------------------------------------------------------------
PRODUCT_KINDS = ("skin", "skinless", "liver", "live")
CUSTOMER_KINDS = ("hotel", "hostel", "function")


class Customer(db.Model):
    __tablename__ = "customers"

    id = Column(String(32), primary_key=True, default=_uuid)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    code = Column(String(16), nullable=False)
    name = Column(String(160), nullable=False)
    # 'hotel' | 'hostel' | 'function'  (function = marriage party, bulk order)
    kind = Column(String(16), nullable=False, default="hotel")
    contact_person = Column(String(160))
    phone = Column(String(32))
    address = Column(Text)

    # How this customer's price is worked out:
    #   'less'  — today's market rate, adjusted by less_* (the usual deal).
    #             Positive is a concession (they pay below market); negative
    #             flips it into a premium (they pay above market) — same
    #             field, either direction, still tied to today's rate.
    #   'fixed' — a flat contract rate, whatever the market does
    price_mode = Column(String(8), nullable=False, default="less")
    less_skin = Column(Numeric(12, 2), nullable=False, default=0)
    less_skinless = Column(Numeric(12, 2), nullable=False, default=0)
    less_liver = Column(Numeric(12, 2), nullable=False, default=0)
    less_live = Column(Numeric(12, 2), nullable=False, default=0)
    rate_skin = Column(Numeric(12, 2), nullable=False, default=0)
    rate_skinless = Column(Numeric(12, 2), nullable=False, default=0)
    rate_liver = Column(Numeric(12, 2), nullable=False, default=0)
    rate_live = Column(Numeric(12, 2), nullable=False, default=0)

    # What they already owed on the day they were added to the system.
    opening_balance = Column(Numeric(14, 2), nullable=False, default=0)

    is_active = Column(Boolean, nullable=False, default=True)
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    branch = relationship("Branch", back_populates="customers")
    sales = relationship("CustomerSale", back_populates="customer",
                         cascade="all, delete-orphan")
    payments = relationship("CustomerPayment", back_populates="customer",
                            cascade="all, delete-orphan")
    adjustments = relationship("CustomerAdjustment", back_populates="customer",
                               cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("branch_id", "code", name="uq_customer_branch_code"),
        CheckConstraint("kind IN ('hotel','hostel','function')", name="ck_customer_kind"),
        CheckConstraint("price_mode IN ('less','fixed')", name="ck_customer_price_mode"),
        Index("ix_customer_branch_active", "branch_id", "is_active"),
    )

    def less_for(self, product: str) -> float:
        return float({"skin": self.less_skin, "skinless": self.less_skinless,
                      "liver": self.less_liver, "live": self.less_live}.get(product, 0) or 0)

    def fixed_for(self, product: str) -> float:
        return float({"skin": self.rate_skin, "skinless": self.rate_skinless,
                      "liver": self.rate_liver, "live": self.rate_live}.get(product, 0) or 0)

    def to_dict(self):
        return {
            "id": self.id, "branch": self.branch.code, "code": self.code,
            "name": self.name, "kind": self.kind,
            "contact": self.contact_person or "", "phone": self.phone or "",
            "address": self.address or "",
            "mode": self.price_mode,
            "lessSkin": float(self.less_skin), "lessSkinless": float(self.less_skinless),
            "lessLiver": float(self.less_liver), "lessLive": float(self.less_live),
            "rateSkin": float(self.rate_skin), "rateSkinless": float(self.rate_skinless),
            "rateLiver": float(self.rate_liver), "rateLive": float(self.rate_live),
            "openingBalance": float(self.opening_balance),
            "active": self.is_active,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


class CustomerSale(db.Model):
    """
    One product line sold to one hotel or hostel on one daily entry.

    `market_rate`, `rate` and `amount` are snapshots recomputed by the server
    every time the entry is saved, so a report never has to reload the entry to
    know what was charged, and the admin changing the day's market rate flows
    straight through to the bill.
    """
    __tablename__ = "customer_sales"

    id = Column(String(32), primary_key=True, default=_uuid)
    entry_id = Column(String(32), ForeignKey("daily_entries.id", ondelete="CASCADE"),
                      nullable=False, index=True)
    customer_id = Column(String(32), ForeignKey("customers.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"), nullable=False)

    line_no = Column(Integer, nullable=False, default=0)  # position on the form
    product = Column(String(16), nullable=False)   # skin | skinless | liver | live
    weight_g = Column(Integer, nullable=False, default=0)
    # live birds only: how many head went out. A live sale comes off the bird
    # stock, not the meat pool, so the balance needs the count as well as the
    # weight. Zero for the three meat products.
    birds = Column(Integer, nullable=False, default=0)
    market_rate = Column(Numeric(12, 2), nullable=False, default=0)
    rate = Column(Numeric(12, 2), nullable=False, default=0)
    rate_override = Column(Numeric(12, 2))                # NULL = derived from the deal
    amount = Column(Numeric(14, 2), nullable=False, default=0)
    # True  -> paid in cash on the day, settles immediately
    # False -> on account, adds to what the customer owes
    settled = Column(Boolean, nullable=False, default=False)
    note = Column(Text)

    entry = relationship("DailyEntry", back_populates="hotel_sales")
    customer = relationship("Customer", back_populates="sales")

    __table_args__ = (
        CheckConstraint("product IN ('skin','skinless','liver','live')",
                        name="ck_sale_product"),
        Index("ix_sale_customer", "customer_id"),
        Index("ix_sale_branch", "branch_id"),
    )

    def to_dict(self):
        c = self.customer
        return {
            "id": self.id,
            "customerId": self.customer_id,
            "customerName": c.name if c else "",
            "customerCode": c.code if c else "",
            "kind": c.kind if c else "hotel",
            "product": self.product,
            "weightG": self.weight_g,
            "birds": self.birds,
            "marketRate": float(self.market_rate),
            "rate": float(self.rate),
            "rateOverride": float(self.rate_override) if self.rate_override is not None else None,
            "amount": float(self.amount),
            "settled": self.settled,
            "note": self.note or "",
            # the deal itself, so the browser can reprice while the user types
            "mode": c.price_mode if c else "less",
            "less": c.less_for(self.product) if c else 0,
            "fixed": c.fixed_for(self.product) if c else 0,
        }


class CustomerPayment(db.Model):
    """Money received from a hotel or hostel against its outstanding balance."""
    __tablename__ = "customer_payments"

    id = Column(String(32), primary_key=True, default=_uuid)
    customer_id = Column(String(32), ForeignKey("customers.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"), nullable=False)
    pay_date = Column(Date, nullable=False, index=True)
    amount = Column(Numeric(14, 2), nullable=False, default=0)
    mode = Column(String(16), nullable=False, default="cash")
    note = Column(Text)
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    customer = relationship("Customer", back_populates="payments")
    branch = relationship("Branch")

    __table_args__ = (
        CheckConstraint("mode IN ('cash','upi','bank','cheque')", name="ck_payment_mode"),
        Index("ix_payment_customer_date", "customer_id", "pay_date"),
    )

    def to_dict(self):
        return {"id": self.id, "customerId": self.customer_id,
                "branch": self.branch.code if self.branch else "",
                "date": self.pay_date.isoformat(), "amount": float(self.amount),
                "mode": self.mode, "note": self.note or ""}


class CustomerAdjustment(db.Model):
    """
    An admin-only manual correction to what a hotel/hostel/function customer
    has been billed — not tied to any sale line. Positive raises the bill,
    negative lowers it (e.g. a mischarge found after the day was approved, or
    a goodwill write-off).

    Unlike Worker.balance_adjustment (a dateless running-total correction),
    this carries a `business_date` and a `settled` flag, the same two things
    a CustomerSale line has, because the request was for this to also move
    that specific day's Day Close and Dashboard profit — not just the
    customer's ledger balance. `settled=True` behaves like a cash hotel sale
    (moves that day's expected cash); `settled=False` behaves like an
    on-account sale (only changes the running balance).
    """
    __tablename__ = "customer_adjustments"

    id = Column(String(32), primary_key=True, default=_uuid)
    customer_id = Column(String(32), ForeignKey("customers.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"), nullable=False)
    business_date = Column(Date, nullable=False, index=True)
    amount = Column(Numeric(14, 2), nullable=False, default=0)   # signed
    settled = Column(Boolean, nullable=False, default=False)
    note = Column(Text)
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    customer = relationship("Customer", back_populates="adjustments")
    branch = relationship("Branch")

    __table_args__ = (
        Index("ix_adjustment_customer_date", "customer_id", "business_date"),
        Index("ix_adjustment_branch_date", "branch_id", "business_date"),
    )

    def to_dict(self):
        return {"id": self.id, "customerId": self.customer_id,
                "customerName": self.customer.name if self.customer else "",
                "branch": self.branch.code if self.branch else "",
                "date": self.business_date.isoformat(), "amount": float(self.amount),
                "settled": self.settled, "note": self.note or ""}


# --------------------------------------------------------------------------
# Labour
# --------------------------------------------------------------------------
class Worker(db.Model):
    __tablename__ = "workers"

    id = Column(String(32), primary_key=True, default=_uuid)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    name = Column(String(160), nullable=False)
    role = Column(String(32), nullable=False, default="dresser")
    day_wage = Column(Numeric(12, 2), nullable=False, default=0)
    phone = Column(String(32))
    joined_on = Column(Date, default=date.today)
    is_active = Column(Boolean, nullable=False, default=True)

    # An admin-only correction folded into the balance-due figure — earned
    # minus paid minus advances is worked out from the ledger as always, this
    # is added on top of that. Positive raises what the worker is owed
    # (a missed wage that never got logged), negative lowers it (a write-off,
    # a cash-box shortage taken out of what's due). Kept as one running figure
    # with a note, rather than a ledger kind, so it needs no schema change to
    # the ledger's ck_ledger_kind check constraint on a live database.
    balance_adjustment = Column(Numeric(12, 2), nullable=False, default=0)
    balance_note = Column(Text)

    branch = relationship("Branch", back_populates="workers")
    ledger = relationship("LabourLedger", back_populates="worker",
                          cascade="all, delete-orphan")

    def to_dict(self):
        return {"id": self.id, "branch": self.branch.code, "name": self.name,
                "role": self.role, "dayWage": float(self.day_wage),
                "phone": self.phone or "", "active": self.is_active,
                "joinedOn": self.joined_on.isoformat() if self.joined_on else None,
                "balanceAdjustment": float(self.balance_adjustment),
                "balanceNote": self.balance_note or ""}


class LabourLedger(db.Model):
    """
    One row per labour event.
      work    -> worker earned a day (adds to balance, is a shop cost)
      paid    -> money handed over  (reduces balance, not an extra cost)
      advance -> money handed over  (reduces balance, not an extra cost)
      tea / tiffin / other -> shop pays, never deducted from the worker
    """
    __tablename__ = "labour_ledger"

    id = Column(String(32), primary_key=True, default=_uuid)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    worker_id = Column(String(32), ForeignKey("workers.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    entry_date = Column(Date, nullable=False, index=True)
    kind = Column(String(16), nullable=False)
    days = Column(Numeric(4, 2), nullable=False, default=0)
    amount = Column(Numeric(12, 2), nullable=False, default=0)
    note = Column(Text)
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    worker = relationship("Worker", back_populates="ledger")
    branch = relationship("Branch")

    __table_args__ = (
        CheckConstraint("kind IN ('work','paid','advance','tea','tiffin','other')",
                        name="ck_ledger_kind"),
        # Attendance is one row per worker per day, so re-marking replaces it.
        # Payments, advances, tea and tiffin legitimately repeat within a day,
        # so the uniqueness is a PARTIAL index limited to 'work'.
        Index("uq_ledger_work_day", "worker_id", "entry_date", unique=True,
              postgresql_where=text("kind = 'work'"),
              sqlite_where=text("kind = 'work'")),
        Index("ix_ledger_branch_date", "branch_id", "entry_date"),
    )

    def to_dict(self):
        return {"id": self.id, "branch": self.branch.code, "workerId": self.worker_id,
                "date": self.entry_date.isoformat(), "type": self.kind,
                "days": float(self.days), "amount": float(self.amount),
                "note": self.note or ""}


# --------------------------------------------------------------------------
# Overheads
#
# Two shapes, because shops have two kinds of cost:
#   * spend_date SET   — a one-off spent on a day (a repair, a delivery
#                        charge). Charged in full to that day.
#   * spend_date NULL  — a standing monthly cost (rent, power, salary).
#                        Spread evenly across the days of the month, so no
#                        single day carries the whole rent.
# --------------------------------------------------------------------------
class Overhead(db.Model):
    __tablename__ = "overheads"

    id = Column(String(32), primary_key=True, default=_uuid)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    period_month = Column(String(7), nullable=False, index=True)     # 'YYYY-MM'
    spend_date = Column(Date, index=True)          # NULL = spread over the month
    category = Column(String(40), nullable=False)
    amount = Column(Numeric(14, 2), nullable=False, default=0)
    note = Column(Text)

    status = Column(String(16), nullable=False, default="pending")
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    reviewed_by_id = Column(Integer, ForeignKey("users.id"))
    reviewed_at = Column(DateTime(timezone=True))
    reject_reason = Column(Text)

    branch = relationship("Branch", back_populates="overheads")
    created_by = relationship("User", foreign_keys=[created_by_id])
    reviewed_by = relationship("User", foreign_keys=[reviewed_by_id])

    __table_args__ = (
        CheckConstraint("status IN ('pending','approved','rejected')",
                        name="ck_overhead_status"),
        Index("ix_overhead_branch_month", "branch_id", "period_month"),
    )

    def to_dict(self):
        return {"id": self.id, "branch": self.branch.code, "month": self.period_month,
                "date": self.spend_date.isoformat() if self.spend_date else None,
                "dated": self.spend_date is not None,
                "category": self.category, "amount": float(self.amount),
                "note": self.note or "", "status": self.status,
                "createdBy": self.created_by_id,
                "createdByName": self.created_by.name if self.created_by else "",
                "reviewedBy": self.reviewed_by_id,
                "rejectReason": self.reject_reason or ""}


# --------------------------------------------------------------------------
# End-of-day cash handover
#
# At close the supervisor hands the day's takings to management — part cash,
# part PhonePe. This records what was declared and lets it be set against what
# the day's trading says should have been collected, so a shortfall surfaces
# the same evening rather than at month end.
# --------------------------------------------------------------------------
class DayClose(db.Model):
    __tablename__ = "day_close"

    id = Column(String(32), primary_key=True, default=_uuid)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    business_date = Column(Date, nullable=False, index=True)

    cash_amount = Column(Numeric(14, 2), nullable=False, default=0)
    upi_amount = Column(Numeric(14, 2), nullable=False, default=0)
    # what the server worked out was collectable, frozen at declaration time so
    # the handover can still be read back even if a later edit moves the figures
    expected_amount = Column(Numeric(14, 2), nullable=False, default=0)
    note = Column(Text)

    # -- meat-sales auto-adjustment -----------------------------------------
    # cash + UPI + that day's wages + that day's overheads is compared against
    # the day's recorded revenue. Whatever they differ by is credited or taken
    # off the meat sale on `meat_adjust_entry_id` (extra cash in means extra
    # meat must have gone out; short cash means recorded sales overstate what
    # actually came in). Kept here so re-declaring the same day can undo the
    # old adjustment before applying a new one, instead of stacking.
    meat_adjust_entry_id = Column(String(32), ForeignKey("daily_entries.id", ondelete="SET NULL"))
    meat_adjust_g = Column(Integer, nullable=False, default=0)          # signed: + credited, - removed
    meat_adjust_amount = Column(Numeric(14, 2), nullable=False, default=0)  # signed, same sense

    declared_by_id = Column(Integer, ForeignKey("users.id"))
    declared_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    verified_by_id = Column(Integer, ForeignKey("users.id"))
    verified_at = Column(DateTime(timezone=True))

    branch = relationship("Branch")
    declared_by = relationship("User", foreign_keys=[declared_by_id])
    verified_by = relationship("User", foreign_keys=[verified_by_id])
    meat_adjust_entry = relationship("DailyEntry", foreign_keys=[meat_adjust_entry_id])

    __table_args__ = (
        UniqueConstraint("branch_id", "business_date", name="uq_dayclose_branch_date"),
        Index("ix_dayclose_branch_date", "branch_id", "business_date"),
    )

    def to_dict(self):
        cash, upi = float(self.cash_amount), float(self.upi_amount)
        # self.branch can be gone if the branch itself was later deleted —
        # Branch has no ORM-level cascade onto DayClose (unlike DailyEntry/
        # Worker/Overhead/Customer, which all are), so on a database that
        # doesn't enforce the FK's own ON DELETE CASCADE (SQLite in dev/test;
        # Postgres in production does) a handover can outlive its branch.
        # Guarded the same way CustomerPayment/CustomerAdjustment already are.
        return {"id": self.id, "branch": self.branch.code if self.branch else "",
                "date": self.business_date.isoformat(),
                "cash": cash, "upi": upi, "declared": cash + upi,
                "expectedAtDeclaration": float(self.expected_amount),
                "note": self.note or "",
                "meatAdjustEntryId": self.meat_adjust_entry_id,
                "meatAdjustG": self.meat_adjust_g,
                "meatAdjustAmount": float(self.meat_adjust_amount),
                "declaredBy": self.declared_by_id,
                "declaredByName": self.declared_by.name if self.declared_by else "",
                "declaredAt": self.declared_at.isoformat() if self.declared_at else None,
                "verifiedBy": self.verified_by_id,
                "verifiedByName": self.verified_by.name if self.verified_by else "",
                "verifiedAt": self.verified_at.isoformat() if self.verified_at else None}


# --------------------------------------------------------------------------
# Settings & audit
# --------------------------------------------------------------------------
class Setting(db.Model):
    """Single-row key/value store so waste % and tolerances stay configurable."""
    __tablename__ = "settings"

    key = Column(String(64), primary_key=True)
    value = Column(String(255), nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class ActivityLog(db.Model):
    __tablename__ = "activity_log"

    id = Column(Integer, primary_key=True)
    at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    user_name = Column(String(160))
    role = Column(String(20))
    branch_code = Column(String(16))
    action = Column(String(80), nullable=False, index=True)
    detail = Column(Text)
    ip_address = Column(String(64))

    def to_dict(self):
        return {"id": self.id, "at": self.at.isoformat(),
                "userName": self.user_name or "(anonymous)", "role": self.role or "-",
                "branch": self.branch_code or "-", "action": self.action,
                "detail": self.detail or "", "ip": self.ip_address or ""}
