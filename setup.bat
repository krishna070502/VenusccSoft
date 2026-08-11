@echo off
REM ===========================================================
REM  Venus Chicken Centers - Windows setup
REM  Creates the virtual environment, installs deps, builds the
REM  database tables and an admin account.
REM ===========================================================
setlocal

echo.
echo [1/5] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo   Python not found. Install Python 3.10+ from python.org and tick "Add to PATH".
    pause & exit /b 1
)
python --version

echo.
echo [2/5] Creating virtual environment in .\venv ...
if exist venv (
    echo   venv already exists - reusing it.
) else (
    python -m venv venv
    if errorlevel 1 ( echo   Failed to create venv. & pause & exit /b 1 )
)

echo.
echo [3/5] Installing dependencies...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip --quiet
pip install -r requirements.txt
if errorlevel 1 ( echo   Install failed. & pause & exit /b 1 )

echo.
echo [4/5] Creating database tables...
python manage.py init-db
python manage.py upgrade-db
if errorlevel 1 (
    echo   Could not reach the database. Check DATABASE_URL in .env
    pause & exit /b 1
)

echo.
echo [5/5] Create your administrator account
python manage.py create-admin

echo.
echo ===========================================================
echo  Done. To start the application:
echo.
echo      venv\Scripts\activate
echo      python run.py
echo.
echo  Then open  http://127.0.0.1:5000
echo ===========================================================
pause
