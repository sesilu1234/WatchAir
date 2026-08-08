// Paleta brutalista compartida: tinta + papel + un único acento.
export const INK = "#111111";
export const PAPER = "#f2f1ec";
export const ACCENT = "#00e0a8";
export const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

// Par divergente para los gráficos de análisis. La señal va de − a + alrededor
// del cero, así que aquí el color sólo dice el signo: nunca la magnitud, de eso
// ya se encarga el alto de la barra o el tamaño de la porción. Frío/cálido para
// que se lean como opuestos, con el cálido en el lado positivo.
//
// Naranja quemado y azul pizarra: dos tintas apagadas, en la línea de una
// impresión a dos colores, que es lo que pide el resto de la página (papel
// cálido, sombras duras, mono). Saturarlos más los hacía cantar sobre el papel.
//
// Lo importante es que no se separan sólo por tono: también por claridad
// (luminancia 0,18 frente a 0,07). Eso los deja legibles en escala de grises y
// con cualquier daltonismo, no sólo con el rojo-verde. Contraste contra el papel
// (#f2f1ec): 4,0:1 el naranja y 7,7:1 el azul, por encima del 3:1 que piden los
// bloques de color. El ACCENT de la marca no vale para esto — es demasiado claro
// (1,7:1) y sólo funciona con borde de tinta.
export const SIGNAL_NEG = "#1f4e79";
export const SIGNAL_POS = "#c1571f";
