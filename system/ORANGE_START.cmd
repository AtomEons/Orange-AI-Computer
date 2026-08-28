@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where bun.exe >nul 2>nul
if errorlevel 1 goto :bootstrap

if "%~1"=="" goto :prepare
bun scripts\llm-deploy\orange-deploy.mjs %*
exit /b %errorlevel%

:prepare
echo OrangeFive deployment discovery is observational. Apply requires the exact printed plan hash.
bun scripts\llm-deploy\orange-deploy.mjs discover
if errorlevel 1 exit /b %errorlevel%
bun scripts\llm-deploy\orange-deploy.mjs plan
if errorlevel 1 exit /b %errorlevel%
echo.
echo Review the plan exactly as printed. To approve it, run:
echo   ORANGE_START.cmd apply --approve ^<plan-sha256^>
exit /b 0

:bootstrap
echo Bun is not installed. OrangeFive will not mutate the machine without an explicit operator command.
echo Install only the manifest-pinned deploy runtime, then run ORANGE_START.cmd again:
echo   winget install --id Oven-sh.Bun --exact --version 1.2.0 --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
exit /b 2

