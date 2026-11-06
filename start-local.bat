@echo off
cd /d "%~dp0"
echo.
echo  PITA DZ TV - نسخة تجريبية محلية
echo  افتح في المتصفح:  http://127.0.0.1:8765/
echo  للإيقاف: Ctrl+C
echo.
python -m http.server 8765
pause
