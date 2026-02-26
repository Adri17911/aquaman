@echo off
cd /d "%~dp0\.."
echo === MQTT Diagnostic ===
echo.

echo [1] Checking if Mosquitto listens on LAN (0.0.0.0:1883)...
netstat -an | findstr "1883"
echo    Should show 0.0.0.0:1883 or [::]:1883 LISTENING for LAN access.
echo.

echo [2] Subscribing to aqua/# for 15 seconds - ESP32 messages should appear below...
echo    (If nothing appears, ESP32 is not reaching the broker)
timeout /t 2 /nobreak > nul
cd "C:\Program Files\mosquitto"
mosquitto_sub -h 127.0.0.1 -t "aqua/#" -v -W 15 2>&1
echo.

echo [3] Testing backend health...
curl -s http://localhost:8080/api/health 2>nul || echo    Backend not responding on 8080
echo.

echo [4] Listing devices from backend...
curl -s http://localhost:8080/api/devices 2>nul || echo    Backend not responding
echo.
pause
