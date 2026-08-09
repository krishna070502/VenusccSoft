# Venus Chicken Centers — Operations Console (Flask + PostgreSQL)

The single-file browser app, converted to a Flask application backed by
PostgreSQL. **The interface and behaviour are unchanged** — same screens, same
calculations, same approval workflow, same running hen. What changed is where
the data lives and who is allowed to see it.

---

## Quick start (Windows)

```
setup.bat
```

That script creates `venv\`, installs the dependencies, builds the tables and
walks you through creating an administrator. Then:

```
start.bat
```

and open <http://127.0.0.1:5000>.

### macOS / Linux

```bash
./setup.sh
source venv/bin/activate
python run.py
```

> **Why the virtual environment is not included in this folder:** a venv
> contains compiled binaries for one operating system. I build on Linux, you
> run Windows, so a venv I shipped would not execute on your machine.
> `setup.bat` creates a correct one locally in a few seconds.

---

## Before anything else — rotate the database password

The connection string was shared in a chat and is written into `.env`.
Change it in the Neon console, then update `DATABASE_URL` in `.env`.
`.env` is listed in `.gitignore`, so it will not reach source control.

Also replace `SECRET_KEY` — it signs the session cookies:

```
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## Commands

| Command | Purpose |
|---|---|
| `python manage.py init-db` | Create every table (safe to re-run) |
| `python manage.py create-admin` | Interactive administrator account |
| `python manage.py seed` | Load the 14-day demo dataset |
| `python manage.py reset-db` | Drop and recreate everything |
| `python run.py` | Development server |
| `waitress-serve --port=8000 wsgi:app` | Production server on Windows |
| `gunicorn -w 4 -b 0.0.0.0:8000 wsgi:app` | Production server on Linux |

`GET /healthz` reports whether the database is reachable — point your uptime
monitor at it.

---

## Layout

```
venus/
├─ app/                  the application package
│  ├─ __init__.py        factory, error handlers, page route
│  ├─ config.py          environment settings, connection pooling
│  ├─ extensions.py      the SQLAlchemy instance
│  ├─ models.py          11 tables
│  ├─ calc.py            the authoritative calculation engine
│  ├─ security.py        sessions, idle timeout, RBAC, audit
│  ├─ api.py             REST endpoints
│  ├─ seed.py            demo dataset
│  ├─ static/            logo.png, app.js
│  └─ templates/         index.html
├─ docker/
│  ├─ Dockerfile         multi-stage image, runs as non-root
│  └─ entrypoint.sh      waits for the DB, creates tables
├─ docs/
│  ├─ schema.sql         the DDL, for provisioning by hand
│  └─ test-report.md     latest test run
├─ tests/
│  └─ test_api.py        190-case suite
├─ docker-compose.yml
├─ manage.py  run.py  wsgi.py
├─ requirements.txt
├─ setup.bat  setup.sh  start.bat
└─ .env  .env.example  .gitignore
```

---

## Tables

| Table | Holds |
|---|---|
| `branches` | Shops. Rows, not an enum — add as many as you like at runtime |
| `users`, `user_branches` | Accounts, roles, and which branches each may see |
| `daily_entries` | One row per branch + category + day |
| `purchases` | Birds bought in; several suppliers per day allowed |
| `mortality_photos` | Compressed JPEGs attached to an entry |
| `workers` | Dressers, cutters and helpers, with a daily wage |
| `labour_ledger` | Attendance, payments, advances, tea and tiffin |
| `overheads` | Rent, electricity, supervisor salary — monthly, approved |
| `settings` | Waste percentages, tolerance, default wage |
| `activity_log` | Every login and mutation, with user, role, branch and IP |

Design choices worth knowing:

* **Weights are integer grams, money is `NUMERIC(14,2)`.** No floating-point
  drift in yield or reconciliation figures.
* **`UNIQUE (branch_id, category, business_date)`** — one entry per day per
  category, enforced by the database, not just the UI.
* **`UNIQUE (worker_id, entry_date, kind)`** — re-marking attendance replaces
  the day rather than stacking duplicates.
* Indexes on the columns the dashboard filters by: branch + date, status,
  branch + month.

---

## Security

Hiding a field in the browser is not security, so every rule is re-checked
server-side:

* Passwords are hashed (`werkzeug.security`), never stored in the clear.
* `@admin_required` guards users, branches, settings, the activity log,
  approvals and deletions. A supervisor calling them gets **403** and the
  attempt is logged.
* **Buying prices are stripped from the payload** sent to supervisors, and a
  supervisor's rate value is discarded on write — they cannot set it even by
  crafting a request.
* Profit, cost and margin fields are removed from supervisor responses.
* Branch access is checked per request; a supervisor cannot read or write a
  branch they are not assigned to.
* Idle timeout is enforced on the server as well as in the UI — 2 minutes for
  admins, 10 for supervisors, configurable in `.env`.

---

## Scaling

* Branch codes auto-generate (`B01`, `B02`, … or your own) and every query is
  branch-scoped, so the app is unchanged whether you run 2 shops or 200.
* Connection pooling is tuned for Neon: `pool_pre_ping` and a 280-second
  recycle, because Neon drops idle connections.
* `/api/bootstrap` is one round trip to fill the whole UI; after that only
  deltas travel.
* Mortality photos are base64 in a `TEXT` column today. Past roughly a year of
  daily photos, move them to object storage (S3/R2) and keep only the URL —
  `mortality_photos` is already a separate table so that change touches one
  model.

---

## Verified

46 automated checks pass against the API: authentication, RBAC denials for
every admin-only route, supervisor branch isolation, the duplicate-day
constraint, approval blocked until buying rates are entered, the
post-approval lock, attendance replacement, overhead approval, branch
scaling to eight, and the audit trail capturing all of it.

The calculation engine was checked against the same worked example used
throughout: 200 kg opening at ₹120 plus 205 kg bought at ₹130 gives a
weighted average of **₹125.06/kg**; revenue **₹17,180.00**; closing meat
**9.000 kg** with liver correctly drawn from the meat pool.
