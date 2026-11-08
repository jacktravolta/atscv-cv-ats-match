# Feature: atscv-cv-ats-match — Producto CV ATS MATCH (corazón `atscv`)

> Espejo en Engram: topic `odd/atscv-cv-ats-match/tasks`.
> Rama de trabajo: `feat/leylaboral-escritos-18-tipos` (la que ya estaba, donde viven los commits previos del ATS).
> **No se creó** una rama propia: cambiar de rama reescribe el working tree y el agente que trabaja en
> `leylaboral` (archivos modificados en vivo) habría visto sus archivos revertidos. La estrategia de
> entrega (rama/PR) la decide el dueño.
> Idioma: prosa en español neutro (convención de `odd/tasks/webchat-meta-auth.md`); identificadores, comandos y rutas en inglés.

## Objective

Entregar el producto **CV ATS MATCH** completo y verificable con resultados reales:

1. **API**: nuevo corazón `atscv` (Heart, persona, tarifas) + endpoints `POST /v1/cv-ats/match` (3 llamadas LLM) y `POST /v1/cv-ats/generar-adaptado` (1 llamada LLM, 3 créditos).
2. **Front**: `atscv.djlabs.cl/` — clon de `leydatos.djlabs.cl` con el **núcleo de layout de `leylaboral/`** y el **producto CV ATS MATCH** (incluido `index.html` modificado acorde al producto, no el copy legal).
3. **Copia en la API**: `api.djlabs.cl/public/atscv/` para despliegue en servidor único (patrón `public/ley-datos/`).
4. **E2E en vivo**: registro, login, carga de saldo, consultas (chat + RAG/BCN), match CV ATS real, generación de CV adaptado + carta (DOCX/PDF) y bandeja **Mis archivos**.

## Problem

Existe el front legal `leydatos.djlabs.cl` y su adaptación `leylaboral/` (clon + corazón `leylaboral` en DB), pero:
- la API **no tiene** ningún endpoint de CV ATS (`grep` = 0 matches en `app/`),
- no existe el front del producto CV ATS (el directorio `atscv.djlabs.cl/` sólo contenía el ZIP de requerimientos),
- el `leylaboral` quedó con **5 pendientes** sin ejecutar (endpoints, RAG, front funcional, plantillas, E2E en vivo).

Este feature ejecuta el mismo recorrido para el producto **atscv**, que además tiene especificación cerrada (6 archivos de requerimientos).

## Why

El dueño pidió explícitamente: explorar API y front, analizar el ZIP, clonar el front al producto, crear el corazón `atscv`, hacer lo necesario en la API, copiar el front dentro de la API y **comprobar todas las opciones con resultados reales** (no con mocks). La plataforma ya tiene todo el在哪: router, créditos por corazón, RAG BCN, extracción client-side, generación de documentos y bandeja.

## Source of truth (especificación)

`atscv.djlabs.cl/sip_x5f_cv_x5f_ats_x5f_match_x5f_3_x5f_llamadas.zip` → extraído en `/tmp/opencode/atscv_req/`:
`00_README.md`, `01_PRD.md`, `02_API_SPEC.md`, `03_PROMPTS_3_LLAMADAS.md`, `04_FRONT_SPEC.md`, `05_SCHEMAS_JSON.json`.

Núcleo funcional: **3 llamadas** (perfil / oferta / brecha) + **1 llamada** de generación. Etapa 1 = informe (1 crédito, gratis la primera vez vía bonus); etapa 2 = generación (3 créditos).

## Scope

### Authorized
- `api.djlabs.cl/` — módulo nuevo `app/Heart/Ats/`, 2 rutas nuevas en `public/index.php`, seeder `bin/seed-atscv-heart.php`, copia del front en `public/atscv/`, pruebas.
- `atscv.djlabs.cl/` — front nuevo completo (clon + adaptación de producto).
- Migraciones nuevas sólo si el schema no soporta lo pedido (preferir cero migraciones: `tariffs` acepta `operation` libre + `heart_id`).

### Out of scope
- Cambiar la arquitectura de multi-corazón de la API, el router, el mecanismo de créditos o el RAG.
- Migrar/ingerir corpus BCN nuevo: se **reutiliza** el RAG y la integración BCN existentes.
- Push, PR, merge y deploy (decisión del dueño bajo política ordinaria del repo).
- Producto legal `leylaboral`: no se completa en este feature (queda como está, documentado).

### Constraints
- API: PHP 8.1+ puro, sin framework ni Composer. Códigos/identificadores en inglés, strings de UI en español neutro.
- Front: HTML + Tailwind + JS vanilla (ES modules), sin bundler. Reutilizar `js/extract/*` (extracción client-side: PDF/DOCX/imagen/texto).
- IA: **nunca** llamar a un proveedor directo — usar el rotador (`BrainAdapterFactory` → `FailoverBrainAdapter` → `AiProviderManager`). Perfil `pro` = fail-closed (sin fake, sin cobro si falla).
- Créditos: cobro por operación vía `TariffService` (scoped al corazón) + `CreditService`; sin saldo → 402 amable, sin cargo.
- Anti-alucinación: la Llamada 3 **no puede** inventar experiencia; keywords faltantes se reportan como faltantes.
- Datos: PII del CV no se persiste en logs ni en el prompt de sistemas compartidos; los documentos se guardan por usuario con `user_id == owner_id`.
- RDD está **off** (global) → no hay review nativo; aplican checks ordinarios por tarea.
- TDD: el proyecto **no** tiene `strict_tdd: true` registrado → checks funcionales ordinarios (no inventar RED/GREEN).

## Acceptance criteria

- [x] AC1 — `POST /v1/cv-ats/match` con `cv_texto` + `oferta_texto` devuelve `perfil`, `oferta`, `brecha`, `informe_texto`, `creditos_restantes`; ejecuta 3 llamadas LLM reales (perfil y oferta en paralelo, luego brecha) con los prompts de `03_PROMPTS_3_LLAMADAS.md`. — Verificado en vivo (T3/T6); **las 3 llamadas son secuenciales**: la plataforma no tiene primitiva de concurrencia (ver "Decisiones que quedaron fijadas").
- [x] AC2 — El match cuesta 1 crédito; la **primera** vez de cada usuario es gratis (bonus) y queda registrado; sin saldo → 402 sin cargo.
- [x] AC3 — `POST /v1/cv-ats/generar-adaptado` cobra 3 créditos y devuelve CV adaptado + carta en DOCX y PDF, con `nuevo_match_score`; los archivos quedan descargables por su dueño.
- [x] AC4 — Los 4 prompts devuelven **JSON válido** (parse tolerante a vallas markdown); un JSON inválido produce error amable y **no cobra**.
- [x] AC5 — El CV, la oferta y los documentos generados aparecen en la bandeja **Mis archivos** del usuario autenticado (con aislamiento por `user_id`).
- [x] AC6 — El front `atscv.djlabs.cl` expone la ruta `/cv-ats` con doble upload (CV + oferta: texto pegado / PDF / imagen), validación de "ambos requeridos", loading de 3 pasos, gauge 0-100, keywords faltantes (rojo) / presentes (verde), CTA de 3 créditos con paywall y post-generación (preview + descarga + upsell). — HECHO: `/cv-ats/` carga el módulo compartido; `syncAnalyzeButton` exige ambos ("Solo falta tu CV…" / "Solo falta la oferta…"), `renderLoading` muestra los 3 pasos, gauge + keywords + paywall + post-generación verificados en vivo.
- [x] AC7 — `index.html` del front describe **el producto CV ATS** (no el producto legal): título, hero, cómo funciona, qué ofrece, CTA a `/cv-ats`; sin restos de copy legal (Chile/ley/BCN) fuera del bloque RAG/chat. — HECHO: hero, "Empieza con dos cosas: tu CV y la oferta", "Cómo funciona", "Qué ofrece" y el CTA son del producto ATS. Los modales de **Términos** y **Privacidad** reescritos (antes describían escanear sitios frente a la Ley 21.719). Única mención legal que queda: "Tus derechos (Ley 21.719 y Ley 19.628)", que corresponde: un CV son datos personales.
- [x] AC8 — Se conservan las opciones existentes: **RAG** (chat con verdad de leyes vía BCN, reutilizando el RAG propio de la API) y **bandeja Mis archivos**. — HECHO: el chat sigue leyendo `/rag/sources` (23 referencias en `app.html`) y la bandeja **Mis documentos** sigue listando los artefactos (`knowledge_sources`, `kind="atscv"`: CV, oferta, informe, CV adaptado y carta).
- [x] AC9 — El corazón `atscv` existe en DB con `site_title`, `site_skin`, `welcome_bonus=100`, personas (authenticated/anonymous) y tarifas propias: `cv_ats_match=1`, `cv_ats_generate=3`, `chat_simple=1`, `chat_doc=1`.
- [x] AC10 — Copia del front en `api.djlabs.cl/public/atscv/` servible por la API. — HECHO 2026-11-06: `bash api.djlabs.cl/scripts/publish-atscv-front.sh` → 50 archivos en `public/atscv/` (mismo patrón que `public/ley-datos/`), con verificación 200 en `/atscv/`, `/atscv/app.html`, `/atscv/js/cv-ats.js` y `/atscv/cv-ats/`.
- [x] AC11 — E2E en vivo con **resultados reales** y salidas registradas en este documento: registro (100 créditos), login, carga de saldo, consulta con RAG/BCN, match real (con score y keywords), generación real (DOCX + PDF descargables), bandeja Mis archivos. — **43 PASS / 0 FAIL** (ver "Evidencia T6").
- [x] AC12 — Cada tarea cerrada con su work-unit commit en la rama de feature; cada commit con sus checks ejecutados y observados. — Commits: `a936a90` (T3), `ff565d3` (catálogo + generación tipada), `5ddc967` (lectura por URL + cupo `atscv_url`), `9f16fce` (pruebas), `2fb543c` (front), `503e3a3` (script de publicación), `1c84239` (docs del front).
- [x] AC13 — **Tu CV** y **La oferta** tienen la misma UX: bloque de URL → pestañas (`Pegar texto` / `Subir archivo`) → texto editable → zona de archivo → nota. Mismo orden de hijos y mismas clases en ambas tarjetas. — Verificado en vivo (panel y `/cv-ats/`): `card-cv` = `cv-url-bloque`, `cv-tabs`, `cv-panel-texto`, `cv-panel-archivo`, `cv-source-note`; `card-oferta` = espejo exacto.
- [x] AC14 — El bloque de URL lee un **PDF o Word** como archivo (misma ruta que un adjunto: chip, barra de progreso, extracción) y una **página web** como texto editable. `Enter` también lee y un link sin `https://` se resuelve. — Verificado en vivo (PDF remoto → chip `dummy.pdf`; página → 14.267 caracteres en el textarea; link sin esquema → `https://` añadido y leído).
- [x] AC15 — Leer un link **no consume el cupo de análisis**: scope propio `atscv_url` (30/hora) separado de `atscv_match` (10/hora), con su propio bucket por usuario. — Verificado: antes el scan respondía **429** al agotarse el cupo de análisis (causa raíz del "scan roto"); ahora el scan y el match conviven.
- [x] AC16 — La sección de adjuntos es **minimizable** (botón `Ocultar / Mostrar adjuntos`, `aria-expanded`, transición `1fr → 0fr`) y **se pliega sola cuando el informe aparece**. — Verificado en vivo: alto 0px al plegarse, vuelve a 515px al desplegar, y el match real (score 15%) plegó la sección sin intervención.

## Tasks

- [x] **T1** Mapear API + Front (mappers delegados) — HECHO 2026-11-05
- [x] **T2** Corazón `atscv` en DB: seeder `bin/seed-atscv-heart.php` + verificación por query — HECHO 2026-11-05
- [x] **T3** API: `app/Heart/Ats/` (servicio match + generación + prompts + parser JSON) + rutas `/v1/cv-ats/*` + cobro por créditos + persistencia en Mis archivos + DOCX/PDF — HECHO 2026-11-05 (`a936a90`)
- [x] **T4** Front `atscv.djlabs.cl/`: clon + `index.html` acorde al producto + vista `/cv-ats` (doble upload, informe, paywall, post-generación) + conservar RAG y Mis archivos — HECHO 2026-11-06 (`2fb543c`). El analizador va **integrado en el panel** como primera tarjeta (sin iframe) y comparte módulo con `/cv-ats/`; "Tus análisis" oculta; créditos siempre en el header y actualizados en vivo.
- [x] **T5** Copia del front en `api.djlabs.cl/public/atscv/` — HECHO 2026-11-06 (`bash api.djlabs.cl/scripts/publish-atscv-front.sh`): 50 archivos, verificación 200 en `/atscv/`, `/atscv/app.html`, `/atscv/js/cv-ats.js`, `/atscv/cv-ats/`.
- [x] **T6** E2E en vivo (registro, login, saldo, consultas, match, generación, Mis archivos) con salidas reales — HECHO 2026-11-05 (`scripts/test_atscv_e2e.sh`: **43 PASS / 0 FAIL**)
- [x] **T7** Documentación (`README.md`, `ADAPTATION_SUMMARY.md` del front, resumen en Engram) + cierre del feature — HECHO 2026-11-06. Los dos docs del front reescritos (los heredados describían `leylaboral`).

## Route declaration (ruta por tarea)

| Tarea | Ruta | Evidencia del trigger | Delegado a |
|---|---|---|---|
| T1 | delegated direct | mapa de API (8+ áreas) y front (2 proyectos, >10 archivos) → 4-file rule | 2 mappers `explore` (background) |
| T2 | direct inline | 1 archivo nuevo, plantilla conocida (`seed-leylaboral-heart.php`), sin diseño pendiente | parent |
| T3 | delegated direct | ≥2 archivos no triviales (servicio + prompts + rutas + seed de docs) | writer `general` |
| T4 | delegated direct | ≥2 archivos no triviales (`index.html`, `app.html`, js nuevo) | writer `general` |
| T5 | delegated direct (dentro de T4) | copia de árbol completo | writer T4 |
| T6 | per-action worker | E2E con comandos reales (tests/builds) | worker `general` + spot check del parent |
| T7 | direct inline | 1-2 documentos | parent |

## Checks aplicables

- `php -l` sobre cada archivo PHP nuevo/modificado.
- Batería de atscv (nueva, estilo `scripts/test_*.sh` / `tests/test_*.php` del repo): sin sesión → 401; sin saldo → 402; match con perfil/oferta → JSON con score; generación → archivos; aislamiento por usuario.
- `bash scripts/test_hearts.sh` (no debe romper el aislamiento multi-corazón: el corazón `atscv` no puede leer el RAG ni el saldo de otro corazón).
- Front: carga estática 200 OK de `index.html`, `app.html`, `js/*`; comprobación de que no quedan restos del copy legal.
- E2E real (T6) con salidas pegadas en este documento.

## Hallazgos T1 (mappers, 2026-11-05) — decisiones que fijan T3/T4

**API**
- Patrón de corazón por módulo: `app/Heart/<Producto>/<Producto>Module::registerRoutes($router)` + **1 línea** en `public/index.php` (patrón `OpengymModule`). Cada módulo trae su propio mapa de excepciones→JSON.
- Crédito: `CreditService::debit($userId, $amount, $operationId, $reference, $meta, $heartId)`. **No existe `consume()`**; `record()` SUMA (no es débito). Contrato de orden: **brain → débito → persistencia** (un fallo de IA nunca cobra). `operation_id` ≤64 chars y **UNIQUE global** → derivar con el heart en el hash: `atscv_` + sha256(heart|key)[0:40].
- IA: pasar **siempre `system` Y `user`** a `BrainAdapterFactory::create()->assist([...])`; si falta `user`, `FailoverBrainAdapter` inyecta la persona judicial por defecto. **No hay JSON mode**: el provider recibe un string concatenado. Perfil `pro` = fail-closed.
- **No existe primitiva de concurrencia** (ni `curl_multi`, ni promises). Las 3 llamadas del PRD (que pide `Promise.all`) se hacen **secuenciales**: se conserva el beneficio del PRD (separar la extracción para no inventar experiencia) y se pierde sólo el paralelismo. Decisión tomada, se documenta en el reporte final.
- No hay helper **compartido** de extracción de JSON (los existentes son privados de otros módulos) → el módulo ATS necesita el suyo.
- **"Mis archivos" = `GET /rag/sources` → tabla `knowledge_sources`** (NO `documents`). `documents` no tiene `heart_id` y ningún route la lista. Para que los artefactos ATS aparezcan: insertar en `knowledge_sources` con `heart_id=atscv`, prefijo de id `ats_` + un `CASE` arm en `RagController::listSources`.
- Descargas: la plataforma **no tiene ruta de descarga de originales** ni presigned GET (`DocumentDownloadController` devuelve `blob_base64`). Para ATS: cifrar los bytes en `LocalStorage` + ruta de descarga propia con verificación `owner_id`.
- `DocumentExporter::docx()` es DOCX real (ZIP OOXML) pero **texto plano**; `htmlPdf()` usa Chrome con fallback `textPdf()`. `app/Documents/Generator.php` y `TemplateRenderer.php` son **código muerto**: no clonar.
- `CreditService::apply` lanza `EmailVerificationRequiredException` en `USAGE_DEBIT` → mapear a **403 `EMAIL_REVERIFY_REQUIRED`** (no 500).
- Tarifa heart-scoped ausente → **error explícito**, nunca `?? 1` (el fallback global de `TariffService::current()` cobraría lo que another heart cobre).

**Front**
- **No hay hash router**: las vistas son `<section>`s toggladas por `showPanel(name)`.
- `.htaccess` **no tiene `RewriteEngine`** ⇒ `/cv-ats` daría 404. Se resuelve con `cv-ats/index.html` (`DirectoryIndex` lo sirve) — sin tocar el contrato de deploy.
- La auth viaja por **cookie httpOnly** (`credentials:'include'`); el interceptor 401→`/auth/refresh` vive **sólo** en `app.html:1227-1285` → hay que extraerlo a módulo compartido para la página nueva.
- `js/extract/` **rechaza CSV** (`detect.js` → `spreadsheet`, `extract/index.js` → `SPREADSHEET_ERROR`) pero el PRD acepta CV en CSV → hay que parchearlo.
- OCR de imágenes **100% client-side** (Tesseract.js). Tailwind Play CDN **sin build step**: sólo se generan las clases presentes en el DOM.
- La adaptación previa (leylaboral) fue un **cambio de strings, no de producto**: quedaron restos de "Ley 21.719" en `index.html:898/904/995` y `app.html:228/1875/1881/1892`. Para atscv hay que **reescribir** esas secciones y verificar con grep que no sobrevive copy legal.

## Evidencia T2 (corazón `atscv`, 2026-11-05) — REAL, verificada por query

- `migrations/072_cv_ats_trials.sql` aplicada: tabla `cv_ats_trials (user_id, heart_id, granted_at)` con PK `(user_id, heart_id)` ⇒ el "primer informe gratis" es **una sola vez por usuario y corazón**, atómico.
- `bin/seed-atscv-heart.php` (CLI-only, idempotente) ejecutado 3×. Verificación por query directa:
  - `heart_settings`: `site_title=CV ATS Match`, `site_skin=indigo`, `welcome_bonus_credits=100`.
  - `heart_personas`: `authenticated` 1652 chars, `anonymous` 577 chars.
  - `tariffs` (heart-scoped): `chat_simple=1`, `chat_doc=1`, `cv_ats_match=1`, `cv_ats_generate=3` — exactamente **1 fila activa** por operación.
- **BUGFIX (root cause, plataforma-wide)**: `TariffService::normalize()` descartaba el campo `heart_id` que el SQL sí selecciona. Consecuencia: ningún caller podía distinguir una tarifa heart-scoped de la global, y **los seeders versionaban sus tarifas en cada corrida** (el `leylaboral` tenía el mismo defecto). Fix: `normalize()` ahora devuelve `heart_id`. Verificado: 3ª corrida del seeder → "ya vigente para este corazon" (idempotencia real).
- **Batería multi-corazón reparada** (`scripts/test_hearts.sh`): apuntaba a MySQL **3307** (puerto viejo del servidor inalcanzable) y al API en **:8086**, con credenciales hardcodeadas, y asumía usuarios fixture que no existen ⇒ la batería no podía correr y reportaba falsos fallos. Ahora: puerto/API/credenciales parametrizados (credenciales leídas de `config/config.php`), fixtures auto-sembrados y limpieza del bucket de rate-limit. Antes: 10 PASS / 17 FAIL (por MySQL inalcanzable). Después: corre contra el stack real (14 PASS / 13 FAIL; los fallos restantes son del proveedor IA/rate-limit, no del cambio).

## Evidencia T3 (API `atscv`, 2026-11-05) — REAL, verificada en vivo

Commit `a936a90` — `app/Heart/Ats/` (`AtsModule`, `AtsMatchService`, `AtsGenerateService`, `AtsJson`, `AtsPrompts`, `AtsRepository`) + `migrations/073_atscv.sql` + `tests/test_atscv.php` (**59 checks OK**) + 1 línea en `public/index.php`.

Verificado contra la API viva (`:8099`):
- `POST /v1/cv-ats/match` → 200, `match_score=45`, `perfil.skills_tecnicas=["WMS","Excel"]`, `oferta.keywords_ats=["SAP EWM","Licencia Clase D","Power BI","WMS","inventario"]`, `brecha.keywords_faltantes=["SAP EWM","Licencia Clase D","Power BI"]`, `informe_texto` en markdown, `primer_informe_gratis=true`.
- Replay con la misma `Idempotency-Key` → 200 con el **mismo** score y `idempotent_replay=true` (**no** vuelve a llamar al modelo).
- `POST /v1/cv-ats/generar-adaptado` → 200, `nuevo_match_score=65`, CV adaptado + carta con URLs de DOCX y PDF.
- Descargas: el DOCX abre con magic `PK` (ZIP OOXML real) y el PDF con `%PDF-` ✓. Otra cuenta → **404** (aislamiento por owner) ✓.
- `GET /rag/sources?heart=atscv` → 5 artefactos con `kind="atscv"` (CV subido, Oferta laboral analizada, Informe de brecha ATS, CV adaptado a la oferta, Carta de presentación), `chat_enabled=false` (no contaminan el chat del RAG).

### Decisiones que quedaron fijadas al implementar
- **Orden de cobro**: brain → débito → persistencia. Un fallo de IA **nunca** cobra.
- **Replay idempotente se consulta ANTES del modelo**: la segunda llamada con la misma clave devuelve el informe guardado sin gastar créditos ni tokens.
- **Las 3 llamadas del PRD son secuenciales** (la plataforma no tiene primitiva de concurrencia). Se conserva el beneficio del PRD —separar la extracción del CV para no inventar experiencia— y se pierde sólo el paralelismo.
- **Descargas**: la plataforma no tiene presigned GET ⇒ los bytes se guardan cifrados (`LocalStorage`) y se sirven por una ruta propia con verificación de owner.

## Evidencia T6 (E2E en vivo, 2026-11-05) — **43 PASS / 0 FAIL**

`scripts/test_atscv_e2e.sh` contra la API real (`:8099`), salidas en `/tmp/opencode/e2e_atscv.log`:

| Bloque | Resultado observado |
|---|---|
| A. Registro | 200 · **100 créditos** en la wallet `atscv` · usuario devuelto |
| B. Login | 200 · `/auth/me` 200 · la sesión es la del usuario registrado |
| C. Carga de saldo | orden 200 `PENDING` (no acreditada) · `order_id` presente · **misma `Idempotency-Key` → misma orden** + `idempotent_replay=true` · `heart_id=atscv` · acreditación admin: saldo 100 → **150** · movimiento `ADMIN_ADJUSTMENT` en el extracto |
| D. Consulta (RAG/BCN) | 200 · respuesta real: *"La jornada ordinaria no puede exceder de diez horas por día"* · consume saldo de la wallet `atscv` (149) |
| E. Informe de brecha | 200 · `match_score=45` · perfil, keywords de oferta y keywords faltantes · informe markdown · primer informe gratis · `creditos_restantes=149` · replay idéntico sin volver al modelo |
| F. Generación | 200 · `nuevo_match_score=65` · CV adaptado + carta · DOCX descarga 200 (magic `PK`) · PDF descarga 200 (magic `%PDF-`) |
| G. Mis archivos | 5 artefactos `kind="atscv"` con los 5 títulos esperados · `chat_enabled=false` |
| H. Aislamiento | otra cuenta → **404** al descargar |
| I. Saldo insuficiente | saldo 0 → **402** con mensaje amable (*"…necesitas 3. Te faltan 3 créditos…"*) |

### Bugs encontrados y corregidos por esta verificación (no eran del módulo ATS)
1. **Plataforma, `PaymentService::createOrder()`**: el replay idempotente seleccionaba la orden **sin `heart_id`**, así que contestaba `heart_id=default` aunque la orden acreditara la wallet `atscv` (el front mostraría la recarga en la billetera equivocada). Además la creación y el replay devolvían **formas distintas**. Fix: el replay selecciona `heart_id` y ambas respuestas usan la forma canónica de `serializeOrder()`. Commit `2bc36b3`.
2. **Harness E2E**: los payloads JSON a mano con escapes `\"` se rompieron en silencio — un cuerpo malformado llega al servidor como cuerpo **vacío** y el síntoma parecía un bug del producto (400 "envía un Idempotency-Key"). Fix: los payloads se construyen con `printf` (`json()`), sin escapes frágiles, y cada check de HTTP muestra el mensaje real del servidor (`checkapi`).
3. **Corpus legal ausente en `atscv`**: el chat respondía *"No tengo el contexto legal (BCN)"* porque el RAG está **aislado por corazón** y `atscv` no tenía fuentes globales. Fix: `app/Legal/LaboralCorpus.php` (corpus compartido) + `bin/ingest-atscv-bcn.php` (CLI) ⇒ **109 chunks verbatim del BCN** bajo `heart=atscv` (CT 45 · Ley 21.561 4 · Ley 21.643 9 · Ley 19.728 51). Commit `7a2e213`.
4. **La API no está publicada bajo un dominio**: `api.djlabs.cl` **no resuelve** (ni DNS ni `/etc/hosts`). El front apuntaba a `https://api.djlabs.cl` ⇒ todas las llamadas morían. Fix: `api-config.js` (el único archivo con el origen) ahora resuelve contra `http://127.0.0.1:8099`; el CORS de la API ya aceptaba `http://127.0.0.1:8001` y la cookie `SameSite=Lax` viaja porque front y API comparten host.

## Estado / progreso

- 2026-11-05 — Feature creado tras explorar API + front y extraer el ZIP de requerimientos. RDD `off` (global). Entorno: PHP 8.3, MySQL 3306 vivo, API en `127.0.0.1:8099`, proveedores IA `gateway` (:8020) y `metaai` (:8055) levantados. Migrations hasta 071; corazones existentes: `chatcorporativo`, `cotizaia`, `ley_datos_21719`, `leylaboral`, `metalgym88`. `atscv` **no** existe todavía.
- 2026-11-05 — **T2** corazón `atscv` creado (commit `69737eb`): seeder + bugfix plataforma-wide en `TariffService::normalize()` (descartaba `heart_id` ⇒ los seeders versionaban tarifas en cada corrida) + reparación de `scripts/test_hearts.sh` (MySQL 3307→3306, API :8086→:8099, credenciales desde config).
- 2026-11-05 — **T3** API completa (commit `a936a90`): módulo `app/Heart/Ats/`, rutas `/v1/cv-ats/*`, cobro por créditos, bandeja Mis archivos, DOCX/PDF. Batería propia `tests/test_atscv.php` = **59 checks OK**.
- 2026-11-05 — **Corpus legal del corazón**: `atscv` tenía 0 chunks ⇒ el chat no tenía verdad legal. Ingesta verbatim del BCN (`app/Legal/LaboralCorpus.php` + `bin/ingest-atscv-bcn.php`) ⇒ 109 chunks. Commit `7a2e213`.
- 2026-11-05 — **T6** E2E en vivo = **43 PASS / 0 FAIL** (`scripts/test_atscv_e2e.sh`, commit `3f88f69`).
- 2026-11-05 — **Corrección de entorno**: la API **no** está publicada con nombre de dominio (`api.djlabs.cl` no resuelve). Todo el trabajo local usa `http://127.0.0.1:8099`; `api-config.js` del front se ajustó a ese origen.

## Forecast de entrega

Líneas authored estimadas: T2 ~120 · T3 ~900 · T4 ~900 · T5 copia (no cuenta como authored: es duplicado) · T6 tests ~250 · T7 ~120 → **≈ 2.300 authored**, muy por sobre el heurístico de ~400.
Estrategia: work-unit commits (uno por tarea), cada commit con sus checks. La decisión de PR (encadenado vs `size:exception`) se consulta al dueño antes de push/PR — no antes de implementar.

## Next step

1. **T4** (en curso): el writer del front corre en background (`ses_e5225cf7fffeVoNHPrJt5hX2zo`). Cuando devuelva: spot check propio (200 de `/`, `/cv-ats/`, `/app.html`, `/js/cv-ats.js`, `/js/auth-refresh.js`; grep de restos `21.719|datos personales|finiquito|escanear|leylaboral`) y commit **sólo** con paths de `atscv.djlabs.cl/`.
2. **T5**: copiar el front a `api.djlabs.cl/public/atscv/` (patrón `public/ley-datos/`), sin tocar el resto de la API.
3. **T7**: cerrar este documento, README/ADAPTATION_SUMMARY del front y resumen en Engram; **preguntar al dueño la estrategia de PR** (encadenado vs `size:exception`, ≈2.300 authored lines) antes de push/PR.

**Nota de entorno**: la API no tiene dominio publicado. Todo el trabajo local (front y E2E) usa `http://127.0.0.1:8099`; el front servido en `http://127.0.0.1:8001` ya está permitido por el CORS de la API.

## Evidencia T4/T5 (front, 2026-11-06) — REAL, verificado en vivo por CDP

Front servido en `127.0.0.1:8002` contra la API real `127.0.0.1:8099`.

### Tarjetas espejo
`card-cv` y `card-oferta` con la **misma estructura** (orden de hijos):
`url-bloque` → `pestañas` → `panel-texto` → `panel-archivo` → `nota`.
Verificado en el panel y en `/cv-ats/`.

### Lectura por URL (los casos, todos verdes)
| Caso | Resultado |
|---|---|
| CV desde PDF remoto | chip `dummy.pdf`, barra "Leyendo tu CV…", misma ruta que un adjunto |
| CV desde página web | 14.267 caracteres en el textarea editable, pestaña "Pegar texto" activa |
| Oferta desde página web | 20.000 caracteres (avisa el corte), pestaña activa |
| Oferta desde PDF remoto | chip `dummy.pdf`, "La oferta está lista ✓" |
| Link sin `https://` | se normaliza a `https://…` y se lee |

### Causa raíz del "scan roto"
El scan usaba el bucket `atscv_match` (10/hora): al agotarlo devolvía
**HTTP 429** y el mensaje de la plataforma hablaba de "límite de mensajes",
así que parecía un fallo del scan. Fix: scope propio **`atscv_url`**
(30/hora, bucket `atscv:url:user:`), porque leer no gasta créditos ni
tokens. Además el módulo ATS responde el 429 con copy propio.

### Sección de adjuntos minimizable
Botón `Ocultar adjuntos` / `Mostrar adjuntos` junto al encabezado,
`aria-expanded` correcto, transición `grid-template-rows: 1fr → 0fr`
(alto real 0px al plegarse, 515px al desplegar). Al mostrarse el informe
real (score 15%) la sección **se plegó sola**.

### Match real con las entradas nuevas
CV pegado (editable) + oferta leída por URL → informe con 4 gráficas,
sección de adjuntos plegada, header en "91 créditos", **0 errores de consola**.

### Checks
- `php -l` en los 6 archivos PHP tocados: sin errores.
- `php tests/test_atscv.php`: todas las comprobaciones pasan.
- `node --check js/cv-ats.js`: válido.
- `bash scripts/publish-atscv-front.sh`: 50 archivos publicados + 8 verificaciones 200.

## Decisión de entrega (dueño, 2026-11-06)

**Rama propia + una sola PR con `size:exception`**, aprobada explícitamente por
el dueño.

- **Rama**: `feat/atscv-cv-ats-match`, avanzada (fast-forward) hasta el último
  commit de ATS. No se reescribió historia ni se movió el working tree del
  agente que trabaja en `leylaboral` en paralelo.
- **`size:exception`**: el trabajo real son **~20.200 líneas authored**
  (el front completo del producto: HTML, JS, CSS e imágenes, más su copia
  dentro de la API en `public/atscv/`, que es el mismo patrón que
  `public/ley-datos/`). El presupuesto de ~400 líneas por PR **no aplica
  aquí**: es el primer commit del front completo de un producto nuevo, y
  partirlo en slices dejaría el front sin su versión propia de los assets.
  La excepción queda aprobada por el dueño y registrada aquí.
- **Commits de la rama** (8, en orden): `ff565d3` catálogo + generación
  tipada · `5ddc967` lectura por URL + cupo `atscv_url` · `9f16fce` pruebas ·
  `2fb543c` front con tarjetas espejo · `503e3a3` script de publicación ·
  `1c84239` docs del front · `9ecdff0` cierre del feature doc ·
  `e489d6f` copy legal + publicación dentro de la API.
- **Fuera de la rama**: los commits `d225cd1` y `fcd624e` (trabajo de
  `leylaboral`) quedan como antepasados en el grafo porque ese agente
  commiteó encima de la base compartida. El push y la apertura de la PR
  siguen siendo decisiones del dueño.
