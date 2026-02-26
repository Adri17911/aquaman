# Aquarium Automation Platform

Central platform for aquarium automation: MQTT telemetry ingestion, time-series storage, real-time dashboard, and device control (heater, LED).

## Quick start

### 1. Backend (API + MQTT worker)

```bash
cd "c:\Users\Analog\Desktop\Backend 3.0"
py -m pip install -r requirements.txt
```

Edit `settings.json` and set your MQTT broker host (default `192.168.1.100`).

```bash
py -m uvicorn main:app --host 0.0.0.0 --port 8080
```

### 2. Frontend (development)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — Vite proxies `/api` to the backend.

### 3. Production (single server)

Build the frontend and run the backend; it serves the built SPA:

```bash
cd frontend
npm install
npm run build
cd ..
py -m uvicorn main:app --host 0.0.0.0 --port 8080
```

Open http://localhost:8080

## Architecture

- **API** (`main.py`): FastAPI app with REST endpoints, SSE stream, serves frontend
- **MQTT worker**: Subscribes to `aqua/+/telemetry`, `aqua/+/status`, `aqua/+/ack/#`; writes to DB; emits live events
- **Database**: SQLite (`aqua.db`) — devices, telemetry, commands, acks, status_events
- **Frontend**: React + Vite + TypeScript + Tailwind + Recharts

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health + MQTT status |
| `GET /api/devices` | List devices |
| `GET /api/devices/{id}` | Device detail + latest telemetry |
| `GET /api/telemetry/latest?device_id=` | Latest telemetry snapshot |
| `GET /api/telemetry?device_id=&metric=` | Time-series for charts |
| `POST /api/devices/{id}/commands/heater` | Heater: `{"action":"on|off|toggle"}` |
| `POST /api/devices/{id}/commands/led` | LED: `{"action":"on|off|toggle|set_brightness", "payload":{"value":128}}` |
| `GET /api/commands/{correlation_id}` | Command status (SENT/ACKED/TIMEOUT) |
| `GET /api/stream` | SSE live stream (telemetry, status, acks) |

## MQTT topics

- `aqua/{device_id}/telemetry` — ESP32 publishes sensor data
- `aqua/{device_id}/status` — online/offline (retained, LWT)
- `aqua/{device_id}/cmd/heater` — Backend → ESP32 heater commands
- `aqua/{device_id}/cmd/led` — Backend → ESP32 LED commands
- `aqua/{device_id}/ack/heater` — ESP32 → Backend heater ack
- `aqua/{device_id}/ack/led` — ESP32 → Backend LED ack

Command payloads use `correlation_id` so the backend can match acks.
