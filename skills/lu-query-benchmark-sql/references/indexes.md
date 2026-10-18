# Revisar índices con pruebas

Un índice es como la lista de páginas de un libro. Explica primero qué busca la consulta, qué camino tomó Oracle y qué cambiarías. Usa nombres reales de tablas y columnas. Mantén los detalles técnicos en la evidencia desplegable.

## Qué revisar

- **Posible índice nuevo:** comprueba los índices existentes y su orden de columnas antes de proponer otro. Mira filtros, joins, cuántas filas se necesitan y las lecturas del plan. Una FK sin índice no obliga a crearlo. Un índice compuesto que empieza por otra columna puede tener usos distintos; Oracle también puede usar skip scans.
- **La consulta dificulta la búsqueda:** revisa funciones como TO_CHAR o TRUNC sobre columnas, conversiones implícitas, tipos de binds y LIKE con comodín inicial. Describe el predicado exacto. Un índice basado en funciones puede ser una alternativa si coincide con la expresión; no afirmes que toda función impide cualquier índice. Conserva NULL, límites y zona horaria al reescribir.
- **Índice existente no elegido:** puede ser correcto si hay que leer muchas filas, la tabla es pequeña o los accesos por índice salen caros. Comprueba estadísticas y estimaciones antes de forzarlo. Explicación: “Buscar cada página por separado puede costar más que leer el libro seguido”.
- **Índice por revisar:** distingue UNUSABLE, invisible, duplicado aparente y poco usado. Verifica particiones, expresiones, orden, unicidad y restricciones PK/UNIQUE. No propongas borrar el índice de una restricción. Un índice invisible puede formar parte de una prueba deliberada.
- **Uso bajo:** list_unused_indexes solo tiene valor con monitorización activa y una ventana representativa del negocio. Una consulta o una ventana sin actividad no demuestra inutilidad. Declara la ventana y las consultas cubiertas; sin ellas, “uso no comprobado”.

## Qué debe decir cada recomendación

1. Qué pasa: dos frases cortas, sin dar por conocida la jerga.
2. Qué probar: una acción concreta y el índice o predicado afectado.
3. Evidencia: tool/vista, definición del índice, predicado y operación del plan observado; fecha o corrida y límites disponibles. Si falta algo, dilo.
4. Qué cuesta: los índices ocupan espacio y se actualizan al insertar, cambiar o borrar filas. Reescribir SQL puede cambiar resultados si se hace mal.
5. Cómo comprobarlo: mismos datos y parámetros, huella de resultados, plan real y medianas de tiempo/buffers/lecturas. Cambia una cosa a la vez. Si baja la E/S pero no el tiempo, informa ambos.

No inventes porcentajes ni índices “malos”. Usa status candidate para hipótesis, query para cambios de consulta, review para investigaciones y measured solo para una mejora realmente probada. El SQL propuesto es texto de referencia. Crear, reconstruir o borrar índices requiere una decisión explícita, no forma parte del renderizado.
