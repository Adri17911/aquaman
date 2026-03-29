# AQUA – Aquarium Automation Platform (Backend 4.0)

This tree is a **development copy** of the platform (cloned from Backend 3.0). Run and deploy from here when testing 4.0-specific changes.

AQUA is a central platform for aquarium automation: **ESP32** devices publish sensor data and receive commands over **MQTT**; the **backend** ingests telemetry, stores time-series data, runs LED dawn/dusk and 24h curve schedules, and serves a **web dashboard** for monitoring and control.

---

## Features

- **Real-time dashboard** – temperature, light (lux), water level, heater and LED status
- **Device control** – heater on/off/toggle, LED brightness and on/off
- **Scenarios** – dawn/dusk schedules and custom 24h brightness curves per device
- **Time-series storage** – SQLite-backed telemetry with configurable retention
- **Live updates** – Server-Sent Events (SSE) for instant UI updates
- **Local and remote** – MQTT on LAN; optional **MQTT over TLS (MQTTs)** for ESP32s over the internet
- **Docker-ready** – single stack with backend + Mosquitto for easy deployment (e.g. Portainer)

---

## Architecture

A deeper overview (components, MQTT topics, data flows, modules) is in **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

```
┌─────────────┐     MQTT/MQTTs      ┌──────────────┐     REST + SSE      ┌─────────────┐
│   ESP32     │ ◄─────────────────► │  Mosquitto   │ ◄──────────────────► │   Backend   │
│ (sensors,   │                     │  (broker)    │                      │  (FastAPI)   │
│  heater,    │                     └──────────────┘                      │  + SQLite    │
│  LED)       │                              │                            │  + Scheduler │
└─────────────┘                              │                            └──────┬──────┘
                                             │                                     │
                                             │                            ┌─────────▼─────────┐
                                             │                            │  React dashboard   │
                                             │                            │  (Vite, Tailwind)  │
                                             │                            └────────────────────┘
```

- **Backend** (`main.py`): FastAPI app – REST API, SSE stream, static frontend, MQTT worker, scheduler
- **MQTT worker**: Subscribes to `aqua/+/telemetry`, `aqua/+/status`, `aqua/+/ack/#`; writes to DB; publishes commands
- **Database**: SQLite (`aqua.db`) – devices, telemetry, commands, acks, schedules
- **Frontend**: React + Vite + TypeScript + Tailwind + Recharts

---

## Documentation

| Document | Description |
|----------|-------------|
| [**Setup guide**](docs/SETUP.md) | Prerequisites, local development, Docker, Portainer, MQTT over TLS |
| [**ESP32 guide**](docs/ESP32.md) | Hardware, firmware setup, WiFi/MQTT config, MQTTs for internet |
| [**API reference**](docs/API.md) | All REST endpoints, request/response formats |
| [**Configuration**](docs/CONFIGURATION.md) | settings.json, environment variables, Mosquitto |
| [**Troubleshooting**](docs/TROUBLESHOOTING.md) | Common issues and fixes |
| [**Docker**](DOCKER.md) | Docker Compose, Portainer deploy, MQTTs in Docker |

---

## Quick start (local)

1. **MQTT broker** – Install and run [Mosquitto](https://mosquitto.org/) (e.g. port 1883).

2. **Backend**
   ```bash
   pip install -r requirements.txt
   ```
   Edit `settings.json` and set `mqtt.broker_host` to your broker IP. Then:
   ```bash
   uvicorn main:app --host 0.0.0.0 --port 8080
   ```

3. **Frontend (dev)**  
   In another terminal:
   ```bash
   cd frontend && npm install && npm run dev
   ```
   Open **http://localhost:5173** (Vite proxies `/api` to the backend).

4. **Production (single process)**  
   Build frontend and run backend only:
   ```bash
   cd frontend && npm run build && cd ..
   uvicorn main:app --host 0.0.0.0 --port 8080
   ```
   Open **http://localhost:8080**.

---

## Quick start (Docker)

```bash
docker compose up -d
```

- **Dashboard:** http://localhost:8080  
- **MQTT:** localhost:1883 (plain), 8883 (TLS if configured)

See [DOCKER.md](DOCKER.md) and [docs/SETUP.md](docs/SETUP.md) for Portainer and MQTTs setup.

---

## MQTT topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `aqua/{device_id}/telemetry` | ESP32 → Broker | Sensor payload (temp, lux, water, heater, etc.) |
| `aqua/{device_id}/status` | ESP32 → Broker | online/offline (LWT) |
| `aqua/{device_id}/cmd/heater` | Backend → ESP32 | Heater command (action + correlation_id) |
| `aqua/{device_id}/cmd/led` | Backend → ESP32 | LED command |
| `aqua/{device_id}/ack/heater` | ESP32 → Backend | Heater ack |
| `aqua/{device_id}/ack/led` | ESP32 → Backend | LED ack |

---

## License

Use and modify as you like. No formal license specified.
