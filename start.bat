@echo off
cd /d "%~dp0"

echo Starting AQUA stack...
echo.

REM 1. Mosquitto (MQTT broker)
echo [1/3] Starting Mosquitto...
start "Mosquitto" /d "C:\Program Files\mosquitto" cmd /k "mosquitto.exe -c mosquitto.conf -v"
timeout /t 2 /nobreak > nul

REM 2. Backend (FastAPI)
echo [2/3] Starting Backend...
start "Backend" cmd /k python main.py
timeout /t 3 /nobreak > nul

REM 3. Frontend (Vite dev server)
echo [3/3] Starting Frontend...
start "Frontend" cmd /k "cd frontend && npm run dev"

echo.
echo All services launched. Frontend: http://localhost:5173  Backend: http://localhost:8080
echo Close each window to stop its service.
pause
