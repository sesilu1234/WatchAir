#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <SensirionI2CSdp.h>

const unsigned long LOOP_TIME = 50;          // ~20 Hz
const unsigned long WIFI_CHECK_INTERVAL = 10000;
const unsigned long WIFI_CONNECT_TIMEOUT = 15000;

const char* ssid     = "MIWIFI_g4hr 2G";
const char* password = "GNjkqFXs";
const char* host     = "13.48.132.12";
const uint16_t port  = 8000;

WebSocketsClient ws;
SensirionI2CSdp sdp;

unsigned long last = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastPrint = 0;
bool measuring = false;   // arranca en idle; el comando "start" lo activa

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED) {
    Serial.println("WS conectado");
    // reporta estado actual al (re)conectar, por si el server se reinició
    ws.sendTXT(measuring ? "{\"state\":\"measuring\"}" : "{\"state\":\"idle\"}");
  }
  if (type == WStype_DISCONNECTED) Serial.println("WS desconectado");
  if (type == WStype_TEXT) {
    Serial.printf("WS recibido: %s\n", (char*)payload);
    if (strstr((char*)payload, "start")) {
      measuring = true;
      Serial.println("-> MEASURING");
      ws.sendTXT("{\"state\":\"measuring\"}");
    }
    else if (strstr((char*)payload, "stop")) {
      measuring = false;
      Serial.println("-> IDLE");
      ws.sendTXT("{\"state\":\"idle\"}");
    }
  }
}

void setup() {
  Serial.begin(115200);

  // Sensor
  Wire.begin(4, 21);   // SDA=4, SCL=21
  sdp.begin(Wire, 0x25);
  sdp.stopContinuousMeasurement();
  delay(25);
  sdp.startContinuousMeasurementWithDiffPressureTCompAndAveraging();

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);        // no reescribir credenciales en flash
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);

  Serial.print("WiFi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nOK, IP local ESP32: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nSin WiFi al arrancar; el watchdog reintentara.");
  }

  // WebSocket
  ws.begin(host, port, "/sensor");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
}

void loop() {
  ws.loop();

  // --- Watchdog de WiFi: fuerza reconexion si el auto-reconnect se atasca ---
  if (millis() - lastWifiCheck > WIFI_CHECK_INTERVAL) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi caido, forzando reconexion...");
      WiFi.disconnect();
      WiFi.begin(ssid, password);   // no bloquea; el estado cambia solo
    }
  }

  // --- Diagnostico periodico ---
  if (millis() - lastPrint > 10000) {
    lastPrint = millis();
    Serial.printf("WiFi: %d, WS: %d, measuring: %d\n\n",
                  WiFi.status(), ws.isConnected(), measuring);
  }

  // --- Muestreo y envio ---
  if (measuring && millis() - last >= LOOP_TIME) {
    last = millis();
    float p, t;
    if (sdp.readMeasurement(p, t) == 0) {
      p = -(-p);   // canula en el puerto opuesto -> invierte signo (quita esta linea si no aplica)
      char buf[64];
      snprintf(buf, sizeof(buf), "{\"t\":%lu,\"p\":%.3f,\"temp\":%.2f}", millis(), p, t);
      if (ws.isConnected()) ws.sendTXT(buf);
    }
  }
}