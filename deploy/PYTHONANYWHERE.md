# Deploying to PythonAnywhere

## Read this first — the free tier cannot reach Neon

A free PythonAnywhere account may only make **outbound HTTP(S) connections to
an allow-listed set of sites**. A PostgreSQL connection is neither HTTP nor on
that list, so **your Neon database is unreachable from a free account**. This
is not a configuration problem and there is no way around it on the free plan.

Three ways forward:

| Option | Database | Cost | Notes |
|---|---|---|---|
| **PythonAnywhere free** | SQLite file on the server | free | Fine for testing. Steps below. |
| **PythonAnywhere paid** | Your Neon instance | from $5/mo | Paid accounts have unrestricted outbound access. |
| **Render free** | Your Neon instance | free | See `render.yaml`. Sleeps after 15 min idle. |

If the point is to test the app, the SQLite route below is the quickest. If the
point is to test it *against your real Neon data*, PythonAnywhere free will not
do it — use Render.

---

## Free tier, with SQLite

### 1. Get the code onto the server

Open a **Bash console** on PythonAnywhere and clone the repo:

```bash
git clone https://github.com/srinivasareddy-syamala/VenusCCSoft.git venus
cd venus
```

### 2. Create a virtualenv and install

```bash
mkvirtualenv venus --python=/usr/bin/python3.10
pip install -r requirements.txt
```

`psycopg2-binary` is in `requirements.txt` and is only needed for PostgreSQL.
If it fails to build on the free tier, it is safe to skip — SQLite does not
need it:

```bash
pip install Flask Flask-SQLAlchemy SQLAlchemy python-dotenv Werkzeug
```

### 3. Create the web app

**Web** tab → **Add a new web app** → **Manual configuration** → **Python 3.10**.

Do *not* pick the "Flask" option; it writes a template app over your code.

### 4. Point it at the project

On the **Web** tab set:

- **Source code**: `/home/srinivasareddy/venus`
- **Working directory**: `/home/srinivasareddy/venus`
- **Virtualenv**: `/home/srinivasareddy/.virtualenvs/venus`

Then click the **WSGI configuration file** link and replace its entire contents
with the contents of `deploy/pythonanywhere_wsgi.py` from this repo.

Change the `SECRET_KEY` line to a real value first:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 5. Static files

Still on the **Web** tab, add a static file mapping so the logo and JavaScript
are served directly rather than through Flask:

- **URL**: `/static/`
- **Directory**: `/home/srinivasareddy/venus/app/static/`

### 6. Create the tables and an admin account

The tables create themselves the first time the app starts. Add an
administrator from the Bash console:

```bash
cd ~/venus
workon venus
export DATABASE_URL="sqlite:////home/srinivasareddy/venus/venus.db"
export SECRET_KEY="the-same-key-you-put-in-the-wsgi-file"
python manage.py create-admin
```

Optionally load the demo dataset to have something to look at:

```bash
python manage.py seed
```

### 7. Reload

Press the green **Reload** button on the Web tab, then open
`https://srinivasareddy.pythonanywhere.com`.

---

## Updating later

```bash
cd ~/venus && git pull
workon venus && pip install -r requirements.txt
python manage.py upgrade-db     # adds any new columns to the existing database
```

Then **Reload** on the Web tab.

---

## Free tier limits worth knowing

- **100 CPU-seconds a day.** Ordinary page loads are cheap, but loading the
  demo dataset repeatedly will eat into it.
- **No custom domain** — the address is `srinivasareddy.pythonanywhere.com`.
- **One web worker**, so the connection pool is set to 2 in the WSGI file.
- The app is always on; unlike Render's free tier it does not sleep.

## If you later move to a paid account

Set `DATABASE_URL` to your Neon connection string — either in the WSGI file or
as an environment variable — and reload. `python manage.py upgrade-db` will
create the tables there. Nothing else changes.
