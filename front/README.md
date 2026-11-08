# CV ATS Match — front

Front del producto **CV ATS MATCH** (corazón `atscv`). Analiza tu CV contra
una oferta de empleo y te dice, con calma, qué palabras clave ya tienes y
cuáles te faltan.

No es el producto legal: el chat y el RAG de leyes siguen disponibles en el
panel, pero la primera tarjeta es el analizador.

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Landing del producto (inicio, cómo funciona, qué ofrece, CTA) |
| `/app.html` | Panel del usuario: el analizador como **primera tarjeta**, chat, billetera, archivos |
| `/cv-ats/` | El analizador solo, para compartir el link sin entrar al panel |

El analizador es **el mismo módulo** (`js/cv-ats.js`) en las dos rutas: el
modal de vista previa, las gráficas, la animación de carga, el bloque de URL
y el colapso de la sección de adjuntos se comportan igual en todas partes.

## Cómo correrlo en local

```bash
# front (desde este directorio)
python3 -m http.server 8002

# API (corazón atscv), en api.djlabs.cl/
php -S 127.0.0.1:8099 -t public
```

El front llama a la API con `window.API(ruta)`, que usa `window.__API_BASE__`
(`api-config.js`). En local apunta a `http://127.0.0.1:8099`.

> `api.djlabs.cl` no resuelve en DNS dentro de la red de desarrollo: usa la
> IP local de la API.

## Las dos tarjetas de entrada (idénticas por diseño)

**Tu CV** y **La oferta** tienen la misma forma, sólo cambia el propósito:

1. **Bloque de link** — pegas la URL y el servicio la lee:
   - un **PDF o un Word** viaja como archivo y se carga **igual que un
     adjunto** (mismo lector, misma barra de progreso, mismos mensajes);
   - una **página web** viaja como texto.
   - `Enter` también lee, y un link sin `https://` funciona igual.
2. **Pestañas** — `Pegar texto` (editable) y `Subir archivo`.
3. **Nota** — "Se usará lo último que hayas agregado".

Lo que agregues al final es lo que se usa.

### La sección de adjuntos se minimiza sola

Cuando el informe aparece, la sección de adjuntos se pliega (0fr) para
dejarle el lugar al informe. El botón **Ocultar / Mostrar adjuntos** está
siempre a mano y nada se pierde: el texto y los archivos siguen cargados.

## Contrato con la API

```text
POST /v1/cv-ats/match          { cv_texto, oferta_texto, idempotency_key? }
POST /v1/cv-ats/generar-adaptado { operacion?, perfil?, oferta?, brecha?, plantilla, tipo?, idempotency_key? }
POST /v1/cv-ats/desde-url      { url }        -> { tipo: 'texto' | 'archivo', ... }
GET  /v1/cv-ats/documentos/{id}                -> bytes (DOCX / PDF)
```

`POST /v1/cv-ats/desde-url` **no cobra**: leer un link no gasta créditos ni
tokens y tiene su propio cupo (`atscv_url`, 30/hora), separado del de los
análisis (`atscv_match`, 10/hora).

Las respuestas son `{success, data}` o `{success:false, error:{code, message}}`
(401 / 402 / 403 / 429 / 502). Los `docx_url` y `pdf_url` son relativos: hay
que prefijarlos con `window.API(url)`.

## Publicar dentro de la API (servidor único)

```bash
cd api.djlabs.cl
bash scripts/publish-atscv-front.sh --dry-run   # ver qué cambiaría
bash scripts/publish-atscv-front.sh             # copiar + verificar
```

Copia el front a `api.djlabs.cl/public/atscv/` y verifica que `/atscv/`,
`/atscv/app.html`, `/atscv/js/cv-ats.js` y `/atscv/cv-ats/` respondan 200.
El front es autocontenido (rutas relativas), así que funciona desde
cualquier subdirectorio sin tocar `public/js/` de otros productos.

## Notas

- Los créditos se muestran **siempre** en el header y se actualizan en vivo
  (`wallet:balance-updated`).
- La sección **Tus análisis** está oculta a propósito.
- El puntaje generado nunca pasa de **97**: un 100% se lee como automático.
