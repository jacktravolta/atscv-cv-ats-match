<?php
declare(strict_types=1);

namespace App\Heart\Ats;

/**
 * Reads the brain's answers back into the shapes the platform stores and the
 * front renders.
 *
 * Two jobs:
 *   1. SALVAGE — the model answers with prose around the JSON ("Aquí tienes
 *      el análisis: ```{...}```"). We take the outermost object and decode it.
 *      Same behaviour as PromptCotizacion::salvageJson, so the platform has
 *      ONE way of reading a model answer.
 *   2. NORMALIZE — the model is not a schema validator. "años_experiencia"
 *      may arrive as 5, "5", "5 años" or null; "match_score" as 48, "48" or
 *      "48%". The normalizers coerce defensively so a slightly off answer
 *      never breaks the report, and a missing field never reaches the front
 *      as a type error.
 */
final class AtsJson
{
    /**
     * Pull the JSON object out of a model answer.
     *
     * @return array<string, mixed>|null Null when the answer holds no usable object.
     */
    public static function salvage(string $answer): ?array
    {
        $text = trim($answer);

        if ($text === '') {
            return null;
        }

        // A fenced block first: the most common shape.
        if (preg_match('/```(?:json)?\s*(\{.*?\})\s*```/is', $text, $matches) === 1) {
            $decoded = self::decodeObject($matches[1]);
            if ($decoded !== null) {
                return $decoded;
            }
        }

        // Otherwise the outermost braces of the answer.
        $start = strpos($text, '{');
        $end = strrpos($text, '}');

        if ($start === false || $end === false || $end <= $start) {
            return null;
        }

        return self::decodeObject(substr($text, $start, $end - $start + 1));
    }

    /**
     * The profile of the CV (call 1).
     *
     * @param array<string, mixed> $raw
     * @return array<string, mixed>
     */
    public static function perfil(array $raw): array
    {
        $experiencias = [];

        foreach (self::listOf($raw['experiencias'] ?? null) as $item) {
            if (!is_array($item)) {
                continue;
            }

            $experiencias[] = [
                'cargo' => self::text($item['cargo'] ?? ''),
                'empresa' => self::text($item['empresa'] ?? ''),
                'fechas' => self::text($item['fechas'] ?? ''),
                'logros' => self::textList($item['logros'] ?? []),
            ];
        }

        return [
            'nombre' => self::text($raw['nombre'] ?? ''),
            'cargo_actual' => self::text($raw['cargo_actual'] ?? ''),
            'años_experiencia' => self::years($raw['años_experiencia'] ?? ($raw['anos_experiencia'] ?? null)),
            'skills_tecnicas' => self::textList($raw['skills_tecnicas'] ?? []),
            'skills_blandas' => self::textList($raw['skills_blandas'] ?? []),
            'experiencias' => $experiencias,
            'educacion' => self::textList($raw['educacion'] ?? []),
            'logros_cuantificables' => self::textList($raw['logros_cuantificables'] ?? []),
        ];
    }

    /**
     * The offer (call 2).
     *
     * @param array<string, mixed> $raw
     * @return array<string, mixed>
     */
    public static function oferta(array $raw): array
    {
        $empresa = $raw['empresa'] ?? null;
        $empresa = is_string($empresa) && trim($empresa) !== '' ? trim($empresa) : null;

        return [
            'cargo_oferta' => self::text($raw['cargo_oferta'] ?? ''),
            'empresa' => $empresa,
            'requisitos_obligatorios' => self::textList($raw['requisitos_obligatorios'] ?? []),
            'requisitos_deseables' => self::textList($raw['requisitos_deseables'] ?? []),
            'keywords_ats' => self::textList($raw['keywords_ats'] ?? []),
            'herramientas' => self::textList($raw['herramientas'] ?? []),
            'funciones_principales' => self::textList($raw['funciones_principales'] ?? []),
            'tipo_contrato' => self::text($raw['tipo_contrato'] ?? ''),
        ];
    }

    /**
     * The gap report (call 3).
     *
     * @param array<string, mixed> $raw
     * @return array<string, mixed>
     */
    public static function brecha(array $raw): array
    {
        return [
            'match_score' => self::score($raw['match_score'] ?? null),
            'keywords_faltantes' => self::textList($raw['keywords_faltantes'] ?? []),
            'keywords_presentes' => self::textList($raw['keywords_presentes'] ?? []),
            'fortalezas' => self::textList($raw['fortalezas'] ?? []),
            'debilidades' => self::textList($raw['debilidades'] ?? []),
            'porque_te_rechazaria_ats' => self::text($raw['porque_te_rechazaria_ats'] ?? ''),
            'que_cambiar_para_pasar' => self::textList($raw['que_cambiar_para_pasar'] ?? []),
            'informe_markdown' => self::text($raw['informe_markdown'] ?? ''),
        ];
    }

    /**
     * The adapted CV + cover letter (call 4).
     *
     * @param array<string, mixed> $raw
     * @return array<string, mixed>
     */
    public static function adaptado(array $raw): array
    {
        $secciones = $raw['cv_secciones'] ?? [];
        $secciones = is_array($secciones) ? $secciones : [];

        $experiencia = [];

        foreach (self::listOf($secciones['experiencia'] ?? null) as $item) {
            if (!is_array($item)) {
                continue;
            }

            $experiencia[] = [
                'cargo' => self::text($item['cargo'] ?? ''),
                'empresa' => self::text($item['empresa'] ?? ''),
                'fechas' => self::text($item['fechas'] ?? ''),
                'bullets' => self::textList($item['bullets'] ?? ($item['logros'] ?? [])),
            ];
        }

        return [
            'cv_secciones' => [
                'resumen_profesional' => self::text($secciones['resumen_profesional'] ?? ''),
                'experiencia' => $experiencia,
                'habilidades_tecnicas' => self::textList($secciones['habilidades_tecnicas'] ?? []),
                'educacion' => self::textList($secciones['educacion'] ?? []),
            ],
            'carta_presentacion' => self::text($raw['carta_presentacion'] ?? ''),
            'nuevo_match_estimado' => self::score($raw['nuevo_match_estimado'] ?? null),
        ];
    }

    /**
     * A plain string, trimmed. Anything that is not a scalar becomes ''.
     *
     * @param mixed $value
     */
    public static function text($value): string
    {
        if (is_string($value)) {
            return trim($value);
        }

        if (is_int($value) || is_float($value)) {
            return (string) $value;
        }

        return '';
    }

    /**
     * A list of plain strings. A missing or scalar value becomes [].
     *
     * @param mixed $value
     * @return list<string>
     */
    public static function textList($value): array
    {
        $items = self::listOf($value);
        $out = [];

        foreach ($items as $item) {
            if (is_array($item)) {
                // A nested object (e.g. an education entry) is flattened into a
                // readable line: the front renders plain strings.
                $parts = [];

                foreach ($item as $key => $part) {
                    $text = self::text($part);
                    if ($text === '') {
                        continue;
                    }
                    $parts[] = $text;
                }

                if ($parts !== []) {
                    $out[] = implode(' · ', $parts);
                }

                continue;
            }

            $text = self::text($item);

            if ($text !== '') {
                $out[] = $text;
            }
        }

        return $out;
    }

    /**
     * A percentage-like score: 48, "48", "48%" or 48.0 become 48; anything
     * else becomes 0. Always clamped to 0..100.
     *
     * @param mixed $value
     */
    public static function score($value): int
    {
        if (is_bool($value) || $value === null) {
            return 0;
        }

        if (is_int($value)) {
            return max(0, min(100, $value));
        }

        if (is_float($value)) {
            // A ratio (0.48) is a percentage the model wrote as a fraction.
            $scaled = ($value > 0.0 && $value < 1.0) ? $value * 100.0 : $value;

            return max(0, min(100, (int) round($scaled)));
        }

        if (!is_string($value)) {
            return 0;
        }

        $text = trim(str_replace('%', '', $value));

        if ($text === '' || !is_numeric($text)) {
            return 0;
        }

        $number = (float) $text;
        $scaled = ($number > 0.0 && $number < 1.0) ? $number * 100.0 : $number;

        return max(0, min(100, (int) round($scaled)));
    }

    /**
     * Years of experience: 5, "5", "5 años" or "5+ años" become 5.
     *
     * @param mixed $value
     */
    public static function years($value): int
    {
        if (is_bool($value) || $value === null) {
            return 0;
        }

        if (is_int($value)) {
            return max(0, $value);
        }

        if (is_float($value)) {
            return max(0, (int) round($value));
        }

        if (!is_string($value)) {
            return 0;
        }

        if (preg_match('/\d+/', $value, $matches) !== 1) {
            return 0;
        }

        return max(0, (int) $matches[0]);
    }

    /**
     * @param mixed $value
     * @return list<mixed>
     */
    private static function listOf($value): array
    {
        if (!is_array($value)) {
            return [];
        }

        if ($value === [] || array_is_list($value)) {
            return array_values($value);
        }

        // An object where a list was expected: keep its values, in order.
        return array_values($value);
    }

    /**
     * @return array<string, mixed>|null
     */
    private static function decodeObject(string $json): ?array
    {
        $decoded = json_decode($json, true);

        return is_array($decoded) ? $decoded : null;
    }
}
