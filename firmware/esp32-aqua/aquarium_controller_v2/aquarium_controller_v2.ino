#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <BH1750.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// UltraMax / BLE bridge: set 0 to build without NimBLE-Arduino (Library Manager: "NimBLE-Arduino" by h2zero).
#ifndef ENABLE_FILTER_BRIDGE
#define ENABLE_FILTER_BRIDGE 1
#endif
#if ENABLE_FILTER_BRIDGE
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <string>
#endif

// ============================================================
// AQUA ESP32 Controller (guide-aligned version)
// - MQTT/WiFi: same pattern as esp32_room_sensor (no WiFi.disconnect
//   on reconnect, short client id, setServer before each connect).
// - LEDC: ledcAttach + ledcWrite(pin) for Arduino-ESP32 3.x
// ============================================================

// =========================
// User configuration
// =========================
static const char* WIFI_SSID = "VinylScootering";
static const char* WIFI_PASSWORD = "Adrian*96";

static const char* MQTT_HOST = "172.16.0.2";
static const uint16_t MQTT_PORT = 1883;
static const char* MQTT_USER = "";
static const char* MQTT_PASSWORD = "";
static const char* MQTT_TOPIC_ROOT = "aqua";
static const char* DEVICE_ID = "esp32-01";

// Publish timing
static const unsigned long TELEMETRY_INTERVAL_MS = 1000;
static const unsigned long STATUS_INTERVAL_MS = 30000;
static const unsigned long DISPLAY_ROTATE_MS = 4000;
static const unsigned long WIFI_RETRY_MS = 5000;
static const unsigned long MQTT_RETRY_MS = 5000;

// Feature toggles
static const bool ENABLE_BH1750 = true;
static const bool ENABLE_DS18B20 = true;
static const bool ENABLE_OLED = true;
static const bool ENABLE_WATER_SENSOR = true;
static const bool ENABLE_BUTTON_INPUT = true;
static const bool OLED_SINGLE_SCREEN_MODE = true;   // true = one screen with icon, false = alternate screens
static const bool MQTT_ALLOW_INSECURE_BRIGHTNESS_255 = true; // accept 0-255 and scale to 0-100

// =========================
// Pin summary (guide defaults)
// =========================
static const int LED_PIN = 32;            // PWM LED output
static const int SDA_PIN = 21;            // I2C SDA
static const int SCL_PIN = 22;            // I2C SCL
static const int TEMP_PIN = 5;            // DS18B20 OneWire data
static const int WATER_LEVEL_PIN = 34;    // Analog water level
static const int RELAY_PIN = 18;          // Heater relay
static const int BUTTON_PIN = 35;         // Optional analog button

static const int PWM_FREQ = 5000;
static const int PWM_RESOLUTION = 8;      // 0-255 hardware PWM

// Sensor thresholds
static const int WATER_PRESENT_THRESHOLD = 1800;
static const int BUTTON_PRESSED_THRESHOLD = 1200;

// U8g2 SH1106 128x64 I2C constructor
U8G2_SH1106_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE);

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
BH1750 lightMeter;
OneWire oneWire(TEMP_PIN);
DallasTemperature tempSensors(&oneWire);

String topicTelemetry;
String topicStatus;
String topicCmdHeater;
String topicCmdLed;
String topicAckHeater;
String topicAckLed;
String topicCmdFilter;
String topicAckFilter;

bool heaterState = false;
bool ledState = false;
uint8_t ledBrightness = 0;     // logical percentage 0-100
bool mqttConnected = false;
bool wifiConnected = false;

float currentTempC = NAN;
float currentLux = NAN;
bool waterPresent = false;
float waterVoltage = 0.0f;
bool buttonPressed = false;
float buttonVoltage = 0.0f;

unsigned long lastTelemetryMs = 0;
unsigned long lastStatusMs = 0;
unsigned long lastDisplayRotateMs = 0;
unsigned long lastWifiRetryMs = 0;
unsigned long lastMqttRetryMs = 0;
uint8_t displayPage = 0;

#if ENABLE_FILTER_BRIDGE
static constexpr size_t kBleScanCap = 32;
struct BleScanRow {
  char addr[24];
  char name[40];
  int rssi;
};
static BleScanRow g_bleScanRows[kBleScanCap];
static size_t g_bleScanCount = 0;
static volatile bool g_bleScanEnded = false;
static bool g_nimbleInited = false;
static char g_filterScanStatus[16] = "";
static char g_filterBleError[140] = "";
static char g_filterBoundAddr[24] = "";
static volatile bool g_pendingBleScan = false;

static void strCopy(char* dst, size_t cap, const char* src) {
  if (!dst || cap == 0) return;
  if (!src) src = "";
  size_t n = strlen(src);
  if (n >= cap) n = cap - 1;
  memcpy(dst, src, n);
  dst[n] = 0;
}

static void loadFilterBoundAddress() {
  Preferences prefs;
  if (prefs.begin("aqua", true)) {
    String s = prefs.getString("flt_addr", "");
    strCopy(g_filterBoundAddr, sizeof(g_filterBoundAddr), s.c_str());
    prefs.end();
  }
}

static void saveFilterBoundAddress(const char* mac) {
  Preferences prefs;
  if (prefs.begin("aqua", false)) {
    prefs.putString("flt_addr", mac ? mac : "");
    prefs.end();
  }
  strCopy(g_filterBoundAddr, sizeof(g_filterBoundAddr), mac);
}

class AquaBleScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* adv) override {
    if (!adv || g_bleScanCount >= kBleScanCap) return;
    std::string mac = adv->getAddress().toString();
    const char* macc = mac.c_str();
    for (size_t i = 0; i < g_bleScanCount; i++) {
      if (strcmp(g_bleScanRows[i].addr, macc) == 0) {
        if (adv->getRSSI() > g_bleScanRows[i].rssi) {
          g_bleScanRows[i].rssi = adv->getRSSI();
        }
        return;
      }
    }
    BleScanRow& row = g_bleScanRows[g_bleScanCount++];
    strCopy(row.addr, sizeof(row.addr), macc);
    if (adv->haveName()) {
      strCopy(row.name, sizeof(row.name), adv->getName().c_str());
    } else {
      row.name[0] = 0;
    }
    row.rssi = adv->getRSSI();
  }

  void onScanEnd(const NimBLEScanResults& results, int reason) override {
    (void)results;
    (void)reason;
    strCopy(g_filterScanStatus, sizeof(g_filterScanStatus), "done");
    g_bleScanEnded = true;
  }
};

static AquaBleScanCallbacks g_aquaScanCb;

static void ensureNimble() {
  if (g_nimbleInited) return;
  NimBLEDevice::init("aqua-ctrl");
  g_nimbleInited = true;
}

static void runDeferredBleScan() {
  g_filterBleError[0] = 0;
  g_bleScanCount = 0;
  g_bleScanEnded = false;
  strCopy(g_filterScanStatus, sizeof(g_filterScanStatus), "scanning");

  ensureNimble();
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&g_aquaScanCb, false);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(99);

  // Duration is milliseconds in NimBLE-Arduino 2.x.
  if (!scan->start(5000, false)) {
    strCopy(g_filterScanStatus, sizeof(g_filterScanStatus), "error");
    strCopy(g_filterBleError, sizeof(g_filterBleError), "BLE scan failed to start");
    return;
  }

  const unsigned long deadline = millis() + 12000;
  while (!g_bleScanEnded && (long)(deadline - millis()) > 0) {
    delay(30);
    if (mqttClient.connected()) {
      mqttClient.loop();
    }
  }
  if (!g_bleScanEnded) {
    scan->stop();
    strCopy(g_filterScanStatus, sizeof(g_filterScanStatus), "error");
    strCopy(g_filterBleError, sizeof(g_filterBleError), "BLE scan timeout");
  }
}

static void publishAckFilter(const char* correlationId) {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<384> doc;
  doc["source"] = "mqtt_cmd";
  doc["device_id"] = DEVICE_ID;
  doc["ip"] = localIpString();
  doc["uptime_ms"] = millis();
  if (correlationId && strlen(correlationId) > 0) {
    doc["correlation_id"] = correlationId;
  }
  doc["filter_last_address"] = g_filterBoundAddr;

  char payload[384];
  serializeJson(doc, payload, sizeof(payload));
  mqttClient.publish(topicAckFilter.c_str(), payload, false);
}

// PubSubClient: publishing from mqttCallback often fails; defer ack to loop().
static volatile bool g_deferredFilterAckPending = false;
static char g_deferredFilterAckCorr[48];

static void requestDeferredFilterAck(const char* correlationId) {
  strCopy(g_deferredFilterAckCorr, sizeof(g_deferredFilterAckCorr), correlationId ? correlationId : "");
  g_deferredFilterAckPending = true;
}

static void flushDeferredFilterAck() {
  if (!g_deferredFilterAckPending || !mqttClient.connected()) return;
  g_deferredFilterAckPending = false;
  publishAckFilter(g_deferredFilterAckCorr);
}

static void handleFilterCommand(JsonDocument& doc) {
  const char* action = doc["action"] | "";
  const char* correlationId = doc["correlation_id"] | "";

  if (strcmp(action, "ble_scan") == 0) {
    strCopy(g_pendingFilterAckCorr, sizeof(g_pendingFilterAckCorr), correlationId);
    g_pendingBleScan = true;
    return;
  }

  if (strcmp(action, "bind_ble") == 0) {
    const char* addr = "";
    if (doc.containsKey("payload") && doc["payload"].is<JsonObject>()) {
      JsonObject pl = doc["payload"].as<JsonObject>();
      if (pl.containsKey("address")) {
        addr = pl["address"] | "";
      }
    }
    if (!addr[0]) {
      strCopy(g_filterBleError, sizeof(g_filterBleError), "bind_ble missing payload.address");
    } else {
      saveFilterBoundAddress(addr);
      g_filterBleError[0] = 0;
    }
    requestDeferredFilterAck(correlationId);
    return;
  }

  strCopy(
      g_filterBleError,
      sizeof(g_filterBleError),
      "Pump GATT (connect/on/off/modes) not in this firmware; use Scan/Bind, then extend sketch or vendor app.");

  if (strcmp(action, "connect") == 0 || strcmp(action, "disconnect") == 0 ||
      strcmp(action, "on") == 0 || strcmp(action, "off") == 0 ||
      strcmp(action, "mode_constant") == 0 || strcmp(action, "mode_pulse") == 0 ||
      strcmp(action, "mode_dashed") == 0 || strcmp(action, "mode_sine") == 0 ||
      strcmp(action, "read_state") == 0) {
    requestDeferredFilterAck(correlationId);
    return;
  }

  strCopy(g_filterBleError, sizeof(g_filterBleError), "Unknown filter action");
  requestDeferredFilterAck(correlationId);
}
#endif  // ENABLE_FILTER_BRIDGE

String makeTopic(const String& suffix) {
  return String(MQTT_TOPIC_ROOT) + "/" + String(DEVICE_ID) + "/" + suffix;
}

String localIpString() {
  return WiFi.isConnected() ? WiFi.localIP().toString() : String("0.0.0.0");
}

static const char* mqttClientStateStr(int rc) {
  switch (rc) {
    case -4: return "timeout";
    case -3: return "lost";
    case -2: return "failed";
    case -1: return "disconnected";
    case 0: return "connected";
    case 4: return "bad_credentials";
    case 5: return "unauthorized";
    default: return "other";
  }
}

float analogToVoltage(int raw) {
  return (3.3f * raw) / 4095.0f;
}

uint8_t percentToPwm(uint8_t percent) {
  if (percent > 100) percent = 100;
  return map(percent, 0, 100, 0, 255);
}

uint8_t normalizeBrightnessToPercent(int value) {
  if (value <= 0) return 0;
  if (value <= 100) return (uint8_t)value;
  if (MQTT_ALLOW_INSECURE_BRIGHTNESS_255 && value <= 255) {
    return map(value, 0, 255, 0, 100);
  }
  return 100;
}

void applyHeater(bool on) {
  heaterState = on;
  digitalWrite(RELAY_PIN, heaterState ? HIGH : LOW);
}

void applyLed(bool on, uint8_t brightnessPercent) {
  ledState = on;
  if (!ledState) {
    ledBrightness = 0;
    ledcWrite(LED_PIN, 0);
    return;
  }

  ledBrightness = constrain(brightnessPercent, 0, 100);
  ledcWrite(LED_PIN, percentToPwm(ledBrightness));
}

void readSensors() {
  if (ENABLE_DS18B20) {
    tempSensors.requestTemperatures();
    float t = tempSensors.getTempCByIndex(0);
    if (t > -100.0f && t < 100.0f) {
      currentTempC = t;
    }
  }

  if (ENABLE_BH1750) {
    float lux = lightMeter.readLightLevel();
    if (lux >= 0.0f) {
      currentLux = lux;
    }
  }

  if (ENABLE_WATER_SENSOR) {
    int rawWater = analogRead(WATER_LEVEL_PIN);
    waterVoltage = analogToVoltage(rawWater);
    waterPresent = rawWater > WATER_PRESENT_THRESHOLD;
  }

  if (ENABLE_BUTTON_INPUT) {
    int rawButton = analogRead(BUTTON_PIN);
    buttonVoltage = analogToVoltage(rawButton);
    buttonPressed = rawButton > BUTTON_PRESSED_THRESHOLD;
  }
}

void publishStatus(const char* statusValue, bool retained) {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<256> doc;
  doc["status"] = statusValue;
  doc["source"] = "esp32";
  doc["device_id"] = DEVICE_ID;
  doc["ip"] = localIpString();
  doc["uptime_ms"] = millis();

  char payload[256];
  serializeJson(doc, payload, sizeof(payload));
  mqttClient.publish(topicStatus.c_str(), payload, retained);
}

void publishTelemetry() {
  if (!mqttClient.connected()) return;

#if ENABLE_FILTER_BRIDGE
  StaticJsonDocument<4096> doc;
#else
  StaticJsonDocument<512> doc;
#endif
  doc["device_id"] = DEVICE_ID;
  doc["ip"] = localIpString();
  doc["uptime_ms"] = millis();

  if (!isnan(currentTempC)) doc["temp"] = currentTempC;
  if (!isnan(currentLux)) doc["lux"] = currentLux;
  doc["water"] = waterPresent;
  doc["water_voltage"] = waterVoltage;
  doc["heater"] = heaterState;
  doc["led"] = ledState;
  doc["led_brightness"] = ledBrightness;
  doc["button_pressed"] = buttonPressed;
  doc["button_voltage"] = buttonVoltage;

#if ENABLE_FILTER_BRIDGE
  if (g_filterBoundAddr[0]) {
    doc["filter_last_address"] = g_filterBoundAddr;
  }
  doc["filter_ble_connected"] = false;
  if (g_filterBleError[0]) {
    doc["filter_ble_error"] = g_filterBleError;
  }
  if (g_filterScanStatus[0]) {
    doc["filter_scan_status"] = g_filterScanStatus;
  }
  if (g_bleScanCount > 0 && strcmp(g_filterScanStatus, "done") == 0) {
    JsonArray arr = doc.createNestedArray("filter_scan_results");
    for (size_t i = 0; i < g_bleScanCount; i++) {
      JsonObject o = arr.createNestedObject();
      o["address"] = g_bleScanRows[i].addr;
      if (g_bleScanRows[i].name[0]) {
        o["name"] = g_bleScanRows[i].name;
      }
      o["rssi"] = g_bleScanRows[i].rssi;
    }
  }
#endif

#if ENABLE_FILTER_BRIDGE
  char payload[4096];
#else
  char payload[512];
#endif
  size_t n = serializeJson(doc, payload, sizeof(payload));
  if (n >= sizeof(payload) - 1) {
    Serial.println("telemetry JSON truncated; increase payload buffer");
  }
  mqttClient.publish(topicTelemetry.c_str(), payload, false);
}

void publishAck(const char* component, const char* correlationId) {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<384> doc;
  doc["source"] = "mqtt_cmd";
  doc["device_id"] = DEVICE_ID;
  doc["ip"] = localIpString();
  doc["uptime_ms"] = millis();
  if (correlationId && strlen(correlationId) > 0) {
    doc["correlation_id"] = correlationId;
  }

  String topic;
  if (strcmp(component, "heater") == 0) {
    doc["heater"] = heaterState;
    topic = topicAckHeater;
  } else if (strcmp(component, "led") == 0) {
    doc["led"] = ledState;
    doc["brightness"] = ledBrightness;
    topic = topicAckLed;
  } else {
    return;
  }

  char payload[384];
  serializeJson(doc, payload, sizeof(payload));
  mqttClient.publish(topic.c_str(), payload, false);
}

void handleHeaterCommand(JsonDocument& doc) {
  const char* action = doc["action"] | "";
  const char* correlationId = doc["correlation_id"] | "";

  if (strcmp(action, "on") == 0) {
    applyHeater(true);
  } else if (strcmp(action, "off") == 0) {
    applyHeater(false);
  } else if (strcmp(action, "toggle") == 0) {
    applyHeater(!heaterState);
  }

  publishAck("heater", correlationId);
}

void handleLedCommand(JsonDocument& doc) {
  const char* action = doc["action"] | "";
  const char* correlationId = doc["correlation_id"] | "";

  if (strcmp(action, "on") == 0) {
    uint8_t fallbackBrightness = ledBrightness > 0 ? ledBrightness : 100;
    applyLed(true, fallbackBrightness);
  } else if (strcmp(action, "off") == 0) {
    applyLed(false, 0);
  } else if (strcmp(action, "toggle") == 0) {
    if (ledState) applyLed(false, 0);
    else applyLed(true, ledBrightness > 0 ? ledBrightness : 100);
  } else if (strcmp(action, "set_brightness") == 0) {
    int value = -1;
    if (doc.containsKey("payload") && doc["payload"].containsKey("value")) {
      value = doc["payload"]["value"].as<int>();
    }

    if (value >= 0) {
      uint8_t brightness = normalizeBrightnessToPercent(value);
      if (brightness == 0) applyLed(false, 0);
      else applyLed(true, brightness);
    }
  }

  publishAck("led", correlationId);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print("MQTT JSON parse failed on ");
    Serial.println(topic);
    return;
  }

  String topicStr(topic);
  if (topicStr == topicCmdHeater) {
    handleHeaterCommand(doc);
  } else if (topicStr == topicCmdLed) {
    handleLedCommand(doc);
#if ENABLE_FILTER_BRIDGE
  } else if (topicStr == topicCmdFilter) {
    handleFilterCommand(doc);
#endif
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    WiFi.setSleep(WIFI_PS_NONE);
    if (!wifiConnected) {
      lastMqttRetryMs = 0;
    }
    wifiConnected = true;
    return;
  }

  wifiConnected = false;
  if (mqttClient.connected()) {
    mqttClient.disconnect();
  }

  unsigned long now = millis();
  if (now - lastWifiRetryMs < WIFI_RETRY_MS) return;
  lastWifiRetryMs = now;

  Serial.println("WiFi: reconnecting (soft, like room sensor)...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void subscribeTopics() {
  mqttClient.subscribe(topicCmdHeater.c_str());
  mqttClient.subscribe(topicCmdLed.c_str());
#if ENABLE_FILTER_BRIDGE
  mqttClient.subscribe(topicCmdFilter.c_str());
#endif

  Serial.print("Subscribed: ");
  Serial.println(topicCmdHeater);
  Serial.print("Subscribed: ");
  Serial.println(topicCmdLed);
#if ENABLE_FILTER_BRIDGE
  Serial.print("Subscribed: ");
  Serial.println(topicCmdFilter);
#endif
}

void ensureMqtt() {
  if (!wifiConnected) return;
  if (mqttClient.connected()) {
    mqttConnected = true;
    return;
  }

  mqttConnected = false;
  unsigned long now = millis();
  if (lastMqttRetryMs != 0 && (now - lastMqttRetryMs < MQTT_RETRY_MS)) return;
  lastMqttRetryMs = now;

  char mqttClientId[24];
  snprintf(mqttClientId, sizeof(mqttClientId), "%s-%04X", DEVICE_ID,
           (unsigned)(ESP.getEfuseMac() & 0xFFFF));

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);

  StaticJsonDocument<160> lwtDoc;
  lwtDoc["status"] = "offline";
  lwtDoc["source"] = "esp32";
  lwtDoc["device_id"] = DEVICE_ID;
  char lwtPayload[160];
  serializeJson(lwtDoc, lwtPayload, sizeof(lwtPayload));

  Serial.print("MQTT: connecting to ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORT);
  Serial.print("MQTT clientId: ");
  Serial.println(mqttClientId);

  bool connected;
  if (strlen(MQTT_USER) > 0) {
    connected = mqttClient.connect(
      mqttClientId,
      MQTT_USER,
      MQTT_PASSWORD,
      topicStatus.c_str(),
      1,
      true,
      lwtPayload
    );
  } else {
    connected = mqttClient.connect(
      mqttClientId,
      topicStatus.c_str(),
      1,
      true,
      lwtPayload
    );
  }

  if (connected) {
    mqttConnected = true;
    Serial.println("MQTT: connected");
    subscribeTopics();
    publishStatus("online", true);
  } else {
    int st = mqttClient.state();
    Serial.print("MQTT: connect failed, state=");
    Serial.print(st);
    Serial.print(" (");
    Serial.print(mqttClientStateStr(st));
    Serial.println(")");
  }
}

// U8g2 2.32+ uses drawArc(x,y,rad,start,end) only — old 6-arg ellipse arcs won't compile.
void drawWifiMqttIcon(int x, int y, bool connected) {
  display.drawDisc(x, y + 8, 2);
  display.drawCircle(x, y + 8, 5);
  display.drawCircle(x, y + 8, 9);
  display.drawCircle(x, y + 8, 13);
  if (!connected) {
    display.drawLine(x - 9, y - 7, x + 9, y + 9);
  }
}

void drawSingleScreen() {
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);

  display.drawStr(0, 9, DEVICE_ID);
  drawWifiMqttIcon(117, 7, mqttConnected);

  String line1 = String("IP:") + localIpString();
  display.drawStr(0, 20, line1.c_str());

  char line2[32];
  snprintf(line2, sizeof(line2), "T:%sC L:%s",
           isnan(currentTempC) ? "--" : String(currentTempC, 1).c_str(),
           isnan(currentLux) ? "--" : String(currentLux, 0).c_str());
  display.drawStr(0, 31, line2);

  char line3[32];
  snprintf(line3, sizeof(line3), "Water:%s %.2fV",
           waterPresent ? "OK" : "LOW",
           waterVoltage);
  display.drawStr(0, 42, line3);

  char line4[32];
  snprintf(line4, sizeof(line4), "Heat:%s LED:%s",
           heaterState ? "ON" : "OFF",
           ledState ? "ON" : "OFF");
  display.drawStr(0, 53, line4);

  char line5[32];
  snprintf(line5, sizeof(line5), "Bri:%u Btn:%u",
           ledBrightness,
           buttonPressed ? 1 : 0);
  display.drawStr(0, 64, line5);

  display.sendBuffer();
}

void drawTelemetryScreen() {
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(0, 9, "Telemetry");

  char line1[32];
  snprintf(line1, sizeof(line1), "Temp: %s C",
           isnan(currentTempC) ? "--" : String(currentTempC, 1).c_str());
  display.drawStr(0, 20, line1);

  char line2[32];
  snprintf(line2, sizeof(line2), "Lux:  %s",
           isnan(currentLux) ? "--" : String(currentLux, 0).c_str());
  display.drawStr(0, 31, line2);

  char line3[32];
  snprintf(line3, sizeof(line3), "Water:%s %.2fV",
           waterPresent ? "OK" : "LOW",
           waterVoltage);
  display.drawStr(0, 42, line3);

  char line4[32];
  snprintf(line4, sizeof(line4), "Heat:%s LED:%s",
           heaterState ? "ON" : "OFF",
           ledState ? "ON" : "OFF");
  display.drawStr(0, 53, line4);

  char line5[32];
  snprintf(line5, sizeof(line5), "Bri:%u Btn:%u",
           ledBrightness,
           buttonPressed ? 1 : 0);
  display.drawStr(0, 64, line5);

  display.sendBuffer();
}

void drawConnectionScreen() {
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(0, 9, "Connection");

  String wifiLine = String("WiFi: ") + (wifiConnected ? "OK" : "DOWN");
  display.drawStr(0, 22, wifiLine.c_str());

  String mqttLine = String("MQTT: ") + (mqttConnected ? "OK" : "DOWN");
  display.drawStr(0, 34, mqttLine.c_str());

  String ipLine = String("IP:") + localIpString();
  display.drawStr(0, 46, ipLine.c_str());

  String upLine = String("Up:") + String(millis() / 1000) + "s";
  display.drawStr(0, 58, upLine.c_str());

  display.sendBuffer();
}

void updateDisplay() {
  if (!ENABLE_OLED) return;

  if (OLED_SINGLE_SCREEN_MODE) {
    drawSingleScreen();
    return;
  }

  unsigned long now = millis();
  if (now - lastDisplayRotateMs >= DISPLAY_ROTATE_MS) {
    lastDisplayRotateMs = now;
    displayPage = (displayPage + 1) % 2;
  }

  if (displayPage == 0) drawTelemetryScreen();
  else drawConnectionScreen();
}

void setupTopics() {
  topicTelemetry = makeTopic("telemetry");
  topicStatus = makeTopic("status");
  topicCmdHeater = makeTopic("cmd/heater");
  topicCmdLed = makeTopic("cmd/led");
  topicAckHeater = makeTopic("ack/heater");
  topicAckLed = makeTopic("ack/led");
#if ENABLE_FILTER_BRIDGE
  topicCmdFilter = makeTopic("cmd/filter");
  topicAckFilter = makeTopic("ack/filter");
#endif
}

void setupDisplay() {
  if (!ENABLE_OLED) return;
  display.begin();
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(0, 12, "AQUA booting...");
  display.sendBuffer();
}

void setupSensors() {
  if (ENABLE_DS18B20) {
    tempSensors.begin();
  }
  if (ENABLE_BH1750) {
    lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  }
}

void setupOutputs() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);

  ledcAttach(LED_PIN, PWM_FREQ, PWM_RESOLUTION);
  ledcWrite(LED_PIN, 0);

  applyHeater(false);
  applyLed(false, 0);
}

void setupInputs() {
  if (ENABLE_WATER_SENSOR) pinMode(WATER_LEVEL_PIN, INPUT);
  if (ENABLE_BUTTON_INPUT) pinMode(BUTTON_PIN, INPUT);
}

void setupMqtt() {
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
  mqttClient.setKeepAlive(60);
  mqttClient.setSocketTimeout(15);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Wire.begin(SDA_PIN, SCL_PIN);

  setupTopics();
  setupDisplay();
  setupOutputs();
  setupInputs();
  setupSensors();
  setupMqtt();

#if ENABLE_FILTER_BRIDGE
  loadFilterBoundAddress();
#endif

  Serial.println("AQUA controller starting...");
  Serial.print("Device ID: ");
  Serial.println(DEVICE_ID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void loop() {
  ensureWifi();
  ensureMqtt();

  if (mqttClient.connected()) {
    mqttClient.loop();
#if ENABLE_FILTER_BRIDGE
    flushDeferredFilterAck();
#endif
  } else {
    mqttConnected = false;
  }

#if ENABLE_FILTER_BRIDGE
  if (g_pendingBleScan && mqttClient.connected()) {
    g_pendingBleScan = false;
    runDeferredBleScan();
    publishTelemetry();
  }
#endif

  readSensors();

  unsigned long now = millis();

  if (mqttClient.connected() && now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    publishTelemetry();
  }

  if (mqttClient.connected() && now - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    publishStatus("online", true);
  }

  updateDisplay();
  delay(50);
}
