@echo off
REM Usage: set_mqtt_broker.bat [host] [port]
set HOST=%~1
set PORT=%~2
if "%HOST%"=="" set HOST=192.168.1.250
if "%PORT%"=="" set PORT=1883

curl -X PUT http://localhost:8080/api/settings/mqtt -H "Content-Type: application/json" -d "{\"broker_host\":\"%HOST%\",\"broker_port\":%PORT%}"
echo.
