<?php
declare(strict_types=1);

namespace App\Heart\Ats;

/**
 * The catalogue the panel shows BEFORE the person generates anything.
 *
 * WHY a catalogue instead of constants scattered in the service: the browser
 * renders the picker from this data, so the panel and the API can never
 * disagree about which document types and templates exist, what they are
 * called or what they cost. One source, one truth.
 *
 * Two dimensions:
 *   - TIPO     = WHAT the document does (cover the gaps / enhance the
 *                experiences). It changes the PROMPT the model receives.
 *   - PLANTILLA = HOW the document looks (five ATS-safe single column
 *                layouts). It changes the section order and headings.
 */
final class AtsCatalog
{
    /** The CV keeps the original and adds what the ATS filter asked for. */
    public const TIPO_BRECHAS = 'brechas';

    /** The experiences are rewritten to answer what the recruiter asked. */
    public const TIPO_POTENCIADO = 'potenciado';

    /** The highest score a generated document may claim. */
    public const MAX_MATCH_SCORE = 97;

    /**
     * The document types, in the order the panel shows them.
     *
     * @return list<array{id: string, nombre: string, descripcion: string, creditos: int}>
     */
    public static function tipos(): array
    {
        return [
            [
                'id' => self::TIPO_BRECHAS,
                'nombre' => 'CV con brechas cubiertas',
                'descripcion' => 'Mantiene tu CV original y suma lo que el filtro ATS busca: '
                    . 'las palabras clave y habilidades que te faltaban, sin inventar experiencia.',
                'creditos' => 3,
            ],
            [
                'id' => self::TIPO_POTENCIADO,
                'nombre' => 'CV potenciado',
                'descripcion' => 'Reescribe tus descripciones de experiencia para que destaquen '
                    . 'lo que el reclutador pide. El texto suena humano, nunca automático, '
                    . 'y el resultado no declara un 100%.',
                'creditos' => 3,
            ],
        ];
    }

    /**
     * The five templates, in the order the panel shows them.
     *
     * Every one of them is single column, with standard headings and no
     * tables or graphics: that is what an ATS filter can actually read.
     *
     * The section order and the headings travel WITH the catalogue: the
     * panel paints the preview with exactly the same structure the document
     * will have, so the preview can never promise a layout the generator
     * does not build.
     *
     * @return list<array{id: string, nombre: string, descripcion: string, secciones: list<string>, titulos: array<string, string>}>
     */
    public static function plantillas(): array
    {
        $layouts = self::layouts();
        $descripciones = [
            'harvard' => 'Resumen profesional primero, luego habilidades, experiencia y educación.',
            'simple' => 'Cronológico y directo: experiencia, educación, habilidades y resumen.',
            'habilidades' => 'Habilidades y certificaciones arriba: para cuando el filtro ordena por palabras clave.',
            'ejecutivo' => 'Perfil y alcance primero, experiencia con logros, luego lo demás.',
            'compacto' => 'Una página al grano, para ofertas que piden muchos requisitos.',
        ];
        $nombres = [
            'harvard' => 'Harvard',
            'simple' => 'Simple',
            'habilidades' => 'Por habilidades',
            'ejecutivo' => 'Ejecutivo',
            'compacto' => 'Compacto',
        ];

        $catalogo = [];

        foreach ($layouts as $id => $layout) {
            $catalogo[] = [
                'id' => $id,
                'nombre' => $nombres[$id] ?? $id,
                'descripcion' => $descripciones[$id] ?? '',
                'secciones' => $layout['orden'],
                'titulos' => $layout['titulos'],
            ];
        }

        return $catalogo;
    }

    /**
     * The section order and the headings of one template.
     *
     * @return array{orden: list<string>, titulos: array<string, string>}
     */
    public static function layout(string $plantilla): array
    {
        $layouts = self::layouts();

        return $layouts[$plantilla] ?? $layouts['harvard'];
    }

    /**
     * Every layout, by template id.
     *
     * ONE map: the generator builds the document with it and the catalogue
     * publishes it. If they lived apart, the preview would promise a
     * structure the document does not have.
     *
     * @return array<string, array{orden: list<string>, titulos: array<string, string>}>
     */
    private static function layouts(): array
    {
        return [
            'harvard' => [
                'orden' => ['resumen', 'habilidades', 'experiencia', 'educacion'],
                'titulos' => [
                    'resumen' => 'Resumen profesional',
                    'habilidades' => 'Habilidades técnicas',
                    'experiencia' => 'Experiencia',
                    'educacion' => 'Educación',
                ],
            ],
            'simple' => [
                'orden' => ['experiencia', 'educacion', 'habilidades', 'resumen'],
                'titulos' => [
                    'resumen' => 'Resumen profesional',
                    'habilidades' => 'Habilidades técnicas',
                    'experiencia' => 'Experiencia',
                    'educacion' => 'Educación',
                ],
            ],
            'habilidades' => [
                'orden' => ['habilidades', 'experiencia', 'educacion', 'resumen'],
                'titulos' => [
                    'resumen' => 'Perfil',
                    'habilidades' => 'Habilidades y certificaciones',
                    'experiencia' => 'Experiencia',
                    'educacion' => 'Educación',
                ],
            ],
            'ejecutivo' => [
                'orden' => ['resumen', 'experiencia', 'habilidades', 'educacion'],
                'titulos' => [
                    'resumen' => 'Perfil profesional',
                    'habilidades' => 'Habilidades clave',
                    'experiencia' => 'Experiencia y logros',
                    'educacion' => 'Formación',
                ],
            ],
            'compacto' => [
                'orden' => ['resumen', 'experiencia', 'habilidades', 'educacion'],
                'titulos' => [
                    'resumen' => 'Resumen',
                    'habilidades' => 'Habilidades',
                    'experiencia' => 'Experiencia',
                    'educacion' => 'Educación',
                ],
            ],
        ];
    }

    public static function esTipo(string $tipo): bool
    {
        foreach (self::tipos() as $item) {
            if ($item['id'] === $tipo) {
                return true;
            }
        }

        return false;
    }

    public static function esPlantilla(string $plantilla): bool
    {
        foreach (self::plantillas() as $item) {
            if ($item['id'] === $plantilla) {
                return true;
            }
        }

        return false;
    }

    /**
     * The default type: covering the gaps is the honest first step.
     */
    public static function tipoPorDefecto(): string
    {
        return self::TIPO_BRECHAS;
    }
}
