@echo off
REM run_apply.bat — Windows Task Scheduler launcher for the Job Apply Agent
REM
REM Setup Windows Task Scheduler:
REM 1. Open Task Scheduler (taskschd.msc)
REM 2. Create Basic Task → Name: "Job Apply Agent"
REM 3. Trigger: Daily at 10:00 AM
REM 4. Action: Start a Program
REM    Program/script: C:\path\to\job-apply-agent\run_apply.bat
REM 5. Check "Run whether user is logged on or not" (requires password)
REM 6. Check "Run with highest privileges"
REM
REM Or run manually from Command Prompt:
REM   run_apply.bat           (full run)
REM   run_apply.bat --dry-run (dry run)

REM Get the directory of this batch file
set SCRIPT_DIR=%~dp0

REM Find Git Bash (common installation paths)
set GIT_BASH=""
if exist "C:\Program Files\Git\bin\bash.exe" (
    set GIT_BASH="C:\Program Files\Git\bin\bash.exe"
) else if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    set GIT_BASH="C:\Program Files (x86)\Git\bin\bash.exe"
) else if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" (
    set GIT_BASH="%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
)

if %GIT_BASH%=="" (
    echo ERROR: Git Bash not found. Please install Git for Windows.
    echo Download from: https://git-scm.com/download/win
    pause
    exit /b 1
)

REM Log file for this run (appends to today's log)
REM Use PowerShell for date — wmic is deprecated/removed on many Win11 builds
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set LOG_DATE=%%a

REM Create logs directory if it doesn't exist
if not exist "%SCRIPT_DIR%logs" mkdir "%SCRIPT_DIR%logs"

REM Run the shell script via Git Bash, capturing output to log file
%GIT_BASH% -c "cd '%SCRIPT_DIR:\=/%' && bash run_apply.sh %*" >> "%SCRIPT_DIR%logs\%LOG_DATE%.log" 2>&1

exit /b %ERRORLEVEL%
