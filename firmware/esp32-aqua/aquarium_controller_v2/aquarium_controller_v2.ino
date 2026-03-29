#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <BH1750.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ============================================================
// AQUA ESP32 Controller v2
// - Non-blocking DS18B20 reads (MQTT/display stay responsive)
// - Separate WiFi + MQTT status on OLED
// - LEDC via ledcAttach (Arduino-ESP32 3.x API)
// - MQTT keepAlive / socket timeout; WiFi reconnect delay
// - Placeholders for WiFi/MQTT — set before deploy
// ============================================================

// =========================
// User configuration
// =========================
// MQTT: ESP32 must reach the *same* broker the AQUA backend uses (settings.json).
// Use that machine's LAN IP (e.g. 192.168.0.250). Do NOT use 127.0.0.1 on the ESP32.
// If the broker requires auth, set MQTT_USER / MQTT_PASSWORD to match the backend.
static const char* WIFI_SSID = "VinylScootering";
static const char* WIFI_PASSWORD = "Adrian*96";

static const char* MQTT_HOST = "192.168.0.250";
static const uint16_t MQTT_PORT = 1883;
static const char* MQTT_USER = "";
static const char* MQTT_PASSWORD = "";
static const char* MQTT_TOPIC_ROOT = "aqua";
// Must match the device id in the AQUA app dropdown (and default_device_id in settings.json).
static const char* DEVICE_ID = "esp32-01";

// Publish timing
static const unsigned long TELEMETRY_INTERVAL_MS = 2000;
static const unsigned long STATUS_INTERVAL_MS = 30000;
static const unsigned long DISPLAY_ROTATE_MS = 4000;
// Match working esp32_room_sensor.ino (5s backoff; long backoffs delay recovery after WiFi blips).
static const unsigned long WIFI_RETRY_MS = 5000;
static const unsigned long MQTT_RETRY_MS = 5000;

// DS18B20: conversion is async; read at most this often (ms between completed reads)
static const unsigned long DS18B20_READ_INTERVAL_MS = 2000;
// Wait after requestTemperatures() before getTempCByIndex (12-bit resolution ~750ms)
static const unsigned long DS18B20_CONVERSION_WAIT_MS = 800;

// Feature toggles
static const bool ENABLE_BH1750 = true;
static const bool ENABLE_DS18B20 = true;
static const bool ENABLE_OLED = true;
static const bool ENABLE_WATER_SENSOR = true;
static const bool ENABLE_BUTTON_INPUT = true;
static const bool OLED_SINGLE_SCREEN_MODE = true;
static const bool MQTT_ALLOW_INSECURE_BRIGHTNESS_255 = true;

// =========================
// Pin summary (guide defaults)
// GPIO 34/35: input-only; no internal pull-up on ESP32 — use external bias if needed.
// =========================
static const int LED_PIN = 32;
static const int SDA_PIN = 21;
static const int SCL_PIN = 22;
static const int TEMP_PIN = 5;
static const int WATER_LEVEL_PIN = 34;
static const int RELAY_PIN = 18;
static const int BUTTON_PIN = 35;

static const int PWM_FREQ = 5000;
static const int PWM_RESOLUTION = 8;

static const int WATER_PRESENT_THRESHOLD = 1800;
static const int BUTTON_PRESSED_THRESHOLD = 1200;

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

bool heaterState = false;
bool ledState = false;
uint8_t ledBrightness = 0;
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
unsigned long lastMqttDiagMs = 0;
uint8_t displayPage = 0;

// DS18B20 non-blocking state
bool ds18b20ConversionPending = false;
unsigned long ds18b20RequestAtMs = 0;
unsigned long ds18b20LastCompletedMs = 0;

String makeTopic(const String& suffix) {
  return String(MQTT_TOPIC_ROOT) + "/" + String(DEVICE_ID) + "/" + suffix;
}

String localIpString() {
  return WiFi.isConnected() ? WiFi.localIP().toString() : String("0.0.0.0");
}

void formatLocalIp(char* buf, size_t bufSz) {
  if (!buf || bufSz < 8) return;
  if (WiFi.status() != WL_CONNECTED) {
    snprintf(buf, bufSz, "---");
    return;
  }
  IPAddress ip = WiFi.localIP();
  snprintf(buf, bufSz, "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
}

/** Short boot steps on OLED during setup() (before WiFi.loop exists). */
void showBootPhase(const char* detailLine) {
  if (!ENABLE_OLED) return;
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(0, 10, "AQUA v2 boot");
  display.drawStr(0, 22, detailLine);
  display.sendBuffer();
  delay(80);
}

float analogToVoltage(int raw) {
  return (3.3f * raw) / 4095.0f;
}

/** PubSubClient state() for Serial diagnostics when MQTT will not connect. */
static const char* mqttClientStateStr(int rc) {
  switch (rc) {
    case -4: return "connection_timeout";
    case -3: return "connection_lost";
    case -2: return "connect_failed";
    case -1: return "disconnected";
    case 0: return "connected";
    case 1: return "bad_protocol";
    case 2: return "bad_client_id";
    case 3: return "unavailable";
    case 4: return "bad_credentials";
    case 5: return "unauthorized";
    default: return "other";
  }
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

void readDs18b20NonBlocking() {
  if (!ENABLE_DS18B20) return;

  unsigned long now = millis();

  if (!ds18b20ConversionPending) {
    bool due = (ds18b20LastCompletedMs == 0) ||
               (now - ds18b20LastCompletedMs >= DS18B20_READ_INTERVAL_MS);
    if (due) {
      tempSensors.requestTemperatures();
      ds18b20ConversionPending = true;
      ds18b20RequestAtMs = now;
    }
  } else {
    if (now - ds18b20RequestAtMs >= DS18B20_CONVERSION_WAIT_MS) {
      float t = tempSensors.getTempCByIndex(0);
      if (t > -100.0f && t < 100.0f) {
        currentTempC = t;
      }
      ds18b20ConversionPending = false;
      ds18b20LastCompletedMs = now;
    }
  }
}

void readFastSensors() {
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

  StaticJsonDocument<512> doc;
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

  char payload[512];
  serializeJson(doc, payload, sizeof(payload));
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
    if (ledState) {
      applyLed(false, 0);
    } else {
      applyLed(true, ledBrightness > 0 ? ledBrightness : 100);
    }
  } else if (strcmp(action, "set_brightness") == 0) {
    int value = -1;
    if (doc.containsKey("payload") && doc["payload"].containsKey("value")) {
      value = doc["payload"]["value"].as<int>();
    }

    if (value >= 0) {
      uint8_t brightness = normalizeBrightnessToPercent(value);
      if (brightness == 0) {
        applyLed(false, 0);
      } else {
        applyLed(true, brightness);
      }
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
  }
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    // Modem sleep drops long-lived TCP/MQTT; room sensor omits this but it helps on full ESP32.
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

  Serial.println("WiFi: reconnecting (no hard disconnect — same pattern as esp32_room_sensor)...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void subscribeTopics() {
  mqttClient.subscribe(topicCmdHeater.c_str());
  mqttClient.subscribe(topicCmdLed.c_str());

  Serial.print("Subscribed: ");
  Serial.println(topicCmdHeater);
  Serial.print("Subscribed: ");
  Serial.println(topicCmdLed);
}

void ensureMqtt() {
  if (!wifiConnected) return;
  if (mqttClient.connected()) {
    mqttConnected = true;
    return;
  }

  mqttConnected = false;
  unsigned long now = millis();
  // 0 = "retry now" (first boot or WiFi just came back). Non-zero = backoff after last attempt.
  if (lastMqttRetryMs != 0 && (now - lastMqttRetryMs < MQTT_RETRY_MS)) return;
  lastMqttRetryMs = now;

  // Room sensor uses DEVICE_ID as client id (short). Long IDs + some brokers = trouble; stay <= 23 chars.
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
    Serial.println(") — check broker IP, port, and username/password if broker requires auth");
  }
}

// Compact RSSI-style arcs (fits two side-by-side on 128px wide display)
void drawConnectionIcon(int x, int y, bool connected) {
  display.drawDisc(x, y + 8, 1);
  display.drawCircle(x, y + 8, 3);
  display.drawCircle(x, y + 8, 6);
  display.drawCircle(x, y + 8, 9);
  if (!connected) {
    display.drawLine(x - 8, y, x + 8, y + 16);
  }
}

/** No sensor numbers until MQTT is up — only link progress. */
void drawAwaitMqttScreen() {
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);

  display.drawStr(0, 10, DEVICE_ID);

  if (!wifiConnected) {
    display.drawStr(0, 22, "WiFi: linking...");
    display.drawStr(0, 34, "IP: ---");
    display.drawStr(0, 46, "MQTT: standby");
    char br[22];
    snprintf(br, sizeof(br), "%.18s", MQTT_HOST);
    display.drawStr(0, 58, br);
  } else {
    display.drawStr(0, 22, "WiFi: OK");
    char ipLine[24];
    char ipb[16];
    formatLocalIp(ipb, sizeof(ipb));
    snprintf(ipLine, sizeof(ipLine), "IP:%s", ipb);
    display.drawStr(0, 34, ipLine);

    display.drawStr(0, 46, "MQTT: connecting");
    char br[22];
    snprintf(br, sizeof(br), "%.18s:%u", MQTT_HOST, (unsigned)MQTT_PORT);
    display.drawStr(0, 58, br);
  }

  display.sendBuffer();
}

void drawSingleScreen() {
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);

  display.drawStr(0, 9, DEVICE_ID);
  display.drawStr(74, 9, "W");
  drawConnectionIcon(82, 0, wifiConnected);
  display.drawStr(94, 9, "M");
  drawConnectionIcon(102, 0, mqttConnected);

  String line1 = String("IP:") + localIpString();
  display.drawStr(0, 20, line1.c_str());

  char tempStr[12];
  char luxStr[12];
  if (isnan(currentTempC)) {
    strcpy(tempStr, "--");
  } else {
    dtostrf(currentTempC, 0, 1, tempStr);
  }
  if (isnan(currentLux)) {
    strcpy(luxStr, "--");
  } else {
    dtostrf(currentLux, 0, 0, luxStr);
  }

  char line2[32];
  snprintf(line2, sizeof(line2), "T:%sC L:%s", tempStr, luxStr);
  display.drawStr(0, 31, line2);

  char line3[32];
  snprintf(line3, sizeof(line3), "Water:%s %.2fV",
           waterPresent ? "OK" : "LOW", waterVoltage);
  display.drawStr(0, 42, line3);

  char line4[32];
  snprintf(line4, sizeof(line4), "Heat:%s LED:%s",
           heaterState ? "ON" : "OFF", ledState ? "ON" : "OFF");
  display.drawStr(0, 53, line4);

  char line5[32];
  snprintf(line5, sizeof(line5), "Bri:%u Btn:%u",
           ledBrightness, buttonPressed ? 1 : 0);
  display.drawStr(0, 64, line5);

  display.sendBuffer();
}

void drawTelemetryScreen() {
  display.clearBuffer();
  display.setFont(u8g2_font_6x10_tf);
  display.drawStr(0, 9, "Telemetry");

  char tempStr[12];
  char luxStr[12];
  if (isnan(currentTempC)) {
    strcpy(tempStr, "--");
  } else {
    dtostrf(currentTempC, 0, 1, tempStr);
  }
  if (isnan(currentLux)) {
    strcpy(luxStr, "--");
  } else {
    dtostrf(currentLux, 0, 0, luxStr);
  }

  char line1[32];
  snprintf(line1, sizeof(line1), "Temp: %s C", tempStr);
  display.drawStr(0, 20, line1);

  char line2[32];
  snprintf(line2, sizeof(line2), "Lux:  %s", luxStr);
  display.drawStr(0, 31, line2);

  char line3[32];
  snprintf(line3, sizeof(line3), "Water:%s %.2fV",
           waterPresent ? "OK" : "LOW", waterVoltage);
  display.drawStr(0, 42, line3);

  char line4[32];
  snprintf(line4, sizeof(line4), "Heat:%s LED:%s",
           heaterState ? "ON" : "OFF", ledState ? "ON" : "OFF");
  display.drawStr(0, 53, line4);

  char line5[32];
  snprintf(line5, sizeof(line5), "Bri:%u Btn:%u",
           ledBrightness, buttonPressed ? 1 : 0);
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

  if (!mqttClient.connected()) {
    drawAwaitMqttScreen();
    return;
  }

  if (OLED_SINGLE_SCREEN_MODE) {
    drawSingleScreen();
    return;
  }

  unsigned long now = millis();
  if (now - lastDisplayRotateMs >= DISPLAY_ROTATE_MS) {
    lastDisplayRotateMs = now;
    displayPage = (displayPage + 1) % 2;
  }

  if (displayPage == 0) {
    drawTelemetryScreen();
  } else {
    drawConnectionScreen();
  }
}

void setupTopics() {
  topicTelemetry = makeTopic("telemetry");
  topicStatus = makeTopic("status");
  topicCmdHeater = makeTopic("cmd/heater");
  topicCmdLed = makeTopic("cmd/led");
  topicAckHeater = makeTopic("ack/heater");
  topicAckLed = makeTopic("ack/led");
}

void setupDisplay() {
  if (!ENABLE_OLED) return;
  display.begin();
  showBootPhase("I2C + OLED");
}

void setupSensors() {
  if (ENABLE_DS18B20) {
    tempSensors.begin();
    tempSensors.setWaitForConversion(false);
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
  if (ENABLE_WATER_SENSOR) {
    pinMode(WATER_LEVEL_PIN, INPUT);
  }
  if (ENABLE_BUTTON_INPUT) {
    pinMode(BUTTON_PIN, INPUT);
  }
}

void setupMqtt() {
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
  mqttClient.setKeepAlive(60);
  mqttClient.setSocketTimeout(10);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Wire.begin(SDA_PIN, SCL_PIN);

  setupTopics();
  setupDisplay();
  setupOutputs();
  showBootPhase("Relay + LED PWM");
  setupInputs();
  showBootPhase("Analog inputs");
  setupSensors();
  showBootPhase("Temp + light (I2C)");
  setupMqtt();
  showBootPhase("MQTT client ready");

  Serial.println("AQUA controller v2 starting...");
  Serial.print("Device ID (must match app): ");
  Serial.println(DEVICE_ID);
  Serial.print("MQTT broker: ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORT);
  Serial.print("Telemetry topic: ");
  Serial.println(topicTelemetry);

  showBootPhase("WiFi starting...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void loop() {
  ensureWifi();
  ensureMqtt();

  if (mqttClient.connected()) {
    mqttClient.loop();
  } else {
    mqttConnected = false;
    if (wifiConnected) {
      unsigned long t = millis();
      if (t - lastMqttDiagMs >= 30000) {
        lastMqttDiagMs = t;
        int st = mqttClient.state();
        Serial.print("MQTT offline (WiFi OK). state=");
        Serial.print(st);
        Serial.print(" ");
        Serial.print(mqttClientStateStr(st));
        Serial.print(" | broker ");
        Serial.print(MQTT_HOST);
        Serial.print(":");
        Serial.println(MQTT_PORT);
      }
    }
  }

  readDs18b20NonBlocking();
  readFastSensors();

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
  delay(20);
}
