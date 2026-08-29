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

and open <http://127.0.0.1:5000> — or whatever `PORT` you set in `.env`.

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

## Ports and process sizing

Nothing is pinned to a port number. Everything comes from `.env`:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 5000 | The port the app listens on |
| `HOST` | 127.0.0.1 | Interface for the dev server; use `0.0.0.0` to reach it from another machine |
| `APP_PORT` | 8000 | Port on your machine that Docker maps to the container's `PORT` |
| `WEB_CONCURRENCY` | 2 | gunicorn workers |
| `WEB_THREADS` | 4 | Threads per worker |
| `DB_PORT` / `ADMINER_PORT` | 5432 / 8080 | Only with the `localdb` and `tools` Compose profiles |

Hosting platforms inject their own `PORT`, and that takes precedence, so the
same image runs locally and on a host without editing anything.

---

## Deploying free, to try it out

The app fits a free tier as-is. The one thing to get right: use your **Neon**
database rather than the host's free Postgres, because Render's free database
is deleted after 30 days while Neon's free plan does not expire.

**Render** — easiest, no card needed. `render.yaml` in this repo is a
blueprint: in Render choose **New → Blueprint**, point it at the repo, and the
only thing to fill in is `DATABASE_URL` (your Neon string). `SECRET_KEY` is
generated for you. Tables are created on first boot, then:

```
python manage.py create-admin      # from the Render shell
```

Free instances sleep after 15 minutes idle and take roughly a minute to wake,
which is fine for testing and not for a live shop.

Alternatives worth knowing: **Koyeb** (no sleep on the free service, container
or Git deploys) and **PythonAnywhere** (very stable, but 100 CPU-seconds a day
and no custom domain). **Fly.io** dropped its free tier, and **Railway** gives
$5 of credit a month once you add a card.

---

## Upgrading an existing installation

`db.create_all()` only ever creates *tables*. It will not add a *column* to a
table that already exists, so an installation set up by an earlier release ends
up one or more columns short, and the first query that touches them fails —
which is how a missing `overheads.spend_date` showed up as a 500 straight after
signing in.

The app now closes that gap itself on start-up, and there is a command for it:

```
python manage.py upgrade-db
```

It creates missing tables, runs `ALTER TABLE ... ADD COLUMN` for every column
the models have and the database has not, and creates missing indexes. It never
drops or rewrites anything, it is safe to run repeatedly, and a database that is
already current reports no changes. Set `AUTO_UPGRADE_DB=0` to run migrations
yourself; the app then returns a **503 saying what is missing and what to run**,
rather than a bare 500.

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

## Docker

```bash
docker compose up -d --build                    # uses DATABASE_URL from .env
docker compose --profile localdb up -d --build  # bundles PostgreSQL 16 too
docker compose --profile tools up -d            # + Adminer on :8080
docker compose --profile backup run --rm db-backup   # dump into ./backups
```

Then open <http://localhost:8000>, or the `APP_PORT` you set in `.env`.

| | |
|---|---|
| Logs | `docker compose logs -f web` |
| Create an admin | `docker compose exec web python manage.py create-admin` |
| Load demo data | `docker compose exec web python manage.py seed` |
| Stop, keep data | `docker compose down` |
| Stop, wipe local DB | `docker compose down -v` |

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` and the first boot creates
the administrator for you.

The image is multi-stage, so no compiler ships in the runtime layer. It runs as
an unprivileged user on a read-only filesystem with `no-new-privileges`, and
`/healthz` backs the container healthcheck — deliberately a liveness check
only (is the process up), not a database check, so the 30-second polling
this and the platform's own health check do around the clock never touches
the database. On a serverless/autosuspend Postgres like Neon, a health check
that queried the database on that schedule would keep it permanently awake
and burn through a compute-hour quota in days regardless of real traffic —
see `/healthz/db` below for the check this used to be.

There is deliberately no `depends_on` on the web service. The entrypoint waits
for the database itself, which means the same file works whether the database
is the bundled container or your own, and on every Compose v2 rather than only
2.20 and newer.

## Commands

| Command | Purpose |
|---|---|
| `python manage.py init-db` | Create every table, then upgrade (safe to re-run) |
| `python manage.py upgrade-db` | Bring an older database up to the current models |
| `python manage.py create-admin` | Interactive administrator account |
| `python manage.py seed` | Load the 14-day demo dataset |
| `python manage.py reset-db` | Drop and recreate everything |
| `python run.py` | Development server |
| `waitress-serve --port=%PORT% wsgi:app` | Production server on Windows |
| `gunicorn wsgi:app -b 0.0.0.0:$PORT -w $WEB_CONCURRENCY` | Production server on Linux |

`GET /healthz` reports only whether the web process itself is up — it does
not touch the database, so it is safe for a platform or container health
check to poll every few seconds forever. `GET /healthz/db` is the actual
database-reachability check; use it for manual troubleshooting (`curl` it
when something seems wrong) or a deliberately infrequent, human-configured
uptime monitor — never for anything that polls automatically and often, or
it will defeat a serverless database's ability to ever scale to zero (this
is exactly what exhausted a month's Neon free-tier compute-hour quota in a
few days: the old `/healthz` ran `SELECT 1` and both the platform's and the
container's own health checks polled it every 30 seconds, so the database
never went idle long enough to suspend).

---

## Layout

```
venus/
├─ app/                  the application package
│  ├─ __init__.py        factory, error handlers, page route
│  ├─ config.py          environment settings, connection pooling
│  ├─ extensions.py      the SQLAlchemy instance
│  ├─ models.py          15 tables
│  ├─ calc.py            the authoritative calculation engine
│  ├─ schema.py          brings an older database up to the models
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
│  └─ test_api.py        402-case suite
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
| `customers` | Hotels, hostels and functions, per branch, with the price agreed for each |
| `customer_sales` | What each hotel took on a given day, at market and at their rate |
| `customer_payments` | Money received against a hotel's outstanding balance |
| `workers` | Dressers, cutters and helpers, with a daily wage |
| `labour_ledger` | Attendance, payments, advances, tea and tiffin |
| `overheads` | Rent, power, salaries — monthly and spread, or dated and charged to one day |
| `day_close` | The cash and PhonePe handed over at close, per branch per day |
| `settings` | Waste percentages, tolerance, default wage |
| `activity_log` | Every login and mutation, with user, role, branch and IP |

Design choices worth knowing:

* **Weights are integer grams, money is `NUMERIC(14,2)`.** No floating-point
  drift in yield or reconciliation figures.
* **`UNIQUE (branch_id, category, business_date)`** — one entry per day per
  category, enforced by the database, not just the UI.
* **`UNIQUE (worker_id, entry_date, kind)`** — re-marking attendance replaces
  the day rather than stacking duplicates.
* **`UNIQUE (branch_id, code)` on customers** — hotel codes are unique inside a
  branch, so two shops can both have an `H01`.
* **`customer_sales.line_no`** keeps the rows in the order they were typed. The
  primary key is a random UUID, so ordering by it would shuffle them.
* Indexes on the columns the dashboard filters by: branch + date, status,
  branch + month, customer + date.

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

## Performance

The first version loaded everything and cost three queries per entry. Measured
on the demo dataset, with a 50 KB mortality photo on every entry:

| | Queries | Payload | Time |
|---|---|---|---|
| Before | 358 | 270 KB (+2.8 MB of photos) | 487 ms |
| After | **23** | **337 KB, photos excluded** | **103 ms** |

Three things changed:

* **`DayCostIndex`** resolves labour and overheads for every branch-day in
  three grouped queries instead of three per entry. The query count no longer
  grows with the number of records — pinned by a test that adds 40 entries and
  asserts the count barely moves.
* **Eager loading.** `entries_query()` pulls purchases, photos, hotel lines and
  user names in one round trip each rather than one per row.
* **Photos are deferred and opt-in.** `MortalityPhoto.data_url` is a deferred
  column, so counting photos no longer drags the base64 off the disk. Lists
  carry `photoCount`; the browser fetches images from
  `/api/entries/<id>/photos` only when an entry is opened.

Paging is real: `/api/entries?page=&pageSize=` returns rows with `total` and
`pages`, capped at 1,000. The first load takes a **120-day window** rather than
"the newest 2,000 and quietly lose the rest" — and when a report asks for dates
outside that window the browser widens it first, so a date range can never
silently omit days that simply had not been fetched.

---

## Hotels, hostels & functions

A hotel does not pay the counter price. Register it once under
**Hotels & Functions** with the concession agreed for skin, skinless, liver and
live birds — "fifty rupees under market for skinless" — and from then on every
sale is priced from that day's Section C rate:

```
their rate  =  today's market rate  −  agreed concession
concession  =  (market − their rate) × kg          reported, never hidden
```

A customer can be put on a flat contract rate instead, and any single line can
be overridden for a one-off price. Both figures are stored on every sale line,
so the discount handed out over a period can always be added up.

* Three types: **hotel**, **hostel** and **function** — a marriage party or
  bulk order, priced the same way, with a per-line override for a discount
  negotiated on the day.
* Sales are **additional to** the counter figures in Section G. Meat comes out
  of the meat pool; **live birds come off the bird count and weight instead**,
  so a function taking 30 live birds reduces closing birds by 30, not the meat.
* Each line is marked **paid** or **on account**. Paid settles on the day; on
  account adds to that customer's balance.
* Every hotel has its **own ledger** — dated sales, receipts and a running
  balance, exportable to CSV.
* A sale only becomes real debt **once the admin approves the day**. Until then
  it is listed as pending and excluded from every balance.
* Both admins and supervisors can register a customer and record a receipt.
  Only an admin can delete one, or change an opening balance.

---

## Overheads

Two shapes, because a shop has two kinds of cost:

* **Dated** — spent on one day (a repair, a delivery charge). Charged to that
  day in full.
* **Monthly** — a standing cost (rent, power, salary). Spread evenly across the
  days of the month, so no single day carries the whole rent.

The **overhead ledger** shows either one branch or every branch at once, day by
day over a date range, with the per-branch split on each row and a CSV export.

---

## End of day — cash handover

At close the supervisor records what was handed to management, split between
cash and PhonePe. It is set against what the day's trading says should be in
hand — which is deliberately **not** revenue:

```
  counter meat + live sales + cutting charges
+ hotel / function sales paid on the day
+ receipts collected against old bills
− wages, advances, tea, tiffin and shop costs paid out
= what should be handed over
```

A sale on account puts nothing in the till, and an advance handed to a cutter
takes money out of it. Comparing against revenue would show a false shortfall
on any day with either. The difference reads as **balanced**, **short** or
**over**; the tab carries a badge for days that do not tally or were never
declared; and an admin can verify a handover to lock it.

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

**367 API cases and 83 browser-level checks** now run against the real UI in
jsdom. Worked examples the suite pins down:

* A hotel on ₹50 under a ₹250 market is billed ₹200/kg; 20 kg comes to ₹4,000
  with ₹1,000 recorded as concession, and that 20 kg leaves the closing meat.
* A function on ₹20 under a ₹180 live rate taking 30 birds over 60 kg is billed
  ₹9,600; closing birds drops by 30 and closing **meat is untouched**.
* A ₹3,000 monthly rent divides exactly by the days in the month; a ₹500 dated
  repair lands on its own day in full.
* A day selling ₹17,180 over the counter with a ₹500 advance paid out expects
  ₹16,680 in hand; declaring ₹15,000 + ₹1,180 reads as ₹1,000 short.
* Three rapid clicks on "Save worker" create one worker, and the same advance
  posted twice within seconds is refused with a 409.
* A database built by an older release is detected, upgraded in place, and signs
  in normally with existing rows untouched. The suite builds a genuine old
  schema, asserts the 503 explains itself, upgrades, and re-runs every module
  against it.
