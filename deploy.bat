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
pause
