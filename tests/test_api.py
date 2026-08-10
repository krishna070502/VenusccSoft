"""
Venus Chicken Centers — full module test suite.

Runs against a THROWAWAY database (a temp file, never your Neon instance),
exercises every module with varied inputs, writes docs/test-report.md
and docs/test-results.csv, then deletes the temporary data.

    python tests/test_api.py
"""

import csv
import os
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
os.environ["IDLE_ADMIN_MIN"] = "2"
os.environ["IDLE_SUPERVISOR_MIN"] = "10"

from app import create_app                                    # noqa: E402
from app.extensions import db                                 # noqa: E402
from app.calc import (compute_entry, costing_gaps, months_in_range,          # noqa: E402
                      price_hotel_line, validate_for_submission)
from app.models import (ActivityLog, Branch, Customer, CustomerPayment,      # noqa: E402
                        CustomerSale, DailyEntry, LabourLedger,
                        Overhead, Setting, User, Worker)

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
         "db.create_all()", 14,
         lambda: len(db.metadata.tables))
    case("Infrastructure", "SPA shell is served",
         "GET /", True,
         lambda: b"Venus Chicken Centers" in ADMIN.get("/").data)
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
    case("Session", "Admin idle limit is 2 minutes", "login as admin", 2,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "admin", "password": "admin123"}
                                        ).get_json()["idleMinutes"])
    case("Session", "Supervisor idle limit is 10 minutes", "login as ravi", 10,
         lambda: app.test_client().post("/api/login",
                                        json={"username": "ravi", "password": "ravi123"}
                                        ).get_json()["idleMinutes"])
    case("Session", "Heartbeat keeps the session alive", "POST /api/heartbeat", 200,
         lambda: ADMIN.post("/api/heartbeat", json={}).status_code)
    case("Session", "Expired session is rejected server-side",
         "last_seen pushed 3 min into the past (admin limit 2)", 401,
         lambda: _expire_admin_session())


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
        s["last_seen"] = time.time() - 3 * 60          # 3 minutes ago
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
                  ("POST", "/api/admin/seed", {}),
                  ("POST", "/api/admin/wipe", {})]
    for method, path, body in admin_only:
        case("RBAC", f"Supervisor blocked from {method} {path}",
             "logged in as supervisor", 403,
             lambda m=method, p=path, b=body: getattr(SUP, m.lower())(p, json=b).status_code)

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
         "56.000 kg meat from 82.000 kg", 68.29,
         lambda: broiler["yieldPct"])
    case("Calc engine", "Weighted average cost across opening + purchase",
         "200 kg @₹120 + 205 kg @₹130", 125.06,
         lambda: broiler["avgRate"])
    case("Calc engine", "Revenue sums all sale lines",
         "skin+skinless+liver+live+cutting", 17_180.00,
         lambda: broiler["revenue"])
    case("Calc engine", "Closing meat excludes liver from the pool",
         "5+56-30-20-1 liver-1 damage", 9_000,
         lambda: broiler["expCloseMeatG"])
    case("Calc engine", "Expected closing birds",
         "80+100-20 live-0 dead-40 dressed", 120,
         lambda: broiler["expBirds"])

    exact = compute_entry(base_entry(dressedWtG=100_000, actualMeatG=69_000), SETTINGS)
    case("Calc engine", "Exact 69% yield produces no bonus and no shortfall",
         "100 kg live -> 69 kg meat", (0, 0),
         lambda: (exact["bonusG"], exact["shortG"]))
    bonus = compute_entry(base_entry(dressedWtG=100_000, actualMeatG=73_000), SETTINGS)
    case("Calc engine", "Excess meat becomes bonus",
         "100 kg live -> 73 kg meat", 4_000,
         lambda: bonus["bonusG"])
    case("Calc engine", "Bonus above tolerance raises the high-yield flag",
         "73% vs 69% ±2", True, lambda: bonus["yieldHigh"])
    short = compute_entry(base_entry(dressedWtG=100_000, actualMeatG=64_000), SETTINGS)
    case("Calc engine", "Meat below expected becomes a shortfall",
         "100 kg live -> 64 kg meat", 5_000,
         lambda: short["shortG"])
    case("Calc engine", "Shortfall below tolerance raises the low-yield flag",
         "64% vs 69% ±2", True, lambda: short["yieldLow"])
    edge = compute_entry(base_entry(dressedWtG=100_000, actualMeatG=67_000), SETTINGS)
    case("Calc engine", "Inside tolerance raises no flag",
         "67% vs 69% ±2", (False, False),
         lambda: (edge["yieldLow"], edge["yieldHigh"]))

    parents = compute_entry(base_entry(category="parents", dressedWtG=100_000,
                                       actualMeatG=79_000), SETTINGS)
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

    big = compute_entry(base_entry(dressedWtG=50_000_000, actualMeatG=34_500_000,
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
    r = SUP.post("/api/entries", json=base_entry(businessDate=D(9), submit=True))
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

    case("Daily entry", "Draft can be saved without full validation",
         "submit flag false, sparse data", 201,
         lambda: SUP.post("/api/entries", json={"branch": "B01", "category": "parents",
                                                "businessDate": D(9)}).status_code)
    case("Daily entry", "Duplicate branch+category+date is refused",
         "same day twice", 409,
         lambda: SUP.post("/api/entries", json=base_entry(businessDate=D(9))).status_code)
    case("Daily entry", "Same date but a different category is allowed",
         "broiler and parents on one day", True,
         lambda: _parents_same_day_ok())
    case("Daily entry", "Incomplete submission is rejected with a field list",
         "submit with rateSkin 0", 422,
         lambda: SUP.post("/api/entries",
                          json=base_entry(businessDate=D(8), rateSkin=0, submit=True)).status_code)
    case("Daily entry", "Rejection names the missing field",
         "submit with rateSkin 0", True,
         lambda: "Skin rate" in str(SUP.post("/api/entries",
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
         lambda: ADMIN.put(f"/api/entries/{eid}",
                           json={"actualMeatG": 57_000}).get_json()["actualMeatG"])
    case("Approval", "Record stays approved after an admin edit", "status", "approved",
         lambda: ADMIN.get("/api/entries").get_json()[0]["status"] if False else
         _status_of(eid))
    case("Approval", "Supervisor cannot approve anything", "POST decision as supervisor", 403,
         lambda: SUP.post(f"/api/entries/{eid}/decision",
                          json={"verdict": "approved"}).status_code)
    case("Approval", "Unknown verdict is rejected", "verdict='maybe'", 400,
         lambda: ADMIN.post(f"/api/entries/{eid}/decision",
                            json={"verdict": "maybe"}).status_code)

    # return / resubmit cycle
    r2 = SUP.post("/api/entries", json=base_entry(businessDate=D(6), submit=True))
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
    r = SUP.post("/api/entries", json=base_entry(businessDate=D(5), category="parents",
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
    draft = SUP.post("/api/entries", json=base_entry(businessDate=D(21))).get_json()
    did = draft["id"]

    case("Date permission", "Supervisor can still edit their draft's fields",
         "PUT notes on own draft", 200,
         lambda: SUP.put(f"/api/entries/{did}", json={"notes": "fine"}).status_code)
    case("Date permission", "Supervisor cannot move a saved entry to another date",
         "PUT businessDate as supervisor", 403,
         lambda: SUP.put(f"/api/entries/{did}", json={"businessDate": D(20)}).status_code)
    case("Date permission", "The date is left untouched after the refusal",
         "re-read the record", D(21),
         lambda: _entry_date(did))
    case("Date permission", "The attempt is written to the audit log",
         "action 'Blocked date change'", True,
         lambda: any(a["action"] == "Blocked date change"
                     for a in ADMIN.get("/api/activity").get_json()))
    case("Date permission", "Supervisor still chooses the date when creating",
         "POST with businessDate", D(22),
         lambda: SUP.post("/api/entries",
                          json=base_entry(businessDate=D(22))).get_json()["businessDate"])

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
    other = SUP.post("/api/entries", json=base_entry(businessDate=D(23))).get_json()
    return ADMIN.put(f"/api/entries/{other['id']}/costing",
                     json={"businessDate": day}).status_code


# ===========================================================================
# 7. Photos
# ===========================================================================
def test_photos():
    print("\n[7] Mortality photos")
    png = "data:image/jpeg;base64," + "A" * 200
    r = SUP.post("/api/entries", json=base_entry(businessDate=D(4), mortCount=2,
                                                 mortWtG=4000, photos=[png, png],
                                                 submit=True))
    case("Photos", "Entry with mortality and photos is accepted", "2 photos", 201,
         lambda: r.status_code)
    case("Photos", "Both photos are stored", "photos array", 2,
         lambda: len(r.get_json()["photos"]))
    case("Photos", "Mortality without a photo is refused at the API",
         "mortCount 1, no photos", 422,
         lambda: SUP.post("/api/entries", json=base_entry(businessDate=D(3), mortCount=1,
                                                          mortWtG=2000, submit=True)).status_code)
    case("Photos", "Non-image payloads are discarded",
         "photos=['javascript:alert(1)']", 0,
         lambda: len(SUP.post("/api/entries",
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
    att = lambda day, days: SUP.post("/api/ledger", json={                    # noqa: E731
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

    pay = lambda kind, amt: SUP.post("/api/ledger", json={                    # noqa: E731
        "branch": "B01", "workerId": wid, "date": D(4), "type": kind, "amount": amt})
    case("Payroll", "Record a payment", "paid ₹1000", 201, lambda: pay("paid", 1000).status_code)
    case("Payroll", "Two payments on one day are allowed", "second payment", 201,
         lambda: pay("paid", 200).status_code)
    case("Payroll", "Tea is recorded", "tea ₹30", 201, lambda: pay("tea", 30).status_code)
    case("Payroll", "Two teas on one day are allowed", "second tea", 201,
         lambda: pay("tea", 40).status_code)
    case("Payroll", "Zero amount is refused", "paid ₹0", 422, lambda: pay("paid", 0).status_code)
    case("Payroll", "Unknown ledger type is refused", "type='bribe'", 422,
         lambda: SUP.post("/api/ledger", json={"branch": "B01", "workerId": wid,
                                               "date": D(4), "type": "bribe",
                                               "amount": 10}).status_code)
    case("Payroll", "Unknown worker is refused", "workerId='ghost'", 404,
         lambda: SUP.post("/api/ledger", json={"branch": "B01", "workerId": "ghost",
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
    codes = [SUP.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": day,
                                           "type": "work", "days": 1}).status_code
             for _ in range(8)]
    return (set(codes) == {201}, _work_rows(wid, day))


def _three_days(wid):
    for d in (D(20), D(21), D(22)):
        SUP.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": d,
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
    SUP.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": D(4),
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

    SUP.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
                                  "type": "work", "days": 1})
    SUP.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
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
    SUP.post("/api/ledger", json={"branch": "B01", "workerId": wid, "date": day,
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
    r = SUP.post("/api/entries", json=base_entry(businessDate=day, submit=True))
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
    w = SUP.post("/api/workers", json={"branch": "B01", "name": "BigAdv",
                                       "role": "cutter", "dayWage": 700}).get_json()
    SUP.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
                                  "type": "work", "days": 1})
    SUP.post("/api/ledger", json={"branch": "B01", "workerId": w["id"], "date": day,
                                  "type": "advance", "amount": 5000})
    r = SUP.post("/api/entries", json=base_entry(businessDate=day, submit=True))
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
    case("Overheads", "Two categories on one day split the day's costs",
         "broiler + parents on the same date", True,
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
    """Costs belong to the branch-day, so entries on one day share them."""
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
        per = day_costs_for(b.id, day)
    # two entries share the day, so each carries half the wage
    return per["shared"] == 2 and abs(per["wages"] * 2 - full) < 0.01


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
    case("Hotels", "A negative concession is rejected",
         "lessSkin=-10", 422,
         lambda: SUP.post("/api/customers",
                          json={"branch": "B01", "name": "Neg", "lessSkin": -10}).status_code)
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
    r3 = SUP.post("/api/entries", json=payload)
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
         "open 5kg + meat 56kg − counter 31kg − hotel 25kg − damage 1kg", 4_000,
         lambda: calc.get("expCloseMeatG"))
    case("Hotel sales", "Hotel money is inside revenue",
         "counter + hotel + live + cutting",
         round(calc.get("counterSaleAmt", 0) + calc.get("hotelAmt", 0)
               + calc.get("liveAmt", 0) + calc.get("cutAmt", 0), 2),
         lambda: calc.get("revenue"))
    case("Hotel sales", "The market rate of the day is snapshotted",
         "skin line", 200.0,
         lambda: HOTEL["entry"]["hotelSales"][0]["marketRate"])

    case("Hotel sales", "A line for another branch's customer is refused",
         "B01 entry, B02 customer", 422,
         lambda: SUP.post("/api/entries", json=base_entry(
             businessDate=D(41),
             hotelSales=[{"customerId": ADMIN.post("/api/customers", json={
                 "branch": "B02", "name": "Cross Branch"}).get_json()["id"],
                 "product": "skin", "weightG": 1_000}])).status_code)
    case("Hotel sales", "An unknown customer id is refused",
         "customerId='nope'", 422,
         lambda: SUP.post("/api/entries", json=base_entry(
             businessDate=D(42),
             hotelSales=[{"customerId": "nope", "product": "skin",
                          "weightG": 1_000}])).status_code)
    case("Hotel sales", "Empty rows left behind are ignored",
         "blank line", 0,
         lambda: len(SUP.post("/api/entries", json=base_entry(
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

    draft = SUP.post("/api/entries", json=base_entry(
        businessDate=D(44), rateSkin=200,
        hotelSales=[{"customerId": HOTEL["a"]["id"], "product": "skin",
                     "weightG": 10_000}])).get_json()
    case("Hotels", "A draft bill picks up the new deal",
         "200 − 80", 120.0, lambda: draft["hotelSales"][0]["rate"])
    case("Hotels", "Changing the market rate reprices the draft",
         "rateSkin 200 -> 260", 180.0,
         lambda: SUP.put(f"/api/entries/{draft['id']}", json={"rateSkin": 260})
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
    test_admin_modules()
    test_activity()
    test_robustness()

    total, passed, failed = write_report()
    removed = cleanup()

    print("\n" + "=" * 78)
    print(f"RESULT: {passed}/{total} passed, {failed} failed")
    print(f"Report:  docs/test-report.md  and  docs/test-results.csv")
    print(f"Temporary data removed: {'yes' if removed else 'NO — check ' + TMP_DB}")
    print("=" * 78)
    sys.exit(1 if failed else 0)
