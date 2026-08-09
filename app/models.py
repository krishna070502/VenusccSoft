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
from sqlalchemy.orm import relationship
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

    __table_args__ = (
        UniqueConstraint("branch_id", "category", "business_date",
                         name="uq_entry_branch_category_date"),
        CheckConstraint("category IN ('broiler','parents')", name="ck_entry_category"),
        CheckConstraint("status IN ('draft','pending','approved','rejected')",
                        name="ck_entry_status"),
        Index("ix_entry_branch_date", "branch_id", "business_date"),
        Index("ix_entry_status", "status"),
    )

    def to_dict(self, include_costs: bool = True):
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
            "photos": [p.data_url for p in self.photos],
            "purchases": [p.to_dict(include_costs) for p in self.purchases],
        }
        # Buying prices are admin-only; strip them for supervisors.
        d["openRate"] = float(self.open_rate) if include_costs else 0
        return d


class Purchase(db.Model):
    """Birds bought in on a given day. Several suppliers per day are allowed."""
    __tablename__ = "purchases"

    id = Column(Integer, primary_key=True)
    entry_id = Column(String(32), ForeignKey("daily_entries.id", ondelete="CASCADE"),
                      nullable=False, index=True)
    supplier = Column(String(160))
    batch_no = Column(String(64))
    birds = Column(Integer, nullable=False, default=0)
    weight_g = Column(Integer, nullable=False, default=0)
    rate = Column(Numeric(12, 2), nullable=False, default=0)   # admin fills at approval

    entry = relationship("DailyEntry", back_populates="purchases")

    def to_dict(self, include_costs: bool = True):
        return {"supplier": self.supplier or "", "batch": self.batch_no or "",
                "birds": self.birds, "wtG": self.weight_g,
                "rate": float(self.rate) if include_costs else 0}


class MortalityPhoto(db.Model):
    __tablename__ = "mortality_photos"

    id = Column(Integer, primary_key=True)
    entry_id = Column(String(32), ForeignKey("daily_entries.id", ondelete="CASCADE"),
                      nullable=False, index=True)
    data_url = Column(Text, nullable=False)          # base64 JPEG, ~50 KB each
    uploaded_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    entry = relationship("DailyEntry", back_populates="photos")


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

    branch = relationship("Branch", back_populates="workers")
    ledger = relationship("LabourLedger", back_populates="worker",
                          cascade="all, delete-orphan")

    def to_dict(self):
        return {"id": self.id, "branch": self.branch.code, "name": self.name,
                "role": self.role, "dayWage": float(self.day_wage),
                "phone": self.phone or "", "active": self.is_active,
                "joinedOn": self.joined_on.isoformat() if self.joined_on else None}


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
# Monthly overheads — deliberately kept out of the daily P&L
# --------------------------------------------------------------------------
class Overhead(db.Model):
    __tablename__ = "overheads"

    id = Column(String(32), primary_key=True, default=_uuid)
    branch_id = Column(Integer, ForeignKey("branches.id", ondelete="CASCADE"),
                       nullable=False, index=True)
    period_month = Column(String(7), nullable=False, index=True)     # 'YYYY-MM'
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
                "category": self.category, "amount": float(self.amount),
                "note": self.note or "", "status": self.status,
                "createdBy": self.created_by_id,
                "createdByName": self.created_by.name if self.created_by else "",
                "reviewedBy": self.reviewed_by_id,
                "rejectReason": self.reject_reason or ""}


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
