# Dirección de diseño

Alcance: los reportes HTML que las skills de `lu-query` generan (hoy, la auditoría y el benchmark de SQL). No gobierna la UI del servidor MCP, que no tiene interfaz.

## Design Read

Reporte de performance local para un desarrollador Oracle que acaba de medir una query, en lenguaje de instrumento de laboratorio, dial ENERGY 1 / RHYTHM 2 / MOTION 2.

## Dials

| Dial   | Valor | Por qué                                                                                                                                                                                      |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENERGY | 1     | Un reporte de medición no debe gritar: si la cifra es mala, el número la dice solo.                                                                                                          |
| RHYTHM | 2     | Tres bloques con ritmo propio (veredicto, comparativa, evidencia) y composición distinta entre ellos, porque cada uno pide una lectura distinta: decidir, comparar, auditar.                 |
| MOTION | 2     | Solo la animación de los gráficos, que dibujan a lo largo del eje de repeticiones para que el ojo perciba el paso del tiempo, que es la variable medida. El resto del documento no se mueve. |

## Motivo de identidad

**El par.** Toda comparación se compone como dos columnas con las mismas etiquetas de fila, para que el ojo barra en horizontal y encuentre la diferencia sin leer. Nada más en el documento usa esta estructura, así que se lee como el motivo de la casa y no como un adorno.

Foco único por pantalla: el bloque de veredicto, arriba del todo. Responde dos preguntas y ninguna más: ¿el resultado cambió? y cuánto más rápido.

## Tema

**Claro por defecto, oscuro opcional.** El reporte se comparte y se imprime en pantallas de oficina: el claro es el punto de partida honesto. El oscuro es una elección del usuario que el navegador recuerda (`localStorage`), no una preferencia del sistema que se le imponga.

- El cambio de tema no recarga la página: las variables CSS se releen y las gráficas se redibujan con los colores del tema activo.
- `color-scheme` acompaña a cada tema para que los controles nativos (select, scrollbar) no queden claros sobre fondo oscuro.
- El script que fija el tema corre antes de cargar el CSS: sin destello del tema anterior.
- Ambos temas pasan el mismo umbral de contraste. Un tema alternativo que no se verifica es un tema roto.

## Color

Mismos roles en los dos temas; los valores cambian, la semántica no.

| Rol        | Claro     | Oscuro    | Razón                                                                                                                         |
| ---------- | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Fondo      | `#f7f8fa` | `#0b0d11` | Casi blanco con un punto de azul / negro con un punto de azul: en ambos, que los colores de datos sean los únicos que griten. |
| Superficie | `#ffffff` | `#12151b` | Un solo nivel de elevación sobre el fondo: las tarjetas se separan por superficie, no por sombra.                             |
| Línea      | `#e3e6ec` | `#232833` | Bordes que estructuran sin delinear.                                                                                          |
| Tinta      | `#16181d` | `#eef1f6` | Texto principal.                                                                                                              |
| Apagado    | `#5a6273` | `#8b93a3` | Etiquetas y unidades.                                                                                                         |
| Tenue      | `#67707f` | `#798195` | Texto terciario. Nunca bajar de 4.5:1 en cuerpo normal.                                                                       |
| Antes      | `#b3261e` | `#f0524b` | El original es el problema: rojo.                                                                                             |
| Después    | `#0e7a6e` | `#5ee0d0` | El optimizado es la solución: teal.                                                                                           |
| Aviso      | `#8a5a00` | `#f5c451` | Cuello de botella o métrica que no cuadra: ámbar.                                                                             |

Contraste verificado, formato claro contra fondo / superficie: tinta 16.71 / 17.75, apagado 5.76 / 6.13, tenue 4.70 / 5.00, antes 6.15 / 6.54, después 4.91 / 5.21, aviso 5.58 / 5.93. En oscuro: tinta 17.18 / 16.15, apagado 6.30 / 6.05, tenue 4.99 / 4.69, antes 5.57 / 5.23, después 12.08 / 11.36, aviso 11.94 / 11.36. Todos ≥ 4.5:1.

Tres colores de datos y un acento (teal). Los tres codifican semántica: original, optimizado, diagnóstico. No son decoración, y por eso el límite de dos o tres colores no les aplica igual.

## Fondo

Liso, en los dos temas. Sin rejilla, sin cuadrícula, sin brillo radial. Una rejilla detrás de un gráfico compite con la retícula del gráfico y hace imposible leer la escala. La regla existe por una razón concreta de este producto, no por gusto.

## Tipografía

- Texto: `-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif`.
- Datos, SQL, cifras e identificadores: `'SF Mono', ui-monospace, Menlo, Consolas, monospace`.

Razón: el reporte se abre con `file://` en la máquina del desarrollador, así que las tipografías del sistema arrancan sin una petición de red. Y el contenido del documento es SQL y cifras, donde el monoespaciado no es una estética, es el formato correcto para alinear columnas y cazar espacios de más.

No se cargan Inter, Geist ni Space Grotesk: son la elección por defecto de un modelo, y aquí no hay razón de marca que los imponga.

## Radio y espaciado

Radio 4 px en tarjetas y controles, 2 px en etiquetas de estado. Sin píldoras: una etiqueta de estado corta cabe en un rectángulo, y una píldora solo añade curva.

Espaciado en múltiplos de 4 px. El aire separa bloques, no rellena huecos: si un bloque no necesita aire, sobra uno de los dos.

## Movimiento

Solo los gráficos. Se dibujan de izquierda a derecha sobre el eje de repeticiones, unos 3.5 s, una vez al cargar. El motivo es que el eje x es tiempo y el ojo tiene que recorrerlo en ese sentido. Con `prefers-reduced-motion` el trazo aparece completo, sin animación.

Sin hover decorativo, sin entradas escalonadas, sin parallax. En un documento que se lee para decidir, el movimiento que no codifica información estorba.

## Iconos

Ninguno. Los datos son tablas, planes y series: un icono al lado de `lecturas físicas` no añade nada. Si algún día hace falta, se escribe su relevancia o no se pone.

## Honestidad de los datos

Aplica a todo reporte generado. Es la regla que más distingue un reporte real de uno decorativo.

1. **Ninguna cifra sin origen.** Cada número viene de una medición ejecutada. Si no se midió, el reporte dice `no medido`; nunca muestra `0` ni un `n/d` disfrazado de dato.
2. **Nada de porcentajes de mejora inventados.** El factor de aceleración sale de la mediana de las repeticiones, y el reporte muestra el denominador: `mediana de 8 repeticiones, 2 de calentamiento`.
3. **La huella no prueba corrección.** `ORA_HASH` colisiona. El reporte dice `coincide` o `no coincide`, nunca `el resultado es correcto`.
4. **Lo que se midió, se declara.** Si la sentencia medida lleva un hint o una envoltura, el reporte lo dice arriba, porque su `sql_id` no es el de producción.
5. **Sin relleno.** Si no hay datos, no hay sección. Nada de testimonios, logos ni estadísticas decorativas.

## Estados

Todo reporte tiene que poder rendererizarse en tres situaciones, y el renderer no se inventa datos para salir del paso:

- **Vacío**: la sección se retira del documento en vez de quedar hueca.
- **No medido**: la métrica aparece como texto `no medido` en su celda, con la fila intacta.
- **Error**: bloque con el mensaje de Oracle tal cual y el paso que falló. Un error tragado es peor que un hueco.

## Estados interactivos

Todo control visible hace algo real o no existe. El reporte es un documento: sin navbar, sin enlaces a secciones inexistentes, sin botones muertos. La navegación interna solo apunta a secciones que siempre existen; las condicionales (avisos, cuellos, errores) no van al menú porque un ancla a un bloque ausente es un enlace muerto. El foco tiene que verse.

## Responsivo

El reporte se lee en pantallas grandes pero se consulta en una laptop angosta. Las tablas con columnas explícitas hacen scroll horizontal dentro de su propio contenedor y nunca desbordan la página. Los gráficos se redimensionan con su contenedor. Ninguna tarjeta se recorta en ningún breakpoint.
