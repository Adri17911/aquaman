# AQUA – ESP32 firmware guide

This guide covers hardware, firmware setup, and configuration for the AQUA ESP32 controller (sensors, heater relay, LED, display).

---

## Hardware overview

The reference sketch supports:

| Component | Purpose |
|-----------|---------|
| **DS18B20** (OneWire) | Water temperature |
| **BH1750** (I2C) | Ambient light (lux) |
| **Water level** | Analog pin (e.g. 34) – voltage threshold for low water |
| **Relay** | Heater on/off |
| **LED** | PWM dimming (e.g. channel on GPIO 32) |
| **Button** | Optional (e.g. analog 35) |
| **Display** | Optional (e.g. SH1106 128x64 over I2C) |

Pin definitions are in the sketch (e.g. `TEMP_PIN`, `WATER_LEVEL_PIN`, `RELAY_PIN`, `LED_PIN`, `SDA_PIN`, `SCL_PIN`). Adjust them to your wiring.

---

## Required libraries

Install in Arduino IDE (Library Manager) or PlatformIO:

- **PubSubClient** – MQTT client
- **ArduinoJson** – JSON payloads
- **DallasTemperature** – DS18B20
- **OneWire** – OneWire bus
- **BH1750** – light sensor (I2C)
- **U8g2** – display (if using SH1106)
- **NimBLE-Arduino** (h2zero) – only if the sketch implements the **filter / AQUAEL UltraMax BLE bridge** (`cmd/filter`, BLE scan, bind address).

---

## Configuration (in the sketch)

At the top of the sketch you need to set:

### WiFi

```cpp
const char* ssid     = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
```

### MQTT (local network)

```cpp
const char* mqttServer   = "192.168.1.100";   // Broker IP (e.g. PC or Raspberry Pi)
const uint16_t mqttPort  = 1883;
const char* mqttUser     = "";                // Optional
const char* mqttPassword = "";
const char* mqttClientId = "aqua-esp32-01";
const char* mqttTopicRoot = "aqua";
const char* deviceId     = "esp32-01";
```

- **mqttServer** – IP or hostname of the machine running Mosquitto (or your AQUA server if broker is there).
- **deviceId** – Must match the device ID in the dashboard (e.g. `esp32-01`). Used in topics: `aqua/{deviceId}/telemetry`, etc.

### MQTT over TLS (internet)

To connect over the internet with MQTTs (port 8883):

1. Use **WiFiClientSecure** instead of **WiFiClient**:
   ```cpp
   #include <WiFiClientSecure.h>
   WiFiClientSecure wifiClient;
   PubSubClient mqttClient(wifiClient);
   ```
2. Before connecting to the broker:
   - For **server certificate verification**: set the CA certificate (e.g. `wifiClient.setCACert(caCert)`).
   - For **self-signed** or skip verification: `wifiClient.setInsecure()` (ESP32 Arduino).
3. Set **mqttServer** to the public hostname (e.g. `mqtt.yourdomain.com`) and **mqttPort** to **8883**.

Optional: fetch connection info from the API at boot (HTTPS):

- Call `GET https://your-server.com/api/mqtt/connection`.
- Parse JSON for `broker_host`, `broker_port`, `use_tls`, `topic_root`.
- Configure the MQTT client and topic root from that. (Requires an HTTPS client and more code.)

---

## Topics (reference)

The sketch builds these from `mqttTopicRoot` and `deviceId`:

| Topic | Direction | Description |
|-------|-----------|-------------|
| `aqua/{deviceId}/telemetry` | ESP32 → Broker | Sensor data (see payload below) |
| `aqua/{deviceId}/status` | ESP32 → Broker | online/offline (retained, LWT) |
| `aqua/{deviceId}/cmd/heater` | Backend → ESP32 | Heater command |
| `aqua/{deviceId}/cmd/led` | Backend → ESP32 | LED command |
| `aqua/{deviceId}/ack/heater` | ESP32 → Backend | Heater ack |
| `aqua/{deviceId}/ack/led` | ESP32 → Backend | LED ack |
| `aqua/{deviceId}/cmd/filter` | Backend → ESP32 | Filter / BLE bridge command (optional firmware) |
| `aqua/{deviceId}/ack/filter` | ESP32 → Backend | Filter command ack (`correlation_id` when present) |

---

## Telemetry payload

The ESP32 publishes JSON to `aqua/{deviceId}/telemetry` with at least:

- **device_id** – string (required)
- **ip** – string (required)
- **temp** – number (temperature °C)
- **lux** – number (light level)
- **water** – boolean (water level OK)
- **heater** – boolean
- **led** – boolean
- **led_brightness** – number 0–100
- **uptime_ms** – number (optional)

Additional fields (e.g. `water_voltage`, `button_pressed`) are stored by the backend if present.

### Filter bridge (Bluetooth / AQUAEL UltraMax)

If your firmware talks to the pump over **BLE**, include optional fields on telemetry (JSON). The dashboard reads the latest row; `filter_scan_results` / `filter_scan_status` are also merged from the stored `raw` JSON when present.

| Field | Type | Meaning |
|-------|------|--------|
| `filter_ble_connected` | boolean | ESP32 central connected to the pump (if known). |
| `filter_power` | boolean | Filtration on/off (if known). |
| `filter_mode` | string | Mode name (if known). |
| `filter_state_blob_hex` | string | Opaque state (if any). |
| `filter_ble_error` | string | Last error message (if any). |
| `filter_last_address` | string | Bound peripheral MAC (e.g. after `bind_ble`). |
| `filter_scan_status` | string | e.g. `scanning`, `done`, `error`. |
| `filter_scan_results` | array | After a scan: `[{"address":"aa:bb:…","name":"…","rssi":-60}, …]`. |

---

## Command format

### Heater

- **Topic:** `aqua/{deviceId}/cmd/heater`
- **Payload (example):** `{"action":"on","correlation_id":"uuid","source":"ui","ts":"..."}`  
  Actions: `on`, `off`, `toggle`.
- ESP32 should publish an ack to `aqua/{deviceId}/ack/heater` including `correlation_id` when present.

### LED

- **Topic:** `aqua/{deviceId}/cmd/led`
- **Payload (example):** `{"action":"set_brightness","payload":{"value":50},"correlation_id":"uuid",...}`  
  Actions: `on`, `off`, `toggle`, `set_brightness` (value 0–100 or 0–255 scaled to 100).
- ESP32 should publish an ack to `aqua/{deviceId}/ack/led` with `correlation_id` for the backend to match.

### Filter (BLE bridge)

- **Topic:** `aqua/{deviceId}/cmd/filter`
- **Payload:** `{"action":"<name>","correlation_id":"<uuid>","source":"ui","ts":"..."}` and optionally `"payload": { ... }`.
- **Actions** (typical): `ble_scan` (run BLE scan; put `filter_scan_results` / `filter_scan_status` on the next telemetry), `bind_ble` with `payload.address` set to the chosen MAC (persist in NVS), plus `connect`, `disconnect`, `on`, `off`, mode actions, `read_state` if implemented.
- ESP32 should publish an ack to `aqua/{deviceId}/ack/filter` with `correlation_id` when the action completes (or immediately after queuing, depending on your firmware).

---

## Pin summary (reference sketch)

| Symbol | Default | Description |
|--------|---------|-------------|
| LED_PIN | 32 | LED PWM |
| SDA_PIN / SCL_PIN | 21 / 22 | I2C (BH1750, display) |
| TEMP_PIN | 5 | OneWire (DS18B20) |
| WATER_LEVEL_PIN | 34 | Analog water level |
| RELAY_PIN | 18 | Heater relay |
| BUTTON_PIN | 35 | Optional button (analog) |

Change these `#define`s to match your board and wiring.

---

## Flashing and testing

1. Select the correct **board** (e.g. ESP32 Dev Module) and **port** in the Arduino IDE.
2. Upload the sketch.
3. Open Serial Monitor (e.g. 115200 baud) to see WiFi and MQTT connection messages.
4. In the AQUA dashboard, add the device with the same **device_id** (or rely on auto-discovery once telemetry is received).
5. Confirm the device appears online and telemetry updates. Then test heater and LED commands from the dashboard.

---

## Troubleshooting

- **Device not discovered:** Ensure `device_id` and `mqttTopicRoot` match the backend (default `aqua`). Check that telemetry is published and the backend is subscribed to `aqua/+/telemetry`.
- **MQTT connect failed:** Check broker IP, port (1883 or 8883), firewall, and WiFi. For MQTTs, ensure TLS and certificate handling are correct.
- **Commands not received:** ESP32 must subscribe to `aqua/{deviceId}/cmd/heater` and `aqua/{deviceId}/cmd/led`. If you use the filter bridge, also subscribe to `aqua/{deviceId}/cmd/filter`. Check topic strings and that the backend is publishing to the same broker.

See also [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for backend and dashboard issues.
