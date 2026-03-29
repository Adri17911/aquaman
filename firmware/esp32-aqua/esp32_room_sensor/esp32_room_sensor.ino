#include <WiFi.h>
#include <PubSubClient.h>

#define DHT_PIN 4

const char* WIFI_SSID       = "VinylScootering";
const char* WIFI_PASSWORD   = "Adrian*96";
const char* MQTT_BROKER     = "192.168.0.250";
const uint16_t MQTT_PORT    = 1883;
const char* MQTT_USER       = "";
const char* MQTT_PASSWORD   = "";
const char* MQTT_TOPIC_ROOT = "aqua";
const char* DEVICE_ID       = "room-sensor-01";

const unsigned long PUBLISH_INTERVAL_MS = 2000;
const unsigned long WIFI_RETRY_MS = 5000;
const unsigned long MQTT_RETRY_MS = 5000;

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

char topicTelemetry[80];
char topicStatus[80];

unsigned long lastPublish = 0;
unsigned long lastWiFiRetry = 0;
unsigned long lastMqttRetry = 0;

void buildTopics() {
  snprintf(topicTelemetry, sizeof(topicTelemetry), "%s/%s/telemetry", MQTT_TOPIC_ROOT, DEVICE_ID);
  snprintf(topicStatus, sizeof(topicStatus), "%s/%s/status", MQTT_TOPIC_ROOT, DEVICE_ID);
}

void getIpString(char* buf, int len) {
  IPAddress ip = WiFi.localIP();
  snprintf(buf, len, "%d.%d.%d.%d", (int)ip[0], (int)ip[1], (int)ip[2], (int)ip[3]);
}

bool readDHT22(float* tempC, float* humidity) {
  uint8_t data[5] = {0, 0, 0, 0, 0};

  pinMode(DHT_PIN, OUTPUT);
  digitalWrite(DHT_PIN, LOW);
  delayMicroseconds(1200);   // slightly safer than 1100
  digitalWrite(DHT_PIN, HIGH);
  delayMicroseconds(30);
  pinMode(DHT_PIN, INPUT_PULLUP);

  int loopCount = 1000;
  while (digitalRead(DHT_PIN) == HIGH && loopCount--) delayMicroseconds(1);
  if (loopCount <= 0) return false;

  loopCount = 1000;
  while (digitalRead(DHT_PIN) == LOW && loopCount--) delayMicroseconds(1);
  if (loopCount <= 0) return false;

  loopCount = 1000;
  while (digitalRead(DHT_PIN) == HIGH && loopCount--) delayMicroseconds(1);
  if (loopCount <= 0) return false;

  for (int i = 0; i < 40; i++) {
    loopCount = 1000;
    while (digitalRead(DHT_PIN) == LOW && loopCount--) delayMicroseconds(1);
    if (loopCount <= 0) return false;

    unsigned long t = micros();
    loopCount = 1000;
    while (digitalRead(DHT_PIN) == HIGH && loopCount-- && (micros() - t) < 120) delayMicroseconds(1);
    if (loopCount <= 0 && (micros() - t) >= 120) return false;

    data[i / 8] <<= 1;
    if ((micros() - t) > 40) data[i / 8] |= 1;
  }

  pinMode(DHT_PIN, OUTPUT);
  digitalWrite(DHT_PIN, HIGH);

  uint8_t sum = (data[0] + data[1] + data[2] + data[3]) & 0xFF;
  if (sum != data[4]) return false;

  *humidity = ((data[0] << 8) | data[1]) / 10.0f;

  int16_t rawTemp = (data[2] << 8) | data[3];
  if (rawTemp & 0x8000) {
    rawTemp = -(rawTemp & 0x7FFF);
  }
  *tempC = rawTemp / 10.0f;

  return true;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  unsigned long now = millis();
  if (now - lastWiFiRetry < WIFI_RETRY_MS) return;
  lastWiFiRetry = now;

  Serial.println("WiFi connecting...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void publishStatus(const char* status, bool retained = true) {
  char ipStr[16];
  getIpString(ipStr, sizeof(ipStr));

  char buf[200];
  snprintf(buf, sizeof(buf),
           "{\"status\":\"%s\",\"device_id\":\"%s\",\"ip\":\"%s\",\"ts\":%lu}",
           status, DEVICE_ID, ipStr, millis());

  bool ok = mqttClient.publish(topicStatus, buf, retained);

  if (ok) {
    Serial.print("Status published: ");
    Serial.println(status);
  } else {
    Serial.print("Status publish failed: ");
    Serial.println(status);
  }
}

void publishTelemetry(float tempC, float humidity) {
  char ipStr[16];
  getIpString(ipStr, sizeof(ipStr));

  char buf[200];
  snprintf(buf, sizeof(buf),
           "{\"device_id\":\"%s\",\"ip\":\"%s\",\"temp\":%.1f,\"humidity\":%.1f,\"ts\":%lu}",
           DEVICE_ID, ipStr, tempC, humidity, millis());

  bool ok = mqttClient.publish(topicTelemetry, buf);

  if (ok) {
    Serial.print("OK temp=");
    Serial.print(tempC);
    Serial.print(" humidity=");
    Serial.println(humidity);
  } else {
    Serial.println("Telemetry publish failed");
  }
}

void connectMqtt() {
  if (mqttClient.connected() || WiFi.status() != WL_CONNECTED) return;

  unsigned long now = millis();
  if (now - lastMqttRetry < MQTT_RETRY_MS) return;
  lastMqttRetry = now;

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);

  Serial.print("MQTT connecting... ");

  char lwtPayload[80];
  snprintf(lwtPayload, sizeof(lwtPayload), "{\"status\":\"offline\",\"device_id\":\"%s\"}", DEVICE_ID);

  bool ok;
  if (strlen(MQTT_USER) > 0) {
    ok = mqttClient.connect(
      DEVICE_ID,
      MQTT_USER,
      MQTT_PASSWORD,
      topicStatus,
      1,
      true,
      lwtPayload
    );
  } else {
    ok = mqttClient.connect(
      DEVICE_ID,
      topicStatus,
      1,
      true,
      lwtPayload
    );
  }

  if (ok) {
    Serial.println("connected");
    publishStatus("online", true);
  } else {
    Serial.print("failed, state=");
    Serial.println(mqttClient.state());
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("ESP32-C3 Room Sensor (AM2302)");

  buildTopics();
  connectWiFi();
}

void loop() {
  connectWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    connectMqtt();
  }

  if (mqttClient.connected()) {
    mqttClient.loop();

    unsigned long now = millis();
    if (now - lastPublish >= PUBLISH_INTERVAL_MS) {
      lastPublish = now;

      float t, h;
      if (readDHT22(&t, &h)) {
        publishTelemetry(t, h);
      } else {
        Serial.println("DHT read failed");
      }
    }
  }

  delay(10);
}
