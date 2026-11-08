<?php
declare(strict_types=1);

namespace App\Heart\Ats;

use App\Auth\EmailVerificationRequiredException;
use App\Chat\BrainException;
use App\Core\AppLog;
use App\Core\AuthMiddleware;
use App\Core\ForbiddenException;
use App\Core\RateLimitException;
use App\Core\RateLimits;
use App\Core\Request;
use App\Core\Response;
use App\Core\Router;
use App\Core\UnauthorizedException;
use App\Credits\InsufficientCreditsException;
use App\Heart\UrlAnalyzer\UrlAnalyzerException;
use App\Heart\UrlAnalyzer\UrlAnalyzerService;
use App\Storage\LocalStorage;

/**
 * Route registration for the CV ATS Match heart (atscv).
 *
 * Install: one line in public/index.php after the router is built —
 *   \App\Heart\Ats\AtsModule::registerRoutes($router);
 *
 * The routes:
 *   POST /v1/cv-ats/match             the gap report (3 brain calls)
 *   POST /v1/cv-ats/generar-adaptado  the adapted CV + cover letter (1 brain call)
 *   GET  /v1/cv-ats/documentos/{id}  download one generated file (owner only)
 *
 * This module carries its own exception→JSON mapping (the same one the
 * platform's $respond uses in public/index.php) because it ships as a heart
 * module: keep both in sync when a new exception kind appears.
 */
final class AtsModule
{
    /** The heart this module belongs to. */
    public const HEART = 'atscv';

    /** The tariff operation of the gap report. */
    public const OPERATION_MATCH = 'cv_ats_match';

    /** The tariff operation of the adapted CV. */
    public const OPERATION_GENERATE = 'cv_ats_generate';

    public static function registerRoutes(Router $router): void
    {
        $router->register('POST', '/v1/cv-ats/match', self::respond(static function (Request $request): void {
            $user = AuthMiddleware::requireUser($request);
            $userId = (string) $user['id'];

            $payload = $request->json();

            if (!is_array($payload)) {
                throw new \InvalidArgumentException('El cuerpo debe ser un objeto JSON.');
            }

            // The header wins over the body field (same convention as the
            // payment routes); both are accepted so the front can send
            // whichever it prefers.
            $clientKey = trim((string) (
                $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? ($payload['idempotency_key'] ?? '')
            ));

            // Anti-spam BEFORE any brain call: the limit exists to keep the
            // service fast and fair for everybody.
            RateLimits::enforce('atscv_match', 'atscv:user:' . $userId);

            $data = (new AtsMatchService())->run(
                $userId,
                (string) ($payload['cv_texto'] ?? ''),
                (string) ($payload['oferta_texto'] ?? ''),
                $clientKey
            );

            Response::json(['success' => true, 'data' => $data], 200);
        }));

        $router->register('POST', '/v1/cv-ats/desde-url', self::respond(static function (Request $request): void {
            $user = AuthMiddleware::requireUser($request);
            $userId = (string) $user['id'];

            $payload = $request->json();

            if (!is_array($payload)) {
                throw new \InvalidArgumentException('El cuerpo debe ser un objeto JSON.');
            }

            $url = trim((string) ($payload['url'] ?? ''));

            if ($url === '') {
                throw new \InvalidArgumentException(
                    'Pega el link del documento para que podamos leerlo.'
                );
            }

            // Anti-spam: reading a page is cheap for us but not free for the
            // site we visit. Its OWN bucket: fetching a link never spends
            // the person's analysis quota (that one is for the reports).
            RateLimits::enforce('atscv_url', 'atscv:url:user:' . $userId);

            // REUSE the platform's own downloader (the one the URL analyzer
            // of the other heart uses): it brings the anti-SSRF guard, the
            // redirect handling and the byte limit.
            $scraper = new UrlAnalyzerService();
            $scraper->validateUrl($url);
            $descarga = $scraper->fetch($url);
            $cuerpo = (string) ($descarga['html'] ?? '');
            $finalUrl = (string) ($descarga['final_url'] ?? $url);

            // A PDF or a Word file travels AS ITSELF: the browser receives
            // the bytes and loads them exactly like an attached file (same
            // extractor, same progress bar, same messages).
            $archivo = self::detectarArchivo($cuerpo, $finalUrl);

            if ($archivo !== null) {
                Response::json([
                    'success' => true,
                    'data' => [
                        'url' => $finalUrl,
                        'tipo' => 'archivo',
                        'nombre' => $archivo['nombre'],
                        'mime' => $archivo['mime'],
                        'base64' => base64_encode($cuerpo),
                        'caracteres' => strlen($cuerpo),
                    ],
                ], 200);

                return;
            }

            // Otherwise it is a page: its text is the document.
            $texto = trim($scraper->extractText($cuerpo));

            if ($texto === '') {
                throw new \RuntimeException(
                    'No pudimos leer el texto de esa página. Si es un PDF o un Word, '
                    . 'descárgalo y súbelo aquí: lo leemos igual.'
                );
            }

            Response::json([
                'success' => true,
                'data' => [
                    'url' => $finalUrl,
                    'tipo' => 'texto',
                    'texto' => $texto,
                    'caracteres' => strlen($texto),
                ],
            ], 200);
        }));

        $router->register('POST', '/v1/cv-ats/generar-adaptado', self::respond(static function (Request $request): void {
            $user = AuthMiddleware::requireUser($request);
            $userId = (string) $user['id'];

            $payload = $request->json();

            if (!is_array($payload)) {
                throw new \InvalidArgumentException('El cuerpo debe ser un objeto JSON.');
            }

            $perfil = $payload['perfil'] ?? null;
            $oferta = $payload['oferta'] ?? null;
            $brecha = $payload['brecha'] ?? null;
            $operacion = isset($payload['operacion']) ? trim((string) $payload['operacion']) : '';

            $tieneDatos = is_array($perfil) && $perfil !== []
                && is_array($oferta) && $oferta !== []
                && is_array($brecha) && $brecha !== [];

            // With the operation id the server reads the REAL data back from
            // atscv_analyses (the report the person paid for), so the
            // document is built from the stored analysis and not from
            // whatever the browser sends back. Without it, the payload is
            // still accepted for the callers that do not keep the id.
            if ($operacion === '' && !$tieneDatos) {
                throw new \InvalidArgumentException(
                    'Necesitamos el informe de brecha (perfil, oferta y brecha) para generar el CV adaptado. '
                    . 'Vuelve al paso anterior e inténtalo de nuevo.'
                );
            }

            // The header wins over the body field: the same convention the
            // payment routes use.
            $clientKey = trim((string) (
                $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? ($payload['idempotency_key'] ?? '')
            ));

            RateLimits::enforce('atscv_generate', 'atscv:gen:user:' . $userId);

            $data = (new AtsGenerateService())->run(
                $userId,
                is_array($perfil) ? $perfil : [],
                is_array($oferta) ? $oferta : [],
                is_array($brecha) ? $brecha : [],
                (string) ($payload['plantilla'] ?? 'harvard'),
                $clientKey,
                $operacion === '' ? null : $operacion,
                isset($payload['tipo']) ? (string) $payload['tipo'] : null
            );

            Response::json(['success' => true, 'data' => $data], 200);
        }));

        $router->register('GET', '/v1/cv-ats/documentos/{id}', self::respond(static function (Request $request): void {
            $user = AuthMiddleware::requireUser($request);
            $userId = (string) $user['id'];

            $documentId = trim((string) ($request->param('id') ?? ''));

            if ($documentId === '' || preg_match('/^[a-f0-9-]{36}$/i', $documentId) !== 1) {
                self::notFound();
            }

            // OWNER RULE: the row must belong to the caller. A file of
            // somebody else answers 404 — the same answer as a file that does
            // not exist, so nothing is revealed.
            $document = (new AtsRepository())->findDocumentForOwner($documentId, $userId);

            if ($document === null) {
                self::notFound();
            }

            try {
                $bytes = (new LocalStorage())->get((string) $document['storage_key']);
            } catch (\Throwable $e) {
                AppLog::warning('atscv', 'stored document is missing', [
                    'document_id' => $documentId,
                    'error' => $e->getMessage(),
                ]);

                self::notFound('El archivo ya no está disponible. Genera el CV adaptado de nuevo y lo tendremos listo enseguida.');
            }

            $filename = self::safeFilename((string) ($document['filename'] ?? 'documento'));

            header('Content-Disposition: attachment; filename="' . $filename . '"');
            Response::binary($bytes, (string) ($document['mime'] ?? 'application/octet-stream'));
        }));
    }

    /**
     * The 404 of this module: the same envelope, a warm message.
     */
    private static function notFound(string $message = 'No encontramos ese archivo.'): void
    {
        Response::json([
            'success' => false,
            'error' => [
                'code' => 'NOT_FOUND',
                'message' => $message,
            ],
        ], 404);
    }

    /**
     * A file name safe to put in a Content-Disposition header.
     */
    private static function safeFilename(string $filename): string
    {
        $clean = preg_replace('/[^A-Za-z0-9._-]/', '-', $filename) ?? 'documento';
        $clean = ltrim($clean, '.');

        return $clean === '' ? 'documento' : mb_substr($clean, 0, 200);
    }

    /**
     * Is the downloaded body a file we can hand over as-is?
     *
     * The magic bytes decide, not the extension: a link that says .pdf but
     * serves HTML is HTML, and a link that serves a PDF without saying so
     * is still a PDF.
     *
     * @return array{nombre: string, mime: string}|null
     */
    private static function detectarArchivo(string $cuerpo, string $url): ?array
    {
        if ($cuerpo === '') {
            return null;
        }

        $nombre = basename((string) parse_url($url, PHP_URL_PATH));
        $nombre = $nombre === '' ? 'documento' : rawurldecode($nombre);

        // PDF
        if (str_starts_with($cuerpo, '%PDF-')) {
            return [
                'nombre' => str_ends_with(strtolower($nombre), '.pdf') ? $nombre : $nombre . '.pdf',
                'mime' => 'application/pdf',
            ];
        }

        // Word 2007+ (a docx is a zip)
        if (str_starts_with($cuerpo, "PK\x03\x04")) {
            if (str_ends_with(strtolower($nombre), '.docx')) {
                return ['nombre' => $nombre, 'mime' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
            }

            if (str_ends_with(strtolower($nombre), '.zip')) {
                return ['nombre' => $nombre, 'mime' => 'application/zip'];
            }

            return [
                'nombre' => $nombre . '.docx',
                'mime' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ];
        }

        // Word 97-2003 (OLE2 compound file)
        if (str_starts_with($cuerpo, "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1")) {
            return [
                'nombre' => str_ends_with(strtolower($nombre), '.doc') ? $nombre : $nombre . '.doc',
                'mime' => 'application/msword',
            ];
        }

        return null;
    }

    /**
     * Same exception→JSON mapping as the platform's $respond wrapper (this
     * module ships standalone, so it carries its own copy; keep both in sync
     * with public/index.php when new exception kinds appear). Mapping ORDER
     * matters: specific kinds first, Throwable last.
     */
    private static function respond(callable $handler): callable
    {
        return static function (Request $request) use ($handler): void {
            try {
                $handler($request);
            } catch (UnauthorizedException $e) {
                Response::json(['success' => false, 'error' => ['code' => 'UNAUTHORIZED', 'message' => $e->getMessage()]], 401);
            } catch (ForbiddenException $e) {
                Response::json(['success' => false, 'error' => ['code' => 'FORBIDDEN', 'message' => $e->getMessage()]], 403);
            } catch (EmailVerificationRequiredException $e) {
                // The re-verification gate closes before the ledger row, so
                // nothing was charged when this arrives.
                Response::json(['success' => false, 'error' => ['code' => 'EMAIL_REVERIFY_REQUIRED', 'message' => $e->getMessage()]], 403);
            } catch (InsufficientCreditsException $e) {
                // The balance travels with the error: the front can show
                // exactly how much is missing without a second request.
                Response::json([
                    'success' => false,
                    'error' => [
                        'code' => 'INSUFFICIENT_CREDITS',
                        'message' => $e->getMessage(),
                        'balance' => $e->balance,
                    ],
                ], 402);
            } catch (RateLimitException $e) {
                // The platform's generic copy talks about "messages"; here
                // the limit is about links read and reports made. Say it in
                // the language of this product, without blaming the person.
                Response::json([
                    'success' => false,
                    'error' => [
                        'code' => 'RATE_LIMITED',
                        'message' => 'Hemos puesto un límite por hora para que el servicio siga siendo rápido para todos. '
                            . 'Espera un poco y vuelve a intentarlo: lo que ya cargaste se queda donde está.',
                    ],
                ], 429);
            } catch (BrainException $e) {
                AppLog::error('atscv', 'brain failed', ['error' => $e->getMessage()]);
                // Same empathetic contract as the platform chat: no charge, no scare.
                Response::json([
                    'success' => false,
                    'error' => [
                        'code' => 'BRAIN_UNAVAILABLE',
                        'message' => 'No pudimos generar la respuesta en este momento. Lo siento, la inteligencia artificial '
                            . 'no pudo procesar tu información ahora. Por favor, inténtalo nuevamente en unos minutos. '
                            . 'No se te cobró nada por este intento.',
                    ],
                ], 502);
            } catch (UrlAnalyzerException $e) {
                // The URL is the person's input: say what is wrong with it
                // in plain words, without blaming them for it.
                Response::json([
                    'success' => false,
                    'error' => ['code' => 'URL_INVALID', 'message' => $e->getMessage()],
                ], 400);
            } catch (\RuntimeException $e) {
                // The page loaded but had nothing to read (a PDF link, a page
                // built with JavaScript, a wall of cookies). The way out is
                // the PDF or the pasted text.
                Response::json([
                    'success' => false,
                    'error' => ['code' => 'OFFER_UNREADABLE', 'message' => $e->getMessage()],
                ], 502);
            } catch (\InvalidArgumentException $e) {
                Response::json(['success' => false, 'error' => ['code' => 'VALIDATION_ERROR', 'message' => $e->getMessage()]], 400);
            } catch (\Throwable $e) {
                AppLog::error('atscv', 'request failed', ['error' => $e->getMessage()]);
                Response::json([
                    'success' => false,
                    'error' => [
                        'code' => 'SERVER_ERROR',
                        'message' => 'No pudimos completar tu solicitud en este momento. '
                            . 'Lo siento, estamos experimentando una interrupción temporal. '
                            . 'Por favor, inténtalo nuevamente en unos minutos.',
                    ],
                ], 500);
            }
        };
    }
}
