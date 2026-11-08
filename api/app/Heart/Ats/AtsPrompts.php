<?php
declare(strict_types=1);

namespace App\Heart\Ats;

/**
 * The four brain prompts of the CV ATS Match product (atscv).
 *
 * They are transcribed from the product spec (03_PROMPTS_3_LLAMADAS.md):
 * the prompt ids, the JSON schemas and the "no inventes" rules ARE the
 * product contract, so changing a line here is a product decision, not a
 * refactor.
 *
 * WHY FOUR CALLS AND NOT ONE: the profile is extracted from the CV alone and
 * the offer from the offer alone. Mixing both texts in a single call lets the
 * model contaminate the profile with the offer's requirements (it "learns"
 * SAP EWM because the offer asked for it, and the gap report then reports a
 * skill the person never had). The comparison is a third call over the two
 * already-validated JSON objects; the paid stage is the fourth call.
 */
final class AtsPrompts
{
    /** Prompt id of call 1 (profile extraction). */
    public const PROMPT_EXTRACT_PERFIL = 'system_cv_extract_perfil_v1';

    /** Prompt id of call 2 (offer extraction). */
    public const PROMPT_EXTRACT_OFERTA = 'system_cv_extract_oferta_v1';

    /** Prompt id of call 3 (gap comparison). */
    public const PROMPT_COMPARA = 'system_cv_compara_v1';

    /** Prompt id of call 4 (adapted CV + cover letter). */
    public const PROMPT_GENERA_ADAPTADO = 'system_cv_genera_adaptado_v1';

    /**
     * Call 1 — system prompt: the profile schema and the honesty rule.
     */
    public static function extractPerfilSystemPrompt(): string
    {
        return 'Eres extractor de CV. Solo recibes CV_TEXTO. Devuelve JSON válido sin texto extra.' . "\n"
            . "\n"
            . "Schema:\n"
            . "{\n"
            . '  "nombre": "string",' . "\n"
            . '  "cargo_actual": "string",' . "\n"
            . '  "años_experiencia": 5,' . "\n"
            . '  "skills_tecnicas": ["SAP", "Excel"],' . "\n"
            . '  "skills_blandas": [],' . "\n"
            . '  "experiencias": [{"cargo": "", "empresa": "", "fechas": "", "logros": []}],' . "\n"
            . '  "educacion": [],' . "\n"
            . '  "logros_cuantificables": []' . "\n"
            . "}\n"
            . "\n"
            . "Regla: No inventes. Si no hay dato, deja vacío. Extrae logros con números si existen.";
    }

    /**
     * Call 1 — user prompt: the CV text, exactly as the user sent it.
     */
    public static function extractPerfilUserPrompt(string $cvTexto): string
    {
        return 'CV_TEXTO=' . $cvTexto;
    }

    /**
     * Call 2 — system prompt: the offer schema and the ATS keyword rule.
     */
    public static function extractOfertaSystemPrompt(): string
    {
        return 'Eres extractor de ofertas laborales Chile. Solo recibes OFERTA_TEXTO '
            . '(puede venir de pantallazo con OCR con errores). Devuelve JSON válido.' . "\n"
            . "\n"
            . "Schema:\n"
            . "{\n"
            . '  "cargo_oferta": "string",' . "\n"
            . '  "empresa": "string o null",' . "\n"
            . '  "requisitos_obligatorios": ["Licencia D", "SAP EWM"],' . "\n"
            . '  "requisitos_deseables": [],' . "\n"
            . '  "keywords_ats": ["WMS", "Power BI", "Inventario"],' . "\n"
            . '  "herramientas": ["SAP", "Excel Avanzado"],' . "\n"
            . '  "funciones_principales": [],' . "\n"
            . '  "tipo_contrato": ""' . "\n"
            . "}\n"
            . "\n"
            . 'Regla: keywords_ats = todas las palabras técnicas que un ATS buscaría. '
            . 'Separa obligatorios de deseables. No inventes.';
    }

    /**
     * Call 2 — user prompt: the offer text (OCR included, errors and all).
     */
    public static function extractOfertaUserPrompt(string $ofertaTexto): string
    {
        return 'OFERTA_TEXTO=' . $ofertaTexto;
    }

    /**
     * Call 3 — system prompt: the gap schema and the honesty rule.
     */
    public static function comparaSystemPrompt(): string
    {
        return 'Eres auditor ATS. Recibes PERFIL_JSON y OFERTA_JSON. Compara. Devuelve JSON.' . "\n"
            . "\n"
            . "Schema:\n"
            . "{\n"
            . '  "match_score": 0-100,' . "\n"
            . '  "keywords_faltantes": ["SAP EWM", "Licencia D"],' . "\n"
            . '  "keywords_presentes": ["WMS"],' . "\n"
            . '  "fortalezas": ["Cumples con 3 años experiencia"],' . "\n"
            . '  "debilidades": ["Te falta herramienta obligatoria X"],' . "\n"
            . '  "porque_te_rechazaria_ats": "Texto de 2 líneas duro",' . "\n"
            . '  "que_cambiar_para_pasar": ["Agregar keyword X en experiencia", "Cuantificar logro Y"],' . "\n"
            . '  "informe_markdown": "## Match 48%\nTu CV dice... La oferta pide...\n### Te faltan...\n..."' . "\n"
            . "}\n"
            . "\n"
            . 'Regla: Nunca agregues al perfil skills que no tiene. Sé honesto. '
            . 'El informe_markdown es lo que verá el usuario B2C, lenguaje simple chileno.';
    }

    /**
     * Call 3 — user prompt: the two already-validated JSON objects.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $oferta
     */
    public static function comparaUserPrompt(array $perfil, array $oferta): string
    {
        return 'PERFIL_JSON=' . self::encode($perfil) . "\n"
            . 'OFERTA_JSON=' . self::encode($oferta);
    }

    /**
     * Call 4 — system prompt: the adapted CV contract and the "no lie" rules.
     */
    public static function generaAdaptadoSystemPrompt(string $tipo = AtsCatalog::TIPO_BRECHAS): string
    {
        return 'Eres reescritor CV ATS. Recibes PERFIL, OFERTA, BRECHA. '
            . 'Reescribe CV para maximizar match sin mentir.' . "\n"
            . "\n"
            . "Reglas:\n"
            . "- Usa solo experiencia real del PERFIL.\n"
            . '- Reordena y reescribe logros usando keywords de OFERTA que SÍ tiene el usuario. '
            . 'Si keyword faltante es herramienta que no tiene, NO la inventes en experiencia, '
            . 'ponla como "Conocimiento en..." en habilidades si es creíble, o ignórala.' . "\n"
            . self::reglasDelTipo($tipo)
            . "\n"
            . "Formato salida JSON:\n"
            . "{\n"
            . '  "cv_secciones": {' . "\n"
            . '    "resumen_profesional": "Texto 3 líneas adaptado a oferta...",' . "\n"
            . '    "experiencia": [{"cargo": "", "empresa": "", "fechas": "MM/AAAA - MM/AAAA", '
            . '"bullets": ["Gestioné ... con SAP EWM reduciendo..."]}],' . "\n"
            . '    "habilidades_tecnicas": [],' . "\n"
            . '    "educacion": []' . "\n"
            . '  },' . "\n"
            . '  "carta_presentacion": "Estimados... Vi su oferta para X... Cumplo con...",' . "\n"
            . '  "nuevo_match_estimado": 92' . "\n"
            . "}\n"
            . "\n"
            . "Fechas formato MM/AAAA. Sin tablas, sin emojis. Verbos acción.";
    }

    /**
     * The rules of ONE document type.
     *
     * The type is what the panel lets the person choose before generating:
     * covering the gaps (the honest first step) or enhancing the
     * experiences. The enhanced version must read like a person wrote it
     * and must never claim a perfect score — a 100% reads as automated and
     * invites the suspicion of a fabricated CV.
     */
    private static function reglasDelTipo(string $tipo): string
    {
        if ($tipo === AtsCatalog::TIPO_POTENCIADO) {
            return '- ESTILO: Escribes como una persona, no como una plantilla: frases de largos distintos, '
                . 'sin repetir la misma estructura en cada línea, sin coletillas de IA ("destacando", '
                . '"comenzando un nuevo capítulo"). Nada de emojis ni de superlativos vacíos.' . "\n"
                . '- ALCANCE: Potencias la DESCRIPCIÓN de lo que la persona ya hizo (alcance, volumen, '
                . 'contexto, resultado). NO inventas empresas, cargos, fechas, estudios ni herramientas '
                . 'que no están en PERFIL.' . "\n"
                . '- COBERTURA: No cubres el 100% de los requisitos. Lo que la persona no ha hecho no se '
                . 'incluye. El nuevo match nunca es 100%.' . "\n";
        }

        return '- ALCANCE: Cubres las brechas del INFORME —las keywords y habilidades que el ATS busca y '
            . 'el CV no tenía— con lo que la persona YA tiene, o lo declaras como "Conocimiento en..." '
            . 'cuando es creíble. No agregas experiencia que no existe.' . "\n"
            . '- COBERTURA: El nuevo match nunca es 100%.' . "\n";
    }

    /**
     * Call 4 — user prompt: profile, offer and gap, as the browser sent them.
     *
     * @param array<string, mixed> $perfil
     * @param array<string, mixed> $oferta
     * @param array<string, mixed> $brecha
     */
    public static function generaAdaptadoUserPrompt(array $perfil, array $oferta, array $brecha): string
    {
        return 'PERFIL=' . self::encode($perfil) . "\n"
            . 'OFERTA=' . self::encode($oferta) . "\n"
            . 'BRECHA=' . self::encode($brecha);
    }

    /**
     * @param array<string, mixed> $data
     */
    private static function encode(array $data): string
    {
        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        return $json === false ? '{}' : $json;
    }
}
