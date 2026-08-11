"""
Database and account management.

    python manage.py init-db              create every table, then upgrade
    python manage.py upgrade-db           add anything an older database lacks
    python manage.py create-admin         interactive admin account
    python manage.py seed                 load the 14-day demo dataset
    python manage.py reset-db             DROP everything, then recreate
"""
import getpass
import sys

from app import create_app
from app.extensions import db
from app.models import Branch, User
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


COMMANDS = {"init-db": init_db, "upgrade-db": upgrade_db, "reset-db": reset_db,
            "create-admin": create_admin, "seed": seed}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    with app.app_context():
        COMMANDS[cmd]()
