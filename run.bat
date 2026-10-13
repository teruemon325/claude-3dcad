@echo off
rem Claude 3DCAD launcher for Windows. Double-click this file to start the app.
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto start

echo ============================================================
echo  First-time setup. This takes a few minutes (about 100 MB).
echo ============================================================
py -3.12 --version >nul 2>&1
if errorlevel 1 goto nopython

py -3.12 -m venv .venv
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -e .
if errorlevel 1 goto failed

:start
echo.
echo ============================================================
echo  Starting Claude 3DCAD (Claude 3DCAD / USD BRep kernel)
echo  The browser opens automatically. Close this window to quit.
echo ============================================================
".venv\Scripts\python.exe" -m cad3d.server --open
pause
exit /b 0

:nopython
echo.
echo Python 3.12 was not found.
echo Install it from https://www.python.org/downloads/release/python-31210/
echo ("Windows installer (64-bit)"), then double-click run.bat again.
pause
exit /b 1

:failed
echo.
echo Setup failed. Delete the ".venv" folder and try again.
pause
exit /b 1
