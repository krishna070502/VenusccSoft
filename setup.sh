#!/usr/bin/env bash
# Venus Chicken Centers — macOS / Linux setup
set -e
echo "[1/5] Python"; python3 --version
echo "[2/5] Virtual environment in ./venv"
[ -d venv ] || python3 -m venv venv
source venv/bin/activate
echo "[3/5] Dependencies"
python -m pip install --upgrade pip --quiet
pip install -r requirements.txt
echo "[4/5] Tables"
python manage.py init-db
python manage.py upgrade-db
echo "[5/5] Administrator account"
python manage.py create-admin
cat <<'MSG'

===========================================================
 Done. Start it with:
     source venv/bin/activate
     python run.py
 Then open http://127.0.0.1:${PORT:-5000}   (PORT is set in .env)
===========================================================
MSG
