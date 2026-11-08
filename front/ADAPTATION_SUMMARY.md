# Adaptación Front — CV ATS MATCH: estado real verificado

## Origen

Clon completo de `leydatos.djlabs.cl` → `/home/test/test/controldecarroceria/atscv.djlabs.cl`.
El punto de partida era el mismo esqueleto del producto legal: panel, chat,
billetera, RAG de leyes y bandeja de archivos.

## Qué cambió (producto CV ATS MATCH)

| Pieza | Antes | Ahora |
|---|---|---|
| Copy | Ley 21.719, Inst. Judicial | CV ATS Match: comparas tu CV con una oferta |
| Primera tarjeta del panel | (no había) | El **analizador**, integrado, sin iframe |
| Tarjetas de entrada | Una sola (drop zone) | **Tu CV** y **La oferta**, idénticas por diseño |
| Lectura por link | No existía | Bloque de URL en las dos tarjetas (PDF/Word como archivo, página como texto) |
| Sección de adjuntos | Fija | **Minimizable** y se pliega sola cuando aparece el informe |
| Créditos | Sólo en la billetera | **Badge siempre visible** en el header, actualizado en vivo |
| "Tus análisis" | Visible | **Oculta** a propósito |

## Módulo compartido

`js/cv-ats.js` es la fuente única del analizador: el panel (`app.html`) y la
ruta `/cv-ats/` cargan el mismo archivo, así que el modal de vista previa,
las gráficas, la animación de carga, el bloque de URL y el colapso se
comportan igual en ambos. El módulo **crea** el modal, el bloque de URL y
los estilos por JS: no hay markup duplicado entre las dos rutas.

### Lo que el módulo hace por ti

- **Vista previa en modal** de las 5 plantillas ATS, con los datos reales
  de la persona pero **incompleta y no copiable** (sin copiar/cortar/arrastrar,
  `ESC` y el fondo cierran).
- **Gráficas**: gauge de puntaje, dona de cobertura de keywords, barra de
  reparto de keywords e indicadores de fortalezas/debilidades/acciones.
- **Animación de carga** en las zonas de archivos (flota, brillo, anillo,
  latido) que respeta `prefers-reduced-motion`, y **barra de progreso que
  queda visible** al terminar ("Tu CV está listo ✓").
- **Inyección silenciosa** del análisis en el webchat: el texto con el
  contexto recuperado no se le muestra a la persona (el volcado del prompt
  es opt-in, `options.showPromptDebug`).

## Verificado en vivo (CDP, API real en `:8099`)

- Match completo con CV + oferta leída por URL → informe con 4 gráficas,
  header actualizado (93 → 92 créditos), **0 errores de consola**.
- Vista previa en modal con datos reales; copia bloqueada; `ESC` cierra.
- **CV por URL (PDF remoto)**: el archivo entra por la misma ruta que un
  adjunto (chip + barra de progreso + extracción).
- **CV por URL (página web)**: el texto entra al textarea editable y activa
  la pestaña "Pegar texto".
- **Oferta por URL**: página → texto (20.000 caracteres, avisando el corte);
  PDF → archivo.
- **Tarjetas espejo**: mismo orden de hijos en `card-cv` y `card-oferta`
  (`url-bloque` → pestañas → texto → archivo → nota).
- **Colapso**: el botón deja la sección en 0px y la etiqueta cambia a
  "Mostrar adjuntos"; al mostrarse el informe la sección se pliega sola.

## Hallazgo importante (causa raíz)

El scan de URL **no** consumía el cupo de análisis: usaba el bucket
`atscv_match` (10/hora). Con varias lecturas seguidas, la respuesta era
**HTTP 429** y el scan "parecía roto". Ahora leer un link tiene su propio
scope **`atscv_url` (30/hora)**, porque leer no gasta créditos ni tokens;
el cupo de análisis queda sólo para los informes.

## Publicación en la API

`api.djlabs.cl/scripts/publish-atscv-front.sh` copia el front a
`api.djlabs.cl/public/atscv/` (mismo patrón que `public/ley-datos/`) y
verifica que las rutas respondan 200. Es una copia **local**: no toca
`public/js/` de otros productos.
