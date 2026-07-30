@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules" (
  echo Dang cai thu vien lan dau...
  call npm.cmd install
  if errorlevel 1 (
    echo Khong the cai thu vien. Hay kiem tra Node.js va ket noi mang.
    pause
    exit /b 1
  )
)
echo.
echo Vun Tu dang khoi dong tai http://127.0.0.1:5173
echo Nhan Ctrl+C de dung ung dung.
echo.
call npm.cmd run dev -- --host 127.0.0.1
endlocal
