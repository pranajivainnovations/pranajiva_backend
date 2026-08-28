@echo off
REM Double-click convenience wrapper — runs deploy.sh via Git Bash so you don't need an open
REM terminal. If Git Bash isn't at the default install path, edit BASH_EXE below.

set "BASH_EXE=C:\Program Files\Git\bin\bash.exe"

if not exist "%BASH_EXE%" (
  echo Git Bash not found at "%BASH_EXE%".
  echo Edit BASH_EXE at the top of deploy.bat to point at your bash.exe.
  pause
  exit /b 1
)

"%BASH_EXE%" "%~dp0deploy.sh"

REM deploy.sh appends the outcome, commit and timestamp to DEPLOYED.md. Echo the tail here so a
REM double-click deploy still shows what was recorded before the window is dismissed - otherwise
REM the record exists but nobody sees it, which defeats the point of keeping one.
echo.
echo ================ last entry in DEPLOYED.md ================
if exist "%~dp0DEPLOYED.md" (
  powershell -NoProfile -Command "Get-Content -Path \"%~dp0DEPLOYED.md\" -Tail 9"
) else (
  echo No DEPLOYED.md yet - deploy.sh did not reach the recording step.
)
echo ==========================================================
pause
