@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo Dang cai thu vien cho lan chay dau tien...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Cai thu vien that bai. Vui long kiem tra Node.js va ket noi mang.
    pause
    exit /b 1
  )
)

echo Dang mo TDQ Video Sync - DEV...
call npm.cmd start

if errorlevel 1 (
  echo.
  echo Ung dung dung do co loi. Hay chup man hinh cua so nay de kiem tra.
  pause
)

endlocal
