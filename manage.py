"""
Database and account management.

    python manage.py init-db              create every table, then upgrade
    python manage.py upgrade-db           add anything an older database lacks
    python manage.py create-admin         interactive admin account
    python manage.py seed                 load the 14-day demo dataset
    python manage.py reset-db             DROP everything, then recreate
    python manage.py recompute-closing-stock          dry run — report only
    python manage.py recompute-closing-stock --apply  write the changes
    python manage.py check-continuity [branch]        read-only: reports every day
                                                       whose opening birds/weight/meat
                                                       don't match the previous day's
                                                       closing, plus any date gaps.
                                                       branch is a code or name substring,
                                                       e.g. "check-continuity reddigudem".
                                                       Omit it to check every branch.
"""
import getpass
import sys

from app import create_app
from app.extensions import db
from app.models import Branch, DailyEntry, User
from app.schema import schema_gaps, upgrade_schema

app = create_app()


def _bootstrap_defaults():
    if not Branch.query.first():
        db.session.add_all([
            Branch(code="B01", name="Branch 01 — Main Hub"),
            Branch(code="B02", name="Branch 02 — Downtown"),
        ])
        db.session.commit()
        print("  created starter branches B01, B02")


def init_db():
    db.create_all()
    # An install from an earlier release has the old tables but not the newer
    # columns, and create_all() will not add them. Always follow through.
    upgrade_schema()
    _bootstrap_defaults()
    print("Tables created and up to date.")


def upgrade_db():
    print("Checking the database against the models...")
    report = upgrade_schema()
    left = schema_gaps()
    if left:
        print("\nStill missing after the upgrade:")
        for gap in left:
            print("  -", gap)
        sys.exit(1)
    changed = (len(report["tablesCreated"]) + len(report["columnsAdded"])
               + len(report["indexesCreated"]))
    print(f"Done. {changed} change(s) applied." if changed
          else "Done. Nothing to change.")


def reset_db():
    if input("This DROPS every table. Type 'yes' to continue: ").strip() != "yes":
        print("Cancelled.")
        return
    db.drop_all()
    db.create_all()
    _bootstrap_defaults()
    print("Database reset.")


def create_admin():
    name = input("Full name: ").strip() or "System Admin"
    username = input("Username: ").strip()
    if not username:
        print("Username required.")
        return
    if User.query.filter_by(username=username).first():
        print("That username already exists.")
        return
    pw = getpass.getpass("Password: ")
    if len(pw) < 6:
        print("Use at least 6 characters.")
        return
    u = User(name=name, username=username, role="admin")
    u.set_password(pw)
    u.branches = Branch.query.all()
    db.session.add(u)
    db.session.commit()
    print(f"Admin '{username}' created.")


def seed():
    from app.seed import load_demo
    admin = User.query.filter_by(role="admin").first()
    if not admin:
        print("Create an admin first:  python manage.py create-admin")
        return
    if not User.query.filter_by(role="supervisor").first():
        sup = User(name="Ravi Kumar", username="ravi", role="supervisor")
        sup.set_password("ravi123")
        sup.branches = Branch.query.limit(1).all()
        db.session.add(sup)
        db.session.commit()
        print("  created demo supervisor 'ravi' / 'ravi123'")
    counts = load_demo(admin)
    db.session.commit()
    print("Demo data loaded:", counts)


def recompute_closing_stock(apply_changes=None, verbose=True):
    """
    One-time backfill: re-derive close_birds/close_weight_g/close_meat_g —
    and the opening figures on the FOLLOWING day that carry them forward —
    for every APPROVED entry, under the corrected formula (see calc.py's
    birdDeficit/wtDeficitG/meatDeficitG comments, and its liveShortWtG
    comment — closing birds hitting exactly 0 while the weight side still
    shows something left over, which used to carry that phantom weight into
    the next day's opening instead of zeroing it), without touching any
    figure an admin ever physically typed in by hand.

    There is no persisted flag recording whether a historical close_* value
    was auto-computed or a manual override, so this uses a heuristic:
    reconstruct what the OLD (pre-fix) formula would have produced for that
    entry's own stored opening, and only touch a field if the stored value
    matches that exactly. A human-typed physical count matching a multi-step
    formula's output to the gram is practically impossible, so an exact
    match is strong evidence the field was never touched by hand — and a
    mismatch is left completely alone, on the assumption it is a deliberate
    manual figure. Every historical entry was computed under the same one
    lineage of formulas (birdDeficit/wtDeficitG clamping, then liveShortWtG
    on top of that), so there is no ambiguity about which "old formula" to
    reconstruct — old_pred_wt below adds liveShortWtG back onto expCloseWtG
    before subtracting wtDeficitG, undoing BOTH clamps in one step: as long
    as exactly one of expCloseWtG/liveShortWtG is ever nonzero for a given
    entry (which compute_entry() guarantees), expCloseWtG + liveShortWtG
    always equals max(raw, 0), the same quantity the original pre-fix
    formula would have stored as closing weight.

    Each branch+category is its own independent day-to-day chain, walked
    oldest to newest, because a corrected entry's closing figures change
    what the NEXT entry's opening should be. Only the very first entry in
    each chain is never touched (nothing to carry forward from).

    Dry run by default — reports every change it would make, writes
    nothing. Pass --apply on the command line (or apply_changes=True
    directly, e.g. from a test or the admin-only API endpoint that wraps
    this for admins who have no shell access to the production box) to
    actually commit. verbose=False suppresses the print()s — the API
    endpoint reads the returned dict instead of console output.

    Returns {"changedEntries", "changedFields", "applied", "changes": [...]}
    — one dict per entry actually different, in the same oldest-to-newest
    order they were walked, each carrying branch/category/date and the
    before/after (birds, weightG, meatG) triples for both open and close.
    """
    if apply_changes is None:
        apply_changes = "--apply" in sys.argv
    from app.api import get_settings
    from app.calc import compute_entry

    settings = get_settings()
    combos = (db.session.query(DailyEntry.branch_id, DailyEntry.category)
              .filter(DailyEntry.status == "approved")
              .distinct().order_by(DailyEntry.branch_id).all())

    changed_entries = 0
    changed_fields = 0
    changes = []

    for branch_id, category in combos:
        branch = db.session.get(Branch, branch_id)
        entries = (DailyEntry.query
                   .filter_by(branch_id=branch_id, category=category, status="approved")
                   .order_by(DailyEntry.business_date.asc(), DailyEntry.entered_at.asc())
                   .all())
        if not entries:
            continue

        prev_orig_close = None
        prev_new_close = None
        header_shown = False

        for i, entry in enumerate(entries):
            orig_open = (entry.open_birds, entry.open_weight_g, entry.open_meat_g)
            orig_close = (entry.close_birds, entry.close_weight_g, entry.close_meat_g)

            if i == 0 or prev_orig_close is None:
                new_open = orig_open
            else:
                new_open = (
                    max(prev_new_close[0], 0) if orig_open[0] == prev_orig_close[0] else orig_open[0],
                    max(prev_new_close[1], 0) if orig_open[1] == prev_orig_close[1] else orig_open[1],
                    max(prev_new_close[2], 0) if orig_open[2] == prev_orig_close[2] else orig_open[2],
                )

            orig_data = entry.to_dict(include_costs=True)
            calc_orig = compute_entry(orig_data, settings)
            # What the OLD (pre-fix) formula would have auto-computed from
            # this entry's ORIGINAL stored opening — recovered algebraically
            # from the new formula's own output rather than re-implemented,
            # since new = max(old_raw, 0) and deficit = max(-old_raw, 0)
            # always satisfies old_raw = new - deficit. Meat's old formula
            # also folded opening meat in, so that's added back on here.
            old_pred_birds = calc_orig["expBirds"] - calc_orig["birdDeficit"]
            # expCloseWtG and liveShortWtG are mutually exclusive (see the
            # docstring above) — adding liveShortWtG back on undoes the
            # newer "0 closing birds means 0 closing weight" clamp before
            # wtDeficitG undoes the older "never negative" clamp, so this
            # reconstructs the same raw figure regardless of which fix (if
            # either) actually touched this particular entry.
            old_pred_wt = (calc_orig["expCloseWtG"] + calc_orig["liveShortWtG"]
                          - calc_orig["wtDeficitG"])
            old_pred_meat = (calc_orig["expCloseMeatG"] - calc_orig["meatDeficitG"]) + orig_open[2]

            close_birds_auto = orig_close[0] == old_pred_birds
            close_wt_auto = orig_close[1] == old_pred_wt
            close_meat_auto = orig_close[2] == old_pred_meat

            if new_open == orig_open:
                calc_new = calc_orig
            else:
                new_data = dict(orig_data)
                new_data["openBirds"], new_data["openWtG"], new_data["openMeatG"] = new_open
                calc_new = compute_entry(new_data, settings)

            new_close = (
                calc_new["expBirds"] if close_birds_auto else orig_close[0],
                calc_new["expCloseWtG"] if close_wt_auto else orig_close[1],
                calc_new["expCloseMeatG"] if close_meat_auto else orig_close[2],
            )

            if new_open != orig_open or new_close != orig_close:
                if verbose and not header_shown:
                    print(f"\n{branch.name if branch else branch_id} ({branch.code if branch else '?'}) · {category}")
                    header_shown = True
                if verbose:
                    print(f"  {entry.business_date}  open birds/wt/meat {orig_open} -> {new_open}"
                          f"   close birds/wt/meat {orig_close} -> {new_close}")
                changed_entries += 1
                changed_fields += sum(a != b for a, b in zip(orig_open + orig_close, new_open + new_close))
                changes.append({
                    "branchCode": branch.code if branch else str(branch_id),
                    "branchName": branch.name if branch else str(branch_id),
                    "category": category,
                    "date": entry.business_date.isoformat(),
                    "oldOpen": list(orig_open), "newOpen": list(new_open),
                    "oldClose": list(orig_close), "newClose": list(new_close),
                })
                if apply_changes:
                    entry.open_birds, entry.open_weight_g, entry.open_meat_g = new_open
                    entry.close_birds, entry.close_weight_g, entry.close_meat_g = new_close

            prev_orig_close = orig_close
            prev_new_close = new_close

    if verbose:
        print()
        if not changed_entries:
            print("Nothing to change — every approved entry already matches the corrected formula.")
        else:
            verb = "Changed" if apply_changes else "Would change"
            print(f"{verb} {changed_entries} entry(ies), {changed_fields} field(s) total.")
            if apply_changes:
                print("Committed.")
            else:
                print("Dry run only — nothing written. Re-run with --apply to write these changes.")

    if apply_changes and changed_entries:
        db.session.commit()

    return {"changedEntries": changed_entries, "changedFields": changed_fields,
            "applied": bool(apply_changes), "changes": changes}


def check_continuity(branch_query=None, verbose=True):
    """
    Read-only audit: for every branch + category, walk APPROVED entries
    oldest to newest and check that each day's own opening birds/weight/meat
    match the PREVIOUS approved day's closing figures — exactly what
    carry-forward assumes going forward (see entries_carry_forward() in
    api.py), and exactly the kind of thing a supervisor typo or a manual
    admin edit can quietly break without either of them noticing, since nothing
    in the UI stops an admin from typing an opening figure that doesn't
    match yesterday's close.

    This makes NO changes — it only reads and prints/returns what it finds.
    Unlike recompute_closing_stock() above, which only touches a closing
    figure it can prove was auto-computed under the old formula, this has no
    opinion on which side (yesterday's close or today's open) is the wrong
    one — a human has to look at both and decide, which is exactly why this
    stops at reporting rather than fixing anything.

    branch_query, case-insensitive: matches a branch CODE exactly, or a
    branch NAME as a substring — so "reddigudem" finds a branch named
    "Reddigudem" or "Reddigudem Branch" alike. None/empty checks every
    branch.

    Also flags a gap: two approved entries for the same branch+category with
    one or more calendar days between them and no approved entry on any of
    those in-between dates — a day that was simply never submitted/approved,
    which carry-forward would silently step over.

    Returns {"branchesChecked", "mismatches": [...], "gaps": [...]} — each
    mismatch/gap a plain dict, in the same oldest-to-newest order walked.
    """
    from datetime import timedelta

    branches = Branch.query.order_by(Branch.code).all()
    if branch_query:
        q = branch_query.strip().lower()
        branches = [b for b in branches
                    if b.code.lower() == q or q in b.name.lower()]
        if not branches:
            print(f"No branch matches '{branch_query}'. "
                  f"Known branches: " + ", ".join(f"{b.code} ({b.name})" for b in Branch.query.all()))
            return {"branchesChecked": 0, "mismatches": [], "gaps": []}

    mismatches = []
    gaps = []

    for branch in branches:
        combos = (db.session.query(DailyEntry.category)
                  .filter_by(branch_id=branch.id, status="approved")
                  .distinct().all())
        for (category,) in combos:
            entries = (DailyEntry.query
                       .filter_by(branch_id=branch.id, category=category, status="approved")
                       .order_by(DailyEntry.business_date.asc(), DailyEntry.entered_at.asc())
                       .all())
            header_shown = False

            def _header():
                nonlocal header_shown
                if verbose and not header_shown:
                    print(f"\n{branch.name} ({branch.code}) · {category}")
                    header_shown = True

            for i in range(1, len(entries)):
                prev, cur = entries[i - 1], entries[i]

                gap_days = (cur.business_date - prev.business_date).days
                if gap_days > 1:
                    _header()
                    if verbose:
                        print(f"  gap: no approved entry between {prev.business_date} and "
                              f"{cur.business_date} ({gap_days - 1} day(s) missing)")
                    gaps.append({"branchCode": branch.code, "branchName": branch.name,
                                "category": category, "from": prev.business_date.isoformat(),
                                "to": cur.business_date.isoformat(), "missingDays": gap_days - 1})

                prev_close = (prev.close_birds, prev.close_weight_g, prev.close_meat_g)
                cur_open = (cur.open_birds, cur.open_weight_g, cur.open_meat_g)
                if prev_close != cur_open:
                    _header()
                    if verbose:
                        print(f"  {prev.business_date} -> {cur.business_date}: closing "
                              f"birds/weightG/meatG {prev_close} does not match the next "
                              f"day's opening {cur_open}  "
                              f"(birds off by {cur_open[0] - prev_close[0]:+d}, "
                              f"weight off by {cur_open[1] - prev_close[1]:+d} g, "
                              f"meat off by {cur_open[2] - prev_close[2]:+d} g)")
                    mismatches.append({
                        "branchCode": branch.code, "branchName": branch.name,
                        "category": category,
                        "prevDate": prev.business_date.isoformat(),
                        "date": cur.business_date.isoformat(),
                        "prevClose": list(prev_close), "curOpen": list(cur_open),
                        "birdsOff": cur_open[0] - prev_close[0],
                        "weightOffG": cur_open[1] - prev_close[1],
                        "meatOffG": cur_open[2] - prev_close[2],
                    })

    if verbose:
        print()
        if not mismatches and not gaps:
            print("No continuity problems found — every approved day's opening matches "
                  "the previous day's closing, with no gaps." +
                  (f" (checked: {', '.join(b.code for b in branches)})" if branch_query else ""))
        else:
            print(f"{len(mismatches)} opening/closing mismatch(es), {len(gaps)} date gap(s) found. "
                  "Nothing was changed — this is a read-only report.")

    return {"branchesChecked": len(branches), "mismatches": mismatches, "gaps": gaps}


COMMANDS = {"init-db": init_db, "upgrade-db": upgrade_db, "reset-db": reset_db,
            "create-admin": create_admin, "seed": seed,
            "recompute-closing-stock": recompute_closing_stock,
            "check-continuity": lambda: check_continuity(sys.argv[2] if len(sys.argv) > 2 else None)}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    with app.app_context():
        COMMANDS[cmd]()
