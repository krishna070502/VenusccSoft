"""
Schema upgrades.

`db.create_all()` only ever CREATES tables. It will not add a column to a table
that already exists, so upgrading an installation that was set up by an earlier
release leaves the database one or more columns short and every query touching
that table fails — which is how a missing `overheads.spend_date` surfaced as a
500 immediately after signing in.

This brings a live database up to whatever the models now say, without
dropping anything:

    1. create any table that is missing entirely
    2. ALTER TABLE ... ADD COLUMN for every column the model has and the
       database does not
    3. create any missing index

It is idempotent — running it on an already-current database does nothing and
reports nothing — and it is safe to run on every boot. It deliberately does NOT
drop or alter existing columns: removing data is never something a start-up
script should decide to do on its own.
"""

import re

from sqlalchemy import CheckConstraint, inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.schema import CreateIndex

from .extensions import db

# What to seed an existing row with when a NOT NULL column is added. Adding a
# NOT NULL column to a table that already has rows is rejected unless a default
# comes with it, so every type needs an answer here. TIMESTAMP/DATETIME map to
# CURRENT_TIMESTAMP — valid, unquoted, "now" in both SQLite and Postgres as a
# plain SQL value — for the many audit columns (created_at, entered_at,
# uploaded_at, declared_at...) whose model default is the utcnow function, not
# a fixed value (see _default_literal's docstring below). It is NOT always
# usable directly inside an ADD COLUMN's DEFAULT clause, though — see
# _add_column_statements(), which is where that distinction actually matters.
TYPE_DEFAULTS = [
    ("INT", "0"), ("SERIAL", "0"), ("NUMERIC", "0"), ("DECIMAL", "0"),
    ("FLOAT", "0"), ("REAL", "0"), ("DOUBLE", "0"),
    ("BOOL", "FALSE"),
    ("TIMESTAMP", "CURRENT_TIMESTAMP"), ("DATETIME", "CURRENT_TIMESTAMP"),
    ("VARCHAR", "''"), ("CHAR", "''"), ("TEXT", "''"),
]


def _default_literal(column, type_sql: str) -> str:
    """
    A literal the database will accept for an existing row.

    Booleans are checked BEFORE the general int/float branch — under
    Postgres a real BOOLEAN column rejects `DEFAULT 0` outright ("default
    expression is of type integer"), unlike SQLite, which just stores
    booleans as 0/1 and never complained. TRUE/FALSE keywords are valid in
    both, so those are what gets emitted regardless of which database is
    live. This bit Purchase.has_bill's first production deploy — the column
    was skipped every boot with a DatatypeMismatch until this was fixed.

    A column whose default is a CALLABLE (every *_at audit timestamp uses
    `default=utcnow`, a function, not a fixed value) is not "scalar" as far
    as SQLAlchemy is concerned, so it never enters the branch below at all —
    it falls straight through to the TYPE_DEFAULTS table, which used to have
    no TIMESTAMP/DATETIME entry and so fell all the way to the final "NULL"
    fallback: `ADD COLUMN entered_at TIMESTAMP ... NOT NULL DEFAULT NULL`, a
    self-contradicting clause any database rejects outright the moment the
    table already has a row. Never hit in practice yet only because none of
    these audit columns has ever been added post-hoc to a table that already
    existed — but the exact same latent failure as has_bill's, waiting for
    the next one. CURRENT_TIMESTAMP is what every existing row backfills to.
    """
    default = getattr(column, "default", None)
    if default is not None and getattr(default, "is_scalar", False):
        value = default.arg
        if isinstance(value, bool):
            return "TRUE" if value else "FALSE"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return "'" + value.replace("'", "''") + "'"

    upper = type_sql.upper()
    for token, literal in TYPE_DEFAULTS:
        if token in upper:
            return literal
    return "NULL"


def _already_there(exc) -> bool:
    """True when the failure is only that something already exists."""
    text_ = str(getattr(exc, "orig", exc)).lower()
    return ("already exists" in text_ or "duplicate column" in text_
            or "duplicate_object" in text_)


def _add_column_statements(table_name: str, column, dialect) -> list:
    """
    One or more statements, in order, to bring a single missing column onto
    an existing table. Almost always exactly one ALTER TABLE.

    The one exception: a NOT NULL column whose default is a CALLABLE (every
    *_at audit timestamp — default=utcnow, a function, not a fixed value)
    under SQLite specifically. SQLite's ALTER TABLE ADD COLUMN rejects ANY
    non-constant default outright — "Cannot add a column with non-constant
    default" — including CURRENT_TIMESTAMP, regardless of nullability; a
    restriction Postgres does not share (confirmed directly: Postgres
    accepts `ADD COLUMN ... NOT NULL DEFAULT CURRENT_TIMESTAMP` against a
    table that already has rows without complaint). So under SQLite only,
    the column goes on nullable and bare first, then a follow-up UPDATE
    backfills every existing row to CURRENT_TIMESTAMP (a plain UPDATE has
    none of ADD COLUMN's constant-only restriction). The NOT NULL
    constraint itself is not retroactively enforced at the SQLite level —
    SQLite cannot add one without rebuilding the whole table, which this
    module deliberately never does (see the module docstring) — but every
    existing row ends up fully populated regardless, and the application
    always supplies the value on every new INSERT going forward no matter
    what the database itself enforces.
    """
    type_sql = column.type.compile(dialect=dialect)
    name = dialect.identifier_preparer.quote(column.name)
    table = dialect.identifier_preparer.quote(table_name)

    default = getattr(column, "default", None)
    callable_default = (default is not None and not getattr(default, "is_scalar", False)
                        and callable(getattr(default, "arg", None)))

    if not column.nullable and callable_default and dialect.name == "sqlite":
        return [
            f"ALTER TABLE {table} ADD COLUMN {name} {type_sql}",
            f"UPDATE {table} SET {name} = CURRENT_TIMESTAMP WHERE {name} IS NULL",
        ]

    clause = f"ALTER TABLE {table} ADD COLUMN {name} {type_sql}"
    if not column.nullable:
        clause += f" NOT NULL DEFAULT {_default_literal(column, type_sql)}"
    elif column.server_default is not None:
        clause += f" DEFAULT {column.server_default.arg}"
    return [clause]


def upgrade_schema(verbose: bool = True) -> dict:
    """
    Bring the connected database in line with the models.

    Returns what it changed, so callers can log it and tests can assert on it.
    """
    engine = db.engine
    dialect = engine.dialect
    report = {"tablesCreated": [], "columnsAdded": [], "indexesCreated": [],
              "constraintsSynced": [], "problems": []}

    before = set(inspect(engine).get_table_names())

    # ---- 1. missing tables -------------------------------------------------
    db.metadata.create_all(bind=engine)
    after = set(inspect(engine).get_table_names())
    report["tablesCreated"] = sorted(after - before)

    # ---- 2. missing columns ------------------------------------------------
    inspector = inspect(engine)
    for table in db.metadata.sorted_tables:
        if table.name not in after:
            continue
        present = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in present:
                continue
            statements = _add_column_statements(table.name, column, dialect)
            try:
                with engine.begin() as conn:
                    for statement in statements:
                        conn.execute(text(statement))
                report["columnsAdded"].append(f"{table.name}.{column.name}")
                if verbose:
                    print(f"  + column {table.name}.{column.name}")
            except SQLAlchemyError as exc:
                # Several gunicorn workers boot at once and may all try to add
                # the same column. Whoever loses the race is not a problem.
                if _already_there(exc):
                    report["columnsAdded"].append(f"{table.name}.{column.name}")
                else:
                    report["problems"].append(f"{table.name}.{column.name}: {exc}")

    # ---- 3. missing indexes ------------------------------------------------
    inspector = inspect(engine)
    for table in db.metadata.sorted_tables:
        if table.name not in after:
            continue
        try:
            known = {i["name"] for i in inspector.get_indexes(table.name)}
        except SQLAlchemyError:                               # pragma: no cover
            continue
        for index in table.indexes:
            if index.name in known:
                continue
            try:
                with engine.begin() as conn:
                    conn.execute(CreateIndex(index))
                report["indexesCreated"].append(index.name)
                if verbose:
                    print(f"  + index {index.name}")
            except SQLAlchemyError as exc:
                if not _already_there(exc):
                    report["problems"].append(f"index {index.name}: {exc}")

    # ---- 4. CHECK constraints out of step with the models ------------------
    # An allow-list CHECK (an entry's category, a customer sale's product...)
    # changing in the model — say, a new value added — is not a "missing"
    # column or table, so nothing above notices it. The live database just
    # goes on silently enforcing the old, narrower list forever, and the
    # first save that uses the new value fails with a bare IntegrityError
    # 409 that gives no hint the schema itself is what's stale. Postgres
    # only: SQLite has no ALTER TABLE ... DROP/ADD CONSTRAINT.
    #
    # Every CHECK in this codebase is a plain `col IN ('a','b',...)` allow
    # list, so comparing the quoted literals found in the model's text
    # against the ones Postgres reports back (it rewrites the SQL into its
    # own `= ANY (ARRAY[...])` form, so the two never match verbatim) is
    # enough to tell whether it's actually stale — a constraint shaped some
    # other way just has no literals to compare and is left alone.
    if dialect.name == "postgresql":
        literals = lambda sql: set(re.findall(r"'([^']*)'", str(sql)))
        inspector = inspect(engine)
        ident = dialect.identifier_preparer
        for table in db.metadata.sorted_tables:
            if table.name not in after:
                continue
            try:
                live = {c["name"]: literals(c["sqltext"])
                       for c in inspector.get_check_constraints(table.name) if c.get("name")}
            except SQLAlchemyError:                           # pragma: no cover
                continue
            for constraint in table.constraints:
                if not isinstance(constraint, CheckConstraint) or not constraint.name:
                    continue
                wanted = literals(constraint.sqltext)
                if not wanted or live.get(constraint.name) == wanted:
                    continue                      # not an allow-list, or already matches
                try:
                    with engine.begin() as conn:
                        conn.execute(text(
                            f"ALTER TABLE {ident.quote(table.name)} "
                            f"DROP CONSTRAINT IF EXISTS {ident.quote(constraint.name)}"))
                        conn.execute(text(
                            f"ALTER TABLE {ident.quote(table.name)} ADD CONSTRAINT "
                            f"{ident.quote(constraint.name)} CHECK ({constraint.sqltext})"))
                    report["constraintsSynced"].append(constraint.name)
                    if verbose:
                        print(f"  ~ constraint {constraint.name}")
                except SQLAlchemyError as exc:
                    report["problems"].append(f"constraint {constraint.name}: {exc}")

    if verbose:
        if report["tablesCreated"]:
            print("  + tables " + ", ".join(report["tablesCreated"]))
        if not any(report[k] for k in
                  ("tablesCreated", "columnsAdded", "indexesCreated", "constraintsSynced")):
            print("  database is already up to date")
    return report


def schema_gaps() -> list:
    """
    What the models expect and the database does not have. Used to turn an
    obscure driver error into a sentence that says what to do about it.
    """
    engine = db.engine
    gaps = []
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
    except SQLAlchemyError as exc:                            # pragma: no cover
        return [f"cannot read the database: {exc}"]

    for table in db.metadata.sorted_tables:
        if table.name not in tables:
            gaps.append(f"missing table '{table.name}'")
            continue
        present = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name not in present:
                gaps.append(f"missing column '{table.name}.{column.name}'")
    return gaps
