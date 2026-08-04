




1. comprobar que : si una grabacion no tiene row en supabase , al subirla tendria que pasar que el server el permita subirlo (y ya internamente el server se da cuenta de que no hay nada con ese uuid), o directamente avise a esp32 de que no hay fila (que el usuario entonces no se ha puesto canula seguramente) y que puede borrar eso. pues si no aparece en server, el ACK nunca llegó al usuario y no se puso cánula


ya que este fallo solo puede ocurrir al empezar grabacion , no llegó el ACK de grabacion

(en efeco , mantengo lo del ACK de que ha empezado recording. ahi es cuando añado al fila en browser y notifica al browser)



2. por ahora lo voy a dejar asi : que se 12 horas literlamente desde el comienoz..aunque hayas grabado solo 20 min (ha estado desconectada 11 horas + 40min) 


y en el frontend lo cambio : en vez de poner grabando si o sí deduciendo que habias pulsado grabar y tiene <12 horas  ...literalmente si no hay conexion al esp32, pues que pongo desconectado. fin. ya no se sabe de él . 


y si está conectado , pues simplemente se coje de su objeto status (el cual esp32 actualiza cada poco.. y ya esta )

es decir, no deduzco nada, solo replico lo que me dice el server (que a su vez lo sabe por el heartbeat de la esp32)


3. quizas es mas seguro poner   if (writeBufUsed_ = sizeof(writeBuf_)) flushWriteBuffer();  aun asi, aqui te equivocas, esta bien  :  

  uint8_t writeBuf_[WRITE_BUFFER_RECORDS * RECORD_SIZE];
  constexpr size_t RECORD_SIZE = 6;
constexpr size_t WRITE_BUFFER_RECORDS = 85; 


4. esto está bien, está a propósito jaja


5. sí , en efecto : en esta parte se podria comprobar 
 
(size - HEADER_SIZE) % 6 == 0. Porque un flush a medias deja el resto de la grabación corrupta. Si no es divisible , entonces o quitar los bytes del resto, o si realmente eso quiere que es corrupta ,pues nada ajo y agua


   String path = binPath(uuid);
  File f = SD.open(path, FILE_READ);
  if (!f || f.size() < HEADER_SIZE) {  // marcador huérfano: nada que reanudar
    if (f) f.close();
    SD.remove(ACTIVE_PATH);
    return;
  }


6.en efecto : cada device esp32 debería tener un secreto propio, y en el server deberia ser por tanto DEVICE_SECRETS: dict[uuid, secret]









7.  pensar que pasa si se desconecta cablecito  : measures = null (i2c error) (bueno aqui son cosas distintas. si se desconecta canula es indetectable. simplemente sale presion 0 y es como si no la llevase puesta...y si el i2c da error ahí sí se puede poner un null ...pero de alguna manera tiene que ocupar 6 bytes para seguir sin corromper archivo.bin)


## esp32

8.  Mata hello. Un único mensaje status, idéntico al conectar, al cambiar algo y cada 2 s. sendHello y reconcile_hello desaparecen.
El status lleva todo, no flags sueltos:
json
  {"type":"status","uuid":"…","boot_id":"…","rec_uuid":null,"recording":false,
   "broadcasting":false,"uploading":false,"pending":2,"sd_free_mb":12800,
   "ntp_ok":true,"t_ms":123456}
  ( y supongo que aquí debe aparecer tambien el startEpoch del file , que es cuando empezó la grabacion, el 00:00  de la grabacion jajaa, que es lo que da nombre a la grabacion en base de datos y UI (a pesar de ser identificado por uuid))
(quizas se puede quitar del json sd free mb , t_ms y otras por que bloquean proceso de esp32 ,costoso quizas, y no sirve (por ejemplo free db realmente no puedes iniciar grabacion sin que esté vacio el fylesystem, es decir, se haya subido todo. y ademas te avisaría al grabar : si pulsas recording en el ACK de la esp32 te diria : "imposible grabar no hay espacio"))

   y cuando esta el usuario en frontend en /recording , y le da a grabar espera al ACK del server (que a sus vez espera al ACK de al esp32). aqui entonces crea la row en database el server y envia instantaneamente el status al frontend, el cual le llegara y actualizará la pantalla a decir "recording"  (con el nombre de la grabacion, que es el timestamp y un conteo de tiempo y alguna cosita mas bonita si se quiere)

y por cierto, vuelvo a insistir, el ACK de startrecoridng se queda...no lo veo claro sino...
ahh y tambien debería haber un ACK para el stoprecording : esp32 hace close file, recording = false, borra el active y envia el ACK que supongo que es un simple status, y despues enseguida se pone a enviar la grabacion

9. en UI aparece barrita de uploading asi que el usuario se entera...ademas 6.5 MB tardará poco en upload
asi que no, eso de parar upload lo veo peor diria yo...

sep : broadcasting = false al recibir WStype_DISCONNECTED: si no, sigues encolando en liveQueue para tirarlas.

sep: en esp32, en cuanto se superen 12 horas (o se pare recording) se close archivo, se actualiza status a no recording , se envia status a server, y entonces ya se empieza con upload


10. no se muy bien como seria que recorder solo lo coja el sdtask...porque el qeu recibe el message es la nettask...en principio ahora mismo lo veo bien...lo que sí haria quizas es en vez 
de que si esta grabando y le llega un start , ahora borraria la grabacion actual...mejor que avise de que hay algo grabando y que la pare si quiere y vuelva a grabar...

en handle sever textr :   if (recorder.isRecording()) recorder.stop();      eso no, que hago lo que acbao de decir.


## server



11. lo del reconcile, ahora que está puesto el acknowledge en la accion de recording  , solo sirve para el broadcasting, asi que ponerlo asi y llamar a la funcion asi en server : es un reconcile_broadcast (es decir, si hay len(browser) > 0 y broadcast es false que envie startbroadcast  , y al reves si es len 0 y hay broadcast envie stopbroadcast)



12. la ruta de /status es publica y no tiene sentido. quita eso.


13. reaper de 12 h : creo que igual no hace ni falta. simplemente se queda la row incompleta asi y ya se sabe su significado