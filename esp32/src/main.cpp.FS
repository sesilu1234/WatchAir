// Utilidad de un solo uso: listar y (opcionalmente) borrar el contenido de la
// SD por Serial, sin WiFi ni sensor de por medio. Para usarla: renombrar este
// fichero a main.cpp (sacando el main.cpp real de src/ para que no choquen
// los dos setup()/loop()), compilar+subir, abrir el monitor serie. Al volver
// al firmware normal: borrar este fichero y restaurar el main.cpp original.
#include <Arduino.h>
#include <SD.h>
#include <SPI.h>

// Mismo pin que usa el firmware real (main.cpp).
constexpr int SD_CS_PIN = 5;

// entry.name() en el core de ESP32 devuelve solo el nombre base (p.ej. "rec"),
// no la ruta completa, asi que hay que reconstruirla a mano a partir del
// directorio padre para poder volver a abrirla con SD.open()/SD.remove().
String joinPath(const char* parent, const String& name) {
  String path = String(parent);
  if (!path.endsWith("/")) path += "/";
  path += name;
  return path;
}

void listDir(const char* dirPath, int indent) {
  File dir = SD.open(dirPath);
  if (!dir) {
    Serial.printf("No se pudo abrir %s\n", dirPath);
    return;
  }
  File entry = dir.openNextFile();
  while (entry) {
    String name = String(entry.name());
    String fullPath = joinPath(dirPath, name);
    for (int i = 0; i < indent; i++) Serial.print("  ");
    if (entry.isDirectory()) {
      Serial.printf("[DIR]  %s\n", fullPath.c_str());
      entry.close();
      listDir(fullPath.c_str(), indent + 1);
    } else {
      Serial.printf("%-40s %10lu bytes\n", name.c_str(), (unsigned long)entry.size());
      entry.close();
    }
    entry = dir.openNextFile();
  }
  dir.close();
}

// Borra /rec/*.bin, /rec/*.meta y /rec/current.uuid. No toca nada fuera de /rec.
void wipeRecordings() {
  File dir = SD.open("/rec");
  if (dir) {
    File entry = dir.openNextFile();
    while (entry) {
      String fullPath = joinPath("/rec", String(entry.name()));
      bool isDir = entry.isDirectory();
      entry.close();
      if (!isDir) {
        Serial.printf("Borrando %s\n", fullPath.c_str());
        SD.remove(fullPath);
      }
      entry = dir.openNextFile();
    }
    dir.close();
  }
  if (SD.exists("/rec/current.uuid")) {
    Serial.println("Borrando /rec/current.uuid");
    SD.remove("/rec/current.uuid");
  }
}

void setup() {
  Serial.begin(115200);
  delay(2000); // margen para abrir el monitor serie antes de que esto corra

  if (!SD.begin(SD_CS_PIN)) {
    Serial.println("SD no detectada.");
    return;
  }

  Serial.println("\n=== Contenido de la SD ===");
  listDir("/", 0);

  Serial.println("\nComandos por Serial: LS (relistar) | WIPE (borrar /rec/*.bin, *.meta y current.uuid)");
}

void loop() {
  if (!Serial.available()) return;

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();

  if (cmd == "WIPE") {
    Serial.println("\n=== Borrando grabaciones ===");
    wipeRecordings();
    Serial.println("\nListo. Contenido actual:");
    listDir("/", 0);
  } else if (cmd == "LS") {
    Serial.println("\n=== Contenido de la SD ===");
    listDir("/", 0);
  }
}
