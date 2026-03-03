# AQUA – Troubleshooting

Common issues and how to fix them.

---

## Dashboard / API

### "Application startup complete" but dashboard is blank or 404

- **Cause:** Frontend not built or wrong path.
- **Fix:** Run `cd frontend && npm run build`. Ensure `frontend/dist` exists and contains `index.html` and `assets/`. Restart the backend.

### CORS errors in browser when using dev server (Vite on 5173)

- **Cause:** API and frontend on different origins; backend CORS may not allow the dev origin.
- **Fix:** The backend uses `CORSMiddleware` with `allow_origins=["*"]` by default. If you restricted it, add `http://localhost:5173`. Or use the production build and serve from the same origin (port 8080).

### API returns 404 for /api/...

- **Cause:** Request not prefixed with `/api`, or wrong port.
- **Fix:** Use base URL `http://localhost:8080/api` (or your server). Frontend dev server proxies `/api` to the backend when configured in Vite.

---

## MQTT

### MQTT status shows "Disconnected" in dashboard

- **Checks:**
  1. Mosquitto is running and listening on the configured port (e.g. 1883).
  2. `settings.json` (or env) has the correct `broker_host` and `broker_port`.
  3. No firewall blocking the backend → broker (e.g. Docker host to container, or host to host).
- **Fix:** Start Mosquitto, correct the broker host/port in Settings, save. Backend reconnects automatically. Check backend logs for `MQTT connecting to ...` and any connect errors.

### ESP32 not auto-detected (app and ESP32 must use the same broker)

- **Cause:** The app (backend) and the ESP32 connect to **different** MQTT brokers. The ESP32 is only a **client**; it does not run the broker. Both must connect to the **same** broker (e.g. Mosquitto on your PC or Pi) for the app to see telemetry.
- **Fix:**
  1. In the app: **Settings → Broker host** — set this to the **same** IP or hostname as `mqttServer` in your ESP32 sketch (e.g. `192.168.0.250`).
  2. Ensure Mosquitto is running on that machine and listening on port 1883.
  3. After saving, the app reconnects; when the ESP32 publishes to `aqua/esp32-01/telemetry` (or your `device_id`), the device appears in the dashboard.

### Backend connects but no telemetry / devices

- **Cause:** ESP32 not publishing, or wrong topic root / device_id.
- **Checks:**
  1. ESP32 is connected to the **same** broker and uses the same **topic_root** (default `aqua`).
  2. Telemetry is published to `aqua/{device_id}/telemetry` with at least `device_id` and `ip` in the JSON.
  3. Backend logs show "Telemetry ..." when it receives a message (check log level).
- **Fix:** Confirm ESP32 broker IP/port and `deviceId` / `mqttTopicRoot`. Set the app’s Broker host to match the ESP32’s `mqttServer`.

### Commands sent but ESP32 doesn't respond

- **Checks:**
  1. ESP32 is subscribed to `aqua/{device_id}/cmd/heater` and `aqua/{device_id}/cmd/led` (correct device_id).
  2. Backend shows "Connected" (commands are published only when connected).
  3. Command status in dashboard: SENT → ACKED (if ESP32 publishes ack) or TIMEOUT.
- **Fix:** Verify topics on ESP32 match backend (topic_root + device_id). Check ESP32 serial output for received messages. If using TLS, ensure ESP32 uses the same broker and port (8883).

### MQTT over TLS: backend fails to connect

- **Checks:**
  1. Broker is listening on 8883 and TLS is configured (certificate, key).
  2. `use_tls` is true; `broker_port` is 8883 (or overridden by env).
  3. For self-signed certs, `tls_insecure` is true or a valid CA is set in `ca_certs`.
- **Fix:** Test broker with another TLS client (e.g. `mosquitto_pub` with `--cafile`). Check backend logs for TLS/connect errors. On Docker, ensure backend can reach broker hostname (e.g. `mosquitto` service name) on 8883.

---

## Docker

### Container exits immediately or "address already in use"

- **Cause:** Port 8080 or 1883/8883 already in use on the host.
- **Fix:** Change host port in `docker-compose.yml` (e.g. `"8081:8080"`) or stop the process using the port.

### Backend in Docker can't reach Mosquitto / broker not "autodiscovered"

- **Cause:** Wrong broker host; Docker network; or env not applied in Portainer.
- **Fix:**
  1. When both `aqua` and `mosquitto` are in the same stack with `AQUA_DATA_DIR=/data`, the backend defaults to `mosquitto:1883` if the broker host was never changed from the default. Rebuild and redeploy so this takes effect.
  2. Otherwise set env for the aqua service: `AQUA_MQTT_BROKER_HOST=mosquitto` and `AQUA_MQTT_BROKER_PORT=1883` (same network). If the broker runs on the host, use `host.docker.internal` (Windows/Mac) or the host IP on Linux.
  3. In Portainer, check the stack's **Environment** for the aqua service and add these if missing.

### No data after restarting containers

- **Cause:** Volumes not used or wrong `AQUA_DATA_DIR`.
- **Fix:** Use named volumes (e.g. `aqua_data:/data`) and `AQUA_DATA_DIR=/data`. Data lives in the volume; recreating containers keeps it.

---

## ESP32

### ESP32 doesn't connect to WiFi

- **Fix:** Check SSID/password in the sketch. Ensure 2.4 GHz WiFi (ESP32 doesn’t use 5 GHz). Check Serial Monitor for connection progress.

### ESP32 connects to WiFi but not MQTT

- **Checks:** Broker IP and port (1883/8883). Broker allows connections (no auth or correct username/password). ESP32 and broker on same network (or reachable via port forward for MQTTs).
- **Fix:** Ping broker from another device on same network. For MQTTs, ensure TLS and certificate handling on ESP32 (e.g. WiFiClientSecure, CA or setInsecure).

### Device appears offline in dashboard

- **Cause:** No recent telemetry or status; or backend didn’t receive it.
- **Fix:** ESP32 must publish to `aqua/{device_id}/telemetry` (and optionally status). Backend marks device online when it receives telemetry/status. Check backend logs and MQTT "Connected" status.

### Temperature shows -127 or wrong value

- **Cause:** DS18B20 read failure (disconnect or bad wiring). Some firmware versions wrote -127 (DEVICE_DISCONNECTED_C) into telemetry.
- **Fix:** In the sketch, only update `tempC` when the read is valid (not -127); keep last good value. Check OneWire wiring and pull-up.

---

## Schedules / LED

### Dawn–dusk or curve schedule doesn't change LED

- **Checks:** Schedule is **enabled** and has the correct **device_id**. Device is **online**. Backend runs the scheduler loop (runs every 60 s when app is up).
- **Fix:** Confirm device is online and schedule is enabled. Check backend logs for scheduler activity if added. Ensure ESP32 subscribes to LED commands and applies brightness.

### "Command rejected – device offline"

- **Cause:** Backend considers the device offline (no recent telemetry/status).
- **Fix:** Get telemetry flowing from ESP32; device will show online. Then retry the command.

---

## Getting more help

- **Logs:** Run the backend with log level INFO (default). Increase to DEBUG if your build supports it.
- **MQTT:** Use a client (e.g. MQTT Explorer, `mosquitto_sub`) to subscribe to `aqua/#` and confirm messages from ESP32 and from the backend.
- **API:** Use the [API reference](API.md) and test with `curl` or the dashboard Network tab.
