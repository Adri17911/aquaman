# AQUA – API reference

All API routes are under the **`/api`** prefix. The backend also serves the dashboard at `/` when the frontend is built.

Base URL (local): `http://localhost:8080/api`

---

## Health and status

### GET /api/health

Returns service health, MQTT connection status, and device count.

**Response:** `200 OK`

```json
{
  "status": "ok",
  "mqtt_connected": true,
  "mqtt_broker": "192.168.1.100:1883",
  "devices_count": 1
}
```

---

## Device connection (for ESP32 / clients)

### GET /api/mqtt/connection

Returns MQTT broker connection info for devices. No credentials. Use for internet-facing devices (e.g. ESP32 fetching settings over HTTPS).

**Response:** `200 OK`

```json
{
  "enabled": true,
  "broker_host": "mqtt.yourdomain.com",
  "broker_port": 8883,
  "use_tls": true,
  "topic_root": "aqua"
}
```

When MQTT is disabled, `enabled` is `false` and `broker_host`/`broker_port` may be `null`.

---

## Devices

### GET /api/devices

List all known devices (auto-discovered or manually added).

**Response:** `200 OK`

```json
[
  {
    "device_id": "esp32-01",
    "name": "Living room aquarium",
    "online": true,
    "last_seen_ts": "2025-02-21T12:00:00Z"
  }
]
```

### POST /api/devices

Add a device manually.

**Request body:**

```json
{
  "device_id": "esp32-01",
  "name": "Living room aquarium"
}
```

`name` is optional.

**Response:** `200 OK` – created device object.

### GET /api/devices/{device_id}

Get one device with latest telemetry.

**Response:** `200 OK`

```json
{
  "device_id": "esp32-01",
  "name": "Living room aquarium",
  "online": true,
  "last_seen_ts": "2025-02-21T12:00:00Z",
  "latest_telemetry": {
    "temp": 24.5,
    "lux": 320,
    "water": true,
    "heater": false,
    "led": true,
    "led_brightness": 80
  }
}
```

**Errors:** `404` if device not found.

---

## Telemetry

### GET /api/telemetry/latest

Latest telemetry snapshot, optionally filtered by device.

**Query:** `device_id` (optional) – when omitted, returns latest across all devices (implementation may return first or aggregate).

**Response:** `200 OK` – single telemetry object with `device_id`, `ts`, and metric fields.

**Errors:** `404` if no telemetry yet.

### GET /api/telemetry/log

Recent telemetry rows for a device.

**Query:**

- `device_id` (required)
- `limit` (optional, default 100, max 500)

**Response:** `200 OK`

```json
{
  "device_id": "esp32-01",
  "rows": [
    {
      "ts": "2025-02-21T12:00:00Z",
      "temp": 24.5,
      "lux": 320,
      "water": true,
      "heater": false,
      "led": true,
      "led_brightness": 80
    }
  ]
}
```

### GET /api/telemetry

Time-series for charts: single metric or multiple metrics.

**Query:**

- `device_id` (required)
- `metric` (default `"temp"`) – e.g. `temp`, `lux`, `led_brightness`
- `metrics` (optional) – comma-separated list for multi-metric response
- `from_ts`, `to_ts` (optional) – ISO8601
- `bucket`, `agg` (optional) – aggregation
- `limit` (optional, default 1000, max 10000)

**Response (single metric):** `200 OK`

```json
{
  "device_id": "esp32-01",
  "metric": "temp",
  "points": [
    { "ts": "2025-02-21T12:00:00Z", "value": 24.5 }
  ]
}
```

**Response (multi-metric):** when `metrics` is set, `points` is an array of objects with a value per metric.

---

## Commands

### POST /api/devices/{device_id}/commands/heater

Send heater command.

**Request body:**

```json
{
  "action": "on"
}
```

`action`: `"on"` | `"off"` | `"toggle"`

**Response:** `200 OK`

```json
{
  "correlation_id": "uuid",
  "status": "sent"
}
```

**Errors:** `409` if device offline; `503` if MQTT not connected or publish failed.

### POST /api/devices/{device_id}/commands/led

Send LED command.

**Request body:**

```json
{
  "action": "set_brightness",
  "payload": { "value": 50 }
}
```

`action`: `"on"` | `"off"` | `"toggle"` | `"set_brightness"`. For `set_brightness`, `payload.value` is 0–100 (or 0–255, backend/ESP32 may scale).

**Response:** `200 OK` – `{ "correlation_id": "uuid", "status": "sent" }`

**Errors:** `409` if device offline; `503` if MQTT error.

### GET /api/commands/{correlation_id}

Get command status (SENT, ACKED, TIMEOUT).

**Response:** `200 OK`

```json
{
  "correlation_id": "uuid",
  "device_id": "esp32-01",
  "component": "heater",
  "action": "on",
  "status": "ACKED",
  "acked_at": "2025-02-21T12:00:01Z"
}
```

**Errors:** `404` if command not found.

### GET /api/commands

List recent commands.

**Query:** `device_id` (optional), `limit` (optional, default 50, max 200).

**Response:** `200 OK` – array of command objects.

---

## Live stream

### GET /api/stream

Server-Sent Events (SSE) stream for live telemetry, status, and command acks. The frontend uses this for real-time updates.

**Response:** `200 OK` – `Content-Type: text/event-stream`; event types include `telemetry`, `status`, `command_ack`, etc.

---

## Settings (MQTT)

### GET /api/settings/mqtt

Get MQTT broker settings (passwords are not returned; use `has_password`).

**Response:** `200 OK`

```json
{
  "broker_host": "192.168.1.100",
  "broker_port": 1883,
  "username": "",
  "has_password": false,
  "use_tls": false,
  "ca_certs": "",
  "tls_insecure": false,
  "public_broker_host": "",
  "public_broker_port": null
}
```

### PUT /api/settings/mqtt  
### POST /api/settings/mqtt

Update MQTT settings. Backend reconnects after save.

**Request body (all fields optional):**

```json
{
  "broker_host": "192.168.1.100",
  "broker_port": 1883,
  "username": "user",
  "password": "secret",
  "use_tls": false,
  "ca_certs": "/path/to/ca.crt",
  "tls_insecure": false,
  "public_broker_host": "mqtt.example.com",
  "public_broker_port": 8883
}
```

**Response:** `200 OK` – same shape as GET /api/settings/mqtt (password not echoed).

---

## Schedules

Schedules drive LED dawn/dusk or a 24h curve per device.

### GET /api/schedules

List schedules, optionally filtered by device.

**Query:** `device_id` (optional)

**Response:** `200 OK` – array of schedule objects (id, device_id, name, scenario_type, dawn_time, dusk_time, durations, target_brightness, days_of_week, enabled, curve_points, etc.).

### POST /api/schedules

Create a schedule.

**Request body:**

```json
{
  "device_id": "esp32-01",
  "name": "Morning ramp",
  "scenario_type": "dawn_dusk",
  "dawn_time": "07:00",
  "dusk_time": "21:00",
  "dawn_duration_minutes": 30,
  "dusk_duration_minutes": 30,
  "target_brightness": 100,
  "days_of_week": "0,1,2,3,4,5,6",
  "enabled": true,
  "curve_points": null
}
```

- `scenario_type`: `"dawn_dusk"` or `"curve"`.
- For `"curve"`, `curve_points` is a JSON string of 24h curve data (see frontend curve editor).
- `days_of_week`: comma-separated 0–6 (Sunday–Saturday).

**Response:** `200 OK` – created schedule object.

### GET /api/schedules/{schedule_id}

Get one schedule.

**Response:** `200 OK` – schedule object.

**Errors:** `404` if not found.

### PUT /api/schedules/{schedule_id}

Update a schedule. Same fields as create (all optional).

**Response:** `200 OK` – updated schedule object.

**Errors:** `404` if not found.

### DELETE /api/schedules/{schedule_id}

Delete a schedule.

**Response:** `200 OK` – `{ "status": "deleted" }`

**Errors:** `404` if not found.
