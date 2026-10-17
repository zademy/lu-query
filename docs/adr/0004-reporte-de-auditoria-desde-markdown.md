# El reporte de auditoría lo genera un script sin dependencias dentro de una skill

El consumidor del rastro es una persona que abre un archivo (ADR 0001), no un pipeline. El reporte se decidio en tres puntos que se suelen tratar por separado:

1. **Vive en `skills/lu-query-audit-report/`, no en `dist/` ni en un recurso del server.** Quien pide el reporte es un agente, y un agente puede copiar una carpeta de skill a cualquier lado: un CLI compilado exigiría que el paquete esté instalado y en la misma versión que el server que escribió los logs.
2. **Node sin dependencias, no Python.** El paquete ya exige Node, así que la skill no agrega un segundo runtime ni un paso de instalación por máquina; parsear tablas Markdown con `node:fs` y regex es trabajo determinista que no necesita nada más. El requisito de "instalar lo que falte" desaparece por completo: el script nunca ejecuta `npm install`.
3. **Tailwind v4 y Chart.js 4 por CDN, no vendorizados.** Un reporte offline exige meter las dos librerías en el tarball para algo que se abre una vez; a cambio, el HTML pesa 25 kB y sale con gráficas interactivas de verdad. La plantilla vive en `references/template.html` para que `prettier --check` la formatee: la estructura del reporte la hace cumplir la máquina y no el agente.

La ventana se limita a un mes y el script **rechaza** en vez de recortar: un reporte que se acota en silencio es un reporte que miente. Un `format-version` desconocido se salta con aviso en el propio HTML en vez de fallar, porque un archivo viejo no debe impedir auditar los demás.

## Consecuencias

- Abrir el HTML por primera vez necesita red; sin ella se ven los números pero no las gráficas.
- El script solo lee `format-version 3-md`. Un rastro `1-json`/`2-md` o un server más nuevo necesitan una actualización de la skill, no otro comando.
- El HTML contiene el SQL verbatim, con literales reales de las escrituras: es un documento interno y no se versiona.
- El p95 y el resto de agregados los calcula el script, no el navegador, para que las tarjetas KPI no dependan de que las gráficas carguen.
