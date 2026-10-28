@echo off
rem Start the WorkBuddy Bridge with UI and the WorkBuddy AI failover pool.
rem Only the WorkBuddy AI section is served; pass --provider both to add the
rem WorkBuddy (CN) section. Accounts join the pool only when their sign-in
rem file is uploaded in the UI.
rem Usage: scripts\start.bat [--wsl]

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

set EXTRA_ARGS=
if "%1"=="--wsl" (
  set EXTRA_ARGS=--wsl
  shift
)

node "%PROJECT_DIR%\lib\run.js" ui --provider ai %EXTRA_ARGS% %*
