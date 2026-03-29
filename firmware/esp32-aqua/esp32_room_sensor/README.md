# ESP32-C3 Room Sensor (AM2302)

Room sensor that sends temperature and humidity to your MQTT broker every 2 seconds. Compatible with the AQUA backend (`aqua/{device_id}/telemetry`).

## Hardware

- **Board:** ESP32-C3 SuperMini
- **Sensor:** AM2302 (DHT22 protocol); data pin → **GPIO 4** (change `DHT_PIN` in code if you use another pin)

### AM2302 wiring to ESP32-C3

| AM2302 | ESP32-C3 |
|--------|----------|
| VCC    | 3.3 V    |
| GND    | GND      |
| DATA   | GPIO 4   |

Use a 4.7–10 kΩ pull-up resistor between DATA and 3.3 V (some modules have it on board).

## Arduino IDE setup

1. **Board:** Install “esp32” by Espressif (Board Manager). Select **ESP32C3 Dev Module** (or your board’s name). Set **USB CDC On Boot: Enabled** if you use USB for Serial.
2. **Libraries:** Install via Library Manager:
   - **PubSubClient** (Nick O'Leary)
   - **DHTesp** (beegee-tokyo) — for AM2302/DHT22 on ESP32

## Configuration

Edit the top of `esp32_room_sensor.ino`:

- `WIFI_SSID` / `WIFI_PASSWORD` — your Wi‑Fi
- `MQTT_BROKER` — broker IP or hostname (e.g. same as Backend 3.0 MQTT)
- `MQTT_PORT` — usually `1883`
- `MQTT_USER` / `MQTT_PASSWORD` — leave `""` if broker has no auth
- `MQTT_TOPIC_ROOT` — must match backend config (default `aqua`)
- `DEVICE_ID` — unique ID for this sensor (e.g. `room-sensor-01`)
- `DHT_PIN` — GPIO for AM2302 data (default `4`)

## MQTT topics

- **Telemetry:** `aqua/room-sensor-01/telemetry` (or `{topic_root}/{device_id}/telemetry`)  
  JSON: `device_id`, `ip`, `temp` (°C), `humidity` (%), `ts`
- **Status:** `aqua/room-sensor-01/status` — `online` / `offline`

Backend expects at least `device_id` and `ip` in telemetry; `temp` and `humidity` are stored in the payload (and in DB where applicable).

## Interval

Publish interval is **2 seconds** (`PUBLISH_INTERVAL_MS = 2000`). Change it in the code if you want a different rate.
