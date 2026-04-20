import {
  InternalServerErrorException,
  Injectable,
  Logger,
  RequestTimeoutException,
} from '@nestjs/common';
import { SchemaGraph } from '../../../domain/models/schema.types';
import {
  ContextPoolDictionary,
  ILanguageModelProvider,
} from '../../../domain/ports/language-model-provider.port';

interface OllamaGenerateResponse {
  response?: string;
}

class LlmResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmResponseParseError';
  }
}

@Injectable()
export class OllamaAdapter implements ILanguageModelProvider {
  private readonly logger = new Logger(OllamaAdapter.name);
  private readonly endpoint =
    process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/api/generate';
  private readonly model = process.env.OLLAMA_MODEL ?? 'phi4-mini';
  private readonly timeoutMs = this.resolveTimeoutMs();

  async generateContextPools(
    schema: SchemaGraph,
    region: string,
  ): Promise<ContextPoolDictionary> {
    try {
      const firstAttemptRaw = await this.requestToOllama(
        this.buildPrompt(schema, region),
        this.buildSystemPrompt(region),
        'initial',
      );

      try {
        return this.parseAndValidateLLMResponse(firstAttemptRaw);
      } catch (parseError: unknown) {
        if (!(parseError instanceof LlmResponseParseError)) {
          throw parseError;
        }

        this.logger.warn(
          `Respuesta inicial malformada. Se ejecuta 1 reintento de formateo. Motivo: ${parseError.message}`,
        );

        const retryPrompt = this.buildRetryPrompt(schema, firstAttemptRaw, region);
        const retryRaw = await this.requestToOllama(
          retryPrompt,
          this.buildSystemPrompt(region),
          'retry',
        );

        try {
          return this.parseAndValidateLLMResponse(retryRaw);
        } catch (retryParseError: unknown) {
          if (retryParseError instanceof LlmResponseParseError) {
            this.logger.error(
              `El reintento tambien fallo al parsear la respuesta del modelo: ${retryParseError.message}`,
              retryParseError.stack,
            );
            throw new InternalServerErrorException(
              'No fue posible obtener un arreglo JSON valido desde el modelo despues del reintento.',
            );
          }

          throw retryParseError;
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RequestTimeoutException(
          'Tiempo de espera agotado al consultar Ollama.',
        );
      }

      if (
        error instanceof InternalServerErrorException ||
        error instanceof RequestTimeoutException
      ) {
        throw error;
      }

      throw new InternalServerErrorException(
        `No fue posible generar semillas con Ollama: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async requestToOllama(
    prompt: string,
    systemPrompt: string,
    phase: 'initial' | 'retry',
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      this.logger.log(
        `[${phase}] Iniciando peticion a Ollama (${this.model}). Prompt: ${this.summarizePrompt(prompt)}`,
      );

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: 'json',
          system: systemPrompt,
          prompt,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new InternalServerErrorException(
          `Ollama devolvio HTTP ${response.status}. Detalle: ${detail || 'sin detalle'}`,
        );
      }

      const data = (await response.json()) as OllamaGenerateResponse;
      if (typeof data.response !== 'string') {
        throw new InternalServerErrorException(
          'Ollama no devolvio el campo response esperado.',
        );
      }

      this.logger.debug(`[${phase}] RAW Ollama response: ${data.response}`);

      return data.response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private resolveTimeoutMs(): number {
    const configured = Number(process.env.OLLAMA_TIMEOUT_MS ?? '120000');
    if (Number.isFinite(configured) && configured >= 120000) {
      return configured;
    }

    return 120000;
  }

  private buildSystemPrompt(region: string): string {
    return [
      'Actua como un analista de datos.',
      'Debes devolver exclusivamente un objeto JSON valido.',
      'No uses markdown, no saludes, no expliques.',
      'No inventes categorias para columnas que no existen en el esquema.',
      `Region objetivo: ${region}.`,
    ].join('\n');
  }

  private buildPrompt(schema: SchemaGraph, region: string): string {
    const esquemaParseado = this.buildSchemaParseado(schema);

    return [
      `Actua como un analista de datos. Revisa este esquema SQL:`,
      esquemaParseado,
      `Basado en las columnas reales, identifica que categorias de datos semanticos necesitas (por ejemplo, si ves ciudad necesitas un array de ciudades; si ves razon_social necesitas un array de empresas).`,
      `Genera un diccionario JSON con arreglos de 15 ejemplos altamente realistas para la region: ${region}.`,
      'No inventes categorias para columnas que no existen.',
      '',
      'EJEMPLO ESPERADO:',
      '{',
      '  "nombres_personas": ["Carlos Perez", "Ana Gomez", "Luis Rojas"],',
      '  "nombres_empresas": ["Tech Corp", "Logistica Sur", "AgroAndes"],',
      '  "ciudades": ["Santa Cruz", "Lima", "Bogota"],',
      '  "categorias_productos": ["Electronica", "Abarrotes", "Ferreteria"]',
      '}',
    ].join('\n');
  }

  private buildSchemaParseado(schema: SchemaGraph): string {
    const lines = schema.tables.map((table) => {
      const columns = table.columns
        .map((column) => {
          const columnName = column.name?.trim();
          if (!columnName) {
            return null;
          }

          const dataType = column.dataType?.trim().toUpperCase() ?? 'UNKNOWN';
          return `${columnName} (${dataType})`;
        })
        .filter((columnSummary): columnSummary is string =>
          Boolean(columnSummary),
        );

      const columnsSummary =
        columns.length > 0 ? columns.join(', ') : '(sin columnas detectadas)';

      return `- ${table.name}: ${columnsSummary}`;
    });

    if (lines.length === 0) {
      return '- (sin tablas detectadas)';
    }

    return lines.join('\n');
  }

  private buildRetryPrompt(
    schema: SchemaGraph,
    invalidResponse: string,
    region: string,
  ): string {
    return [
      'Tu salida anterior no fue parseable como objeto JSON valido.',
      'Corrige el formato y responde nuevamente.',
      'Responde SOLO con un objeto JSON valido con valores string[].',
      'No uses markdown. No agregues texto antes ni despues.',
      'Salida invalida previa:',
      invalidResponse,
      'Repite el esquema de tablas/columnas en tu generacion:',
      this.buildPrompt(schema, region),
    ].join('\n');
  }

  private parseAndValidateLLMResponse(text: string): ContextPoolDictionary {
    const jsonObjectText = this.extractJsonObjectText(text);
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonObjectText);
    } catch (error: unknown) {
      this.logger.warn(
        `Fallo JSON.parse() de la respuesta del LLM. Motivo: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new LlmResponseParseError(
        'El contenido no pudo convertirse a JSON.',
      );
    }

    if (!this.isPlainObject(parsed)) {
      this.logger.warn('El contenido parseado existe, pero no es un objeto JSON.');
      throw new LlmResponseParseError(
        'La respuesta no contiene un objeto JSON valido.',
      );
    }

    const contextPools = this.normalizeContextPools(parsed);

    if (Object.keys(contextPools).length === 0) {
      this.logger.warn(
        'La respuesta del LLM no incluyo categorias validas con valores string[].',
      );
      throw new LlmResponseParseError(
        'No se encontraron categorias validas en el diccionario JSON.',
      );
    }

    return contextPools;
  }

  private normalizeContextPools(rawObject: Record<string, unknown>): ContextPoolDictionary {
    const normalized: ContextPoolDictionary = {};

    for (const [rawKey, rawValue] of Object.entries(rawObject)) {
      const key = rawKey.trim();
      if (!key) {
        continue;
      }

      if (!Array.isArray(rawValue)) {
        this.logger.warn(
          `Categoria ignorada porque no es arreglo: ${rawKey}`,
        );
        continue;
      }

      if (!rawValue.every((entry) => typeof entry === 'string')) {
        this.logger.warn(
          `Categoria ignorada porque contiene valores no-string: ${rawKey}`,
        );
        continue;
      }

      const values = rawValue
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      if (values.length === 0) {
        this.logger.warn(
          `Categoria ignorada porque no contiene strings validos: ${rawKey}`,
        );
        continue;
      }

      normalized[key] = values;
    }

    return normalized;
  }

  private extractJsonObjectText(text: string): string {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch && typeof jsonMatch[0] === 'string') {
      return jsonMatch[0];
    }

    const firstBraceIndex = text.indexOf('{');
    const lastBraceIndex = text.lastIndexOf('}');
    if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
      return text.substring(firstBraceIndex, lastBraceIndex + 1);
    }

    this.logger.warn(
      'Fallo extraccion por regex/indices: no se encontro bloque JSON de objeto en la respuesta del LLM.',
    );

    throw new LlmResponseParseError(
      'No se encontro un objeto JSON valido en la respuesta del modelo.',
    );
  }

  private summarizePrompt(prompt: string): string {
    const max = 900;
    if (prompt.length <= max) {
      return prompt;
    }

    return `${prompt.slice(0, max)}... [truncated ${prompt.length - max} chars]`;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
