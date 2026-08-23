"""
Database and account management.

    python manage.py init-db              create every table, then upgrade
    python manage.py upgrade-db           add anything an older database lacks
    python manage.py create-admin         interactive admin account
    python manage.py seed                 load the 14-day demo dataset
    python manage.py reset-db             DROP everything, then recreate
    python manage.py recompute-closing-stock          dry run — report only
    python manage.py recompute-closing-stock --apply  write the changes
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


def recompute_closing_stock():
    """
    One-time backfill: re-derive close_birds/close_weight_g/close_meat_g —
    and the opening figures on the FOLLOWING day that carry them forward —
    for every APPROVED entry, under the corrected formula (see calc.py's
    birdDeficit/wtDeficitG/meatDeficitG comments), without touching any
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
    formula (this app has only ever had the one, until today's fix), so
    there is no ambiguity about which "old formula" to reconstruct.

    Each branch+category is its own independent day-to-day chain, walked
    oldest to newest, because a corrected entry's closing figures change
    what the NEXT entry's opening should be. Only the very first entry in
    each chain is never touched (nothing to carry forward from).

    Dry run by default — prints every change it would make and a summary,
    writes nothing. Pass --apply to actually commit.
    """
    apply_changes = "--apply" in sys.argv
    from app.api import get_settings
    from app.calc import compute_entry

    settings = get_settings()
    combos = (db.session.query(DailyEntry.branch_id, DailyEntry.category)
              .filter(DailyEntry.status == "approved")
              .distinct().order_by(DailyEntry.branch_id).all())

    changed_entries = 0
    changed_fields = 0

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
            old_pred_wt = calc_orig["expCloseWtG"] - calc_orig["wtDeficitG"]
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
                if not header_shown:
                    print(f"\n{branch.name if branch else branch_id} ({branch.code if branch else '?'}) · {category}")
                    header_shown = True
                print(f"  {entry.business_date}  open birds/wt/meat {orig_open} -> {new_open}"
                      f"   close birds/wt/meat {orig_close} -> {new_close}")
                changed_entries += 1
                changed_fields += sum(a != b for a, b in zip(orig_open + orig_close, new_open + new_close))
                if apply_changes:
                    entry.open_birds, entry.open_weight_g, entry.open_meat_g = new_open
                    entry.close_birds, entry.close_weight_g, entry.close_meat_g = new_close

            prev_orig_close = orig_close
            prev_new_close = new_close

    print()
    if not changed_entries:
        print("Nothing to change — every approved entry already matches the corrected formula.")
        return
    verb = "Changed" if apply_changes else "Would change"
    print(f"{verb} {changed_entries} entry(ies), {changed_fields} field(s) total.")
    if apply_changes:
        db.session.commit()
        print("Committed.")
    else:
        print("Dry run only — nothing written. Re-run with --apply to write these changes.")


COMMANDS = {"init-db": init_db, "upgrade-db": upgrade_db, "reset-db": reset_db,
            "create-admin": create_admin, "seed": seed,
            "recompute-closing-stock": recompute_closing_stock}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    with app.app_context():
        COMMANDS[cmd]()
