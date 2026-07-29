@echo off
setlocal

REM Thin Windows wrapper around the native PowerShell launcher.
REM Manual usage:
REM   run_apply.bat
REM   run_apply.bat -DryRun -SkipWindowGuard

set "SCRIPT_DIR=%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run_apply.ps1" %*
exit /b %ERRORLEVEL%
