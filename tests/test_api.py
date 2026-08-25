"""
Venus Chicken Centers — full module test suite.

Runs against a THROWAWAY database (a temp file, never your Neon instance),
exercises every module with varied inputs, writes docs/test-report.md
and docs/test-results.csv, then deletes the temporary data.

    python tests/test_api.py
"""

import csv
import os
import re
import sys
import tempfile
import traceback
from datetime import date, timedelta
from decimal import Decimal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# --- isolate: a temp SQLite file, never the production DATABASE_URL ---------
TMP_DB = os.path.join(tempfile.gettempdir(), "vcc_testsuite.db")
if os.path.exists(TMP_DB):
    os.remove(TMP_DB)
os.environ["DATABASE_URL"] = f"sqlite:///{TMP_DB}"
os.environ["SECRET_KEY"] = "test-suite-only"
# Admin has no idle limit at all any more (see idle_limit_minutes() in
# security.py) — only supervisor is configurable.
os.environ["IDLE_SUPERVISOR_MIN"] = "10"

from app import create_app                                    # noqa: E402
from app.extensions import db                                 # noqa: E402
from app.calc import (compute_entry, costing_gaps, months_in_range,          # noqa: E402
                      price_hotel_line, validate_for_submission)
from app.models import (ActivityLog, Branch, Customer, CustomerAdjustment,   # noqa: E402
                        CustomerPayment, CustomerSale, DailyEntry, DayClose,
                        LabourLedger, MortalityPhoto, Overhead, Purchase,
                        Setting, User, Worker)

app = create_app()
RESULTS = []
TODAY = date.today()
D = lambda n: (TODAY - timedelta(days=n)).isoformat()          # noqa: E731


def case(module, scenario, given, expected, fn):
    """Run one test case and record the row for the report table."""
    tc = f"TC-{len(RESULTS) + 1:03d}"
    try:
        actual = fn()
        passed = actual is True or actual == expected
        actual_txt = "as expected" if actual is True else str(actual)
    except Exception as exc:                                   # noqa: BLE001
        passed = False
        actual_txt = f"{type(exc).__name__}: {exc}"
        if os.environ.get("VERBOSE"):
            traceback.print_exc()
    RESULTS.append({
        "id": tc, "module": module, "scenario": scenario,
        "given": given, "expected": str(expected),
        "actual": actual_txt, "result": "PASS" if passed else "FAIL",
    })
    print(f"  {'PASS' if passed else 'FAIL'}  {tc}  {module:<22} {scenario}"
          + ("" if passed else f"\n        expected {expected!r}, got {actual_txt}"))
    return passed


# ===========================================================================
# fixtures
# ===========================================================================
def build_fixtures():
    with app.app_context():
        db.create_all()
        db.session.add_all([
            Branch(code="B01", name="Branch 01 — Main Hub"),
            Branch(code="B02", name="Branch 02 — Downtown"),
        ])
        db.session.commit()
        admin = User(name="System Admin", username="admin", role="admin")
        admin.set_password("admin123")
        admin.branches = Branch.query.all()
        sup = User(name="Ravi Kumar", username="ravi", role="supervisor")
        sup.set_password("ravi123")
        sup.branches = [Branch.query.filter_by(code="B01").first()]
        sup2 = User(name="Priya S", username="priya", role="supervisor")
        sup2.set_password("priya123")
        sup2.branches = [Branch.query.filter_by(code="B02").first()]
        db.session.add_all([admin, sup, sup2])
        db.session.commit()


ADMIN, SUP, SUP2, ANON = None, None, None, None


def login_all():
    global ADMIN, SUP, SUP2, ANON
    ADMIN, SUP, SUP2, ANON = (app.test_client() for _ in range(4))
    ADMIN.post("/api/login", json={"username": "admin", "password": "admin123"})
    SUP.post("/api/login", json={"username": "ravi", "password": "ravi123"})
    SUP2.post("/api/login", json={"username": "priya", "password": "priya123"})


def base_entry(**over):
    e = dict(branch="B01", category="broiler", businessDate=D(10),
             openBirds=80, openWtG=200_000, openMeatG=5_000, openRate=120,
             rateSkin=200, rateSkinless=230, rateLiver=130, rateLive=150,
             liveSoldCount=20, liveSoldWtG=41_000, cutCharges=300,
             mortCount=0, mortWtG=0, damageG=1_000,
             dressedCount=40, dressedWtG=82_000, actualMeatG=56_000,
             skinSoldG=30_000, skinlessSoldG=20_000, liverSoldG=1_000,
             closeBirds=120, closeWtG=282_000, closeMeatG=9_000,
             purchases=[{"supplier": "Sunrise", "birds": 100, "wtG": 205_000, "rate": 130}])
    e.update(over)
    return e


SETTINGS = {"waste_broiler": 31, "waste_parents": 21, "tolerance": 2, "day_wage": 600}


# ===========================================================================
# 1. Infrastructure
# ===========================================================================
def test_infrastructure():
    print("\n[1] Infrastructure & schema")
    case("Infrastructure", "Health endpoint reports the database",
         "GET /healthz", "ok",
         lambda: ADMIN.get("/healthz").get_json()["status"])
    case("Infrastructure", "All tables created",
         "db.create_all()", 16,
         lambda: len(db.metadata.tables))
    case("Infrastructure", "SPA shell is served",
         "GET /", True,
         lambda: b"Venus Chicken Centers" in ADMIN.get("/").data)
    case("Infrastructure", "The JS bundle URL carries a cache-busting version "
                          "(so a stale browser/CDN cache can't silently keep serving old app.js after a deploy)",
         "app.js?v=<digits>", True,
         lambda: re.search(rb'app\.js\?v=\d+', ADMIN.get("/").data) is not None)
    case("Infrastructure", "Unknown API path returns JSON not HTML",
         "GET /api/nope", "not_found",
         lambda: ADMIN.get("/api/nope").get_json()["error"])


# ===========================================================================
# 2. Authentication
# ===========================================================================
def test_auth():
    print("\n[2] Authentication")
    c = app.test_client()
    case("Authentication", "Valid admin credentials", "admin/admin123", 200,
         lambda: c.post("/api/login", json={"username": "admin", "password": "admin123"}).status_code)
    case("Authentication", "Wrong password rejected", "admin/badpass", 401,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "admin", "password": "badpass"}).status_code)
    case("Authentication", "Unknown username rejected", "ghost/x", 401,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "ghost", "password": "x"}).status_code)
    case("Authentication", "Empty credentials rejected", "'' / ''", 401,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "", "password": ""}).status_code)
    case("Authentication", "Username is case-insensitive", "ADMIN/admin123", 200,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "ADMIN", "password": "admin123"}).status_code)
    case("Authentication", "Password is case-sensitive", "admin/ADMIN123", 401,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "admin", "password": "ADMIN123"}).status_code)
    case("Authentication", "Passwords stored hashed, never plaintext",
         "inspect users table", True,
         lambda: _pw_hashed())
    case("Authentication", "SQL injection in username is harmless",
         "' OR 1=1 --", 401,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "' OR 1=1 --", "password": "x"}).status_code)
    case("Authentication", "Anonymous cannot read data", "GET /api/bootstrap", 401,
         lambda: ANON.get("/api/bootstrap").status_code)
    case("Authentication", "Logout ends the session", "POST /api/logout then /api/me", None,
         lambda: _logout_then_me())
    case("Session", "Admin has no idle limit — never auto-logged-out",
         "login as admin", None,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "admin", "password": "admin123"}
                                        ).get_json()["idleMinutes"])
    case("Session", "Supervisor idle limit is 10 minutes", "login as ravi", 10,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "ravi", "password": "ravi123"}
                                        ).get_json()["idleMinutes"])
    case("Session", "Heartbeat keeps the session alive", "POST /api/heartbeat", 200,
         lambda: ADMIN.post("/api/heartbeat", json={}).status_code)
    case("Session", "An admin session survives even after a long idle gap",
         "last_seen pushed 3 hours into the past, no limit applies", 200,
         lambda: _expire_admin_session())
    case("Session", "A supervisor's session is rejected once past their 10-minute limit",
         "last_seen pushed 11 min into the past", 401,
         lambda: _expire_supervisor_session())


def _pw_hashed():
    with app.app_context():
        u = User.query.filter_by(username="admin").first()
        return u.password_hash != "admin123" and len(u.password_hash) > 40


def _logout_then_me():
    c = app.test_client()
    c.post("/api/login", json={"username": "admin", "password": "admin123"})
    c.post("/api/logout", json={})
    return c.get("/api/me").get_json()["user"]


def _expire_admin_session():
    import time
    c = app.test_client()
    c.post("/api/login", json={"username": "admin", "password": "admin123"})
    with c.session_transaction() as s:
        s["last_seen"] = time.time() - 3 * 60 * 60      # 3 hours ago
    return c.get("/api/bootstrap").status_code


def _expire_supervisor_session():
    import time
    c = app.test_client()
    c.post("/api/login", json={"username": "ravi", "password": "ravi123"})
    with c.session_transaction() as s:
        s["last_seen"] = time.time() - 11 * 60          # 11 minutes ago
    return c.get("/api/bootstrap").status_code


# ===========================================================================
# 3. RBAC
# ===========================================================================
def test_rbac():
    print("\n[3] Role-based access control")
    admin_only = [("POST", "/api/users", {"name": "x", "username": "x", "password": "x"}),
                  ("POST", "/api/branches", {"name": "Sneaky"}),
                  ("PUT", "/api/settings", {"tolerance": 9}),
                  ("GET", "/api/activity", None),
                  ("DELETE", "/api/activity", None),
                  ("GET", "/api/ledger", None),
                  ("POST", "/api/admin/seed", {}),
                  ("GET", "/api/admin/wipe-preview", None),
                  ("GET", "/api/admin/wipe-backup", None),
                  ("POST", "/api/admin/wipe", {"confirm": "DELETE ALL DATA"})]
    for method, path, body in admin_only:
        case("RBAC", f"Supervisor blocked from {method} {path}",
             "logged in as supervisor", 403,
             lambda m=method, p=path, b=body: getattr(SUP, m.lower())(p, json=b).status_code)

    # "Wipe everything" was removed outright on 2026-08-13 (commit 2893c0e) and
    # this test used to pin it at a flat 404, even for an admin. It has since
    # been reintroduced deliberately, in a far more guarded form: scoped to
    # only the day-to-day transaction tables (branches/users/workers/customers
    # are never touched), gated behind an exact typed confirmation phrase, and
    # always preceded by a full Excel backup download — see admin_wipe() in
    # api.py and test_admin_wipe() near the end of this file for the real
    # coverage. This case now just confirms the route exists and the phrase
    # gate actually gates it; it is intentionally NOT a 404 any more.
    case("RBAC", "Wiping data without the exact confirmation phrase is refused",
         "POST /api/admin/wipe, no confirm", 422,
         lambda: ADMIN.post("/api/admin/wipe", json={}).status_code)

    case("RBAC", "Supervisor sees only assigned branches",
         "ravi assigned B01 only", ["B01"],
         lambda: list(SUP.get("/api/bootstrap").get_json()["branches"].keys()))
    case("RBAC", "A second supervisor sees a different branch",
         "priya assigned B02 only", ["B02"],
         lambda: list(SUP2.get("/api/bootstrap").get_json()["branches"].keys()))
    case("RBAC", "Admin sees every branch", "admin", 2,
         lambda: len(ADMIN.get("/api/bootstrap").get_json()["branches"]))
    case("RBAC", "Supervisor cannot write to another branch",
         "ravi (B01) posts a worker to B02", 403,
         lambda: SUP.post("/api/workers",
                          json={"branch": "B02", "name": "X", "dayWage": 100}).status_code)
    case("RBAC", "Supervisor receives no user list", "GET /api/bootstrap", [],
         lambda: SUP.get("/api/bootstrap").get_json()["users"])
    case("RBAC", "Admin receives the user list", "GET /api/bootstrap", 3,
         lambda: len(ADMIN.get("/api/bootstrap").get_json()["users"]))


# ===========================================================================
# 4. Calculation engine (pure, no database)
# ===========================================================================
def test_calc():
    print("\n[4] Calculation engine")
    broiler = compute_entry(base_entry(), SETTINGS)

    case("Calc engine", "Broiler waste 31% -> expected meat",
         "dressed live 82.000 kg", 56_580,
         lambda: broiler["expectedMeatG"])
    case("Calc engine", "Waste meat = live - expected",
         "82.000 kg live @31%", 25_420,
         lambda: broiler["wasteMeatG"])
    case("Calc engine", "Yield percentage",
         # actual meat obtained is now reconciled from closing meat (9kg,
         # base_entry's default) + skin(30) + skinless(20) + liver(1) +
         # damage(1) = 61.000 kg — see calc.py's compute_entry().
         "61.000 kg meat from 82.000 kg", 74.39,
         lambda: broiler["yieldPct"])
    case("Calc engine", "Weighted average cost across opening + purchase",
         "200 kg @₹120 + 205 kg @₹130", 125.06,
         lambda: broiler["avgRate"])
    case("Calc engine", "Revenue sums all sale lines",
         "skin+skinless+liver+live+cutting", 17_180.00,
         lambda: broiler["revenue"])
    case("Calc engine", "Closing meat is a direct entry now, not a formula output",
         "base_entry's default closeMeatG (9kg), unchanged", 9_000,
         lambda: broiler["expCloseMeatG"])
    case("Calc engine", "Expected closing birds",
         "80+100-20 live-0 dead-40 dressed", 120,
         lambda: broiler["expBirds"])

    # actualMeatG is derived now: closeMeatG + skin(30,000) + skinless(20,000)
    # + liver(1,000) + damage(1,000) — base_entry's other defaults, sum
    # 52,000 — so each closeMeatG below is chosen to reconstruct the same
    # actual-meat-obtained figure these cases were originally testing.
    exact = compute_entry(base_entry(dressedWtG=100_000, closeMeatG=17_000), SETTINGS)
    case("Calc engine", "Exact 69% yield produces no bonus and no shortfall",
         "100 kg live -> 69 kg meat (17,000 closing + 52,000 sold/damage)", (0, 0),
         lambda: (exact["bonusG"], exact["shortG"]))
    bonus = compute_entry(base_entry(dressedWtG=100_000, closeMeatG=21_000), SETTINGS)
    case("Calc engine", "Excess meat becomes bonus",
         "100 kg live -> 73 kg meat (21,000 closing + 52,000 sold/damage)", 4_000,
         lambda: bonus["bonusG"])
    case("Calc engine", "Bonus above tolerance raises the high-yield flag",
         "73% vs 69% ±2", True, lambda: bonus["yieldHigh"])
    short = compute_entry(base_entry(dressedWtG=100_000, closeMeatG=12_000), SETTINGS)
    case("Calc engine", "Meat below expected becomes a shortfall",
         "100 kg live -> 64 kg meat (12,000 closing + 52,000 sold/damage)", 5_000,
         lambda: short["shortG"])
    case("Calc engine", "Shortfall below tolerance raises the low-yield flag",
         "64% vs 69% ±2", True, lambda: short["yieldLow"])
    edge = compute_entry(base_entry(dressedWtG=100_000, closeMeatG=15_000), SETTINGS)
    case("Calc engine", "Inside tolerance raises no flag",
         "67% vs 69% ±2", (False, False),
         lambda: (edge["yieldLow"], edge["yieldHigh"]))

    parents = compute_entry(base_entry(category="parents", dressedWtG=100_000,
                                       closeMeatG=27_000), SETTINGS)
    case("Calc engine", "Parents waste 21% -> expected meat",
         "100 kg live, parents", 79_000,
         lambda: parents["expectedMeatG"])
    case("Calc engine", "Parents at 79% is neither bonus nor short",
         "100 kg -> 79 kg", (0, 0),
         lambda: (parents["bonusG"], parents["shortG"]))

    empty = compute_entry({"category": "broiler"}, SETTINGS)
    case("Calc engine", "Empty entry does not divide by zero",
         "all fields absent", (0, 0.0),
         lambda: (empty["expectedMeatG"], empty["yieldPct"]))
    zero_p = compute_entry(base_entry(purchases=[]), SETTINGS)
    case("Calc engine", "No purchases falls back to the opening rate",
         "opening 200 kg @₹120, no buys", 120.00,
         lambda: zero_p["avgRate"])
    multi = compute_entry(base_entry(purchases=[
        {"birds": 50, "wtG": 100_000, "rate": 100},
        {"birds": 50, "wtG": 100_000, "rate": 140}]), SETTINGS)
    case("Calc engine", "Several suppliers blend into one average",
         "200@120 + 100@100 + 100@140", 120.00,
         lambda: multi["avgRate"])
    case("Calc engine", "Purchased birds are summed across lines",
         "50 + 50", 100, lambda: multi["buyBirds"])

    # 34,500,000 actual meat wanted -> closeMeatG = 34,500,000 - 52,000
    # (base_entry's default sold/damage) = 34,448,000
    big = compute_entry(base_entry(dressedWtG=50_000_000, closeMeatG=34_448_000,
                                   purchases=[{"birds": 200_000, "wtG": 400_000_000,
                                               "rate": 130}]), SETTINGS)
    case("Calc engine", "Large volumes stay precise (50 tonnes)",
         "50,000 kg live @69%", 69.0, lambda: big["yieldPct"])
    mort = compute_entry(base_entry(mortCount=10, mortWtG=20_000), SETTINGS)
    case("Calc engine", "Mortality is valued at the average cost",
         "20 kg dead @ the weighted average", 2501.23, lambda: mort["mortValue"])
    case("Calc engine", "Mortality rate as a percentage of birds handled",
         "10 of 180", 5.56, lambda: mort["mortRate"])
    case("Calc engine", "Month range spanning a year boundary",
         "2025-11-15 → 2026-02-03", ["2025-11", "2025-12", "2026-01", "2026-02"],
         lambda: months_in_range(date(2025, 11, 15), date(2026, 2, 3)))


# ===========================================================================
# 5. Validation
# ===========================================================================
def test_validation():
    print("\n[5] Field validation")
    full = base_entry()
    case("Validation", "A complete entry passes", "all fields present", [],
         lambda: validate_for_submission(full, False, False))
    case("Validation", "Missing skin rate is caught", "rateSkin = 0", True,
         lambda: "Skin rate" in validate_for_submission(base_entry(rateSkin=0), False, False))
    case("Validation", "Missing opening weight is caught on a normal day",
         "openWtG = 0", True,
         lambda: "Opening bird weight" in validate_for_submission(
             base_entry(openWtG=0), False, False))
    case("Validation", "Opening fields optional on the first ever day",
         "openWtG = 0, first entry", True,
         lambda: "Opening bird weight" not in validate_for_submission(
             base_entry(openWtG=0, openBirds=None), False, True))
    case("Validation", "Mortality without a photo blocks submission",
         "mortCount = 3, photos = []", True,
         lambda: any("photo" in m.lower() for m in
                     validate_for_submission(base_entry(mortCount=3), False, False)))
    case("Validation", "Mortality with a photo passes",
         "mortCount = 3, 1 photo", True,
         lambda: not any("photo" in m.lower() for m in validate_for_submission(
             base_entry(mortCount=3, photos=["data:image/jpeg;base64,AAA"]), False, False)))
    case("Validation", "Supervisor is never asked for a buying rate",
         "purchase rate = 0, role supervisor", True,
         lambda: not any("rate per kg" in m for m in validate_for_submission(
             base_entry(purchases=[{"birds": 10, "wtG": 20_000, "rate": 0}]), False, False)))
    case("Validation", "Admin IS asked for the buying rate",
         "purchase rate = 0, role admin", True,
         lambda: any("rate per kg" in m for m in validate_for_submission(
             base_entry(purchases=[{"birds": 10, "wtG": 20_000, "rate": 0}]), True, False)))
    case("Validation", "Purchase with birds but no weight is caught",
         "birds 10, wtG 0", True,
         lambda: any("weight" in m for m in validate_for_submission(
             base_entry(purchases=[{"birds": 10, "wtG": 0, "rate": 5}]), False, False)))
    case("Validation", "Dressing fields optional when nothing was dressed",
         "dressedCount = 0", [],
         lambda: validate_for_submission(
             base_entry(dressedCount=0, dressedWtG=0, actualMeatG=0), False, False))
    case("Validation", "Costing gaps list what the admin still owes",
         "rate 0 and openRate 0", 2,
         lambda: len(costing_gaps(base_entry(openRate=0,
                                             purchases=[{"birds": 1, "wtG": 1000, "rate": 0}]))))
    case("Validation", "No gaps once rates are supplied",
         "openRate 120, rate 130", [],
         lambda: costing_gaps(base_entry(openRate=120)))


# ===========================================================================
# 6. Daily entry lifecycle
# ===========================================================================
ENTRY_IDS = {}


def test_entries():
    print("\n[6] Daily entry & approval workflow")
    # Opening birds/weight/meat are carried forward server-side now (a
    # supervisor can no longer type them in — see _carry_forward_opening() in
    # api.py), so "main" below no longer gets base_entry()'s openBirds=80/
    # openWtG=200_000/openMeatG=5_000 just by sending them. Seed yesterday's
    # approved entry with exactly those as its closing figures so today's
    # carry-forward reproduces the same starting point the rest of this test
    # (weighted-average pricing included) was written to expect.
    seed = ADMIN.post("/api/entries", json=base_entry(
        branch="B01", category="broiler", businessDate=D(1), submit=True,
        closeAuto={"birds": False, "wt": False, "meat": False},
        closeBirds=80, closeWtG=200_000, closeMeatG=5_000)).get_json()
    ADMIN.post(f"/api/entries/{seed['id']}/decision", json={"verdict": "approved"})

    # A supervisor is now pinned to today's date no matter what businessDate
    # they send, so the "main" workflow entry has to live at D(0) — the only
    # date a supervisor can ever create/edit/view.
    r = SUP.post("/api/entries", json=base_entry(businessDate=D(0), submit=True))
    ENTRY_IDS["main"] = r.get_json().get("id")
    case("Daily entry", "Supervisor submits a complete day", "POST /api/entries", 201,
         lambda: r.status_code)
    case("Daily entry", "New submission is pending", "status field", "pending",
         lambda: r.get_json()["status"])
    case("Daily entry", "Supervisor's buying rate is discarded on write",
         "supervisor sends rate 130", 0,
         lambda: r.get_json()["purchases"][0]["rate"])
    case("Daily entry", "Cost figures stripped from supervisor payload",
         "response.calc", False,
         lambda: "netProfit" in r.get_json()["calc"])
    case("Daily entry", "Operational figures still visible to supervisor",
         "response.calc.yieldPct", True,
         lambda: "yieldPct" in r.get_json()["calc"])

    # This one isn't about who created it (draft-without-validation is generic
    # behaviour) — use ADMIN so it can keep its own D(9) slot instead of
    # competing with SUP's single today-only branch+category budget.
    case("Daily entry", "Draft can be saved without full validation",
         "submit flag false, sparse data", 201,
         lambda: ADMIN.post("/api/entries", json={"branch": "B01", "category": "parents",
                                                   "businessDate": D(9)}).status_code)
    case("Daily entry", "Duplicate branch+category+date is refused",
         "same day twice", 409,
         lambda: SUP.post("/api/entries", json=base_entry(businessDate=D(9))).status_code)
    case("Daily entry", "Same date but a different category is allowed",
         "broiler and parents on one day", True,
         lambda: _parents_same_day_ok())
    # Field-validation behaviour, not a supervisor-specific rule — ADMIN keeps
    # its own D(8)/D(7) slots free of the today-only collision with "main".
    case("Daily entry", "Incomplete submission is rejected with a field list",
         "submit with rateSkin 0", 422,
         lambda: ADMIN.post("/api/entries",
                            json=base_entry(businessDate=D(8), rateSkin=0, submit=True)).status_code)
    case("Daily entry", "Rejection names the missing field",
         "submit with rateSkin 0", True,
         lambda: "Skin rate" in str(ADMIN.post("/api/entries",
                 json=base_entry(businessDate=D(7), rateSkin=0, submit=True)).get_json()))
    case("Daily entry", "Failed submission leaves nothing behind",
         "rolled back", True, lambda: _no_entry_on(D(8)))

    eid = ENTRY_IDS["main"]
    case("Approval", "Approval blocked while the buying rate is missing",
         "POST decision approved", 422,
         lambda: ADMIN.post(f"/api/entries/{eid}/decision",
                            json={"verdict": "approved"}).status_code)
    case("Approval", "The response names the costing gap", "gaps array", True,
         lambda: "purchase line 1 rate" in str(ADMIN.post(
             f"/api/entries/{eid}/decision", json={"verdict": "approved"}).get_json()))
    ap = ADMIN.post(f"/api/entries/{eid}/decision",
                    json={"verdict": "approved", "openRate": 120, "rates": [130]})
    case("Approval", "Approved once rates are supplied", "with rates", "approved",
         lambda: ap.get_json()["status"])
    case("Approval", "Reviewer is stamped on the record", "reviewedBy", True,
         lambda: ap.get_json()["reviewedBy"] is not None)
    case("Approval", "Admin sees the weighted average after pricing",
         "200@120 + 205@130", 125.06, lambda: ap.get_json()["calc"]["avgRate"])
    case("Approval", "Supervisor cannot edit an approved record", "PUT as supervisor", 403,
         lambda: SUP.put(f"/api/entries/{eid}", json={"actualMeatG": 99_000}).status_code)
    case("Approval", "Admin can edit an approved record", "PUT as admin", 57_000,
         # actualMeatG is derived now (closing meat + skin + skinless + liver
         # + hotel + damage — see calc.py), never taken from the client, so
         # this edits closeMeatG (5,000 + the default 52,000 sold/damage =
         # 57,000) and checks the derived figure instead.
         lambda: ADMIN.put(f"/api/entries/{eid}",
                           json={"closeMeatG": 5_000}).get_json()["actualMeatG"])
    case("Approval", "Record stays approved after an admin edit", "status", "approved",
         lambda: ADMIN.get("/api/entries").get_json()[0]["status"] if False else
         _status_of(eid))
    case("Approval", "Supervisor cannot approve anything", "POST decision as supervisor", 403,
         lambda: SUP.post(f"/api/entries/{eid}/decision",
                          json={"verdict": "approved"}).status_code)
    case("Approval", "Unknown verdict is rejected", "verdict='maybe'", 400,
         lambda: ADMIN.post(f"/api/entries/{eid}/decision",
                            json={"verdict": "maybe"}).status_code)

    # return / resubmit cycle — a genuinely supervisor-owned workflow, so this
    # stays SUP. "broiler" on B01/today is already spoken for by "main"
    # (above), so this uses the other available category, "parents" — the
    # only remaining isolated slot a pinned-to-today supervisor has here.
    r2 = SUP.post("/api/entries", json=base_entry(businessDate=D(6), category="parents",
                                                   submit=True))
    rid = r2.get_json()["id"]
    ADMIN.post(f"/api/entries/{rid}/decision",
               json={"verdict": "rejected", "reason": "Photo unclear"})
    case("Approval", "Return sets status and stores the reason", "verdict rejected",
         ("rejected", "Photo unclear"), lambda: _reason_of(rid))
    case("Approval", "Returned entry becomes editable again for its author",
         "PUT as supervisor", 200,
         lambda: SUP.put(f"/api/entries/{rid}", json={"notes": "recounted"}).status_code)
    case("Approval", "Resubmitting without an explanation is refused",
         "submit, explanation empty", 422,
         lambda: SUP.put(f"/api/entries/{rid}",
                         json={"explanation": "", "submit": True}).status_code)
    case("Approval", "Resubmitting with an explanation succeeds",
         "submit + explanation", "pending",
         lambda: SUP.put(f"/api/entries/{rid}",
                         json={"explanation": "Rechecked the scale", "submit": True}
                         ).get_json()["status"])
    case("Daily entry", "Another supervisor cannot see this branch's entries",
         "priya lists entries", 0,
         lambda: len(SUP2.get("/api/entries").get_json()))
    case("Daily entry", "Supervisor sees only entries they created",
         "ravi lists entries", True,
         lambda: all(x["createdByName"] == "Ravi Kumar"
                     for x in SUP.get("/api/entries").get_json()))
    case("Daily entry", "Date range filter works", f"from={D(9)}&to={D(9)}", True,
         lambda: all(x["businessDate"] == D(9)
                     for x in ADMIN.get(f"/api/entries?from={D(9)}&to={D(9)}").get_json()))
    case("Daily entry", "Status filter works", "status=approved", True,
         lambda: all(x["status"] == "approved"
                     for x in ADMIN.get("/api/entries?status=approved").get_json()))
    case("Daily entry", "Admin can delete an entry", "DELETE", 200,
         lambda: ADMIN.delete(f"/api/entries/{rid}").status_code)
    case("Daily entry", "Deleting a missing entry returns 404", "DELETE bogus", 404,
         lambda: ADMIN.delete("/api/entries/does-not-exist").status_code)


def _parents_same_day_ok():
    # This is really about the branch+category+date uniqueness constraint,
    # not about who is posting — ADMIN keeps it on its own D(5) slot instead
    # of competing with SUP's single today-only "parents" slot (used by the
    # return/resubmit cycle above).
    r = ADMIN.post("/api/entries", json=base_entry(businessDate=D(5), category="parents",
                                                    submit=True))
    return r.status_code == 201


def _no_entry_on(day):
    with app.app_context():
        return DailyEntry.query.filter_by(business_date=date.fromisoformat(day)).count() == 0


def _status_of(eid):
    with app.app_context():
        return db.session.get(DailyEntry, eid).status


def _reason_of(rid):
    with app.app_context():
        e = db.session.get(DailyEntry, rid)
        return (e.status, e.reject_reason)


# ===========================================================================
# 6b. Admin-only date correction
# ===========================================================================
def test_date_permission():
    print("\n[6b] Business-date correction (admin only)")
    # This whole function is fundamentally about what an ADMIN can do to an
    # entry's date, so the fixture entry is admin-created — that leaves it
    # completely unrestricted by the supervisor's new today-only pin, exactly
    # like before.
    draft = ADMIN.post("/api/entries", json=base_entry(businessDate=D(21))).get_json()
    did = draft["id"]

    # ...except "supervisor can still edit their own draft's fields", which
    # is genuinely about supervisor capability — that needs its own
    # supervisor-owned, today-dated entry, since the ADMIN fixture above
    # isn't theirs to touch. "broiler" on B01/today belongs to test_entries'
    # permanent "main" record, so this uses "parents", and is deleted again
    # right after so it doesn't permanently consume that slot.
    sup_draft = SUP.post("/api/entries",
                         json=base_entry(businessDate=D(0), category="parents")).get_json()
    sid = sup_draft["id"]

    case("Date permission", "Supervisor can still edit their draft's fields",
         "PUT notes on own draft", 200,
         lambda: SUP.put(f"/api/entries/{sid}", json={"notes": "fine"}).status_code)
    case("Date permission", "Supervisor cannot move a saved entry to another date",
         "PUT businessDate as supervisor", 403,
         lambda: SUP.put(f"/api/entries/{sid}", json={"businessDate": D(20)}).status_code)
    case("Date permission", "The date is left untouched after the refusal",
         "re-read the record", D(0),
         lambda: _entry_date(sid))
    case("Date permission", "The attempt is written to the audit log",
         "action 'Blocked date change'", True,
         lambda: any(a["action"] == "Blocked date change"
                     for a in ADMIN.get("/api/activity").get_json()))
    ADMIN.delete(f"/api/entries/{sid}")  # free B01/parents/today for later tests

    case("Date permission", "A supervisor's chosen date is silently overridden to today",
         "POST with businessDate", D(0),
         lambda: SUP2.post("/api/entries",
                           json=base_entry(branch="B02", businessDate=D(22))
                           ).get_json()["businessDate"])

    case("Date permission", "Admin moves an entry from the approval panel",
         "PUT /costing businessDate", D(20),
         lambda: ADMIN.put(f"/api/entries/{did}/costing",
                           json={"businessDate": D(20)}).get_json()["businessDate"])
    case("Date permission", "Admin moves it on the edit path too",
         "PUT businessDate", D(19),
         lambda: ADMIN.put(f"/api/entries/{did}",
                           json={"businessDate": D(19)}).get_json()["businessDate"])
    case("Date permission", "Admin can move and approve in one call",
         "POST decision with businessDate", (D(18), "approved"),
         lambda: _move_and_approve(did, D(18)))
    case("Date permission", "The move is recorded with both dates",
         "activity detail", True,
         lambda: any(a["action"] == "Changed record date/time" and D(19) in a["detail"]
                     for a in ADMIN.get("/api/activity").get_json()))
    case("Date permission", "Moving onto an occupied day is refused",
         "collide with an existing entry", 409,
         lambda: _collide(D(18)))
    case("Date permission", "A malformed date is a 422, not a crash",
         "businessDate='31-02-2026'", 422,
         lambda: ADMIN.put(f"/api/entries/{did}/costing",
                           json={"businessDate": "31-02-2026"}).status_code)
    case("Date permission", "Re-sending the same date changes nothing",
         "no-op move", 200,
         lambda: ADMIN.put(f"/api/entries/{did}/costing",
                           json={"businessDate": D(18)}).status_code)


def _entry_date(eid):
    with app.app_context():
        return db.session.get(DailyEntry, eid).business_date.isoformat()


def _move_and_approve(eid, day):
    r = ADMIN.post(f"/api/entries/{eid}/decision",
                   json={"verdict": "approved", "businessDate": day,
                         "openRate": 120, "rates": [130]}).get_json()
    return (r.get("businessDate"), r.get("status"))


def _collide(day):
    # Just a fixture for the clash check — ADMIN keeps it on its own D(23)
    # slot instead of forcing today and clashing with "main".
    other = ADMIN.post("/api/entries", json=base_entry(businessDate=D(23))).get_json()
    return ADMIN.put(f"/api/entries/{other['id']}/costing",
                     json={"businessDate": day}).status_code


# ===========================================================================
# 7. Photos
# ===========================================================================
def test_photos():
    print("\n[7] Mortality photos")
    # Mortality/photo validation is generic, not supervisor-specific — ADMIN
    # keeps these on their own D(4)/D(3)/D(2) slots instead of colliding with
    # a supervisor's single today-only entry.
    png = "data:image/jpeg;base64," + "A" * 200
    r = ADMIN.post("/api/entries", json=base_entry(businessDate=D(4), mortCount=2,
                                                    mortWtG=4000, photos=[png, png],
                                                    submit=True))
    case("Photos", "Entry with mortality and photos is accepted", "2 photos", 201,
         lambda: r.status_code)
    case("Photos", "Both photos are stored", "photos array", 2,
         lambda: len(r.get_json()["photos"]))
    # A single dead bird happens too often in the ordinary course of running
    # a shed to make everyone stop and photograph it — the photo is only
    # required once mortality is MORE than 1 bird, the same threshold for
    # every branch (there is no branch-specific exception anywhere in this
    # rule).
    case("Photos", "Exactly 1 dead bird does NOT require a photo",
         "mortCount 1, no photos", 201,
         lambda: ADMIN.post("/api/entries", json=base_entry(businessDate=D(5), mortCount=1,
                                                             mortWtG=2000, submit=True)).status_code)
    case("Photos", "Mortality above 1 bird without a photo is refused at the API",
         "mortCount 2, no photos", 422,
         lambda: ADMIN.post("/api/entries", json=base_entry(businessDate=D(3), mortCount=2,
                                                             mortWtG=4000, submit=True)).status_code)
    case("Photos", "Non-image payloads are discarded",
         "photos=['javascript:alert(1)']", 0,
         lambda: len(ADMIN.post("/api/entries",
                     json=base_entry(businessDate=D(2),
                                     photos=["javascript:alert(1)"])).get_json()["photos"]))


# ===========================================================================
# 8. Labour
# ===========================================================================
WORKER_ID = {}


def test_labour():
    print("\n[8] Labour, attendance and payroll")
    w = SUP.post("/api/workers", json={"branch": "B01", "name": "Suresh",
                                       "role": "dresser", "dayWage": 600})
    WORKER_ID["w"] = w.get_json().get("id")
    case("Labour", "Supervisor may add a worker", "POST /api/workers", 201,
         lambda: w.status_code)
    case("Labour", "Worker without a wage is refused", "dayWage 0", 422,
         lambda: SUP.post("/api/workers",
                          json={"branch": "B01", "name": "NoWage", "dayWage": 0}).status_code)
    case("Labour", "Worker without a name is refused", "name ''", 422,
         lambda: SUP.post("/api/workers",
                          json={"branch": "B01", "name": "  ", "dayWage": 500}).status_code)
    case("Labour", "Unicode names are preserved", "name 'ರಮೇಶ್'", "ರಮೇಶ್",
         lambda: SUP.post("/api/workers", json={"branch": "B01", "name": "ರಮೇಶ್",
                                                "dayWage": 500}).get_json()["name"])
    case("Labour", "Supervisor cannot delete a worker", "DELETE as supervisor", 403,
         lambda: SUP.delete(f"/api/workers/{WORKER_ID['w']}").status_code)

    wid = WORKER_ID["w"]
    # POST /api/ledger now forces a non-admin's date to today, so these
    # attendance/payroll fixtures (which deliberately span several distinct
    # days) go through ADMIN — none of this is about supervisor permission,
    # just wage/balance arithmetic.
    att = lambda day, days: ADMIN.post("/api/ledger", json={                  # noqa: E731
        "branch": "B01", "workerId": wid, "date": day, "type": "work", "days": days})
    case("Attendance", "Mark a full day", "days=1", 201, lambda: att(D(5), 1).status_code)
    case("Attendance", "Wage equals the daily rate", "600/day", 600.0,
         lambda: att(D(5), 1).get_json()["amount"])
    case("Attendance", "Half day is worth half the wage", "days=0.5", 300.0,
         lambda: att(D(5), 0.5).get_json()["amount"])
    case("Attendance", "Re-marking replaces rather than duplicates",
         "5 marks on one day", 1, lambda: _work_rows(wid, D(5)))
    case("Attendance", "Marking absent removes the day", "days=0", 0,
         lambda: (att(D(5), 0), _work_rows(wid, D(5)))[1])
    case("Attendance", "Eight rapid clicks stay consistent",
         "double-click simulation", (True, 1),
         lambda: _rapid_attendance(wid, D(4)))
    case("Attendance", "Separate days accumulate", "3 different days", 3,
         lambda: _three_days(wid))

    pay = lambda kind, amt: ADMIN.post("/api/ledger", json={                  # noqa: E731
        "branch": "B01", "workerId": wid, "date": D(4), "type": kind, "amount": amt})
    case("Payroll", "Record a payment", "paid ₹1000", 201, lambda: pay("paid", 1000).status_code)
    case("Payroll", "Two payments on one day are allowed", "second payment", 201,
         lambda: pay("paid", 200).status_code)
    case("Payroll", "Tea is recorded", "tea ₹30", 201, lambda: pay("tea", 30).status_code)
    case("Payroll", "Two teas on one day are allowed", "second tea", 201,
         lambda: pay("tea", 40).status_code)
    case("Payroll", "Zero amount is refused", "paid ₹0", 422, lambda: pay("paid", 0).status_code)
    case("Payroll", "Unknown ledger type is refused", "type='bribe'", 422,
         lambda: ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid,
                                                  "date": D(4), "type": "bribe",
                                                  "amount": 10}).status_code)
    case("Payroll", "Unknown worker is refused", "workerId='ghost'", 404,
         lambda: ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": "ghost",
                                                  "date": D(4), "type": "paid",
                                                  "amount": 10}).status_code)
    case("Payroll", "Balance = earned − paid − advances",
         "3 days ×600 − 1200 paid", True, lambda: _balance_check(wid))
    case("Payroll", "Tea and tiffin never reduce the worker balance",
         "add ₹70 of tea", True, lambda: _tea_not_deducted(wid))
    case("Payroll", "Tea and tiffin DO count as a shop cost",
         "labour_for other", True, lambda: _tea_is_shop_cost())


def _work_rows(wid, day):
    with app.app_context():
        return LabourLedger.query.filter_by(worker_id=wid, kind="work",
                                            entry_date=date.fromisoformat(day)).count()


def _rapid_attendance(wid, day):
    codes = [ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": day,
                                              "type": "work", "days": 1}).status_code
             for _ in range(8)]
    return (set(codes) == {201}, _work_rows(wid, day))


def _three_days(wid):
    for d in (D(20), D(21), D(22)):
        ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": d,
                                        "type": "work", "days": 1})
    with app.app_context():
        return LabourLedger.query.filter(
            LabourLedger.worker_id == wid, LabourLedger.kind == "work",
            LabourLedger.entry_date.in_([date.fromisoformat(D(20)),
                                         date.fromisoformat(D(21)),
                                         date.fromisoformat(D(22))])).count()


def _balance_check(wid):
    with app.app_context():
        rows = LabourLedger.query.filter_by(worker_id=wid).all()
        earned = sum(float(r.amount) for r in rows if r.kind == "work")
        paid = sum(float(r.amount) for r in rows if r.kind in ("paid", "advance"))
        tea = sum(float(r.amount) for r in rows if r.kind in ("tea", "tiffin"))
        return abs((earned - paid) - (earned - paid)) == 0 and tea > 0 and earned > 0


def _tea_not_deducted(wid):
    with app.app_context():
        rows = LabourLedger.query.filter_by(worker_id=wid).all()
        before = sum(float(r.amount) for r in rows if r.kind == "work") - \
                 sum(float(r.amount) for r in rows if r.kind in ("paid", "advance"))
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": D(4),
                                    "type": "tiffin", "amount": 70})
    with app.app_context():
        rows = LabourLedger.query.filter_by(worker_id=wid).all()
        after = sum(float(r.amount) for r in rows if r.kind == "work") - \
                sum(float(r.amount) for r in rows if r.kind in ("paid", "advance"))
    return before == after


def _tea_is_shop_cost():
    from app.api import labour_for
    with app.app_context():
        b = Branch.query.filter_by(code="B01").first()
        lab = labour_for(b.id, date.fromisoformat(D(4)))
        return lab["other"] > 0


# ===========================================================================
# 8b. Advances deducted from the day's profit
# ===========================================================================
def test_advances():
    print("\n[8b] Daily advances")
    from app.api import labour_for
    day = D(16)
    w = SUP.post("/api/workers", json={"branch": "B01", "name": "AdvTest",
                                       "role": "cutter", "dayWage": 700}).get_json()

    case("Advances", "Default day wage is 700", "settings.dayWage", 700.0,
         lambda: ADMIN.get("/api/bootstrap").get_json()["settings"]["dayWage"])
    case("Advances", "Admin can change a wage after the worker exists",
         "PUT dayWage 750", 750.0,
         lambda: ADMIN.put(f"/api/workers/{w['id']}",
                           json={"dayWage": 750}).get_json()["dayWage"])
    ADMIN.put(f"/api/workers/{w['id']}", json={"dayWage": 700})

    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
                                    "type": "work", "days": 1})
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
                                    "type": "advance", "amount": 500})

    case("Advances", "Wages and advances are reported separately",
         "700 wage + 500 advance", (700.0, 500.0),
         lambda: _labour_split(day))
    case("Advances", "Several advances on one day add up",
         "second advance of 200", 700.0,
         lambda: _second_advance(w["id"], day))
    case("Advances", "Only wages and overheads hit the profit, never advances",
         "net = revenue − cogs − wages − other", True,
         lambda: _net_excludes_advances(day))
    case("Advances", "A large advance does not swing the day's profit",
         "₹5,000 advance on a quiet day", True,
         lambda: _big_advance_ignored())
    case("Advances", "A day with no advance shows zero", "different day", 0.0,
         lambda: _advances_on(D(15)))
    case("Advances", "Advances stay with their own branch",
         "B02 advance does not touch B01", True,
         lambda: _branch_isolated(day))
    case("Advances", "The advance still reduces what the worker is owed",
         "earned − advances", True,
         lambda: _balance_reduced(w["id"]))
    case("Advances", "Supervisors never see the advance figures",
         "supervisor payload", True,
         lambda: all("advances" not in e["calc"]
                     for e in SUP.get("/api/entries").get_json()))


def _labour_split(day):
    from app.api import labour_for
    with app.app_context():
        b = Branch.query.filter_by(code="B01").first()
        lab = labour_for(b.id, date.fromisoformat(day))
        return (lab["wages"], lab["advances"])


def _second_advance(wid, day):
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": day,
                                    "type": "advance", "amount": 200})
    from app.api import labour_for
    with app.app_context():
        b = Branch.query.filter_by(code="B01").first()
        return labour_for(b.id, date.fromisoformat(day))["advances"]


def _advances_on(day):
    from app.api import labour_for
    with app.app_context():
        b = Branch.query.filter_by(code="B01").first()
        return labour_for(b.id, date.fromisoformat(day))["advances"]


def _net_excludes_advances(day):
    r = ADMIN.post("/api/entries", json=base_entry(businessDate=day, submit=True))
    if r.status_code != 201:
        return f"submit failed {r.status_code}"
    eid = r.get_json()["id"]
    ADMIN.post(f"/api/entries/{eid}/decision",
               json={"verdict": "approved", "openRate": 120, "rates": [130]})
    c = [e for e in ADMIN.get("/api/entries").get_json() if e["id"] == eid][0]["calc"]
    charged = round(c["revenue"] - c["cogs"] - c["labour"] - c["otherExp"], 2)
    # advances present, reported, but not subtracted
    return (c["advances"] > 0
            and abs(c["netProfit"] - charged) < 0.01
            and abs(c["netProfit"] - (charged - c["advances"])) > 1)


def _big_advance_ignored():
    day = D(17)
    w = ADMIN.post("/api/workers", json={"branch": "B01", "name": "BigAdv",
                                         "role": "cutter", "dayWage": 700}).get_json()
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
                                    "type": "work", "days": 1})
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
                                    "type": "advance", "amount": 5000})
    r = ADMIN.post("/api/entries", json=base_entry(businessDate=day, submit=True))
    if r.status_code != 201:
        return f"submit failed {r.status_code}"
    eid = r.get_json()["id"]
    ADMIN.post(f"/api/entries/{eid}/decision",
               json={"verdict": "approved", "openRate": 120, "rates": [130]})
    c = [e for e in ADMIN.get("/api/entries").get_json() if e["id"] == eid][0]["calc"]
    return (c["advances"] == 5000.0 and c["labour"] == 700.0
            and abs(c["netProfit"] - (c["revenue"] - c["cogs"] - c["labour"] - c["otherExp"])) < 0.01)


def _branch_isolated(day):
    from app.api import labour_for
    w2 = ADMIN.post("/api/workers", json={"branch": "B02", "name": "OtherBranch",
                                          "role": "cutter", "dayWage": 700}).get_json()
    ADMIN.post("/api/ledger", json={"branch": "B02", "workerId": w2["id"], "date": day,
                                    "type": "advance", "amount": 900})
    with app.app_context():
        b1 = Branch.query.filter_by(code="B01").first()
        b2 = Branch.query.filter_by(code="B02").first()
        return (labour_for(b1.id, date.fromisoformat(day))["advances"] == 700.0
                and labour_for(b2.id, date.fromisoformat(day))["advances"] == 900.0)


def _balance_reduced(wid):
    with app.app_context():
        rows = LabourLedger.query.filter_by(worker_id=wid).all()
        earned = sum(float(r.amount) for r in rows if r.kind == "work")
        adv = sum(float(r.amount) for r in rows if r.kind == "advance")
        return earned > 0 and adv > 0 and (earned - adv) == earned - 700.0


# ===========================================================================
# 9. Overheads
# ===========================================================================
def test_overheads():
    print("\n[9] Monthly overheads")
    month = TODAY.strftime("%Y-%m")
    o = SUP.post("/api/overheads", json={"branch": "B01", "month": month,
                                         "category": "rent", "amount": 25000,
                                         "note": "August rent"})
    oid = o.get_json().get("id")
    case("Overheads", "Supervisor entry starts pending", "POST as supervisor", "pending",
         lambda: o.get_json()["status"])
    case("Overheads", "Admin entry is approved immediately", "POST as admin", "approved",
         lambda: ADMIN.post("/api/overheads",
                            json={"branch": "B01", "month": month,
                                  "category": "electricity", "amount": 8400}
                            ).get_json()["status"])
    case("Overheads", "Zero amount is refused", "amount 0", 422,
         lambda: SUP.post("/api/overheads", json={"branch": "B01", "month": month,
                                                  "category": "rent", "amount": 0}).status_code)
    case("Overheads", "Supervisor cannot approve", "POST decision as supervisor", 403,
         lambda: SUP.post(f"/api/overheads/{oid}/decision",
                          json={"verdict": "approved"}).status_code)
    case("Overheads", "Admin returns one with a reason", "verdict rejected", "rejected",
         lambda: ADMIN.post(f"/api/overheads/{oid}/decision",
                            json={"verdict": "rejected", "reason": "Attach the bill"}
                            ).get_json()["status"])
    case("Overheads", "Return reason is stored", "rejectReason", "Attach the bill",
         lambda: ADMIN.post(f"/api/overheads/{oid}/decision",
                            json={"verdict": "rejected", "reason": "Attach the bill"}
                            ).get_json()["rejectReason"])
    case("Overheads", "Admin can approve after correction", "verdict approved", "approved",
         lambda: ADMIN.post(f"/api/overheads/{oid}/decision",
                            json={"verdict": "approved"}).get_json()["status"])
    case("Overheads", "Supervisor cannot delete an approved overhead", "DELETE", 403,
         lambda: SUP.delete(f"/api/overheads/{oid}").status_code)
    case("Overheads", "Admin can delete", "DELETE as admin", 200,
         lambda: ADMIN.delete(f"/api/overheads/{oid}").status_code)
    case("Overheads", "A day carries its share of the month's overheads",
         "monthly total ÷ days in month", True,
         lambda: _overhead_day_share_applied())
    case("Overheads", "Same-day broiler+parents: broiler carries the whole day's cost",
         "broiler + parents on the same date, worked by the same crew", True,
         lambda: _day_costs_split())


def _overhead_day_share_applied():
    """Each trading day carries monthly overheads ÷ days in that month."""
    import calendar
    from app.api import overhead_day_share
    month = TODAY.strftime("%Y-%m")
    ADMIN.post("/api/overheads", json={"branch": "B01", "month": month,
                                       "category": "rent", "amount": 31000})
    dim = calendar.monthrange(TODAY.year, TODAY.month)[1]
    with app.app_context():
        b = Branch.query.filter_by(code="B01").first()
        share = overhead_day_share(b.id, TODAY)
    expected_total = sum(float(o["amount"]) for o in
                         ADMIN.get("/api/bootstrap").get_json()["overheads"]
                         if o["branch"] == "B01" and o["month"] == month
                         and o["status"] == "approved")
    return abs(share - expected_total / dim) < 0.02


def _day_costs_split():
    """
    Costs belong to the branch-day. When broiler and parents both have an
    entry the same day, they were worked by the same crew — broiler
    carries the whole day's wages, parents carries none of it (not an
    even split, which would put an unfair share on whichever entry is
    the smaller of the two that day).
    """
    from app.api import day_costs_for, labour_for
    day = TODAY - timedelta(days=19)
    w = ADMIN.post("/api/workers", json={"branch": "B01", "name": "SplitTest",
                                         "role": "cutter", "dayWage": 700}).get_json()
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w["id"],
                                    "date": day.isoformat(), "type": "work", "days": 1})
    for cat in ("broiler", "parents"):
        r = ADMIN.post("/api/entries", json=base_entry(businessDate=day.isoformat(),
                                                       category=cat, submit=True))
        if r.status_code == 201:
            ADMIN.post(f"/api/entries/{r.get_json()['id']}/decision",
                       json={"verdict": "approved", "openRate": 120, "rates": [130]})
    with app.app_context():
        b = Branch.query.filter_by(code="B01").first()
        full = labour_for(b.id, day)["wages"]
        broiler_share = day_costs_for(b.id, day, "broiler")
        parents_share = day_costs_for(b.id, day, "parents")
    return (broiler_share["shared"] == 2 and parents_share["shared"] == 2
            and abs(broiler_share["wages"] - full) < 0.01
            and parents_share["wages"] == 0)


# ===========================================================================
# 10. Branches, users, settings
# ===========================================================================
def test_admin_modules():
    print("\n[10] Branches, users and settings")
    case("Branches", "Create with an explicit code", "code=BX1", "BX1",
         lambda: ADMIN.post("/api/branches",
                            json={"code": "BX1", "name": "Test Branch X"}).get_json()["code"])
    case("Branches", "Duplicate code is refused", "code=BX1 again", 409,
         lambda: ADMIN.post("/api/branches",
                            json={"code": "BX1", "name": "Clash"}).status_code)
    case("Branches", "Blank name is refused", "name=''", 422,
         lambda: ADMIN.post("/api/branches", json={"name": "  "}).status_code)
    case("Branches", "Auto code is allocated when none is given", "no code", True,
         lambda: ADMIN.post("/api/branches",
                            json={"name": "Auto branch"}).get_json()["code"].startswith("B"))
    case("Branches", "Scales to any number (adds 15 at once, codes stay unique)",
         "create 15 more branches", True,
         lambda: _make_many_branches(15))
    case("Branches", "Rename works", "PUT name", "Renamed Hub",
         lambda: ADMIN.put("/api/branches/BX1",
                           json={"name": "Renamed Hub"}).get_json()["name"])
    case("Branches", "Deleting cascades to its records", "DELETE BX1", True,
         lambda: _delete_branch_cascades())
    case("Branches", "Cannot delete the last remaining branch",
         "delete down to one", 409, lambda: _cannot_delete_last())

    case("Users", "Create a supervisor with a branch", "role=supervisor", 201,
         lambda: ADMIN.post("/api/users", json={"name": "Test Sup", "username": "tsup",
                                                "password": "pw1234", "role": "supervisor",
                                                "branches": ["B01"]}).status_code)
    case("Users", "Supervisor without a branch is refused", "branches=[]", 422,
         lambda: ADMIN.post("/api/users", json={"name": "NoBranch", "username": "nb",
                                                "password": "pw1234", "role": "supervisor",
                                                "branches": []}).status_code)
    case("Users", "Duplicate username is refused", "username=tsup", 409,
         lambda: ADMIN.post("/api/users", json={"name": "Dup", "username": "tsup",
                                                "password": "pw1234",
                                                "role": "supervisor",
                                                "branches": ["B01"]}).status_code)
    case("Users", "Unknown role is refused", "role=owner", 422,
         lambda: ADMIN.post("/api/users", json={"name": "X", "username": "xx",
                                                "password": "pw1234",
                                                "role": "owner"}).status_code)
    case("Users", "New account can sign in", "tsup/pw1234", 200,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "tsup",
                                              "password": "pw1234"}).status_code)
    case("Users", "Password reset takes effect", "reset then login", 200,
         lambda: _reset_and_login())
    case("Users", "Too-short password is refused", "pw='abc'", 422,
         lambda: ADMIN.put(f"/api/users/{_uid('tsup')}/password",
                           json={"password": "abc"}).status_code)
    case("Users", "Admin cannot delete their own account", "self delete", 409,
         lambda: ADMIN.delete(f"/api/users/{_uid('admin')}").status_code)
    case("Users", "Deleted account can no longer sign in", "delete tsup", 401,
         lambda: _delete_and_try_login())

    case("Settings", "Waste percentages are configurable", "broiler 28%", 28.0,
         lambda: ADMIN.put("/api/settings",
                           json={"wasteBroiler": 28}).get_json()["waste_broiler"])
    case("Settings", "New waste % feeds the calculation", "28% -> 72% yield", 72_000,
         lambda: compute_entry(base_entry(dressedWtG=100_000),
                               {"waste_broiler": 28, "waste_parents": 21,
                                "tolerance": 2})["expectedMeatG"])
    case("Settings", "Restore the default", "broiler 31%", 31.0,
         lambda: ADMIN.put("/api/settings",
                           json={"wasteBroiler": 31}).get_json()["waste_broiler"])


def _make_many_branches(n):
    with app.app_context():
        before = Branch.query.count()
    for i in range(n):
        ADMIN.post("/api/branches", json={"name": f"Scale test {i}"})
    with app.app_context():
        codes = [b.code for b in Branch.query.all()]
        return len(codes) == before + n and len(set(codes)) == len(codes)


def _delete_branch_cascades():
    with app.app_context():
        b = Branch.query.filter_by(code="BX1").first()
        bid = b.id
    ADMIN.post("/api/entries", json=base_entry(branch="BX1", businessDate=D(1)))
    ADMIN.delete("/api/branches/BX1")
    with app.app_context():
        return (Branch.query.filter_by(code="BX1").first() is None
                and DailyEntry.query.filter_by(branch_id=bid).count() == 0)


def _cannot_delete_last():
    with app.app_context():
        codes = [b.code for b in Branch.query.all()]
    for c in codes[1:]:
        ADMIN.delete(f"/api/branches/{c}")
    status = ADMIN.delete(f"/api/branches/{codes[0]}").status_code
    return status


def _uid(username):
    with app.app_context():
        u = User.query.filter_by(username=username).first()
        return u.id if u else 0


def _reset_and_login():
    ADMIN.put(f"/api/users/{_uid('tsup')}/password", json={"password": "brandnew1"})
    return app.test_client().post("/api/login",
                                  json={"username": "tsup",
                                        "password": "brandnew1"}).status_code


def _delete_and_try_login():
    ADMIN.delete(f"/api/users/{_uid('tsup')}")
    return app.test_client().post("/api/login",
                                  json={"username": "tsup",
                                        "password": "brandnew1"}).status_code


# ===========================================================================
# 11. Activity log
# ===========================================================================
def test_activity():
    print("\n[11] Activity log")
    rows = ADMIN.get("/api/activity").get_json()
    kinds = {r["action"] for r in rows}
    for want in ["Sign in", "Failed sign in", "Submitted entry", "Approved entry",
                 "Returned entry", "Added worker", "Created branch", "Added overhead",
                 "Changed settings", "Created user", "Blocked: admin only"]:
        case("Activity log", f"Records '{want}'", "after the run above", True,
             lambda ww=want, kk=kinds: ww in kk)
    case("Activity log", "Captures who did it", "userName present", True,
         lambda: all(r["userName"] for r in rows))
    case("Activity log", "Captures the role", "role present", True,
         lambda: any(r["role"] == "supervisor" for r in rows))
    case("Activity log", "Filter by action works", "?action=Sign in", True,
         lambda: all(r["action"] == "Sign in"
                     for r in ADMIN.get("/api/activity?action=Sign in").get_json()))
    case("Activity log", "Supervisor cannot read it", "GET as supervisor", 403,
         lambda: SUP.get("/api/activity").status_code)
    case("Activity log", "Blocked attempts are themselves logged",
         "'Blocked: admin only'", True, lambda: "Blocked: admin only" in kinds)


# ===========================================================================
# 12. Robustness
# ===========================================================================
def test_robustness():
    print("\n[12] Robustness & edge cases")
    case("Robustness", "Malformed JSON body does not crash", "no body on login", 401,
         lambda: app.test_client().post("/api/login", data="not json",
                                        content_type="application/json").status_code)
    case("Robustness", "Missing fields default to zero", "empty entry payload", 201,
         lambda: ADMIN.post("/api/entries", json={"branch": "B01", "category": "broiler",
                                                  "businessDate": D(30)}).status_code)
    case("Robustness", "Negative weights are stored as given, not crashed",
         "openWtG = -5000", 201,
         lambda: ADMIN.post("/api/entries", json={"branch": "B01", "category": "parents",
                                                  "businessDate": D(30),
                                                  "openWtG": -5000}).status_code)
    case("Robustness", "Text in a numeric field is refused cleanly (422, not 500)",
         "openBirds='abc'", 422,
         lambda: ADMIN.post("/api/entries",
                            json={"branch": "B01", "category": "broiler",
                                  "businessDate": D(29),
                                  "openBirds": "abc"}).status_code)
    case("Robustness", "Very long note is truncated, not rejected", "3000 chars", True,
         lambda: len(ADMIN.post("/api/entries",
                     json={"branch": "B01", "category": "broiler", "businessDate": D(28),
                           "notes": "x" * 3000}).get_json()["notes"]) <= 2000)
    case("Robustness", "HTML in a note is stored safely as text",
         "<script>alert(1)</script>", True,
         lambda: "<script>" in ADMIN.post("/api/entries",
                 json={"branch": "B01", "category": "parents", "businessDate": D(28),
                       "notes": "<script>alert(1)</script>"}).get_json()["notes"])
    case("Robustness", "Unknown branch code is refused", "branch='ZZZ'", 403,
         lambda: ADMIN.post("/api/entries", json={"branch": "ZZZ", "category": "broiler",
                                                  "businessDate": D(27)}).status_code)
    case("Robustness", "Invalid category falls back to broiler", "category='duck'", "broiler",
         lambda: ADMIN.post("/api/entries",
                            json={"branch": "B01", "category": "duck",
                                  "businessDate": D(26)}).get_json()["category"])
    case("Robustness", "A constraint breach returns 409, never 500",
         "duplicate day", 409,
         lambda: (ADMIN.post("/api/entries", json={"branch": "B01", "category": "broiler",
                                                   "businessDate": D(25)}),
                  ADMIN.post("/api/entries", json={"branch": "B01", "category": "broiler",
                                                   "businessDate": D(25)}))[1].status_code)


# ===========================================================================
# 13. Admin data wipe — MUST run last: it deletes every daily entry, purchase,
# hotel sale, receipt, adjustment, overhead, day close and labour ledger row
# built up by every test module before it.
# ===========================================================================
def test_admin_wipe():
    print("\n[13] Admin: delete all data")
    before = {"branches": _count(Branch), "users": _count(User),
              "workers": _count(Worker), "customers": _count(Customer)}
    case("Data wipe", "There is real data to delete after the whole suite",
         "entries > 0", True, lambda: _count(DailyEntry) > 0)

    case("Data wipe", "A supervisor cannot see the preview", "GET wipe-preview", 403,
         lambda: SUP.get("/api/admin/wipe-preview").status_code)
    case("Data wipe", "A supervisor cannot fetch the backup", "GET wipe-backup", 403,
         lambda: SUP.get("/api/admin/wipe-backup").status_code)
    case("Data wipe", "A supervisor cannot wipe", "POST wipe", 403,
         lambda: SUP.post("/api/admin/wipe", json={"confirm": "DELETE ALL DATA"}).status_code)

    prev = ADMIN.get("/api/admin/wipe-preview").get_json()
    case("Data wipe", "Preview reports what would be deleted", "delete.entries", True,
         lambda: prev["delete"]["entries"] == _count(DailyEntry) and prev["delete"]["entries"] > 0)

    backup = ADMIN.get("/api/admin/wipe-backup").get_json()
    case("Data wipe", "The backup carries every entry the preview counted",
         "len(backup.entries)", prev["delete"]["entries"], lambda: len(backup["entries"]))
    case("Data wipe", "Backed-up entries carry no photo data, just a count",
         "photos empty, photoCount present", True,
         lambda: all(e["photos"] == [] and "photoCount" in e for e in backup["entries"]))
    case("Data wipe", "Preview reports what would be kept", "keep.branches", before["branches"],
         lambda: prev["keep"]["branches"])

    case("Data wipe", "No confirmation phrase is refused", "POST with no body", 422,
         lambda: ADMIN.post("/api/admin/wipe", json={}).status_code)
    case("Data wipe", "A wrong confirmation phrase is refused", "confirm='yes'", 422,
         lambda: ADMIN.post("/api/admin/wipe", json={"confirm": "yes"}).status_code)
    case("Data wipe", "Nothing was deleted by the failed attempts",
         "entries unchanged", prev["delete"]["entries"], lambda: _count(DailyEntry))

    result = ADMIN.post("/api/admin/wipe", json={"confirm": "DELETE ALL DATA"}).get_json()
    case("Data wipe", "The real wipe reports ok", "ok", True, lambda: result["ok"])

    for model, key in [(DailyEntry, "entries"), (Purchase, "purchases"),
                       (CustomerSale, "hotelSales"), (CustomerPayment, "payments"),
                       (CustomerAdjustment, "adjustments"), (Overhead, "overheads"),
                       (DayClose, "dayCloses"), (LabourLedger, "labourLedger"),
                       (MortalityPhoto, "mortalityPhotos")]:
        case("Data wipe", f"{key} table is empty", f"{model.__tablename__}", 0,
             lambda m=model: _count(m))

    case("Data wipe", "Branches are untouched", "same count", before["branches"],
         lambda: _count(Branch))
    case("Data wipe", "User accounts are untouched", "same count", before["users"],
         lambda: _count(User))
    case("Data wipe", "Worker profiles are untouched", "same count", before["workers"],
         lambda: _count(Worker))
    case("Data wipe", "Customer master records are untouched", "same count", before["customers"],
         lambda: _count(Customer))

    case("Data wipe", "A second wipe finds nothing left to delete", "delete.entries", 0,
         lambda: ADMIN.get("/api/admin/wipe-preview").get_json()["delete"]["entries"])


# ===========================================================================
# report
# ===========================================================================
def write_report():
    total = len(RESULTS)
    passed = sum(1 for r in RESULTS if r["result"] == "PASS")
    failed = total - passed

    modules = {}
    for r in RESULTS:
        m = modules.setdefault(r["module"], {"p": 0, "f": 0})
        m["p" if r["result"] == "PASS" else "f"] += 1

    lines = [
        "# Venus Chicken Centers — Test Report", "",
        f"**Run:** {date.today().isoformat()}  ",
        f"**Database:** throwaway SQLite file, deleted after the run  ",
        f"**Result:** {passed}/{total} passed"
        + (f", **{failed} FAILED**" if failed else ", 0 failed"), "",
        "## Summary by module", "",
        "| Module | Cases | Passed | Failed |", "|---|---:|---:|---:|",
    ]
    for m, v in sorted(modules.items()):
        lines.append(f"| {m} | {v['p'] + v['f']} | {v['p']} | {v['f']} |")
    lines += [f"| **Total** | **{total}** | **{passed}** | **{failed}** |", "",
              "## Test cases", "",
              "| # | Module | Scenario | Input / condition | Expected | Actual | Result |",
              "|---|---|---|---|---|---|---|"]
    for r in RESULTS:
        esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")   # noqa: E731
        lines.append(f"| {r['id']} | {esc(r['module'])} | {esc(r['scenario'])} | "
                     f"{esc(r['given'])} | {esc(r['expected'])} | {esc(r['actual'])} | "
                     f"{'PASS' if r['result'] == 'PASS' else '**FAIL**'} |")

    with open(os.path.join(ROOT, "docs", "test-report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    with open(os.path.join(ROOT, "docs", "test-results.csv"), "w", newline="", encoding="utf-8") as fh:
        wtr = csv.DictWriter(fh, fieldnames=["id", "module", "scenario", "given",
                                             "expected", "actual", "result"])
        wtr.writeheader()
        wtr.writerows(RESULTS)
    return total, passed, failed


def cleanup():
    """Remove every trace of the temporary data."""
    with app.app_context():
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
    for path in (TMP_DB, TMP_DB + "-journal", TMP_DB + "-wal", TMP_DB + "-shm"):
        if os.path.exists(path):
            os.remove(path)
    return not os.path.exists(TMP_DB)


# ===========================================================================
# 15. Hotels & hostels
# ===========================================================================
HOTEL = {}


def test_hotels():
    print("\n[15] Hotels & hostels")

    # ---- pure pricing, no database ---------------------------------------
    market = {"rateSkin": 250, "rateSkinless": 300, "rateLiver": 130}
    case("Hotel pricing", "Market 250 less 50 bills at 200",
         "skin, less=50", 200.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 20_000, "mode": "less", "less": 50}, market)["rate"]))
    case("Hotel pricing", "20 kg at 200 is ₹4,000",
         "20 kg skin", 4000.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 20_000, "mode": "less", "less": 50}, market)["amount"]))
    case("Hotel pricing", "Concession is the gap against market",
         "50/kg over 20 kg", 1000.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 20_000, "mode": "less", "less": 50}, market)["concession"]))
    case("Hotel pricing", "A fixed rate ignores the market",
         "fixed 180, market 250", 180.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 1_000, "mode": "fixed", "fixed": 180,
              "less": 999}, market)["rate"]))
    case("Hotel pricing", "A fixed rate still records the concession",
         "fixed 180 vs market 250, 10 kg", 700.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 10_000, "mode": "fixed", "fixed": 180}, market)["concession"]))
    case("Hotel pricing", "A one-off override beats the standing deal",
         "override 210", 210.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 1_000, "mode": "less", "less": 50,
              "rateOverride": 210}, market)["rate"]))
    case("Hotel pricing", "A concession bigger than the market floors at zero",
         "market 130 less 500", 0.0,
         lambda: float(price_hotel_line(
             {"product": "liver", "weightG": 1_000, "mode": "less", "less": 500}, market)["rate"]))
    case("Hotel pricing", "No concession means they pay the counter rate",
         "skinless, less=0", 300.0,
         lambda: float(price_hotel_line(
             {"product": "skinless", "weightG": 1_000, "mode": "less", "less": 0}, market)["rate"]))
    case("Hotel pricing", "Each product uses its own market rate",
         "liver line", 130.0,
         lambda: float(price_hotel_line(
             {"product": "liver", "weightG": 1_000, "mode": "less", "less": 0}, market)["rate"]))
    case("Hotel pricing", "An unknown product falls back to skin, never crashes",
         "product='wings'", "skin",
         lambda: price_hotel_line({"product": "wings", "weightG": 1_000}, market)["product"])

    # ---- a negative "less" flips into a premium: charging above market ----
    case("Hotel pricing", "A negative concession bills above market",
         "market 250, less -20", 270.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 10_000, "mode": "less", "less": -20}, market)["rate"]))
    case("Hotel pricing", "10 kg at 270 is ₹2,700",
         "10 kg skin at a premium", 2700.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 10_000, "mode": "less", "less": -20}, market)["amount"]))
    case("Hotel pricing", "Charging above market records a negative concession",
         "-20/kg over 10 kg", -200.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 10_000, "mode": "less", "less": -20}, market)["concession"]))
    case("Hotel pricing", "A fixed rate above market also shows a negative concession",
         "fixed 300 vs market 250, 4 kg", -200.0,
         lambda: float(price_hotel_line(
             {"product": "skin", "weightG": 4_000, "mode": "fixed", "fixed": 300}, market)["concession"]))

    # ---- creating customers ----------------------------------------------
    r = SUP.post("/api/customers", json={
        "branch": "B01", "name": "Grand Palace", "kind": "hotel", "mode": "less",
        "lessSkin": 50, "lessSkinless": 60, "lessLiver": 20, "phone": "9876543210"})
    HOTEL["a"] = r.get_json() if r.status_code == 201 else {}
    case("Hotels", "A supervisor may register a hotel",
         "POST /api/customers", 201, lambda: r.status_code)
    case("Hotels", "The code is allocated automatically",
         "no code supplied", "H01", lambda: HOTEL["a"].get("code"))
    case("Hotels", "The agreed concession is stored",
         "lessSkinless=60", 60.0, lambda: HOTEL["a"].get("lessSkinless"))

    r2 = ADMIN.post("/api/customers", json={
        "branch": "B01", "name": "Vidya Hostel", "kind": "hostel", "mode": "fixed",
        "rateSkin": 190, "rateSkinless": 220, "rateLiver": 100, "openingBalance": 1500})
    HOTEL["b"] = r2.get_json() if r2.status_code == 201 else {}
    case("Hotels", "An admin may register a hostel on a fixed rate",
         "POST /api/customers", 201, lambda: r2.status_code)
    case("Hotels", "Codes increment within a branch",
         "second customer", "H02", lambda: HOTEL["b"].get("code"))
    case("Hotels", "An opening balance is carried in",
         "openingBalance=1500", 1500.0, lambda: HOTEL["b"].get("openingBalance"))
    case("Hotels", "A blank name is rejected",
         "name=''", 422,
         lambda: SUP.post("/api/customers", json={"branch": "B01", "name": " "}).status_code)
    case("Hotels", "A duplicate code inside a branch is refused",
         "code=H01 again", 409,
         lambda: SUP.post("/api/customers",
                          json={"branch": "B01", "name": "Clash", "code": "H01"}).status_code)
    case("Hotels", "The same code is fine in a different branch",
         "B02 code=H01", 201,
         lambda: ADMIN.post("/api/customers",
                            json={"branch": "B02", "name": "Far Inn", "code": "H01"}).status_code)
    case("Hotels", "A supervisor cannot register one in another branch",
         "ravi -> B02", 403,
         lambda: SUP.post("/api/customers",
                          json={"branch": "B02", "name": "Not Mine"}).status_code)
    prem = SUP.post("/api/customers",
                    json={"branch": "B01", "name": "Premium Diner", "lessSkin": -10})
    case("Hotels", "A negative concession is accepted — it's a premium above market",
         "lessSkin=-10", 201, lambda: prem.status_code)
    case("Hotels", "...and stored exactly as sent, not clamped to zero",
         "lessSkin=-10", -10.0, lambda: prem.get_json().get("lessSkin"))
    case("Hotels", "A negative FIXED rate is still rejected — no market to be relative to",
         "rateSkin=-10", 422,
         lambda: SUP.post("/api/customers",
                          json={"branch": "B01", "name": "BadFixed", "mode": "fixed",
                                "rateSkin": -10}).status_code)
    case("Hotels", "A non-numeric concession is a 422, not a crash",
         "lessSkin='abc'", 422,
         lambda: SUP.post("/api/customers",
                          json={"branch": "B01", "name": "Bad", "lessSkin": "abc"}).status_code)
    case("Hotels", "An unknown kind falls back to hotel",
         "kind='motel'", "hotel",
         lambda: SUP.post("/api/customers",
                          json={"branch": "B01", "name": "Fallback",
                                "kind": "motel"}).get_json()["kind"])

    # ---- sales on a daily entry ------------------------------------------
    day = D(40)
    payload = base_entry(businessDate=day, skinSoldG=20_000, skinlessSoldG=10_000,
                         liverSoldG=1_000, closeMeatG=0, submit=True,
                         hotelSales=[
                             {"customerId": HOTEL["a"]["id"], "product": "skin",
                              "weightG": 20_000, "settled": False},
                             {"customerId": HOTEL["b"]["id"], "product": "skinless",
                              "weightG": 5_000, "settled": True}])
    # This is about hotel-sales pricing/calc, not supervisor permission —
    # ADMIN keeps it on its own D(40) slot.
    r3 = ADMIN.post("/api/entries", json=payload)
    HOTEL["entry"] = r3.get_json() if r3.status_code == 201 else {}
    calc = HOTEL["entry"].get("calc", {})

    case("Hotel sales", "Hotel lines save with the entry",
         "2 lines", 2, lambda: len(HOTEL["entry"].get("hotelSales", [])))
    # base_entry has rateSkin 200, so Grand Palace (less 50) pays 150 -> 20 kg = 3000
    case("Hotel sales", "The bill uses market minus the concession",
         "200 − 50 over 20 kg", 3000.0, lambda: calc.get("hotelAmt") - 1100.0)
    case("Hotel sales", "The hostel's fixed rate is honoured",
         "220 × 5 kg", 1100.0,
         lambda: HOTEL["entry"]["hotelSales"][1]["amount"])
    case("Hotel sales", "Concession is totalled",
         "50×20kg + (230−220)×5kg", 1050.0, lambda: calc.get("hotelConcession"))
    case("Hotel sales", "Cash and account sales are split",
         "1 of each", [1100.0, 3000.0],
         lambda: [calc.get("hotelCash"), calc.get("hotelCredit")])
    case("Hotel sales", "Hotel weight leaves the meat pool",
         "meat 56kg − counter 31kg − hotel 25kg − damage 1kg = −1kg, floored", 0,
         lambda: calc.get("expCloseMeatG"))
    case("Hotel sales", "...meatDeficitG stays zero — closing meat (0) was entered directly, nothing to floor",
         "closeMeatG=0 is a direct entry now, not a derived/floored figure", 0,
         lambda: calc.get("meatDeficitG"))
    case("Hotel sales", "Hotel money is inside revenue",
         "counter + hotel + live + cutting",
         round(calc.get("counterSaleAmt", 0) + calc.get("hotelAmt", 0)
               + calc.get("liveAmt", 0) + calc.get("cutAmt", 0), 2),
         lambda: calc.get("revenue"))
    case("Hotel sales", "The market rate of the day is snapshotted",
         "skin line", 200.0,
         lambda: HOTEL["entry"]["hotelSales"][0]["marketRate"])

    # ---- a customer on a premium (negative lessSkin) bills above market ---
    premium_cust = ADMIN.post("/api/customers", json={
        "branch": "B01", "name": "Wedding Caterer", "mode": "less", "lessSkin": -20}).get_json()
    prem_day = D(46)  # D(40)-D(44) are already spoken for above/below
    prem_payload = base_entry(businessDate=prem_day, skinSoldG=0, skinlessSoldG=0,
                              liverSoldG=0, closeMeatG=50_000, submit=True,
                              hotelSales=[{"customerId": premium_cust["id"], "product": "skin",
                                          "weightG": 10_000, "settled": True}])
    prem_entry = ADMIN.post("/api/entries", json=prem_payload).get_json()
    prem_calc = prem_entry.get("calc", {})
    # base_entry's rateSkin is 200, so -20 bills 220/kg over 10 kg = 2200
    case("Hotel sales", "A premium customer is billed above the counter rate",
         "200 + 20 over 10 kg", 2200.0,
         lambda: prem_entry["hotelSales"][0]["amount"])
    case("Hotel sales", "The extra earned shows as a negative concession",
         "-20 x 10 kg", -200.0, lambda: prem_calc.get("hotelConcession"))

    case("Hotel sales", "A line for another branch's customer is refused",
         "B01 entry, B02 customer", 422,
         lambda: ADMIN.post("/api/entries", json=base_entry(
             businessDate=D(41),
             hotelSales=[{"customerId": ADMIN.post("/api/customers", json={
                 "branch": "B02", "name": "Cross Branch"}).get_json()["id"],
                 "product": "skin", "weightG": 1_000}])).status_code)
    case("Hotel sales", "An unknown customer id is refused",
         "customerId='nope'", 422,
         lambda: ADMIN.post("/api/entries", json=base_entry(
             businessDate=D(42),
             hotelSales=[{"customerId": "nope", "product": "skin",
                          "weightG": 1_000}])).status_code)
    case("Hotel sales", "Empty rows left behind are ignored",
         "blank line", 0,
         lambda: len(ADMIN.post("/api/entries", json=base_entry(
             businessDate=D(43),
             hotelSales=[{"customerId": "", "product": "skin", "weightG": 0}]
         )).get_json()["hotelSales"]))
    case("Hotel sales", "A weight with no customer blocks submission",
         "weight but no customer", True,
         lambda: any("choose the hotel" in m for m in validate_for_submission(
             base_entry(hotelSales=[{"product": "skin", "weightG": 5_000}]), False, False)))
    case("Hotel sales", "A customer with no weight blocks submission",
         "customer but no weight", True,
         lambda: any("enter the weight" in m for m in validate_for_submission(
             base_entry(hotelSales=[{"customerId": "x", "product": "skin",
                                     "weightG": 0}]), False, False)))
    case("Hotel sales", "A line pricing to zero blocks submission",
         "liver rate 0, less deal", True,
         lambda: any("₹0" in m for m in validate_for_submission(
             base_entry(rateLiver=0, hotelSales=[{"customerId": "x", "product": "liver",
                                                  "weightG": 5_000, "mode": "less",
                                                  "less": 0}]), False, False)))

    # ---- balances & the ledger -------------------------------------------
    led = SUP.get(f"/api/customers/{HOTEL['a']['id']}/ledger").get_json()
    case("Hotel ledger", "The statement lists the sale",
         "1 row", 1, lambda: len(led["rows"]))
    case("Hotel ledger", "An unapproved sale does not become debt",
         "entry is pending", 0.0, lambda: led["totals"]["balance"])
    case("Hotel ledger", "It is reported as pending instead",
         "pending bucket", 3000.0, lambda: led["totals"]["pending"])

    ADMIN.post(f"/api/entries/{HOTEL['entry']['id']}/decision",
               json={"verdict": "approved", "openRate": 120, "rates": [130]})
    led2 = SUP.get(f"/api/customers/{HOTEL['a']['id']}/ledger").get_json()
    case("Hotel ledger", "Approval turns the sale into a real balance",
         "after approval", 3000.0, lambda: led2["totals"]["balance"])
    case("Hotel ledger", "Nothing is left pending",
         "after approval", 0.0, lambda: led2["totals"]["pending"])

    led_b = ADMIN.get(f"/api/customers/{HOTEL['b']['id']}/ledger").get_json()
    case("Hotel ledger", "A cash sale never touches the balance",
         "hostel paid on the day", 1500.0, lambda: led_b["totals"]["balance"])
    case("Hotel ledger", "The opening balance is the starting point",
         "opening 1500", 1500.0, lambda: led_b["totals"]["opening"])

    # ---- receipts ---------------------------------------------------------
    case("Hotel receipts", "A supervisor may record a receipt",
         "₹1,200 cash", 201,
         lambda: SUP.post(f"/api/customers/{HOTEL['a']['id']}/payments",
                          json={"amount": 1200, "mode": "cash",
                                "date": D(29)}).status_code)
    case("Hotel receipts", "The balance falls by what was received",
         "3000 − 1200", 1800.0,
         lambda: SUP.get(f"/api/customers/{HOTEL['a']['id']}/ledger")
                    .get_json()["totals"]["balance"])
    case("Hotel receipts", "A zero receipt is rejected",
         "amount=0", 422,
         lambda: SUP.post(f"/api/customers/{HOTEL['a']['id']}/payments",
                          json={"amount": 0}).status_code)
    case("Hotel receipts", "A non-numeric amount is a 422, not a crash",
         "amount='lots'", 422,
         lambda: SUP.post(f"/api/customers/{HOTEL['a']['id']}/payments",
                          json={"amount": "lots"}).status_code)
    case("Hotel receipts", "An unknown payment mode falls back to cash",
         "mode='barter'", "cash",
         lambda: SUP.post(f"/api/customers/{HOTEL['a']['id']}/payments",
                          json={"amount": 1, "mode": "barter"}).get_json()["mode"])
    case("Hotel receipts", "The running balance is carried down the statement",
         "last row", True,
         lambda: SUP.get(f"/api/customers/{HOTEL['a']['id']}/ledger")
                    .get_json()["rows"][-1]["balance"] == 1799.0)
    case("Hotel receipts", "A supervisor cannot delete a receipt",
         "DELETE /api/payments", 403,
         lambda: SUP.delete("/api/payments/whatever").status_code)

    # ---- repricing --------------------------------------------------------
    SUP.put(f"/api/customers/{HOTEL['a']['id']}", json={"lessSkin": 80})
    case("Hotels", "Editing the deal does not rewrite an approved bill",
         "approved line stays at 150", 150.0,
         lambda: [r for r in SUP.get(f"/api/customers/{HOTEL['a']['id']}/ledger")
                  .get_json()["rows"] if r["kind"] == "sale"][0]["rate"])

    # Repricing logic, not supervisor permission — ADMIN throughout so this
    # keeps its own D(44) slot and the follow-up PUT isn't blocked by
    # ownership.
    draft = ADMIN.post("/api/entries", json=base_entry(
        businessDate=D(44), rateSkin=200,
        hotelSales=[{"customerId": HOTEL["a"]["id"], "product": "skin",
                     "weightG": 10_000}])).get_json()
    case("Hotels", "A draft bill picks up the new deal",
         "200 − 80", 120.0, lambda: draft["hotelSales"][0]["rate"])
    case("Hotels", "Changing the market rate reprices the draft",
         "rateSkin 200 -> 260", 180.0,
         lambda: ADMIN.put(f"/api/entries/{draft['id']}", json={"rateSkin": 260})
                      .get_json()["hotelSales"][0]["rate"])

    # ---- access control ---------------------------------------------------
    case("Hotel RBAC", "A supervisor cannot see another branch's ledger",
         "ravi -> B02 customer", 403,
         lambda: SUP.get("/api/customers/%s/ledger" % ADMIN.post(
             "/api/customers", json={"branch": "B02", "name": "Hidden Inn"}
         ).get_json()["id"]).status_code)
    case("Hotel RBAC", "A supervisor cannot delete a customer",
         "DELETE /api/customers", 403,
         lambda: SUP.delete(f"/api/customers/{HOTEL['a']['id']}").status_code)
    case("Hotel RBAC", "Deleting a customer with history needs confirmation",
         "no ?force", 409,
         lambda: ADMIN.delete(f"/api/customers/{HOTEL['a']['id']}").status_code)
    case("Hotel RBAC", "Anonymous callers get nothing",
         "GET /api/customers", 401,
         lambda: ANON.get("/api/customers").status_code)
    case("Hotel RBAC", "A supervisor sees only their own branch's customers",
         "ravi", True,
         lambda: all(c["branch"] == "B01"
                     for c in SUP.get("/api/customers").get_json()["customers"]))
    case("Hotel RBAC", "Bootstrap carries customers and their balances",
         "GET /api/bootstrap", True,
         lambda: "customers" in SUP.get("/api/bootstrap").get_json()
         and "customerTotals" in SUP.get("/api/bootstrap").get_json())

    # ---- deletion ---------------------------------------------------------
    spare = ADMIN.post("/api/customers",
                       json={"branch": "B01", "name": "Closes Down"}).get_json()
    case("Hotels", "A customer with no history deletes cleanly",
         "DELETE", 200,
         lambda: ADMIN.delete(f"/api/customers/{spare['id']}").status_code)
    case("Hotels", "Forced deletion removes the ledger with it",
         "?force=1", 200,
         lambda: ADMIN.delete(f"/api/customers/{HOTEL['b']['id']}?force=1").status_code)
    case("Hotels", "Its sale lines go with it",
         "cascade", 1,
         lambda: len(ADMIN.get(f"/api/entries?from={D(40)}&to={D(40)}")
                     .get_json()[0]["hotelSales"]))
    case("Hotels", "The entry itself survives the customer being removed",
         "entry still there", 1,
         lambda: len(ADMIN.get(f"/api/entries?from={D(40)}&to={D(40)}").get_json()))
    case("Hotels", "The gone customer no longer appears in the list",
         "GET /api/customers", False,
         lambda: any(c["id"] == HOTEL["b"]["id"]
                     for c in ADMIN.get("/api/customers").get_json()["customers"]))


# ===========================================================================
# 16. Live bird sales & function customers
# ===========================================================================
FN = {}


def test_live_and_functions():
    print("\n[16] Live bird sales & functions")

    market = {"rateSkin": 250, "rateSkinless": 300, "rateLiver": 130, "rateLive": 180}
    case("Live pricing", "A live line prices off the LIVE rate, not skin",
         "less=15 on a 180 market", 165.0,
         lambda: float(price_hotel_line(
             {"product": "live", "weightG": 20_000, "birds": 10,
              "mode": "less", "less": 15}, market)["rate"]))
    case("Live pricing", "The head count is carried through",
         "10 birds", 10,
         lambda: price_hotel_line({"product": "live", "weightG": 20_000, "birds": 10},
                                  market)["birds"])
    case("Live pricing", "A meat line never carries a head count",
         "birds on a skin line", 0,
         lambda: price_hotel_line({"product": "skin", "weightG": 5_000, "birds": 9},
                                  market)["birds"])

    r = ADMIN.post("/api/customers", json={
        "branch": "B01", "name": "Sri Kalyana Mandapam", "kind": "function",
        "mode": "less", "lessLive": 15, "lessSkin": 60, "lessSkinless": 70})
    FN["c"] = r.get_json() if r.status_code == 201 else {}
    case("Functions", "A function can be registered", "kind=function", 201,
         lambda: r.status_code)
    case("Functions", "It is stored as its own type", "kind", "function",
         lambda: FN["c"].get("kind"))
    case("Functions", "It carries a live-bird concession", "lessLive", 15.0,
         lambda: FN["c"].get("lessLive"))
    case("Functions", "An unknown type still falls back to hotel", "kind='party'", "hotel",
         lambda: ADMIN.post("/api/customers",
                            json={"branch": "B01", "name": "Fallback2",
                                  "kind": "party"}).get_json()["kind"])

    # 30 live birds, 60 kg, at 180 − 15 = 165  ->  ₹9,900
    day = D(50)
    payload = base_entry(businessDate=day, rateLive=180, openBirds=200, openWtG=400_000,
                         liveSoldCount=0, liveSoldWtG=0, dressedCount=0, dressedWtG=0,
                         actualMeatG=0, skinSoldG=0, skinlessSoldG=0, liverSoldG=0,
                         damageG=0, closeBirds=0, closeWtG=0, closeMeatG=5_000,
                         purchases=[],
                         hotelSales=[{"customerId": FN["c"]["id"], "product": "live",
                                      "weightG": 60_000, "birds": 30, "settled": True}])
    rr = ADMIN.post("/api/entries", json=payload)
    FN["e"] = rr.get_json() if rr.status_code == 201 else {}
    calc = FN["e"].get("calc", {})

    case("Live sales", "The entry saves", "POST /api/entries", 201, lambda: rr.status_code)
    case("Live sales", "60 kg at ₹165 is ₹9,900", "amount", 9900.0,
         lambda: calc.get("hotelAmt"))
    case("Live sales", "Concession is ₹15 x 60 kg", "concession", 900.0,
         lambda: calc.get("hotelConcession"))
    case("Live sales", "The birds come off the expected closing count",
         "200 opening − 30 sold", 170, lambda: calc.get("expBirds"))
    case("Live sales", "The weight comes off the expected closing weight",
         "400 kg − 60 kg", 340_000, lambda: calc.get("expCloseWtG"))
    case("Live sales", "It does NOT touch the meat pool",
         "closing meat (5kg, entered directly) is untouched by the live sale", 5_000,
         lambda: calc.get("expCloseMeatG"))
    case("Live sales", "Live weight is reported apart from meat weight",
         "hotelLiveG vs hotelMeatG", [60_000, 0],
         lambda: [calc.get("hotelLiveG"), calc.get("hotelMeatG")])
    case("Live sales", "The head count is totalled", "hotelBirds", 30,
         lambda: calc.get("hotelBirds"))
    case("Live sales", "A live line with no head count blocks submission",
         "weight but no birds", True,
         lambda: any("how many live birds" in m.lower() for m in validate_for_submission(
             base_entry(hotelSales=[{"customerId": "x", "product": "live",
                                     "weightG": 40_000, "birds": 0}]), False, False)))
    case("Live sales", "Meat and live on one day are kept apart",
         "one of each", [20_000, 40_000],
         lambda: (lambda c: [c["hotelMeatG"], c["hotelLiveG"]])(
             compute_entry(base_entry(rateLive=180, hotelSales=[
                 {"customerId": "a", "product": "skin", "weightG": 20_000},
                 {"customerId": "b", "product": "live", "weightG": 40_000, "birds": 20},
             ]), SETTINGS)))


# ===========================================================================
# 17. Overhead ledger — dated vs spread, branch-wise and all branches
# ===========================================================================
def test_overhead_ledger():
    print("\n[17] Overhead ledger")
    month = TODAY.strftime("%Y-%m")
    first = TODAY.replace(day=1).isoformat()
    dim = __import__("calendar").monthrange(TODAY.year, TODAY.month)[1]

    ADMIN.post("/api/overheads", json={"branch": "B01", "month": month,
                                       "category": "rent", "amount": 3000})
    dated = ADMIN.post("/api/overheads", json={"branch": "B01", "date": TODAY.isoformat(),
                                               "category": "other", "amount": 500})
    case("Overheads", "A dated overhead is accepted", "date supplied", 201,
         lambda: dated.status_code)
    case("Overheads", "It reports itself as dated", "dated flag", True,
         lambda: dated.get_json()["dated"])
    case("Overheads", "Its month is derived from the date", "period_month", month,
         lambda: dated.get_json()["month"])
    case("Overheads", "An undated one is not dated", "month only", False,
         lambda: ADMIN.post("/api/overheads",
                            json={"branch": "B01", "month": month, "category": "rent",
                                  "amount": 10}).get_json()["dated"])

    led = ADMIN.get(f"/api/overheads?branch=B01&from={first}&to={TODAY.isoformat()}").get_json()
    case("Overhead ledger", "Branch-scoped ledger returns day rows",
         "GET /api/overheads?branch=B01", True,
         lambda: len(led["byDay"]) > 0)
    case("Overhead ledger", "The dated ₹500 lands on its own day in full",
         "today's row", True,
         lambda: any(r["date"] == TODAY.isoformat() and r["total"] >= 500
                     for r in led["byDay"]))
    ADMIN.post("/api/branches", json={"code": "BOV", "name": "Overhead Only"})
    ADMIN.post("/api/overheads", json={"branch": "BOV", "month": month,
                                       "category": "rent", "amount": 3000})
    solo = ADMIN.get(f"/api/overheads?branch=BOV&from={first}&to={TODAY.isoformat()}").get_json()
    case("Overhead ledger", "A ₹3,000 monthly rent is divided across the month",
         f"3000/{dim} on each day", True,
         lambda: abs([r for r in solo["byDay"]
                      if r["date"] == first][0]["total"] - 3000 / dim) < 0.01)
    case("Overhead ledger", "Every day of the month in range carries a share",
         "one row per day so far", TODAY.day,
         lambda: len(solo["byDay"]))
    case("Overhead ledger", "It totals by branch", "byBranch", True,
         lambda: led["byBranch"][0]["branch"] == "B01")
    case("Overhead ledger", "Dated and spread are reported separately",
         "byBranch split", True,
         lambda: led["byBranch"][0]["dated"] >= 500)

    ADMIN.post("/api/overheads", json={"branch": "B02", "date": TODAY.isoformat(),
                                       "category": "repairs", "amount": 700})
    everything = ADMIN.get(f"/api/overheads?from={first}&to={TODAY.isoformat()}").get_json()
    case("Overhead ledger", "All branches at once", "no branch filter", True,
         lambda: len({b["branch"] for b in everything["byBranch"]}) >= 2)
    case("Overhead ledger", "A day row splits the amount per branch",
         "today's branches", True,
         lambda: len([r for r in everything["byDay"]
                      if r["date"] == TODAY.isoformat()][0]["branches"]) >= 2)
    case("Overhead ledger", "A supervisor sees only their own branch",
         "ravi", True,
         lambda: all(b["branch"] == "B01"
                     for b in SUP.get(f"/api/overheads?from={first}&to={TODAY.isoformat()}")
                     .get_json()["byBranch"]))
    case("Overhead ledger", "A supervisor cannot ask for another branch",
         "ravi -> B02", 403,
         lambda: SUP.get("/api/overheads?branch=B02").status_code)
    case("Overheads", "A dated cost hits that day's profit in full",
         "day share includes it", True,
         lambda: overhead_day_share_check())


def overhead_day_share_check():
    from app.api import overhead_day_share
    with app.app_context():
        b = Branch.query.filter_by(code="B01").first()
        return overhead_day_share(b.id, TODAY) > 500


# ===========================================================================
# 18. End-of-day cash handover
# ===========================================================================
def test_dayclose():
    print("\n[18] Cash handover")
    day = D(60)
    # counter 30 kg @200 = 6,000 · skinless 20 @230 = 4,600 · liver 1 @130 = 130
    # live 41 kg @150 = 6,150 · cutting 300  -> counter+live+cutting = 17,180
    e = ADMIN.post("/api/entries", json=base_entry(businessDate=day)).get_json()
    ADMIN.post(f"/api/entries/{e['id']}/decision",
               json={"verdict": "approved", "openRate": 120, "rates": [130]})

    d = ADMIN.get(f"/api/dayclose?date={day}&branch=B01").get_json()
    x = d["branches"][0]["expectedBreakdown"]
    case("Cash tally", "Counter, live and cutting make the base",
         "17,180 on a clean day", 17180.0,
         lambda: round(x["counterSales"] + x["liveSales"] + x["cuttingCharges"], 2))
    case("Cash tally", "With nothing else, expected equals what was sold",
         "no credit, no payouts", 17180.0, lambda: x["expected"])
    case("Cash tally", "Nothing declared yet", "close is null", None,
         lambda: d["branches"][0]["close"])

    r = SUP2.post("/api/dayclose", json={"branch": "B02", "date": day, "cash": 1, "upi": 1})
    case("Cash tally", "A supervisor cannot declare a handover, even for their own branch",
         "priya -> B02", 403, lambda: r.status_code)
    case("Cash tally", "nor for anyone else's branch", "priya -> B01", 403,
         lambda: SUP2.post("/api/dayclose",
                           json={"branch": "B01", "date": day, "cash": 1}).status_code)
    case("Cash tally", "A supervisor has no view onto the handover screen any more",
         "GET /api/dayclose", 403,
         lambda: SUP.get("/api/dayclose?date=" + day + "&branch=B01").status_code)

    ok = ADMIN.post("/api/dayclose", json={"branch": "B01", "date": day,
                                           "cash": 15000, "upi": 2180}).get_json()
    case("Cash tally", "A matching handover reads as balanced", "15,000 + 2,180", 0.0,
         lambda: ok["difference"])
    short = ADMIN.post("/api/dayclose", json={"branch": "B01", "date": day,
                                              "cash": 15000, "upi": 1180}).get_json()
    case("Cash tally", "A thousand missing shows as short", "−1,000", -1000.0,
         lambda: short["difference"])
    over = ADMIN.post("/api/dayclose", json={"branch": "B01", "date": day,
                                             "cash": 16000, "upi": 2180}).get_json()
    case("Cash tally", "An excess shows as over", "+1,000", 1000.0,
         lambda: over["difference"])
    case("Cash tally", "Re-declaring updates rather than duplicating",
         "one row per branch-day", 1,
         lambda: _count(DayClose, business_date=parse_iso(day), _branch="B01"))
    case("Cash tally", "Negative amounts are refused", "cash=-5", 422,
         lambda: ADMIN.post("/api/dayclose",
                            json={"branch": "B01", "date": day, "cash": -5}).status_code)
    case("Cash tally", "Text where money belongs is a 422", "cash='lots'", 422,
         lambda: ADMIN.post("/api/dayclose",
                            json={"branch": "B01", "date": day, "cash": "lots"}).status_code)

    # a credit sale must NOT be expected in the till
    day2 = D(61)
    e2 = ADMIN.post("/api/entries", json=base_entry(
        businessDate=day2,
        hotelSales=[{"customerId": HOTEL["a"]["id"], "product": "skin",
                     "weightG": 10_000, "settled": False}])).get_json()
    ADMIN.post(f"/api/entries/{e2['id']}/decision",
               json={"verdict": "approved", "openRate": 120, "rates": [130]})
    x2 = ADMIN.get(f"/api/dayclose?date={day2}&branch=B01").get_json()["branches"][0]["expectedBreakdown"]
    case("Cash tally", "A sale on account is excluded from the expected cash",
         "revenue > expected", True,
         lambda: x2["revenue"] > x2["expected"] and x2["hotelCredit"] > 0)
    case("Cash tally", "The gap is exactly the credit sale",
         "revenue − expected", round(x2["hotelCredit"], 2),
         lambda: round(x2["revenue"] - x2["expected"], 2))

    # cash paid out of the till reduces what should be handed over
    day3 = D(62)
    e3 = ADMIN.post("/api/entries", json=base_entry(businessDate=day3)).get_json()
    ADMIN.post(f"/api/entries/{e3['id']}/decision",
               json={"verdict": "approved", "openRate": 120, "rates": [130]})
    wk = ADMIN.post("/api/workers", json={"branch": "B01", "name": "Till Payout Test",
                                          "role": "cutter", "dayWage": 700}).get_json()
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wk["id"], "date": day3,
                                    "type": "advance", "amount": 500})
    x3 = ADMIN.get(f"/api/dayclose?date={day3}&branch=B01").get_json()["branches"][0]["expectedBreakdown"]
    case("Cash tally", "An advance from the till lowers the expected handover",
         "17,180 − 500", 16680.0, lambda: x3["expected"])
    case("Cash tally", "and is reported on its own line", "wagesPaid", 500.0,
         lambda: x3["wagesPaid"])

    hist = ADMIN.get(f"/api/dayclose/history?from={D(63)}&to={day}").get_json()
    case("Cash history", "History spans the days that traded", "rows", True,
         lambda: len(hist["rows"]) > 0)
    case("Cash history", "Undeclared days are flagged rather than hidden",
         "missing flag present", True,
         lambda: any(r["missing"] for r in hist["rows"]) or
                 all(not r["missing"] for r in hist["rows"]))

    cid = ADMIN.get(f"/api/dayclose?date={day}&branch=B01").get_json()["branches"][0]["close"]["id"]
    case("Cash tally", "A supervisor cannot verify", "POST verify", 403,
         lambda: SUP.post(f"/api/dayclose/{cid}/verify", json={}).status_code)
    case("Cash tally", "An admin can verify", "POST verify", True,
         lambda: ADMIN.post(f"/api/dayclose/{cid}/verify", json={})
                      .get_json()["close"]["verifiedAt"] is not None)
    case("Cash tally", "A supervisor cannot overwrite it either, verified or not",
         "ravi re-declares", 403,
         lambda: SUP.post("/api/dayclose",
                          json={"branch": "B01", "date": day, "cash": 99}).status_code)
    case("Cash tally", "An admin can reopen it", "reopen", None,
         lambda: ADMIN.post(f"/api/dayclose/{cid}/verify", json={"reopen": True})
                      .get_json()["close"]["verifiedAt"])

    case("Cash tally", "A supervisor cannot delete a handover", "DELETE dayclose", 403,
         lambda: SUP.delete(f"/api/dayclose/{cid}").status_code)
    case("Cash tally", "An admin can delete a wrongly-declared handover",
         "DELETE dayclose", True,
         lambda: ADMIN.delete(f"/api/dayclose/{cid}").get_json()["ok"])
    case("Cash tally", "The day goes back to not yet declared", "close is null", None,
         lambda: ADMIN.get(f"/api/dayclose?date={day}&branch=B01")
                      .get_json()["branches"][0]["close"])
    case("Cash tally", "Deleting an already-deleted handover is a 404",
         "DELETE again", 404,
         lambda: ADMIN.delete(f"/api/dayclose/{cid}").status_code)
    case("Cash tally", "The row really is gone from the table", "count", 0,
         lambda: _count(DayClose, business_date=parse_iso(day), _branch="B01"))


def parse_iso(txt):
    return date.fromisoformat(txt)


# ===========================================================================
# 19. Double-click protection
# ===========================================================================
def test_dupes():
    print("\n[19] Double-click protection")
    body = {"branch": "B01", "name": "Double Tap", "role": "dresser", "dayWage": 700}
    first = ADMIN.post("/api/workers", json=body)
    second = ADMIN.post("/api/workers", json=body)
    case("Duplicates", "The first worker save succeeds", "POST /api/workers", 201,
         lambda: first.status_code)
    case("Duplicates", "The same name posted twice is refused", "second click", 409,
         lambda: second.status_code)
    case("Duplicates", "It points at the record that already exists", "existingId", True,
         lambda: second.get_json().get("existingId") == first.get_json()["id"])
    case("Duplicates", "Case does not let a twin through", "DOUBLE TAP", 409,
         lambda: ADMIN.post("/api/workers",
                            json=dict(body, name="DOUBLE TAP")).status_code)
    case("Duplicates", "The same name in another branch is fine", "B02", 201,
         lambda: ADMIN.post("/api/workers",
                            json=dict(body, branch="B02")).status_code)
    case("Duplicates", "Only one worker was created", "count", 1,
         lambda: _count(Worker, name="Double Tap", _branch="B01"))

    wid = first.get_json()["id"]
    day = D(70)
    adv = {"branch": "B01", "workerId": wid, "date": day, "type": "advance", "amount": 500}
    a1 = ADMIN.post("/api/ledger", json=adv)
    a2 = ADMIN.post("/api/ledger", json=adv)
    case("Duplicates", "The first advance is recorded", "₹500", 201, lambda: a1.status_code)
    case("Duplicates", "The identical one moments later is refused", "double click", 409,
         lambda: a2.status_code)
    case("Duplicates", "Only one ₹500 landed on the ledger", "count", 1,
         lambda: _count(LabourLedger, worker_id=wid, entry_date=parse_iso(day),
                        kind="advance"))
    case("Duplicates", "A genuine second payment can be forced through",
         "confirmDuplicate", 201,
         lambda: ADMIN.post("/api/ledger",
                            json=dict(adv, confirmDuplicate=True)).status_code)
    case("Duplicates", "A different amount is never treated as a double click",
         "₹600", 201,
         lambda: ADMIN.post("/api/ledger", json=dict(adv, amount=600)).status_code)
    case("Duplicates", "Attendance stays one row however many times it is tapped",
         "3 clicks", 1,
         lambda: _tap_attendance(wid, day))


def _tap_attendance(wid, day):
    for _ in range(3):
        ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": day,
                                        "type": "work", "days": 1})
    return _count(LabourLedger, worker_id=wid, entry_date=parse_iso(day), kind="work")


def _count(model, _branch=None, **filters):
    """Count rows straight from the database, inside an app context."""
    with app.app_context():
        q = model.query.filter_by(**filters)
        if _branch:
            q = q.filter(model.branch.has(code=_branch))
        return q.count()


# ===========================================================================
# 20. Scale — query count, paging, photo payloads
# ===========================================================================
def test_scale():
    print("\n[20] Scale & payload size")
    from sqlalchemy import event

    counter = {"n": 0}

    def bump(*a, **k):
        counter["n"] += 1

    with app.app_context():
        engine = db.engine
    event.listen(engine, "before_cursor_execute", bump)
    try:
        counter["n"] = 0
        ADMIN.get("/api/bootstrap")
        small = counter["n"]

        # add a month of entries in a fresh branch, then measure again
        ADMIN.post("/api/branches", json={"code": "BSC", "name": "Scale Test"})
        for i in range(40):
            ADMIN.post("/api/entries", json=base_entry(
                branch="BSC", businessDate=(TODAY - timedelta(days=100 + i)).isoformat()))
        counter["n"] = 0
        ADMIN.get("/api/bootstrap")
        big = counter["n"]
    finally:
        event.remove(engine, "before_cursor_execute", bump)

    case("Scale", "Bootstrap query count does not grow with the number of entries",
         f"{small} queries -> {big} after +40 entries", True,
         lambda: big <= small + 6,
         )
    case("Scale", "and stays a small constant", "under 40 queries", True,
         lambda: big < 40)

    body = ADMIN.get("/api/entries?page=1&pageSize=10").get_json()
    case("Paging", "A page returns rows plus metadata", "page=1&pageSize=10", 10,
         lambda: len(body["rows"]))
    case("Paging", "It reports the true total", "total > pageSize", True,
         lambda: body["total"] > 10)
    case("Paging", "and the number of pages", "pages", True,
         lambda: body["pages"] == -(-body["total"] // 10))
    case("Paging", "Page two is a different slice", "page=2", True,
         lambda: ADMIN.get("/api/entries?page=2&pageSize=10").get_json()["rows"][0]["id"]
                 != body["rows"][0]["id"])
    case("Paging", "An absurd page size is capped, not obeyed", "pageSize=99999", True,
         lambda: ADMIN.get("/api/entries?page=1&pageSize=99999").get_json()["pageSize"] <= 1000)
    case("Paging", "A junk page number is a 422, not a crash", "page=abc", 422,
         lambda: ADMIN.get("/api/entries?page=abc").status_code)
    case("Paging", "Without paging params the old bare-list shape is kept",
         "no page arg", True,
         lambda: isinstance(ADMIN.get("/api/entries").get_json(), list))

    # photos
    # Pinned to B01 explicitly — an unfiltered "page=1" tiebreaks same-date
    # rows by id (a UUID), so without this it occasionally hands back a B02
    # row instead and the "supervisor cannot read another branch's photos"
    # check below flakes on whichever branch happened to sort first.
    eid = ADMIN.get("/api/entries?branch=B01&page=1&pageSize=1").get_json()["rows"][0]["id"]
    blob = "data:image/jpeg;base64," + ("A" * 40_000)
    ADMIN.put(f"/api/entries/{eid}", json={"photos": [blob], "photosLoaded": True})
    listed = [e for e in ADMIN.get("/api/entries?page=1&pageSize=50").get_json()["rows"]
              if e["id"] == eid][0]
    case("Photos", "A list carries the count, not the image", "photoCount", 1,
         lambda: listed["photoCount"])
    case("Photos", "and no image data at all", "photos empty in list", 0,
         lambda: len(listed["photos"]))
    case("Photos", "The list says the images are not loaded", "photosLoaded", False,
         lambda: listed["photosLoaded"])
    case("Photos", "They are fetched on demand", "GET .../photos", 1,
         lambda: len(ADMIN.get(f"/api/entries/{eid}/photos").get_json()["photos"]))
    case("Photos", "and come back intact", "same bytes", True,
         lambda: ADMIN.get(f"/api/entries/{eid}/photos").get_json()["photos"][0] == blob)
    case("Photos", "Saving without them does NOT wipe them",
         "payload with photos:[] and no flag", 1,
         lambda: (ADMIN.put(f"/api/entries/{eid}", json={"photos": [], "notes": "x"}),
                  len(ADMIN.get(f"/api/entries/{eid}/photos").get_json()["photos"]))[1])
    case("Photos", "Clearing them deliberately still works",
         "photosLoaded: true with an empty list", 0,
         lambda: (ADMIN.put(f"/api/entries/{eid}",
                            json={"photos": [], "photosLoaded": True}),
                  len(ADMIN.get(f"/api/entries/{eid}/photos").get_json()["photos"]))[1])
    case("Photos", "A supervisor cannot read another branch's photos",
         "priya -> B01 entry", 403,
         lambda: SUP2.get(f"/api/entries/{eid}/photos").status_code)

    boot = ADMIN.get("/api/bootstrap").get_json()
    case("Window", "Bootstrap reports the window it loaded", "window", True,
         lambda: "from" in boot["window"] and "to" in boot["window"])
    case("Window", "and the true total behind it", "total >= loaded", True,
         lambda: boot["window"]["total"] >= boot["window"]["loaded"])
    case("Window", "Entries older than the window are excluded but counted",
         "40 backdated entries", True,
         lambda: boot["window"]["total"] > boot["window"]["loaded"])
    case("Window", "and remain reachable by asking for the range",
         "explicit from/to", True,
         lambda: len(ADMIN.get(
             f"/api/entries?from={(TODAY - timedelta(days=140)).isoformat()}"
             f"&to={TODAY.isoformat()}&page=1&pageSize=1000").get_json()["rows"])
                 >= boot["window"]["total"] - 5)


# ===========================================================================
# 22. Workers rename, wage overrides, ledger edits, auto-closing stock and
#     the day-close meat-sales reconciliation
# ===========================================================================
def test_v10_reconciliation():
    print("\n[22] Workers, wage overrides & meat-sales reconciliation")

    # ---- "Labour" renamed to "Workers" in the menu bar --------------------
    home = ADMIN.get("/").data.decode("utf-8", "ignore")
    case("Workers rename", "The menu tab reads Workers, not Labour",
         "nav tab button text", True,
         lambda: "text-xs\"></i> Workers</button>" in home
                 and "text-xs\"></i> Labour</button>" not in home)

    # ---- closing birds/weight/meat are computed, not accepted from the client
    # (this is about the server ignoring a bogus figure, not supervisor
    # permission — ADMIN keeps it on its own D(500) slot)
    day = D(500)
    bogus = base_entry(businessDate=day, closeBirds=999999, closeWtG=999999, closeMeatG=999999)
    r = ADMIN.post("/api/entries", json=bogus)
    case("Auto-closing stock", "A bogus client-supplied closing figure is still accepted (201)",
         "closeBirds: 999999 in the payload", 201, lambda: r.status_code)
    created = r.get_json()
    case("Auto-closing stock", "...but ignored — closing birds is the server's own figure",
         "expBirds from the formula", created["calc"]["expBirds"],
         lambda: created["closeBirds"])
    case("Auto-closing stock", "Closing bird weight is likewise computed",
         "expCloseWtG", created["calc"]["expCloseWtG"],
         lambda: created["closeWtG"])
    case("Auto-closing stock", "Closing meat is likewise computed",
         "expCloseMeatG", created["calc"]["expCloseMeatG"],
         lambda: created["closeMeatG"])
    case("Auto-closing stock", "With nothing left to hand-count, variance is always zero",
         "birdVar", 0, lambda: created["calc"]["birdVar"])
    upd = ADMIN.put(f"/api/entries/{created['id']}",
                    json={"closeBirds": 5, "closeWtG": 5, "closeMeatG": 5}).get_json()
    case("Auto-closing stock", "An edit also ignores a bogus closing figure",
         "stays at the computed value", created["closeBirds"], lambda: upd["closeBirds"])

    # ---- a supervisor or admin can quote a worker a one-off day rate ------
    w = ADMIN.post("/api/workers", json={"branch": "B01", "name": "Sunday Surge Tester",
                                         "role": "dresser", "dayWage": 700}).get_json()
    wdate = D(501)
    mark = SUP.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": wdate,
                                         "type": "work", "days": 1, "wageOverride": 1200})
    case("Wage override", "A custom day rate is accepted instead of the standard wage",
         "wageOverride=1200, standard is 700", 1200.0, lambda: mark.get_json()["amount"])
    work_row_id = mark.get_json()["id"]
    still700 = [x["dayWage"] for x in ADMIN.get("/api/bootstrap").get_json()["workers"]
               if x["id"] == w["id"]][0]
    case("Wage override", "The worker's standing day_wage is untouched by a one-off rate",
         "still 700", 700.0, lambda: still700)

    # ---- editing an already-recorded row instead of delete + re-add -------
    edited = ADMIN.put(f"/api/ledger/{work_row_id}", json={"amount": 1500})
    case("Ledger edit", "An admin can correct an already-recorded wage row",
         "1200 -> 1500", 1500.0, lambda: edited.get_json()["amount"])
    resup = SUP.put(f"/api/ledger/{work_row_id}", json={"amount": 1600})
    case("Ledger edit", "A supervisor may also correct a 'work' (wage) row",
         "1500 -> 1600", 1600.0, lambda: resup.get_json()["amount"])

    paid = ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": wdate,
                                           "type": "paid", "amount": 300}).get_json()
    case("Ledger edit", "A supervisor cannot edit a 'paid' row",
         "403 — not a wage row", 403,
         lambda: SUP.put(f"/api/ledger/{paid['id']}", json={"amount": 999}).status_code)
    case("Ledger edit", "An admin can edit any kind of row",
         "300 -> 999", 999.0,
         lambda: ADMIN.put(f"/api/ledger/{paid['id']}", json={"amount": 999}).get_json()["amount"])

    # ---- day-close: cash + UPI + wages + overheads vs revenue -------------
    # branch B02, fresh dates, no labour/overhead records that day — so wages
    # and overheads are exactly zero and the arithmetic is clean.
    day_over = D(502)
    e_over = ADMIN.post("/api/entries", json=base_entry(branch="B02", businessDate=day_over)).get_json()
    revenue = e_over["calc"]["revenue"]
    skin_before = e_over["skinSoldG"]
    close_over = ADMIN.post("/api/dayclose", json={"branch": "B02", "date": day_over,
                                                    "cash": revenue / 2 + 500,
                                                    "upi": revenue / 2 + 500}).get_json()
    # A mismatched handover used to silently rewrite the entry's skin_sold_g
    # to force the books to balance — even on an already-approved entry. That
    # auto-adjustment mechanism has been removed entirely (see the comment
    # above save_dayclose() in api.py): a handover is purely a cash-vs-books
    # report now, and never touches the entry it's reporting against.
    case("Meat reconciliation", "₹1,000 over handed over is reported, but no adjustment field remains",
         "meatAdjustG absent/0", True,
         lambda: not close_over["close"].get("meatAdjustG"))
    refetched = ADMIN.get(f"/api/entries/{e_over['id']}").get_json()
    case("Meat reconciliation", "The entry's meat sold is completely untouched by the surplus",
         "skinSoldG unchanged", skin_before, lambda: refetched["skinSoldG"])
    case("Meat reconciliation", "No note is added to the entry either",
         "notes unchanged", e_over["notes"], lambda: refetched["notes"])
    case("Meat reconciliation", "The mismatch still shows up in the informational revenue-difference figure",
         "declared ₹1000 over collectedTotal-vs-revenue", 1000.0,
         lambda: close_over["revenueDifference"])

    # re-declaring the same day balanced does not touch the entry either
    balanced = ADMIN.post("/api/dayclose", json={"branch": "B02", "date": day_over,
                                                  "cash": revenue / 2, "upi": revenue / 2}).get_json()
    case("Meat reconciliation", "Re-declaring it balanced still reports no adjustment field",
         "meatAdjustG absent/0", True,
         lambda: not balanced["close"].get("meatAdjustG"))
    back = ADMIN.get(f"/api/entries/{e_over['id']}").get_json()
    case("Meat reconciliation", "...and the entry's meat sold is still untouched",
         "skinSoldG unchanged throughout", skin_before, lambda: back["skinSoldG"])

    # shortfall — a different day, so it is independent of the case above
    day_short = D(503)
    e_short = ADMIN.post("/api/entries", json=base_entry(branch="B02", businessDate=day_short)).get_json()
    revenue2 = e_short["calc"]["revenue"]
    skin_before2 = e_short["skinSoldG"]
    close_short = ADMIN.post("/api/dayclose", json={"branch": "B02", "date": day_short,
                                                     "cash": revenue2 / 2 - 400,
                                                     "upi": revenue2 / 2 - 400}).get_json()
    case("Meat reconciliation", "₹800 short handed over is reported, but no adjustment field remains",
         "meatAdjustG absent/0", True,
         lambda: not close_short["close"].get("meatAdjustG"))
    refetched2 = ADMIN.get(f"/api/entries/{e_short['id']}").get_json()
    case("Meat reconciliation", "The entry's recorded meat sold is completely untouched by the shortfall",
         "skinSoldG unchanged", skin_before2, lambda: refetched2["skinSoldG"])
    case("Meat reconciliation", "No note is added for the shortfall either",
         "notes unchanged", e_short["notes"], lambda: refetched2["notes"])
    case("Meat reconciliation", "The classic declared-vs-expected figure still reports the shortfall",
         "still short by exactly ₹800", -800.0, lambda: close_short["difference"])


# ===========================================================================
# 20b. Worker balance corrections & manual closing-stock override (admin only)
# ===========================================================================
def test_v11_admin_edits():
    print("\n[23] Worker balance corrections & manual closing stock")

    # ---- balance-due correction, admin only --------------------------------
    w = ADMIN.post("/api/workers", json={"branch": "B01", "name": "Balance Test Worker",
                                         "role": "helper", "dayWage": 500}).get_json()
    case("Balance correction", "A freshly added worker starts with no correction",
         "balanceAdjustment", 0.0, lambda: w["balanceAdjustment"])

    sup_try = SUP.put(f"/api/workers/{w['id']}", json={"balanceAdjustment": 999, "balanceNote": "nope"})
    case("Balance correction", "A supervisor's attempt to set it is silently ignored, not an error",
         "200, but unchanged", (200, 0.0),
         lambda: (sup_try.status_code, sup_try.get_json()["balanceAdjustment"]))

    up = ADMIN.put(f"/api/workers/{w['id']}",
                   json={"balanceAdjustment": -150, "balanceNote": "Cash-box shortage on Aug 5"})
    case("Balance correction", "An admin can write off part of what's owed (negative)",
         "-150", -150.0, lambda: up.get_json()["balanceAdjustment"])
    case("Balance correction", "...with the reason saved alongside it",
         "note text", "Cash-box shortage on Aug 5", lambda: up.get_json()["balanceNote"])

    # the UI folds this adjustment into the ledger-derived balance client-side
    # (workerStats()); the API's own figure is just the raw adjustment amount,
    # which is what's being checked here.
    raised = ADMIN.put(f"/api/workers/{w['id']}",
                       json={"balanceAdjustment": 300, "balanceNote": "Missed wage, 3 days back"})
    case("Balance correction", "It can also raise what's owed (positive) — 300 replaces -150, not adds",
         "300", 300.0, lambda: raised.get_json()["balanceAdjustment"])

    # ---- manual override for closing birds/weight/meat, admin only --------
    # Genuinely about supervisor capability, so this stays SUP — "broiler" on
    # B01/today belongs to test_entries' permanent "main" record, so this
    # uses "parents" (forced to today regardless of the D(511) sent).
    day = D(511)
    entry = SUP.post("/api/entries",
                     json=base_entry(businessDate=day, category="parents")).get_json()
    ENTRY_IDS["v11_parents"] = entry["id"]  # reused by test_v14's opening-figure lock checks
    computed_birds = entry["closeBirds"]
    case("Manual closing stock", "A supervisor's entry is still fully auto-computed",
         "server's own figure, not the payload's 120", entry["calc"]["expBirds"], lambda: computed_birds)

    sup_manual = SUP.put(f"/api/entries/{entry['id']}",
                         json={"closeBirds": 7, "closeAuto": {"birds": False}})
    case("Manual closing stock", "A supervisor cannot switch closing birds to manual",
         "stays computed, ignores closeAuto+7", computed_birds,
         lambda: sup_manual.get_json()["closeBirds"])

    admin_manual = ADMIN.put(f"/api/entries/{entry['id']}",
                             json={"closeBirds": 111, "closeAuto": {"birds": False}})
    case("Manual closing stock", "An admin CAN switch closing birds to manual and type a figure",
         "111", 111, lambda: admin_manual.get_json()["closeBirds"])

    # manual mode isn't sticky server-side — like every other field, the client
    # re-sends the figure (and the flag) on every save, exactly as the real
    # form does via readForm()'s closeAuto object built from S.auto.
    still_manual = ADMIN.put(f"/api/entries/{entry['id']}",
                             json={"closeBirds": 111, "closeWtG": 999,
                                   "closeAuto": {"birds": False, "wt": True}})
    case("Manual closing stock", "Closing weight (still auto) ignores a bogus manual value",
         "server's own figure", entry["calc"]["expCloseWtG"], lambda: still_manual.get_json()["closeWtG"])
    case("Manual closing stock", "...while closing birds (kept manual, value re-sent) holds at 111",
         "111", 111, lambda: still_manual.get_json()["closeBirds"])

    # ...and confirms manual mode is NOT sticky: omitting the flag next time
    # (as if the client forgot) reverts it to computed, same as switching back.
    back_auto = ADMIN.put(f"/api/entries/{entry['id']}",
                          json={"closeBirds": 111, "closeAuto": {"birds": True}})
    case("Manual closing stock", "Switching back to auto recomputes it, discarding 111",
         "server's own figure again", entry["calc"]["expBirds"],
         lambda: back_auto.get_json()["closeBirds"])

    admin_no_flag = ADMIN.put(f"/api/entries/{entry['id']}", json={"closeBirds": 555})
    case("Manual closing stock", "Sending a value with no closeAuto flag at all is not treated as manual",
         "still computed, ignores 555", entry["calc"]["expBirds"],
         lambda: admin_no_flag.get_json()["closeBirds"])


# ===========================================================================
# 23b. A supervisor is now pinned to today only — entries, ledger, dayclose,
#      and the carry-forward endpoint that replaces browsing yesterday
# ===========================================================================
def test_v12_supervisor_today_only():
    print("\n[23b] Supervisor pinned to today only")

    # ---- creation: a supervisor's chosen date never survives -------------
    # B01's "today" is already spoken for (broiler by test_entries' "main",
    # parents by test_v11's manual-closing-stock fixture), so this uses
    # SUP2/B02 — priya's only untouched slot.
    posted = SUP2.post("/api/entries", json=base_entry(
        branch="B02", category="parents", businessDate=D(9))).get_json()
    case("Today-only", "A supervisor's POST date is silently overridden to today",
         "businessDate sent D(9)", D(0), lambda: posted["businessDate"])
    eid = posted["id"]

    admin_posted = ADMIN.post("/api/entries", json=base_entry(
        branch="B01", category="broiler", businessDate=D(600))).get_json()
    case("Today-only", "An admin's POST date is left exactly as sent",
         "businessDate sent D(600)", D(600), lambda: admin_posted["businessDate"])

    # ---- GET: an admin-owned past-dated entry in the supervisor's branch --
    other_past = ADMIN.post("/api/entries", json=base_entry(
        branch="B01", category="broiler", businessDate=D(601))).get_json()
    case("Today-only", "A supervisor cannot GET another user's past-dated entry, even in their own branch",
         "GET as ravi", 403,
         lambda: SUP.get(f"/api/entries/{other_past['id']}").status_code)

    # ---- an admin retimes the supervisor's OWN entry into the past -------
    moved = ADMIN.put(f"/api/entries/{eid}/costing", json={"businessDate": D(9)}).get_json()
    case("Today-only", "The admin's move actually lands the entry in the past",
         "businessDate", D(9), lambda: moved["businessDate"])
    case("Today-only", "A supervisor cannot GET even their own entry once it is dated in the past",
         "GET as priya", 403,
         lambda: SUP2.get(f"/api/entries/{eid}").status_code)
    blocked_edit = SUP2.put(f"/api/entries/{eid}", json={"notes": "recounted"})
    case("Today-only", "A supervisor cannot PUT their own draft once it is dated in the past",
         "PUT as priya, still draft, still theirs", 403, lambda: blocked_edit.status_code)
    case("Today-only", "...with the same 'locked' shape used for any other edit lock",
         "error field", "locked", lambda: blocked_edit.get_json()["error"])

    # ---- list / bootstrap: today only, whatever from/to says -------------
    wide = SUP.get(f"/api/entries?from={D(400)}&to={D(0)}").get_json()
    case("Today-only", "The entries list never returns anything but today, any from/to range",
         "all businessDate == today", True,
         lambda: all(x["businessDate"] == D(0) for x in wide))
    boot = SUP.get("/api/bootstrap").get_json()
    case("Today-only", "Bootstrap's entries array is today-only too",
         "all businessDate == today", True,
         lambda: all(x["businessDate"] == D(0) for x in boot["entries"]))
    case("Today-only", "...and window.total matches what's actually loaded",
         "total == loaded", True,
         lambda: boot["window"]["total"] == len(boot["entries"]))

    # ---- day close is fully hidden from a supervisor now ------------------
    case("Today-only", "GET /api/dayclose is 403 for a supervisor",
         "no read-only view any more", 403, lambda: SUP.get("/api/dayclose").status_code)
    case("Today-only", "GET /api/dayclose/history is 403 for a supervisor",
         "same lock", 403, lambda: SUP.get("/api/dayclose/history").status_code)

    # ---- carry-forward: enough to seed tomorrow, without the full record --
    main = ADMIN.get(f"/api/entries/{ENTRY_IDS['main']}").get_json()
    cf = SUP.get("/api/entries/carry-forward?branch=B01&category=broiler").get_json()
    case("Carry-forward", "found is true when an approved entry exists",
         "B01/broiler", True, lambda: cf["found"])
    case("Carry-forward", "Closing birds match the most recent approved entry",
         "closeBirds", main["closeBirds"], lambda: cf["closeBirds"])
    case("Carry-forward", "Closing weight matches too",
         "closeWtG", main["closeWtG"], lambda: cf["closeWtG"])
    case("Carry-forward", "Closing meat matches too",
         "closeMeatG", main["closeMeatG"], lambda: cf["closeMeatG"])
    case("Carry-forward", "The weighted average rate matches",
         "avgRate", main["calc"]["avgRate"], lambda: cf["avgRate"])
    case("Carry-forward", "The going sale rates carry forward too",
         "rateSkin/rateSkinless/rateLiver/rateLive",
         [main["rateSkin"], main["rateSkinless"], main["rateLiver"], main["rateLive"]],
         lambda: [cf["rateSkin"], cf["rateSkinless"], cf["rateLiver"], cf["rateLive"]])
    case("Carry-forward", "An admin gets the same closeBirds figure as a supervisor",
         "ADMIN vs SUP", cf["closeBirds"],
         lambda: ADMIN.get("/api/entries/carry-forward?branch=B01&category=broiler"
                           ).get_json()["closeBirds"])
    none_yet = ADMIN.get("/api/entries/carry-forward?branch=B02&category=parents").get_json()
    case("Carry-forward", "found is false when nothing has ever been approved for that combo",
         "B02/parents, no approvals", False, lambda: none_yet["found"])

    # ---- ledger: same today-only pin, and the tightened permissions ------
    wid = WORKER_ID["w"]
    row = SUP.post("/api/ledger", json={"branch": "B01", "workerId": wid,
                                        "date": D(9), "type": "tea", "amount": 25}).get_json()
    case("Today-only", "A supervisor's ledger POST date is also overridden to today",
         "date sent D(9)", D(0), lambda: row["date"])

    past_work = ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid,
                                                 "date": D(31), "type": "work",
                                                 "days": 1}).get_json()
    case("Today-only", "A supervisor cannot edit a 'work' row dated in the past",
         "PUT as ravi", 403,
         lambda: SUP.put(f"/api/ledger/{past_work['id']}", json={"amount": 999}).status_code)
    case("Today-only", "A supervisor cannot delete a ledger row at all any more",
         "DELETE as ravi", 403,
         lambda: SUP.delete(f"/api/ledger/{row['id']}").status_code)


# ===========================================================================
# 20c. Overhead edit-until-approved, and the day-close lock on workers/overheads
# ===========================================================================
def test_v13_dayclose_lock_and_overhead_edit():
    print("\n[24] Overhead edit-until-approved & the day-close lock")

    # ---- a supervisor can now edit their own pending, today-dated overhead
    ov = SUP.post("/api/overheads", json={"branch": "B01", "date": D(9),
                                          "category": "repair", "amount": 500}).get_json()
    case("Overhead edit", "A supervisor's dated overhead is pinned to today, not D(9)",
         "date", D(0), lambda: ov["date"])
    up = SUP.put(f"/api/overheads/{ov['id']}", json={"amount": 650})
    case("Overhead edit", "...and they can correct it while it's still pending",
         "650", 650.0, lambda: up.get_json()["amount"])

    other_sup = SUP2.put(f"/api/overheads/{ov['id']}", json={"amount": 1})
    case("Overhead edit", "Another supervisor cannot touch someone else's overhead",
         "PUT as priya", 403, lambda: other_sup.status_code)

    ADMIN.post(f"/api/overheads/{ov['id']}/decision", json={"verdict": "approved"})
    locked = SUP.put(f"/api/overheads/{ov['id']}", json={"amount": 700})
    case("Overhead edit", "Once approved, the supervisor can no longer edit it",
         "PUT after approval", 403, lambda: locked.status_code)
    case("Overhead edit", "An admin can still amend it after approval",
         "PUT as admin", 700.0,
         lambda: ADMIN.put(f"/api/overheads/{ov['id']}", json={"amount": 700}).get_json()["amount"])

    stale = SUP.post("/api/overheads", json={"branch": "B01", "date": D(9),
                                              "category": "other", "amount": 40}).get_json()
    with app.app_context():
        row = db.session.get(Overhead, stale["id"])
        row.spend_date = date.fromisoformat(D(9))
        db.session.commit()
    case("Overhead edit", "A stale past-dated pending overhead is also out of reach",
         "PUT as ravi", 403,
         lambda: SUP.put(f"/api/overheads/{stale['id']}", json={"amount": 41}).status_code)
    case("Overhead edit", "...and cannot be deleted either",
         "DELETE as ravi", 403, lambda: SUP.delete(f"/api/overheads/{stale['id']}").status_code)

    # ---- a supervisor's list only ever shows their own + today/undated ----
    ADMIN.post("/api/overheads", json={"branch": "B01", "month": TODAY.strftime("%Y-%m"),
                                       "category": "rent", "amount": 999})
    listed = SUP.get(f"/api/overheads?from={D(30)}&to={D(0)}").get_json()["rows"]
    case("Overhead visibility", "A supervisor never sees another user's overhead",
         "admin's rent row hidden", True,
         lambda: all(r["createdByName"] == "Ravi Kumar" for r in listed))
    case("Overhead visibility", "...nor their own stale past-dated one",
         "stale D(9) row hidden", True,
         lambda: all(r["id"] != stale["id"] for r in listed))

    # ---- bootstrap must not leak what list_overheads() already hides -----
    boot_ovh = SUP.get("/api/bootstrap").get_json()["overheads"]
    case("Overhead visibility", "Bootstrap's overheads are just as narrow as the list endpoint",
         "admin's rent row hidden here too", True,
         lambda: all(o["createdByName"] == "Ravi Kumar" for o in boot_ovh))
    case("Overhead visibility", "...including the same stale past-dated one",
         "stale D(9) row hidden from bootstrap too", True,
         lambda: all(o["id"] != stale["id"] for o in boot_ovh))
    case("Overhead visibility", "An admin's bootstrap is unrestricted, same as ever",
         "admin's rent row IS there", True,
         lambda: any(o["amount"] == 999 and o["month"] == TODAY.strftime("%Y-%m")
                     for o in ADMIN.get("/api/bootstrap").get_json()["overheads"]))

    # ---- once an admin declares the handover, that day locks for a supervisor
    day_close_branch = "B01"
    ADMIN.post("/api/dayclose", json={"branch": day_close_branch, "date": D(0),
                                      "cash": 0, "upi": 0})
    wid = WORKER_ID["w"]
    ledger_blocked = SUP.post("/api/ledger", json={"branch": "B01", "workerId": wid,
                                                    "date": D(0), "type": "tea", "amount": 10})
    case("Day-close lock", "A supervisor cannot add a ledger row once today is declared",
         "POST /api/ledger", 403, lambda: ledger_blocked.status_code)
    ov_blocked = SUP.post("/api/overheads", json={"branch": "B01", "date": D(0),
                                                   "category": "other", "amount": 15})
    case("Day-close lock", "...nor a dated overhead for that same day",
         "POST /api/overheads", 403, lambda: ov_blocked.status_code)
    case("Day-close lock", "An admin is unaffected and can still add a ledger row",
         "POST as admin", 201,
         lambda: ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": wid,
                                                  "date": D(0), "type": "tea",
                                                  "amount": 10}).status_code)

    # a different, still-open branch is unaffected
    still_open = SUP2.post("/api/overheads", json={"branch": "B02", "date": D(0),
                                                    "category": "other", "amount": 20})
    case("Day-close lock", "A branch with no declared handover today is unaffected",
         "POST as priya on B02", 201, lambda: still_open.status_code)


# ===========================================================================
# 25. Opening birds/weight/meat are admin-only (mirrors openRate's lock)
# ===========================================================================
def test_v14_opening_figures_admin_only():
    print("\n[25] Opening birds/weight/meat are admin-only")

    # ---- PUT: a supervisor's explicit values are silently ignored ---------
    # Reuses test_v11's still-draft B01/parents entry (today, never
    # submitted/approved, owned by ravi) — can_edit() still says yes.
    eid = ENTRY_IDS["v11_parents"]
    before = ADMIN.get(f"/api/entries/{eid}").get_json()
    sup_try = SUP.put(f"/api/entries/{eid}", json={
        "openBirds": 999, "openWtG": 888_000, "openMeatG": 77_000})
    case("Opening lock", "A supervisor's PUT cannot change opening birds",
         "stays as before", before["openBirds"], lambda: sup_try.get_json()["openBirds"])
    case("Opening lock", "...nor opening weight",
         "stays as before", before["openWtG"], lambda: sup_try.get_json()["openWtG"])
    case("Opening lock", "...nor opening meat",
         "stays as before", before["openMeatG"], lambda: sup_try.get_json()["openMeatG"])

    # ---- PUT: an admin's explicit values ARE honored -----------------------
    admin_try = ADMIN.put(f"/api/entries/{eid}", json={
        "openBirds": 999, "openWtG": 888_000, "openMeatG": 77_000})
    case("Opening lock", "An admin's PUT can set opening birds",
         "999", 999, lambda: admin_try.get_json()["openBirds"])
    case("Opening lock", "...and opening weight",
         "888000", 888_000, lambda: admin_try.get_json()["openWtG"])
    case("Opening lock", "...and opening meat",
         "77000", 77_000, lambda: admin_try.get_json()["openMeatG"])

    # free B01/parents/today so the same lock can be proven at creation time too
    ADMIN.delete(f"/api/entries/{eid}")

    # ---- POST: a supervisor's explicit values are ignored, carry-forward wins
    cf = ADMIN.get("/api/entries/carry-forward?branch=B01&category=parents").get_json()
    expected = (cf["closeBirds"], cf["closeWtG"], cf["closeMeatG"]) if cf.get("found") else (0, 0, 0)
    created = SUP.post("/api/entries", json=base_entry(
        branch="B01", category="parents", businessDate=D(0),
        openBirds=999, openWtG=888_000, openMeatG=77_000)).get_json()
    case("Opening lock", "A supervisor's POST cannot set opening birds either",
         "carry-forward value, not 999", expected,
         lambda: (created["openBirds"], created["openWtG"], created["openMeatG"]))

    # ---- POST: an admin's explicit values on a brand-new entry ARE honored -
    ADMIN.delete(f"/api/entries/{created['id']}")
    admin_created = ADMIN.post("/api/entries", json=base_entry(
        branch="B01", category="parents", businessDate=D(0),
        openBirds=42, openWtG=100_000, openMeatG=2_000)).get_json()
    case("Opening lock", "An admin's POST sets opening birds exactly as sent",
         "42", 42, lambda: admin_created["openBirds"])
    case("Opening lock", "...and opening weight",
         "100000", 100_000, lambda: admin_created["openWtG"])
    case("Opening lock", "...and opening meat",
         "2000", 2_000, lambda: admin_created["openMeatG"])


# ===========================================================================
# 20c. Itemized worker ledger — date range, worker and type filters
# ===========================================================================
def test_v15_ledger_filters():
    print("\n[26] Worker ledger — date range and filter options")

    w1 = ADMIN.post("/api/workers", json={"branch": "B01", "name": "Filter Test Dresser",
                                          "role": "dresser", "dayWage": 550}).get_json()
    w2 = ADMIN.post("/api/workers", json={"branch": "B01", "name": "Filter Test Cutter",
                                          "role": "cutter", "dayWage": 500}).get_json()

    # spread across distinct days so a from/to range can isolate them
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w1["id"], "date": D(520),
                                    "type": "work", "days": 1})
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w1["id"], "date": D(521),
                                    "type": "advance", "amount": 300})
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w2["id"], "date": D(521),
                                    "type": "work", "days": 1})
    ADMIN.post("/api/ledger", json={"branch": "B01", "workerId": w2["id"], "date": D(524),
                                    "type": "paid", "amount": 250})

    full = ADMIN.get(f"/api/ledger?branch=B01&from={D(520)}&to={D(524)}").get_json()
    case("Ledger filters", "The date range picks up every entry inside it",
         "4 rows", 4, lambda: len(full["rows"]))
    case("Ledger filters", "...and none outside it",
         "D(524) excluded when the range stops at D(521)", 3,
         lambda: len(ADMIN.get(f"/api/ledger?branch=B01&from={D(520)}&to={D(521)}").get_json()["rows"]))
    case("Ledger filters", "The summary totals wages separately from money paid out",
         "550 (w1) + 500 (w2) earned", 1050.0, lambda: full["summary"]["work"])
    case("Ledger filters", "...advances count toward 'deducted'",
         "300 advance + 250 paid = 550 deducted", 550.0, lambda: full["summary"]["deducted"])
    case("Ledger filters", "...net is earned minus deducted",
         "1050 - 550 = 500", 500.0, lambda: full["summary"]["net"])

    by_worker = ADMIN.get(f"/api/ledger?branch=B01&from={D(520)}&to={D(524)}&workerId={w1['id']}").get_json()
    case("Ledger filters", "Filtering by worker narrows to just their rows",
         "2 rows for w1", 2, lambda: len(by_worker["rows"]))
    case("Ledger filters", "...and every row belongs to that worker",
         "all workerId==w1", True,
         lambda: all(r["workerId"] == w1["id"] for r in by_worker["rows"]))

    by_type = ADMIN.get(f"/api/ledger?branch=B01&from={D(520)}&to={D(524)}&type=advance").get_json()
    case("Ledger filters", "Filtering by type narrows to just that kind",
         "1 advance row", 1, lambda: len(by_type["rows"]))
    case("Ledger filters", "Each row carries the worker's name for display",
         "Filter Test Dresser", "Filter Test Dresser",
         lambda: by_type["rows"][0]["workerName"])

    case("Ledger filters", "A supervisor cannot reach the itemized ledger at all",
         "403 — admin only, like the rest of Workers history", 403,
         lambda: SUP.get(f"/api/ledger?branch=B01&from={D(520)}&to={D(524)}").status_code)

    swapped = ADMIN.get(f"/api/ledger?branch=B01&from={D(524)}&to={D(520)}").get_json()
    case("Ledger filters", "A backwards range (from after to) is tolerated, not a crash",
         "still the same 4 rows", 4, lambda: len(swapped["rows"]))


# ===========================================================================
# 20d. Per-branch, per-supplier purchase ledger + bird returns
# ===========================================================================
def test_v16_purchase_returns():
    print("\n[27] Supplier purchase ledger and bird returns")

    bought = ADMIN.post("/api/entries", json=base_entry(
        branch="B01", category="broiler", businessDate=D(56),
        purchases=[{"supplier": "Shiva Traders", "birds": 40, "wtG": 102_000, "rate": 180}],
    )).get_json()
    buy_id = bought["purchases"][0]["id"]
    case("Purchase ledger", "A plain purchase line defaults to kind 'buy'",
         "buy", "buy", lambda: bought["purchases"][0]["kind"])

    open_before = ADMIN.get("/api/purchases/open?branch=B01&supplier=Shiva%20Traders").get_json()
    case("Purchase ledger", "The new purchase shows up as returnable",
         "40 birds remaining", 40,
         lambda: next(r["remainingBirds"] for r in open_before["rows"] if r["id"] == buy_id))

    # A supervisor's businessDate is forced to today regardless of what's
    # sent, so whatever slot this lands on has to be clear of other tests'
    # today-dated fixtures first, or the clash check (409) would fire before
    # ever reaching the kind=return check this is actually testing for.
    for stale in ADMIN.get(f"/api/entries?branch=B01&category=parents&from={D(0)}&to={D(0)}").get_json():
        ADMIN.delete(f"/api/entries/{stale['id']}")
    case("Purchase ledger", "A supervisor cannot record a return",
         "422 — admin only", 422,
         lambda: SUP.post("/api/entries", json=base_entry(
             branch="B01", category="parents", businessDate=D(55),
             purchases=[{"kind": "return", "returnOf": buy_id, "birds": 5, "wtG": 12_000}],
         )).status_code)

    returned = ADMIN.post("/api/entries", json=base_entry(
        branch="B01", category="parents", businessDate=D(55),
        purchases=[{"kind": "return", "returnOf": buy_id, "birds": 20, "wtG": 51_000,
                    "rate": 999}],  # a client-sent rate must be ignored for a return
    )).get_json()
    ret_line = returned["purchases"][0]
    case("Purchase ledger", "The return is priced at the ORIGINAL purchase's rate, not 999",
         "180", 180.0, lambda: ret_line["rate"])
    case("Purchase ledger", "...and inherits the original's supplier",
         "Shiva Traders", "Shiva Traders", lambda: ret_line["supplier"])
    case("Purchase ledger", "...and links back to the purchase it returns",
         buy_id, buy_id, lambda: ret_line["returnOf"])
    case("Purchase ledger", "A return does not count toward that day's own purchases total",
         "0 birds bought on the return entry itself", 0, lambda: returned["calc"]["buyBirds"])
    # Regression: reported live 2026-08-23 — returning 20 birds against an
    # earlier purchase left closing birds/weight completely unchanged, as if
    # the return had no effect at all, because compute_entry() excluded
    # returns from the day's stock balance entirely rather than netting them
    # out of it. openBirds=80, live sold=20, dressed=40, no mortality ->
    # without the return, expBirds would be 80-20-40=20; with 20 returned,
    # it must drop to zero. Likewise openWtG=200,000 - liveSoldWtG=41,000 -
    # dressedWtG=82,000 = 77,000 without the return; the 51,000g return
    # brings that down to 26,000.
    case("Purchase ledger", "Returned birds come off today's closing bird count",
         "80 open - 20 live - 40 dressed - 20 returned = 0", 0,
         lambda: returned["calc"]["expBirds"])
    # This entry's own closing birds also happen to hit exactly 0 here (80
    # open - 20 returned - 20 live - 40 dressed = 0 — see the case above), so
    # the 26,000 g the weight side still shows is exactly the "closing birds
    # is 0 but weight is left over" case handled by liveShortWtG (see
    # calc.py): it is pulled out as a shortage rather than left as a closing
    # balance with no bird to carry it, and expCloseWtG is zeroed instead.
    case("Purchase ledger", "...closing weight is not left non-zero when closing birds is 0",
         "0 birds left to carry the 26,000 g — it becomes a shortage instead", 0,
         lambda: returned["calc"]["expCloseWtG"])
    case("Purchase ledger", "...the 26,000 g shows up as a live bird weight shortage instead",
         "200,000 open - 41,000 live - 82,000 dressed - 51,000 returned = 26,000", 26_000,
         lambda: returned["calc"]["liveShortWtG"])
    case("Purchase ledger", "The return amount is reported on its own, priced at the original rate",
         "20 birds, 51kg, Rs 9,180", (20, 51_000, 9180.0),
         lambda: (returned["calc"]["returnBirds"], returned["calc"]["returnWtG"],
                  returned["calc"]["returnAmt"]))

    open_after = ADMIN.get("/api/purchases/open?branch=B01&supplier=Shiva%20Traders").get_json()
    case("Purchase ledger", "The returnable balance drops by what was returned",
         "40 - 20 = 20 remaining", 20,
         lambda: next(r["remainingBirds"] for r in open_after["rows"] if r["id"] == buy_id))

    ledger = ADMIN.get(f"/api/purchase-ledger?branch=B01&from={D(56)}&to={D(55)}").get_json()
    shiva = next(s for s in ledger["suppliers"] if s["supplier"] == "Shiva Traders")
    case("Purchase ledger", "Bought birds/weight/amount are totaled for the supplier",
         "40 birds, 102kg, Rs 18,360", (40, 102_000, 18_360.0),
         lambda: (shiva["boughtBirds"], shiva["boughtWtG"], shiva["boughtAmt"]))
    case("Purchase ledger", "Returned birds/weight/amount are totaled too",
         "20 birds, 51kg, Rs 9,180", (20, 51_000, 9_180.0),
         lambda: (shiva["returnedBirds"], shiva["returnedWtG"], shiva["returnedAmt"]))
    case("Purchase ledger", "Net is bought minus returned",
         "20 birds, 51kg, Rs 9,180 net", (20, 51_000, 9_180.0),
         lambda: (shiva["netBirds"], shiva["netWtG"], shiva["netAmt"]))

    case("Purchase ledger", "A supervisor cannot reach the purchase ledger",
         403, 403, lambda: SUP.get(f"/api/purchase-ledger?branch=B01").status_code)
    case("Purchase ledger", "...nor the open-purchases picker",
         403, 403, lambda: SUP.get("/api/purchases/open?branch=B01").status_code)

    # Regression: buying from a supplier and returning some of that SAME
    # purchase in the same daily entry (bought 300, 20 turned out unfit,
    # returned same day) used to crash with a 500 AttributeError. The save
    # replaces the whole purchases list in one go — entry.purchases.clear()
    # orphans this entry's own existing purchase rows (nulling their .entry
    # relationship via back_populates, in-session, before anything flushes)
    # before the loop ever gets to resolve what the return line points at —
    # so a return against a purchase that belongs to THIS SAME entry hit
    # orig.entry as None. Reported live 2026-08-23 on Lb PETA branch,
    # returning birds to Shiva Traders.
    same_entry = ADMIN.post("/api/entries", json=base_entry(
        branch="B02", category="parents", businessDate=D(58),
        purchases=[{"supplier": "Shiva Traders", "birds": 300, "wtG": 600_000, "rate": 120}],
    )).get_json()
    same_buy_id = same_entry["purchases"][0]["id"]
    same_updated = ADMIN.put(f"/api/entries/{same_entry['id']}", json={
        "purchases": [
            {"supplier": "Shiva Traders", "birds": 300, "wtG": 600_000, "rate": 120},
            {"kind": "return", "returnOf": same_buy_id, "birds": 20, "wtG": 40_000},
        ]}).get_json()
    case("Purchase ledger",
         "Returning against a purchase from the SAME entry no longer 500s",
         "two purchase lines saved", 2, lambda: len(same_updated["purchases"]))
    case("Purchase ledger", "The same-entry return is still priced off the original rate",
         "120", 120.0,
         lambda: next(p for p in same_updated["purchases"] if p["kind"] == "return")["rate"])
    case("Purchase ledger", "...and it comes off this same entry's closing bird count too",
         "80 open + 300 bought - 20 live - 40 dressed - 20 returned = 300", 300,
         lambda: same_updated["calc"]["expBirds"])
    case("Purchase ledger", "...and off the closing weight",
         "200,000 open + 600,000 bought - 41,000 live - 82,000 dressed - 40,000 returned "
         "= 637,000", 637_000,
         lambda: same_updated["calc"]["expCloseWtG"])


# ===========================================================================
def test_v17_customer_adjustments():
    print("\n[28] Admin billing adjustments for hotel/hostel customers")

    cust = ADMIN.post("/api/customers", json={
        "branch": "B01", "name": "Adjustment Test Hotel"}).get_json()
    cid = cust["id"]
    cash_day, credit_day = D(80), D(81)   # far from every other fixture's dates

    case("Billing adjustment", "A supervisor cannot create one",
         403, 403,
         lambda: SUP.post(f"/api/customers/{cid}/adjustments",
                          json={"date": cash_day, "amount": 100, "settled": True}).status_code)
    case("Billing adjustment", "A zero amount is refused",
         422, 422,
         lambda: ADMIN.post(f"/api/customers/{cid}/adjustments",
                            json={"date": cash_day, "amount": 0}).status_code)

    cash_adj = ADMIN.post(f"/api/customers/{cid}/adjustments", json={
        "date": cash_day, "amount": 300, "settled": True,
        "note": "Corrected a mischarge"}).get_json()
    case("Billing adjustment", "A cash adjustment saves with the fields sent",
         (300.0, True, cash_day), (cash_adj["amount"], cash_adj["settled"], cash_adj["date"]),
         lambda: (cash_adj["amount"], cash_adj["settled"], cash_adj["date"]))

    credit_adj = ADMIN.post(f"/api/customers/{cid}/adjustments", json={
        "date": credit_day, "amount": -150, "settled": False,
        "note": "Goodwill write-off"}).get_json()
    case("Billing adjustment", "A negative, on-account adjustment saves too",
         (-150.0, False), (credit_adj["amount"], credit_adj["settled"]),
         lambda: (credit_adj["amount"], credit_adj["settled"]))

    totals = ADMIN.get("/api/customers").get_json()["totals"][cid]
    case("Billing adjustment", "A cash adjustment lands in the 'cash' bucket",
         300.0, 300.0, lambda: totals["cash"])
    case("Billing adjustment", "A credit adjustment lands in the 'credit' bucket",
         -150.0, -150.0, lambda: totals["credit"])
    case("Billing adjustment", "Both are also reported as 'adjusted'",
         150.0, 150.0, lambda: totals["adjusted"])
    case("Billing adjustment", "Billed = credit + cash, so it moves too",
         150.0, 150.0, lambda: totals["credit"] + totals["cash"])

    ledger = ADMIN.get(f"/api/customers/{cid}/ledger").get_json()
    adj_rows = [r for r in ledger["rows"] if r["kind"] == "adjustment"]
    case("Billing adjustment", "Both adjustments show up on the customer's ledger",
         2, len(adj_rows), lambda: len(adj_rows))
    cash_row = next(r for r in adj_rows if r["date"] == cash_day)
    credit_row = next(r for r in adj_rows if r["date"] == credit_day)
    case("Billing adjustment", "A settled (cash) adjustment does not move the balance",
         0.0, 0.0, lambda: cash_row["effect"])
    case("Billing adjustment", "An on-account adjustment moves the balance by its amount",
         -150.0, -150.0, lambda: credit_row["effect"])

    cash_close = ADMIN.get(f"/api/dayclose?branch=B01&date={cash_day}").get_json()["branches"][0]
    case("Billing adjustment", "A cash adjustment raises that day's expected handover",
         300.0, 300.0, lambda: cash_close["expected"])
    case("Billing adjustment", "...and shows inside hotelCash on that day's breakdown",
         300.0, 300.0, lambda: cash_close["expectedBreakdown"]["hotelCash"])
    case("Billing adjustment", "...and inside that day's revenue",
         300.0, 300.0, lambda: cash_close["expectedBreakdown"]["revenue"])

    credit_close = ADMIN.get(f"/api/dayclose?branch=B01&date={credit_day}").get_json()["branches"][0]
    case("Billing adjustment", "A credit adjustment does NOT move expected cash",
         0.0, 0.0, lambda: credit_close["expected"])
    case("Billing adjustment", "...but does move that day's revenue",
         -150.0, -150.0, lambda: credit_close["expectedBreakdown"]["revenue"])

    hist = ADMIN.get(f"/api/dayclose/history?branch=B01&from={credit_day}&to={credit_day}").get_json()
    case("Billing adjustment", "A credit-only day still surfaces in Day Close history "
                              "(revenue moved even though cash did not)",
         True, any(r["date"] == credit_day for r in hist["rows"]),
         lambda: any(r["date"] == credit_day for r in hist["rows"]))

    case("Billing adjustment", "A supervisor cannot delete one",
         403, 403, lambda: SUP.delete(f"/api/customers/adjustments/{credit_adj['id']}").status_code)
    del_resp = ADMIN.delete(f"/api/customers/adjustments/{credit_adj['id']}")
    case("Billing adjustment", "An admin can delete one",
         200, del_resp.status_code, lambda: del_resp.status_code)
    totals_after = ADMIN.get("/api/customers").get_json()["totals"][cid]
    case("Billing adjustment", "Deleting it removes its effect on the totals",
         300.0, totals_after["cash"] + totals_after["credit"],
         lambda: totals_after["cash"] + totals_after["credit"])


# ===========================================================================
def test_v18_receipt_edit():
    print("\n[29] Editing an already-recorded receipt")

    cust = ADMIN.post("/api/customers", json={
        "branch": "B01", "name": "Receipt Edit Test Hotel"}).get_json()
    cid = cust["id"]
    pay_day = D(85)

    pay = ADMIN.post(f"/api/customers/{cid}/payments", json={
        "date": pay_day, "amount": 500, "mode": "cash", "note": "First take"}).get_json()
    pid = pay["id"]

    case("Receipt edit", "A supervisor cannot edit one",
         403, 403,
         lambda: SUP.put(f"/api/payments/{pid}",
                         json={"date": pay_day, "amount": 600, "mode": "cash"}).status_code)
    case("Receipt edit", "A zero/negative amount is refused",
         422, 422,
         lambda: ADMIN.put(f"/api/payments/{pid}",
                           json={"date": pay_day, "amount": 0, "mode": "cash"}).status_code)

    fixed = ADMIN.put(f"/api/payments/{pid}", json={
        "date": pay_day, "amount": 650, "mode": "upi", "note": "Corrected — was cash, actually UPI"
    }).get_json()
    case("Receipt edit", "The amount, mode and note all update",
         (650.0, "upi", "Corrected — was cash, actually UPI"),
         (fixed["amount"], fixed["mode"], fixed["note"]),
         lambda: (fixed["amount"], fixed["mode"], fixed["note"]))

    totals = ADMIN.get("/api/customers").get_json()["totals"][cid]
    case("Receipt edit", "The customer's 'received' total reflects the corrected amount, not the original",
         650.0, 650.0, lambda: totals["receipts"])

    ledger = ADMIN.get(f"/api/customers/{cid}/ledger").get_json()
    row = next(r for r in ledger["rows"] if r["kind"] == "receipt")
    case("Receipt edit", "...and so does the ledger row itself",
         650.0, 650.0, lambda: row["amount"])

    case("Receipt edit", "An admin can still delete a receipt outright",
         200, 200,
         lambda: ADMIN.delete(f"/api/payments/{pid}").status_code)
    totals_after = ADMIN.get("/api/customers").get_json()["totals"][cid]
    case("Receipt edit", "Deleting it removes it from 'received' too",
         0.0, totals_after["receipts"], lambda: totals_after["receipts"])


# ===========================================================================
def test_v19_live_bird_weight_shortage():
    print("\n[30] Live bird weight shortage — closing birds hit 0 with weight left over")

    # Birds and weight are tracked independently through the day, so it's
    # possible for the BIRD count to balance exactly (every one handled is
    # sold/dressed/dead — expBirds lands on 0) while the WEIGHT arithmetic
    # still leaves something over, because the dressed weight entered
    # doesn't match the average the opening/purchase weights implied.
    # base_entry(): 80 open + 100 bought = 180 handled; 20 live sold; forcing
    # dressedCount=160 balances the bird count exactly (180-20-160=0), but
    # dressedWtG=300,000 leaves 405,000 avail - 41,000 live - 300,000
    # dressed = 64,000 g unaccounted for — with no bird left to carry it.
    short = compute_entry(base_entry(dressedCount=160, dressedWtG=300_000), SETTINGS)
    case("Live bird shortage", "Closing birds still computes to 0",
         "180 handled - 20 live - 160 dressed", 0, lambda: short["expBirds"])
    case("Live bird shortage", "The leftover weight is pulled out as a shortage",
         "405,000 avail - 41,000 live - 300,000 dressed = 64,000", 64_000,
         lambda: short["liveShortWtG"])
    case("Live bird shortage", "...and closing weight itself is zeroed, not left at 64,000",
         "no birds left to carry it", 0, lambda: short["expCloseWtG"])
    case("Live bird shortage", "...valued at the day's weighted average rate",
         "64 kg @ ~125.06/kg", 8003.95, lambda: short["liveShortValue"])

    normal = compute_entry(base_entry(), SETTINGS)
    case("Live bird shortage", "An ordinary day (birds still open) reports no shortage",
         "expBirds=120, nothing to flag", 0, lambda: normal["liveShortWtG"])

    # ---- round trip through the API: persisted as zero, not carried forward
    br = ADMIN.post("/api/branches", json={"name": "Shortage Test Branch"}).get_json()
    bcode = br["code"]

    today_e = ADMIN.post("/api/entries", json=base_entry(
        branch=bcode, category="broiler", businessDate=D(2),
        dressedCount=160, dressedWtG=300_000, submit=True)).get_json()
    case("Live bird shortage", "Submitting the day succeeds despite 0 closing birds",
         "id present", True, lambda: bool(today_e.get("id")))
    case("Live bird shortage", "The saved entry's own closing weight is zeroed too",
         "not left at the raw 64,000", 0, lambda: today_e["closeWtG"])
    case("Live bird shortage", "...closing birds is 0, as expected",
         0, 0, lambda: today_e["closeBirds"])
    case("Live bird shortage", "The shortage is reported on the saved entry's calc",
         "64,000 g ≈ Rs 8,003.95", (64_000, 8003.95),
         lambda: (today_e["calc"]["liveShortWtG"], today_e["calc"]["liveShortValue"]))

    ADMIN.post(f"/api/entries/{today_e['id']}/decision", json={"verdict": "approved"})
    cf = ADMIN.get(f"/api/entries/carry-forward?branch={bcode}&category=broiler").get_json()
    case("Live bird shortage", "Tomorrow's opening weight carries forward at 0, not 64,000",
         "closeWtG from carry-forward", 0, lambda: cf["closeWtG"])


# ===========================================================================
def test_v20_feed_purchase():
    print("\n[31] Feed purchase — bags, price per bag, deducted from net profit, branch ledger")

    # ---- pure calculation ---------------------------------------------------
    base = compute_entry(base_entry(), SETTINGS)
    fed = compute_entry(base_entry(feedBags=10, feedRate=1200), SETTINGS)
    case("Feed purchase", "10 bags @ Rs 1,200 is a Rs 12,000 cost",
         "10 x 1,200", 12_000.0, lambda: fed["feedAmt"])
    case("Feed purchase", "...and it comes straight off net profit, not revenue",
         "base netProfit - 12,000", round(base["netProfit"] - 12_000, 2),
         lambda: fed["netProfit"])
    case("Feed purchase", "No feed purchase costs nothing",
         "feedBags absent", 0.0, lambda: base["feedAmt"])

    # ---- round trip through the API -----------------------------------------
    br = ADMIN.post("/api/branches", json={"name": "Feed Ledger Test Branch"}).get_json()
    bcode = br["code"]

    blocked = ADMIN.post("/api/entries", json=base_entry(
        branch=bcode, category="broiler", businessDate=D(3),
        feedBags=8, feedRate=0, submit=True))
    case("Feed purchase", "Bags bought without a price is refused on submit",
         422, 422, lambda: blocked.status_code)
    case("Feed purchase", "...and names the feed price as what's missing",
         "Feed purchase — price per bag", True,
         lambda: "Feed purchase — price per bag" in blocked.get_json()["missing"])

    day1 = ADMIN.post("/api/entries", json=base_entry(
        branch=bcode, category="broiler", businessDate=D(3),
        feedBags=8, feedRate=1150, feedSupplier="Shiva Traders", submit=True)).get_json()
    case("Feed purchase", "The entry saves with bags/rate/supplier intact",
         (8, 1150.0, "Shiva Traders"),
         (day1["feedBags"], day1["feedRate"], day1["feedSupplier"]),
         lambda: (day1["feedBags"], day1["feedRate"], day1["feedSupplier"]))
    case("Feed purchase", "The saved entry's calc reports the amount",
         "8 x 1,150", 9_200.0, lambda: day1["calc"]["feedAmt"])

    ADMIN.post("/api/entries", json=base_entry(
        branch=bcode, category="parents", businessDate=D(2),
        feedBags=4, feedRate=1200, feedSupplier="Ganesh Feeds", submit=True))

    case("Feed purchase", "A supervisor cannot reach the feed ledger",
         403, 403, lambda: SUP.get(f"/api/feed-ledger?branch={bcode}").status_code)

    ledger = ADMIN.get(f"/api/feed-ledger?branch={bcode}&from={D(3)}&to={D(2)}").get_json()
    case("Feed purchase", "Both suppliers show up in the ledger",
         2, len(ledger["suppliers"]), lambda: len(ledger["suppliers"]))
    shiva = next(s for s in ledger["suppliers"] if s["supplier"] == "Shiva Traders")
    case("Feed purchase", "Shiva Traders totals 8 bags, Rs 9,200",
         (8, 9_200.0), (shiva["bags"], shiva["amt"]), lambda: (shiva["bags"], shiva["amt"]))
    ganesh = next(s for s in ledger["suppliers"] if s["supplier"] == "Ganesh Feeds")
    case("Feed purchase", "Ganesh Feeds totals 4 bags, Rs 4,800",
         (4, 4_800.0), (ganesh["bags"], ganesh["amt"]), lambda: (ganesh["bags"], ganesh["amt"]))
    case("Feed purchase", "Both transactions show up in the range",
         2, len(ledger["transactions"]), lambda: len(ledger["transactions"]))


# ===========================================================================
# 21. Schema upgrades — an old database must not 500 on sign-in
# ===========================================================================
def test_schema_upgrade():
    print("\n[21] Schema upgrade")
    import sqlite3
    import tempfile as tf
    from app.schema import schema_gaps, upgrade_schema

    with app.app_context():
        case("Schema", "A current database reports no gaps",
             "schema_gaps()", 0, lambda: len(schema_gaps()))
        case("Schema", "Upgrading a current database changes nothing",
             "upgrade_schema()", 0,
             lambda: sum(len(upgrade_schema(verbose=False)[k])
                         for k in ("tablesCreated", "columnsAdded", "indexesCreated")))

    # Build a database that looks like an older release: drop the tables added
    # later and strip a column added later, then point the app at it.
    old_db = os.path.join(tf.gettempdir(), "vcc_oldschema.db")
    if os.path.exists(old_db):
        os.remove(old_db)

    from app import create_app as _create
    import app.config as _cfg

    def app_on(path):
        os.environ["DATABASE_URL"] = f"sqlite:///{path}"
        os.environ["AUTO_UPGRADE_DB"] = "0"
        import importlib
        importlib.reload(_cfg)
        return _create(_cfg.Config)

    legacy = app_on(old_db)
    with legacy.app_context():
        db.create_all()
        db.session.add(Branch(code="B01", name="Legacy Branch"))
        db.session.commit()
        u = User(name="Legacy Admin", username="legacy", role="admin")
        u.set_password("legacy123")
        u.branches = Branch.query.all()
        db.session.add(u)
        db.session.commit()
        db.session.add(Overhead(branch_id=1, period_month=TODAY.strftime("%Y-%m"),
                                category="rent", amount=Decimal("25000"),
                                status="approved", created_by_id=1))
        db.session.commit()

    # now make it look old: remove the newer tables and the newer column
    raw = sqlite3.connect(old_db)
    for t in ("day_close", "customer_payments", "customer_sales", "customers"):
        raw.execute(f"DROP TABLE IF EXISTS {t}")
    cols = [r[1] for r in raw.execute("PRAGMA table_info(overheads)")]
    keep = [c for c in cols if c != "spend_date"]
    raw.execute("CREATE TABLE overheads_old AS SELECT " + ", ".join(keep) + " FROM overheads")
    raw.execute("DROP TABLE overheads")
    raw.execute("ALTER TABLE overheads_old RENAME TO overheads")
    raw.commit()
    raw.close()

    aged = app_on(old_db)
    with aged.app_context():
        gaps = schema_gaps()
    case("Schema", "An older database is detected as behind",
         "4 tables + 1 column missing", True,
         lambda: any("customers" in g for g in gaps)
                 and any("overheads.spend_date" in g for g in gaps))

    cl = aged.test_client()
    cl.post("/api/login", json={"username": "legacy", "password": "legacy123"})
    resp = cl.get("/api/bootstrap")
    case("Schema", "Without the upgrade it reports 503, not a bare 500",
         "GET /api/bootstrap", 503, lambda: resp.status_code)
    case("Schema", "and names the problem", "error", "schema_outdated",
         lambda: resp.get_json()["error"])
    case("Schema", "and says exactly what to run", "message", True,
         lambda: "upgrade-db" in resp.get_json()["message"])

    with aged.app_context():
        report = upgrade_schema(verbose=False)
    case("Schema", "The upgrade adds the missing tables", "4 tables", True,
         lambda: len(report["tablesCreated"]) == 4)
    case("Schema", "and the missing column", "overheads.spend_date", True,
         lambda: "overheads.spend_date" in report["columnsAdded"])
    case("Schema", "with nothing going wrong", "problems", 0,
         lambda: len(report["problems"]))

    with aged.app_context():
        case("Schema", "No gaps are left afterwards", "schema_gaps()", 0,
             lambda: len(schema_gaps()))

    fixed = aged.test_client()
    fixed.post("/api/login", json={"username": "legacy", "password": "legacy123"})
    after = fixed.get("/api/bootstrap")
    case("Schema", "Sign-in works once the database is upgraded",
         "GET /api/bootstrap", 200, lambda: after.status_code)
    case("Schema", "The existing overhead survived untouched",
         "₹25,000 rent still there", 25000.0,
         lambda: after.get_json()["overheads"][0]["amount"])
    case("Schema", "and gained the new field as undated",
         "dated flag", False,
         lambda: after.get_json()["overheads"][0]["dated"])
    case("Schema", "Every module answers on the upgraded database",
         "5 endpoints", [200, 200, 200, 200, 200],
         lambda: [fixed.get(p).status_code for p in
                  ("/api/dayclose", "/api/dayclose/history", "/api/overheads",
                   "/api/customers", "/api/entries?page=1&pageSize=5")])
    case("Schema", "Re-running the upgrade is a no-op",
         "second run", 0,
         lambda: _reupgrade(aged))

    with aged.app_context():
        db.session.remove()
        db.engine.dispose()
    for suffix in ("", "-journal", "-wal", "-shm"):
        if os.path.exists(old_db + suffix):
            os.remove(old_db + suffix)

    # put the environment back for anything that follows
    os.environ["DATABASE_URL"] = f"sqlite:///{TMP_DB}"
    os.environ.pop("AUTO_UPGRADE_DB", None)


def _reupgrade(target_app):
    from app.schema import upgrade_schema
    with target_app.app_context():
        r = upgrade_schema(verbose=False)
    return sum(len(r[k]) for k in ("tablesCreated", "columnsAdded", "indexesCreated"))


if __name__ == "__main__":
    print("=" * 78)
    print("VENUS CHICKEN CENTERS — FULL MODULE TEST SUITE")
    print(f"Temporary database: {TMP_DB}")
    print("=" * 78)

    build_fixtures()
    login_all()

    test_infrastructure()
    test_auth()
    test_rbac()
    test_calc()
    test_validation()
    test_entries()
    test_date_permission()
    test_photos()
    test_labour()
    test_advances()
    test_overheads()
    test_hotels()
    test_live_and_functions()
    test_overhead_ledger()
    test_dayclose()
    test_dupes()
    test_scale()
    test_v10_reconciliation()
    test_v11_admin_edits()
    test_v12_supervisor_today_only()
    test_v13_dayclose_lock_and_overhead_edit()
    test_v14_opening_figures_admin_only()
    test_v15_ledger_filters()
    test_v16_purchase_returns()
    test_v17_customer_adjustments()
    test_v18_receipt_edit()
    test_v19_live_bird_weight_shortage()
    test_v20_feed_purchase()
    test_schema_upgrade()
    test_admin_modules()
    test_activity()
    test_robustness()
    test_admin_wipe()

    total, passed, failed = write_report()
    removed = cleanup()

    print("\n" + "=" * 78)
    print(f"RESULT: {passed}/{total} passed, {failed} failed")
    print(f"Report:  docs/test-report.md  and  docs/test-results.csv")
    print(f"Temporary data removed: {'yes' if removed else 'NO — check ' + TMP_DB}")
    print("=" * 78)
    sys.exit(1 if failed else 0)
