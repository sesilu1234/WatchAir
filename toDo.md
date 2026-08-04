



-deberia la esp32 eviar heartbeat de status siempr que : ha

    haya algun cambio
    y quizas un heartbeat cada poco rato por si un cambio no hubiese llegado bien





-que haya diferencia entre hello y el send status no tiene mucho sentido...sin  mas quitar el hello y mantener el status (haciendo el status un poco mas completo si acaso)



-la esp32 envia un status o heartbeat el mismo el solito cada ciertos segundos



----------



el server , cada vez que recibe un heartbeat , lo reenvia a los browsers de ese devide_uuid

el server tiene un loop para last_seen para poner en desconectado un esp32 si no responde hace X segundos




-----------


el browser cuando está en live-view hace 






OBS:



-para hacer stop tambien deberia haber ACK
-cuando está el browser




