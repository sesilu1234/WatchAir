#pragma once
#include <Arduino.h>
#include <WebSocketsClient.h>

// Mensajes del WS de control con server2. Solo texto: el binario de las
// grabaciones va aparte, por POST (ver uploader.h).
//
// Todo lo de aquí corre en la tarea de red y solo ella toca `ws`
// (WebSocketsClient no es thread-safe).

// El ÚNICO mensaje de estado. Idéntico al conectar, ante cualquier cambio y
// cada 2 s; no hay `hello` ni flags sueltos. Lleva todo lo que server2 necesita
// saber del aparato, y es también lo que confirma un start/stop: server2 espera
// a ver el `rec_uuid` que pidió, no un ACK aparte.
//
// Regla dura: el status NO toca la SD. Solo lee variables que ya están en
// memoria (de ahí el contador de pendientes y la instantánea del recorder).
void sendStatus(WebSocketsClient& ws);

void sendSample(WebSocketsClient& ws, uint32_t tMs, float pressure, float temp);

// Despacha un mensaje de texto entrante de server2: start/stop_broadcast y
// start/stop_recording. Actualiza los flags de shared.h según corresponda y
// NACKea el comando que no se pueda cumplir.
void handleServerText(WebSocketsClient& ws, uint8_t* payload, size_t len);
