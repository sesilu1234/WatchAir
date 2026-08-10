






- una grabacion rejected no atasca la cola (o si reintenta hasta el infinito y blockea)? pero te jode y se queda basura... si devuelve un 400 la request, borrar fichero...


- cuidado que a veces clicka /recordings y pone desconectado al pricnipio. deberia ser conectando...


- Ver print y logger de subida pa ver...y tambien de realtime, que falla bastante y va traqueteando


- cambiar hz de muestreo  ? HZ . y en este caso seria bueno aumentar el buffer ?


- ver que algoritmos , comparativas, illneses, leer papaers, metricas, ver de manera bastante clara y certera cuando hay algo raro, ver las ocndiciones/illneses mas comunes y otras menos y tenerlas en cuenta


- ver si se esta midiendo bien, y si la forma de la curva es certera y real y se pinta bien (no desplaza ni traspone puntos), si esta bien los hz, si la forma y tanto pico es normal, etc



-Those are credentials/tokens. Since they've now been exposed in this conversation/log excerpt, rotate the device secret and invalidate/rotate the JWT signing secret if these are real production credentials.

Especially the device secret: it's directly appearing in your HTTP query string, which also means it can end up in access logs.

For the application itself, I'd eventually change:

POST /device/upload?uuid=...&secret=...&recording=...

to an authentication header, e.g.:

Authorization: Bearer <device-token>


----


- todos mis secrets estan commiteados , ncluidos keys de supabase ,etc....

antes de hacer publico o algo, rotar TODO

---




















