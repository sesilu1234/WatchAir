- load:0x40078000,len:13232
  load:0x40080400,len:3028
  entry 0x400805e4
  [ 892][E][sd_diskio.cpp:806] sdcard_mount(): f_mount failed: (1) A hard error occurred in the low level disk I/O layer
  [ 1705][E][sd_diskio.cpp:806] sdcard_mount(): f_mount failed: (3) The physical drive cannot work
  [ 2520][E][sd_diskio.cpp:806] sdcard_mount(): f_mount failed: (1) A hard error occurred in the low level disk I/O layer
  [ 3333][E][sd_diskio.cpp:806] sdcard_mount(): f_mount failed: (3) The physical drive cannot work
  [ 4148][E][sd_diskio.cpp:806] sdcard_mount(): f_mount failed: (1) A hard error occurred in the low level disk I/O layer
  SD no detectada: la grabacion no va a funcionar hasta que se resuelva.
  Connecting to WiFi: PR_2.4GHz
  ..
  OK, IP local ESP32: 192.168.1.110
  SNTP arrancado
  WS conectado a server2
  WiFi: 3, WS: 1, broadcasting: 0, recording: 0, subiendo: 0

WiFi: 3, WS: 1, broadcasting: 0, recording: 0, subiendo: 0

WiFi: 3, WS: 1, broadcasting: 0, recording: 0, subiendo: 0

WiFi: 3, WS: 1, broadcasting: 0, recording: 0, subiendo: 0

que si no puede inicializaar disk que avise por server

y poner mas bonito el print ese, icnliyendo si ntp y disk estan inicilizados , y poner que es el 3 del wifi...

- una grabacion rejected no atasca la cola (o si reintenta hasta el infinito y blockea)? pero te jode y se queda basura... si devuelve un 400 la request, borrar fichero...

[23:17, 06/08/2026] ulisesplarocher:
-mirar logs para ver que hay mal y que mejorar
-poner mas logs
-poner timestamps en logs (pro y bien)
-posibilidad de borrar delete grabaciones desde ui (select all tambien )
-cuidado que a veces clicka /recordings y pone desconectado al pricnipio. deberia ser conectando...

-quizas modificar ui , la tabla de recordings está feo . creo
[23:24, 06/08/2026] ulisesplarocher: y poner algo debajo en /recording tipo metricas, pero memo y dummy por ahora, pero para dar mas aire y espacio
[00:34, 07/08/2026] ulisesplarocher: Barra de losding o info de como va upload...porque tarda bastante...

Que pasa?

Ver print y logger de subida pa ver...y tambien de realtime, que falla bastante y va traqueteando
[10:37, 07/08/2026] ulisesplarocher: -para borrar mensajes tienes que escribir "delete recordings"

- que si estas en pantalla grande grafica en pc puedes moverte de izquierda a derecha con arrows keys

- check que te permita ver por hora, o por tiempo en la grabacion
