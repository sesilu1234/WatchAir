#include <Arduino.h>
#include <SD.h>
#include <SPI.h>
#include <SensirionI2CSdp.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_random.h>
#include <time.h>

#include "protocol.h"
#include "recorder.h"
#include "secrets.h"
#include "shared.h"
#include "uploader.h"

// Tres tareas, cada una con un único trabajo:
//
//   sampler  prio 5, core 1 — lee el sensor a 25 Hz clavados y encola. Nunca
//                             toca la SD, ni la red, ni coge el candado, así
//                             que nada puede hacerle perder una muestra.
//   sd       prio 3, core 1 — única dueña de la tarjeta: vacía la cola de
//                             muestras y, cuando no se graba, sube lo pendiente.
//                             Puede bloquearse (flush, POST) sin molestar a nadie.
//   net      prio 2, core 0 — ws.loop(), status, live view, watchdog de WiFi.
//                             Única que toca `ws`.
//
// Antes esto era un solo loop() cooperativo: un flush de la SD (que puede tardar
// >100 ms en una tarjeta lenta) se comía muestras, y la subida tenía que ir a
// trocitos con una máquina de estados para no ahogar el heartbeat. Separadas,
// el muestreo va con vTaskDelayUntil (sin deriva) y la subida es un POST y ya.

const unsigned long WIFI_CHECK_INTERVAL = 10000;
const unsigned long WIFI_CONNECT_TIMEOUT = 15000;
const unsigned long STATUS_INTERVAL_MS = 2000;
const unsigned long UPLOAD_RETRY_MS = 5000;  // no reintentar en bucle una subida que falla

// Módulo microSD por SPI (VSPI por defecto de un devkit ESP32: SCK=18,
// MISO=19, MOSI=23 — SD.begin() los usa solo con pasar el CS).
constexpr int SD_CS_PIN = 5;
// El defecto de la librería son 4 MHz, un techo de 500 kB/s que era el cuello
// de botella real de la subida. Si tu módulo/cableado no aguanta 20 MHz, baja
// a 10000000: el síntoma es que SD.begin() falle o devuelva datos corruptos.
constexpr uint32_t SD_SPI_HZ = 4000000;

// Una muestra ya lista para escribir o emitir.
struct Sample {
  uint32_t tMs;    // millis() del instante de la lectura: sella la grabación y el live view
  float pressure;
  float temp;
  int16_t pCentiPa;
};

// Cola de grabación: no debe perder nada, así que va holgada (~10 s a 25 Hz)
// para absorber un flush lento sin descartar muestras.
constexpr size_t SAMPLE_QUEUE_LEN = 256;
// Cola del live view: es best-effort, si se llena se tiran muestras y ya.
constexpr size_t LIVE_QUEUE_LEN = 32;

SemaphoreHandle_t recorderMutex = nullptr;
volatile bool recordingActive = false;
volatile bool broadcasting = false;
volatile bool sensorOk = false;
volatile bool uploadInFlight = false;
volatile bool statusDirty = true;  // el primer status sale en cuanto haya WS
char bootId[9] = "";

static QueueHandle_t sampleQueue = nullptr;
static QueueHandle_t liveQueue = nullptr;

// Lo que quede en la cola al arrancar una grabación son muestras de la anterior,
// con un sello que no pertenece a la nueva línea de tiempo. Se tiran.
void resetSampleQueue() {
  if (sampleQueue) xQueueReset(sampleQueue);
}

WebSocketsClient ws;
SensirionI2CSdp sdp;

static bool sdReady = false;

static const char* NTP_SERVER_1 = "pool.ntp.org";
static const char* NTP_SERVER_2 = "time.nist.gov";
static bool sntpStarted = false;

// Arranca el cliente SNTP (UTC: mismo huso que server2 y el frontend).
//
// Tiene que poder llamarse tarde, no solo en setup(): si al arrancar no había
// WiFi, configTime() no llegaba a llamarse nunca y el reloj no se ponía jamás
// — y sin hora no se graba ni se reanuda, hasta reiniciar a mano. Basta con
// encender el ESP32 antes que el router para caer en eso.
//
// No se rellama si ya hay hora: configTime() reinicia el cliente SNTP por
// dentro y eso resetearía el backoff de reintento de lwIP.
static void ensureSntpStarted() {
  if (sntpStarted || timeIsSynced()) return;
  configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
  sntpStarted = true;
  Serial.println("SNTP arrancado");
}

// ===================================================
// Tarea de muestreo: 25 Hz clavados, nunca se bloquea
// ===================================================
static void samplerTask(void*) {
  TickType_t lastWake = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(LOOP_TIME_MS);

  for (;;) {
    // vTaskDelayUntil marca el periodo desde el despertar anterior, no desde
    // "ahora": si una vuelta se retrasa, la siguiente se acorta y no hay deriva
    // acumulada (el `lastSample = millis()` de antes sí la tenía).
    vTaskDelayUntil(&lastWake, period);

    float p, t;
    bool ok = (sdp.readMeasurement(p, t) == 0);
    sensorOk = ok;
    if (!ok) continue;

    p = -(-p);  // canula en el puerto opuesto -> invierte signo (quita esta linea si no aplica)

    Sample s{millis(), p, t, (int16_t)round(p * 100.0f)};

    // Grabar y emitir son independientes: la misma muestra va a una, a otra, a
    // las dos o a ninguna. Los envíos son sin espera (timeout 0): esta tarea no
    // se bloquea por nada.
    if (recordingActive) xQueueSend(sampleQueue, &s, 0);
    if (broadcasting) xQueueSend(liveQueue, &s, 0);
  }
}

// ===================================================
// Tarea de SD: única dueña de la tarjeta
// ===================================================
static void sdTask(void*) {
  uint32_t lastUploadAttempt = 0;
  bool resumeChecked = false;

  for (;;) {
    // Reanudar una grabación cortada por un reinicio, en cuanto haya hora NTP
    // (sin hora real no hay con qué sellar las muestras del tramo nuevo).
    //
    // Hasta que esto pase NO se sube nada, y no es por prudencia: listPending()
    // excluye la grabación en curso mirando currentUuid_, que está vacío hasta
    // que resumeIfPending() lo rellena. Subir antes se llevaría por delante el
    // .bin de una grabación viva.
    if (!resumeChecked && sdReady && timeIsSynced()) {
      {
        RecorderLock lock;
        recorder.resumeIfPending();
        recordingActive = recorder.isRecording();
      }
      resumeChecked = true;
      statusDirty = true;  // ya se sabe si hay grabación viva y cuántas pendientes
      Serial.println("NTP sincronizado; reanudacion comprobada");
    }

    Sample s;
    // Espera corta en vez de bloqueo indefinido: si no llegan muestras (porque
    // no se está grabando) hay que despertarse igual para mirar si toca subir.
    if (xQueueReceive(sampleQueue, &s, pdMS_TO_TICKS(100)) == pdTRUE) {
      bool wasRecording = recordingActive;
      {
        RecorderLock lock;
        // s.tMs (millis() de la lectura) y no "ahora": la muestra puede llevar
        // rato en la cola si un flush o una subida entretuvieron a esta tarea.
        recorder.sample(s.pCentiPa, s.tMs);
        // recorder.sample() corta sola a las 12 h: hay que enterarse de eso.
        recordingActive = recorder.isRecording();
      }
      // Al llegar al tope de 12 h el fichero ya está cerrado: se avisa a server2
      // (recording = false) antes de que la tarea empiece con la subida.
      if (wasRecording && !recordingActive) statusDirty = true;
      continue;  // vaciar la cola antes de plantearse subir nada
    }

    if (resumeChecked && !recordingActive && millis() - lastUploadAttempt >= UPLOAD_RETRY_MS) {
      lastUploadAttempt = millis();
      uploadNextPending();  // bloquea lo que haga falta; aquí no molesta a nadie
    }
  }
}

// ===================================================
// Tarea de red: ws, status, live view, WiFi
// ===================================================
static void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("WS conectado a server2");
      // El status reconstruye el estado de server2 (qué grabación hay en curso,
      // qué queda por subir): gana la ESP32. No hay `hello`, es el mismo mensaje
      // de siempre y sale ya, sin esperar al periódico.
      statusDirty = true;
      break;
    case WStype_DISCONNECTED:
      Serial.println("WS desconectado de server2");
      // Sin socket no hay a quién emitir: si no, el sampler sigue llenando
      // liveQueue con muestras que solo se van a tirar.
      broadcasting = false;
      break;
    case WStype_TEXT:
      handleServerText(ws, payload, len);
      break;
    default:
      break;  // en este protocolo ya no viaja binario por el WS
  }
}

static void netTask(void*) {
  uint32_t lastWifiCheck = 0, lastStatus = 0, lastPrint = 0;

  for (;;) {
    ws.loop();

    // --- Status: cada 2 s y, sobre todo, en cuanto algo cambia. Lo inmediato
    // no es un lujo: es lo que confirma un start/stop a server2, que si no
    // tardaría hasta 2 s en dar por buena cada grabación. handleServerText()
    // corre dentro del ws.loop() de arriba, así que un comando recién recibido
    // se contesta en esta misma vuelta ---
    if (ws.isConnected() && (statusDirty || millis() - lastStatus > STATUS_INTERVAL_MS)) {
      statusDirty = false;  // antes de leer el estado: un cambio a mitad no se pierde
      lastStatus = millis();
      sendStatus(ws);
    }

    // --- Watchdog de WiFi: fuerza reconexion si el auto-reconnect se atasca,
    // y arranca el SNTP si el WiFi apareció después de setup() ---
    if (millis() - lastWifiCheck > WIFI_CHECK_INTERVAL) {
      lastWifiCheck = millis();
      if (WiFi.status() == WL_CONNECTED) {
        ensureSntpStarted();
      } else {
        Serial.println("WiFi caido, forzando reconexion...");
        sntpStarted = false;  // al recuperar la red habrá que rearrancarlo
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASS);  // no bloquea; el estado cambia solo
      }
    }

    // --- Live view: lo que haya encolado el sampler ---
    Sample s;
    while (xQueueReceive(liveQueue, &s, 0) == pdTRUE) {
      if (broadcasting && ws.isConnected()) sendSample(ws, s.tMs, s.pressure, s.temp);
    }

    // --- Diagnostico periodico ---
   if (millis() - lastPrint > 10000) {
    lastPrint = millis();

    Serial.println("========== STATUS ==========");
    Serial.printf("WiFi         : %s\n",
                  WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED");
    Serial.printf("WebSocket    : %s\n",
                  ws.isConnected() ? "CONNECTED" : "DISCONNECTED");
    Serial.printf("Broadcasting : %s\n",
                  broadcasting ? "YES" : "NO");
    Serial.printf("Recording    : %s\n",
                  recordingActive ? "YES" : "NO");
    Serial.printf("Uploading    : %s\n",
                  uploadInFlight ? "YES" : "NO");
    Serial.println("============================\n");
}

    vTaskDelay(pdMS_TO_TICKS(5));  // cede CPU; el live view tolera 5 ms de latencia
  }
}

// ===================================================
void setup() {
  Serial.begin(115200);

  // Identifica este arranque en el status: dos boot_id distintos seguidos son
  // un reinicio, y con el t_ms delatan un bucle de reinicios.
  snprintf(bootId, sizeof(bootId), "%08x", (unsigned)esp_random());

  recorderMutex = xSemaphoreCreateMutex();
  sampleQueue = xQueueCreate(SAMPLE_QUEUE_LEN, sizeof(Sample));
  liveQueue = xQueueCreate(LIVE_QUEUE_LEN, sizeof(Sample));

  // Sensor: siempre activo (la spec lo pide así; grabar/emitir son cosas aparte).
  Wire.begin(4, 21);  // SDA=4, SCL=21
  Wire.setClock(400000);  // el read a 25 Hz es el camino caliente del sampler
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
    sdReady = SD.begin(SD_CS_PIN, SPI, SD_SPI_HZ);
  }
  if (!sdReady) {
    Serial.println("SD no detectada: la grabacion no va a funcionar hasta que se resuelva.");
  } else {
    Serial.println("SD detectada y montada correctamente.");
    recorder.begin();
  }

  // WiFi
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);  // no reescribir credenciales en flash
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nOK, IP local ESP32: %s\n", WiFi.localIP().toString().c_str());
    ensureSntpStarted();  // camino rápido; si no, lo arranca el watchdog al conectar
  } else {
    Serial.println("\nSin WiFi al arrancar; el watchdog reintentara (WiFi y SNTP).");
  }

  // WebSocket: la ESP32 se autentica con DEVICE_UUID+DEVICE_SECRET en la query string.
  String path = String("/device/ws?uuid=") + DEVICE_UUID + "&secret=" + DEVICE_SECRET;
  ws.begin(SERVER2_HOST, SERVER2_PORT, path);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);

  // El sampler va en el core 1 con la de SD (que es quien le consume la cola) y
  // la red en el 0, para que un POST largo no compita con el muestreo.
  xTaskCreatePinnedToCore(samplerTask, "sampler", 4096, nullptr, 5, nullptr, 1);
  xTaskCreatePinnedToCore(sdTask, "sd", 10240, nullptr, 3, nullptr, 1);  // HTTPClient come pila
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 2, nullptr, 0);
}

void loop() {
  // Todo el trabajo vive en las tres tareas de arriba.
  vTaskDelay(portMAX_DELAY);
}
