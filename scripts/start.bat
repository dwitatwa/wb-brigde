@echo off
rem Start the WorkBuddy Bridge with UI, failover pool, and all discovered accounts.
rem Usage: scripts\start.bat [--wsl]

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

set EXTRA_ARGS=
if "%1"=="--wsl" (
  set EXTRA_ARGS=--wsl
  shift
)

node "%PROJECT_DIR%\lib\run.js" ui --pool failover --all-accounts %EXTRA_ARGS% %*
