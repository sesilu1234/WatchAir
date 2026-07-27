#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <SensirionI2CSdp.h>


const unsigned long LOOP_TIME = 50;
const char* ssid     = "MIWIFI_g4hr 2G";
const char* password = "GNjkqFXs";
const char* host = "13.48.132.12";
const uint16_t port  = 8000;

WebSocketsClient ws;
SensirionI2CSdp sdp;
unsigned long last = 0;

bool measuring = false;   // <-- arranca en idle; el boton lo activa

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED)    Serial.println("WS conectado");
  if (type == WStype_DISCONNECTED) Serial.println("WS desconectado");

  if (type == WStype_TEXT) {
    Serial.printf("WS recibido: %s\t", (char*)payload);   // <-- imprime lo que llega

    if (strstr((char*)payload, "start")) {
      measuring = true;
      Serial.println("-> MEASURING");
      ws.sendTXT("{\"state\":\"measuring\"}");   // confirma estado real al frontend
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

  Wire.begin(4, 21);
  sdp.begin(Wire, 0x25);
  sdp.stopContinuousMeasurement();
  delay(25);
  sdp.startContinuousMeasurementWithDiffPressureTCompAndAveraging();

  WiFi.begin(ssid, password);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\nOK, IP local ESP32: %s\n", WiFi.localIP().toString().c_str());

  ws.begin(host, port, "/sensor");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);   // reintenta solo si se cae
}

void loop() {
  ws.loop();   // imprescindible, gestiona la conexion

  static unsigned long lastPrint = 0;
  if (millis() - lastPrint > 2000) {
    lastPrint = millis();
    Serial.printf("WiFi: %d, WS: %d\n", WiFi.status(), ws.isConnected());
  }

  if (measuring && millis() - last >= LOOP_TIME) {    // <-- solo envia si measuring
    last = millis();
    float p, t;
    if (sdp.readMeasurement(p, t) == 0) {
      p = p;   // <-- ajuste de signo (canula en el puerto opuesto)
      char buf[64];
      snprintf(buf, sizeof(buf), "{\"t\":%lu,\"p\":%.3f,\"temp\":%.2f}", millis(), p, t);
      ws.sendTXT(buf);
    }
  }
}