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

from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.schema import CreateIndex

from .extensions import db

# What to seed an existing row with when a NOT NULL column is added. Adding a
# NOT NULL column to a table that already has rows is rejected unless a default
# comes with it, so every type needs an answer here.
TYPE_DEFAULTS = [
    ("INT", "0"), ("SERIAL", "0"), ("NUMERIC", "0"), ("DECIMAL", "0"),
    ("FLOAT", "0"), ("REAL", "0"), ("DOUBLE", "0"),
    ("BOOL", "0"),
    ("VARCHAR", "''"), ("CHAR", "''"), ("TEXT", "''"),
]


def _default_literal(column, type_sql: str) -> str:
    """A literal the database will accept for an existing row."""
    default = getattr(column, "default", None)
    if default is not None and getattr(default, "is_scalar", False):
        value = default.arg
        if isinstance(value, bool):
            return "1" if value else "0"
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


def _add_column_sql(table_name: str, column, dialect) -> str:
    type_sql = column.type.compile(dialect=dialect)
    name = dialect.identifier_preparer.quote(column.name)
    table = dialect.identifier_preparer.quote(table_name)
    clause = f"ALTER TABLE {table} ADD COLUMN {name} {type_sql}"
    if not column.nullable:
        clause += f" NOT NULL DEFAULT {_default_literal(column, type_sql)}"
    elif column.server_default is not None:
        clause += f" DEFAULT {column.server_default.arg}"
    return clause


def upgrade_schema(verbose: bool = True) -> dict:
    """
    Bring the connected database in line with the models.

    Returns what it changed, so callers can log it and tests can assert on it.
    """
    engine = db.engine
    dialect = engine.dialect
    report = {"tablesCreated": [], "columnsAdded": [], "indexesCreated": [],
              "problems": []}

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
            statement = _add_column_sql(table.name, column, dialect)
            try:
                with engine.begin() as conn:
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

    if verbose:
        if report["tablesCreated"]:
            print("  + tables " + ", ".join(report["tablesCreated"]))
        if not any(report[k] for k in ("tablesCreated", "columnsAdded", "indexesCreated")):
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
