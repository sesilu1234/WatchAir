#include <Arduino.h>
#include <SD.h>
#include <SPI.h>
#include <SensirionI2CSdp.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <time.h>

#include "protocol.h"
#include "recorder.h"
#include "secrets.h"

const unsigned long WIFI_CHECK_INTERVAL = 10000;
const unsigned long WIFI_CONNECT_TIMEOUT = 15000;
const unsigned long HEARTBEAT_INTERVAL_MS = 2000;

// Módulo microSD por SPI (VSPI por defecto de un devkit ESP32: SCK=18,
// MISO=19, MOSI=23 — SD.begin() los usa solo con pasar el CS).
constexpr int SD_CS_PIN = 5;

WebSocketsClient ws;
SensirionI2CSdp sdp;

unsigned long lastSample = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastPrint = 0;
bool broadcasting = false; // estado derivado: lo decide server2 (start/stop_broadcast)
bool ntpSynced = false;
bool sdReady = false;
bool sensorOk = false; // última lectura I2C correcta; precondición del start

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("WS conectado a server2");
      // hello reconstruye el estado de server2: qué grabación hay en curso
      // (gana la ESP32) y qué ficheros quedan pendientes de subir.
      sendHello(ws);
      break;
    case WStype_DISCONNECTED:
      Serial.println("WS desconectado de server2");
      break;
    case WStype_TEXT:
      handleServerText(ws, payload, len, broadcasting);
      break;
    default:
      break; // los binarios solo van ESP32 -> server2 en este protocolo
  }
}

void trySyncNtp() {
  if (ntpSynced) return;
  if (!timeIsSynced()) return;
  ntpSynced = true;
  Serial.println("NTP sincronizado");
  // Solo ahora se puede reanudar: sin hora real no hay con qué sellar las
  // muestras del tramo posterior al reinicio.
  if (sdReady) recorder.resumeIfPending();
}

void setup() {
  Serial.begin(115200);

  // Sensor: siempre activo (la spec lo pide así; grabar/emitir son cosas aparte).
  Wire.begin(4, 21); // SDA=4, SCL=21
  sdp.begin(Wire, 0x25);
  sdp.stopContinuousMeasurement();
  delay(25);
  sdp.startContinuousMeasurementWithDiffPressureTCompAndAveraging();

  // SD: fuente de verdad de las grabaciones. Sin ella no se puede grabar,
  // pero el resto (live view) sigue funcionando.
  // Unos módulos SD tardan un poco en asentar su alimentación tras el power-on;
  // sin margen, SD.begin() puede fallar con "Card Failed! cmd: 0x00" de forma
  // intermitente. Se reintenta unas cuantas veces con un pequeño delay entre medias.
  delay(200);
  for (int attempt = 0; attempt < 5 && !sdReady; attempt++) {
    if (attempt > 0) delay(300);
    sdReady = SD.begin(SD_CS_PIN);
  }
  if (!sdReady) {
    Serial.println("SD no detectada: la grabacion no va a funcionar hasta que se resuelva.");
  } else {
    recorder.begin(); // retoma una grabación en curso si hubo un reinicio a mitad
  }

  // WiFi
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false); // no reescribir credenciales en flash
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nOK, IP local ESP32: %s\n", WiFi.localIP().toString().c_str());
    configTime(0, 0, "pool.ntp.org", "time.nist.gov"); // UTC: mismo huso que server/frontend
  } else {
    Serial.println("\nSin WiFi al arrancar; el watchdog reintentara.");
  }

  // WebSocket: la ESP32 se autentica con DEVICE_UUID+DEVICE_SECRET en la query string.
  String path = String("/device/ws?uuid=") + DEVICE_UUID + "&secret=" + DEVICE_SECRET;
  ws.begin(SERVER2_HOST, SERVER2_PORT, path);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
}

void loop() {
  ws.loop();
  trySyncNtp();

  // --- Watchdog de WiFi: fuerza reconexion si el auto-reconnect se atasca ---
  if (millis() - lastWifiCheck > WIFI_CHECK_INTERVAL) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi caido, forzando reconexion...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS); // no bloquea; el estado cambia solo
    }
  }

  // --- Heartbeat cada 2 s: server2 lo usa para saber que seguimos vivos y
  // reconciliar comandos perdidos (start/stop_broadcast) ---
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    if (ws.isConnected()) sendHeartbeat(ws, broadcasting, recorder.isRecording());
  }

  // --- Subida de grabaciones ya paradas y pendientes (nunca mientras se graba) ---
  if (sdReady && ws.isConnected()) {
    maybeStartUpload(ws);
    uploadTick(ws);
  }

  // --- Diagnostico periodico ---
  if (millis() - lastPrint > 10000) {
    lastPrint = millis();
    Serial.printf("WiFi: %d, WS: %d, broadcasting: %d, recording: %d\n\n",
                  WiFi.status(), ws.isConnected(), broadcasting, recorder.isRecording());
  }

  // --- Muestreo a 25 Hz: el sensor está siempre activo; grabar y emitir son
  // cosas independientes que se hacen (o no) con la misma muestra ---
  if (millis() - lastSample >= LOOP_TIME_MS) {
    lastSample = millis();
    float p, t;
    sensorOk = (sdp.readMeasurement(p, t) == 0);
    if (sensorOk) {
      p = -(-p); // canula en el puerto opuesto -> invierte signo (quita esta linea si no aplica)

      // Grabar y emitir son independientes: la misma muestra va a una, a otra,
      // a las dos o a ninguna.
      if (sdReady && recorder.isRecording()) {
        recorder.sample((int16_t)round(p * 100.0f));
      }
      if (broadcasting && ws.isConnected()) {
        sendSample(ws, millis(), p, t);
      }
    }
  }
}
