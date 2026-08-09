"""Demo dataset — the same 14-day sample the browser version generated."""

import random
from datetime import date, timedelta
from decimal import Decimal

from .extensions import db
from .models import (Branch, DailyEntry, LabourLedger, Overhead, Purchase,
                     User, Worker, utcnow)

SUPPLIERS = ["Sunrise Poultry", "Green Valley", "Deccan Agro"]
WORKER_NAMES = [("Suresh", "dresser"), ("Mahesh", "dresser"),
                ("Anil", "cutter"), ("Vikram", "cutter")]


def load_demo(admin: User) -> dict:
    """Wipes operational data and rebuilds a plausible fortnight."""
    supervisor = User.query.filter_by(role="supervisor").first() or admin

    Overhead.query.delete()
    LabourLedger.query.delete()
    Worker.query.delete()
    DailyEntry.query.delete()
    db.session.flush()

    today = date.today()
    branches = Branch.query.filter_by(is_active=True).all()
    made = {"entries": 0, "workers": 0, "ledger": 0, "overheads": 0}

    # ---- labour ---------------------------------------------------------
    for br in branches:
        for name, role in WORKER_NAMES:
            w = Worker(branch_id=br.id, name=f"{name} ({br.code})", role=role,
                       day_wage=Decimal("650" if role == "dresser" else "600"),
                       joined_on=today - timedelta(days=30))
            db.session.add(w)
            db.session.flush()
            made["workers"] += 1
            for i in range(13, -1, -1):
                if random.random() < 0.12:
                    continue
                d = today - timedelta(days=i)
                days = Decimal("0.5") if random.random() < 0.1 else Decimal("1")
                db.session.add(LabourLedger(
                    branch_id=br.id, worker_id=w.id, entry_date=d, kind="work",
                    days=days, amount=Decimal(w.day_wage) * days,
                    note="Half day" if days == Decimal("0.5") else "Full day",
                    created_by_id=supervisor.id))
                made["ledger"] += 1
                if i % 7 == 0:
                    db.session.add(LabourLedger(
                        branch_id=br.id, worker_id=w.id, entry_date=d, kind="paid",
                        amount=Decimal(w.day_wage) * 5, note="Weekly settlement",
                        created_by_id=supervisor.id))
                    made["ledger"] += 1
                if i % 3 == 0:
                    db.session.add(LabourLedger(
                        branch_id=br.id, worker_id=w.id, entry_date=d, kind="tea",
                        amount=Decimal("30"), note="Morning tea",
                        created_by_id=supervisor.id))
                    made["ledger"] += 1

        # ---- monthly overheads ------------------------------------------
        month = today.strftime("%Y-%m")
        for cat, amt in [("rent", 25000), ("electricity", 8400), ("supervisor_salary", 22000)]:
            db.session.add(Overhead(branch_id=br.id, period_month=month, category=cat,
                                    amount=Decimal(amt), note="Demo data",
                                    status="approved", created_by_id=supervisor.id,
                                    reviewed_by_id=admin.id, reviewed_at=utcnow()))
            made["overheads"] += 1

    # ---- daily entries --------------------------------------------------
    for br in branches:
        for cat in ("broiler", "parents"):
            avg = 2600 if cat == "parents" else 2050
            waste = 21 if cat == "parents" else 31
            yf = (100 - waste) / 100
            open_b, open_w = 80, 80 * avg
            open_m, open_rate = random.randint(0, 6000), 135 if cat == "parents" else 120

            for i in range(13, -1, -1):
                d = today - timedelta(days=i)
                buy_b = random.randint(180, 320)
                buy_w = int(buy_b * avg * random.uniform(0.96, 1.04))
                buy_rate = round(open_rate * random.uniform(0.97, 1.06), 2)

                avail_w = open_w + buy_w
                avail_v = open_w / 1000 * open_rate + buy_w / 1000 * buy_rate
                avg_rate = avail_v / (avail_w / 1000)

                mort_c = random.randint(0, 4)
                live_c = int((open_b + buy_b) * random.uniform(0.16, 0.26))
                dr_c = int((open_b + buy_b - live_c - mort_c) * random.uniform(0.55, 0.80))
                dr_w = dr_c * avg
                y = yf + random.uniform(-0.045, 0.025)
                if random.random() < 0.15:
                    y -= 0.045
                meat = int(dr_w * y)
                close_b = open_b + buy_b - live_c - mort_c - dr_c
                sell_mul = random.uniform(1.55, 1.80)
                r_skin = round(avg_rate * sell_mul)
                skin = int((open_m + meat) * random.uniform(0.42, 0.62))
                skinless = int((open_m + meat - skin) * random.uniform(0.55, 0.85))
                liver = dr_c * 35
                dmg = random.randint(0, 900)
                close_m = max(open_m + meat - skin - skinless - liver - dmg, 0)
                status = "approved" if i > 1 else ("pending" if i == 1 else "draft")

                e = DailyEntry(
                    branch_id=br.id, category=cat, business_date=d,
                    open_birds=open_b, open_weight_g=open_w, open_meat_g=open_m,
                    open_rate=Decimal(str(round(open_rate, 2))),
                    rate_skin=Decimal(str(r_skin)), rate_skinless=Decimal(str(r_skin + 35)),
                    rate_liver=Decimal("130"), rate_live=Decimal(str(round(avg_rate * 1.16))),
                    live_sold_count=live_c, live_sold_weight_g=live_c * avg,
                    cutting_charges=Decimal(str(live_c * 8)),
                    mortality_count=mort_c, mortality_weight_g=mort_c * avg, damage_meat_g=dmg,
                    dressed_count=dr_c, dressed_weight_g=dr_w, actual_meat_g=meat,
                    skin_sold_g=skin, skinless_sold_g=skinless, liver_sold_g=liver,
                    close_birds=close_b, close_weight_g=close_b * avg, close_meat_g=close_m,
                    status=status, created_by_id=supervisor.id,
                    reviewed_by_id=admin.id if status == "approved" else None,
                    reviewed_at=utcnow() if status == "approved" else None,
                )
                e.purchases.append(Purchase(supplier=random.choice(SUPPLIERS),
                                            birds=buy_b, weight_g=buy_w,
                                            rate=Decimal(str(buy_rate))))
                db.session.add(e)
                made["entries"] += 1

                open_b, open_w, open_m, open_rate = close_b, close_b * avg, close_m, avg_rate

    db.session.flush()
    return made
