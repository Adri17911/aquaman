# AQUA – Configuration reference

This document describes **settings.json**, **environment variables**, and **Mosquitto** configuration.

---

## settings.json

The backend creates `settings.json` on first run in the application directory (or in `AQUA_DATA_DIR` when set). All settings are optional; defaults apply if omitted.

### Location

- **Default:** next to `main.py` (e.g. `Backend 3.0/settings.json`).
- **Docker:** set `AQUA_DATA_DIR=/data` and mount a volume at `/data`; file is `/data/settings.json`.

### Structure

```json
{
  "mqtt": {
    "broker_host": "192.168.1.100",
    "broker_port": 1883,
    "username": null,
    "password": null,
    "client_id": "aqua-backend",
    "topic_root": "aqua",
    "default_device_id": "esp32-01",
    "enabled": true,
    "keepalive_seconds": 60,
    "telemetry_qos": 1,
    "command_qos": 1,
    "command_timeout_seconds": 25,
    "use_tls": false,
    "ca_certs": null,
    "tls_insecure": false,
    "public_broker_host": null,
    "public_broker_port": null
  },
  "logging": {
    "retain_days": 30
  }
}
```

### MQTT fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| broker_host | string | 192.168.1.100 | MQTT broker hostname or IP |
| broker_port | number | 1883 | Broker port (1883 plain, 8883 TLS) |
| username | string \| null | null | Broker username (optional) |
| password | string \| null | null | Broker password (optional) |
| client_id | string | aqua-backend | MQTT client ID |
| topic_root | string | aqua | Topic prefix (e.g. aqua/{device_id}/telemetry) |
| default_device_id | string | esp32-01 | Default device ID (e.g. for UI) |
| enabled | boolean | true | Enable MQTT worker |
| keepalive_seconds | number | 60 | MQTT keepalive (10–600) |
| telemetry_qos | number | 1 | QoS for telemetry subscription (0–2) |
| command_qos | number | 1 | QoS for command publish (0–2) |
| command_timeout_seconds | number | 25 | Seconds before marking command TIMEOUT (1–120); use ≥20 if ESP32 runs `ble_scan` (~5s) |
| use_tls | boolean | false | Use TLS when connecting to broker |
| ca_certs | string \| null | null | Path to CA certificate file (optional) |
| tls_insecure | boolean | false | Skip server hostname verification (e.g. self-signed) |
| public_broker_host | string \| null | null | Hostname returned to devices (GET /api/mqtt/connection) |
| public_broker_port | number \| null | null | Port returned to devices (e.g. 8883) |

### Logging

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| retain_days | number | 30 | Telemetry retention: 0 = keep all forever; 1–3650 = purge rows older than N days |

---

## Environment variables

These override settings from `settings.json` and are **not** written back. Useful for Docker and deployment.

### Data directory

| Variable | Description |
|----------|-------------|
| AQUA_DATA_DIR | Directory for `settings.json` and `aqua.db`. Default: application directory. In Docker set to `/data`. |
| AQUA_RETAIN_DAYS | Telemetry retention: `0` = keep all forever; `1`–`3650` = purge rows older than N days. Overrides `logging.retain_days` from settings. |

### MQTT overrides

| Variable | Description |
|----------|-------------|
| AQUA_MQTT_BROKER_HOST | Override broker host (e.g. `mosquitto` in Docker, `host.docker.internal` for host broker) |
| AQUA_MQTT_BROKER_PORT | Override broker port |
| AQUA_MQTT_USE_TLS | Set to `1`, `true`, or `yes` to enable TLS |
| AQUA_MQTT_CA_CERTS | Path to CA certificate file |
| AQUA_MQTT_TLS_INSECURE | Set to `1`, `true`, or `yes` to skip hostname verification |
| AQUA_MQTT_PUBLIC_BROKER_HOST | Public hostname for devices (e.g. domain) |
| AQUA_MQTT_PUBLIC_BROKER_PORT | Public port for devices (e.g. 8883) |
| AQUA_COMMAND_TIMEOUT_SECONDS | Override command ack timeout (1–120), e.g. `30` for slow BLE scans |

### Example (Docker Compose)

```yaml
environment:
  AQUA_DATA_DIR: /data
  AQUA_MQTT_BROKER_HOST: mosquitto
  AQUA_MQTT_BROKER_PORT: "1883"
  AQUA_MQTT_PUBLIC_BROKER_HOST: mqtt.yourdomain.com
  AQUA_MQTT_PUBLIC_BROKER_PORT: "8883"
```

---

## Database

- **Path:** `{AQUA_DATA_DIR}/aqua.db` (default: `aqua.db` next to the app).
- **Type:** SQLite. No separate server; the file must be writable by the process.
- **Backup:** Copy `aqua.db` (and `settings.json`) while the app is stopped, or use SQLite backup tools.

---

## Mosquitto (broker)

AQUA does not include a broker; you run Mosquitto (or another MQTT broker) separately.

### Minimal config (plain MQTT, port 1883)

```conf
listener 1883 0.0.0.0
allow_anonymous true
```

### With TLS (port 8883)

Add a second listener and point to your certs:

```conf
listener 1883 0.0.0.0
allow_anonymous true

listener 8883 0.0.0.0
allow_anonymous true
cafile   /mosquitto/certs/ca.crt
certfile /mosquitto/certs/server.crt
keyfile  /mosquitto/certs/server.key
require_certificate false

persistence true
persistence_location /mosquitto/data/
log_dest stdout
```

See `mosquitto/mosquitto.conf.example` in the repo. Mount this file and the certs in Docker as described in [SETUP.md](SETUP.md) and [DOCKER.md](../DOCKER.md).

### Authentication (optional)

To require username/password, configure Mosquitto with `allow_anonymous false` and a password file, then set `username` and `password` in AQUA settings (or via the dashboard).
