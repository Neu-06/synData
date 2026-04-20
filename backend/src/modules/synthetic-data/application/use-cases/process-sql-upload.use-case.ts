import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  ILanguageModelProvider,
  LANGUAGE_MODEL_PROVIDER,
} from '../../domain/ports/language-model-provider.port';
import {
  ISqlSchemaExtractor,
  SqlDialect,
  SQL_SCHEMA_EXTRACTOR,
} from '../../domain/ports/sql-schema-extractor.port';
import { SyntheticPreview } from '../../domain/models/schema.types';
import { FakerGenerationService } from '../services/faker-generation.service';

export type OutputFormat = 'json' | 'sql';

export interface ProcessSqlUploadCommand {
  fileName: string;
  fileBuffer: Buffer;
  dialect: SqlDialect;
  rowCount: number;
  region: string;
  outputFormat: OutputFormat;
}

export interface ProcessSqlUploadResult {
  fileName: string;
  mimeType: string;
  content: string;
}

@Injectable()
export class ProcessSqlUploadUseCase {
  constructor(
    @Inject(SQL_SCHEMA_EXTRACTOR)
    private readonly sqlSchemaExtractor: ISqlSchemaExtractor,
    @Inject(LANGUAGE_MODEL_PROVIDER)
    private readonly languageModelProvider: ILanguageModelProvider,
    private readonly fakerGenerationService: FakerGenerationService,
  ) {}

  async execute(command: ProcessSqlUploadCommand): Promise<ProcessSqlUploadResult> {
    const sqlContent = command.fileBuffer.toString('utf-8');
    if (sqlContent.trim().length === 0) {
      throw new BadRequestException('El archivo .sql esta vacio.');
    }

    if (!Number.isInteger(command.rowCount) || command.rowCount < 1) {
      throw new BadRequestException('rowCount debe ser un entero positivo.');
    }

    const normalizedRegion = command.region.trim();
    if (normalizedRegion.length === 0) {
      throw new BadRequestException('region es obligatoria.');
    }

    const schema = await this.sqlSchemaExtractor.extractFromSql(
      sqlContent,
      command.dialect,
    );
    const contextPools = await this.languageModelProvider.generateContextPools(
      schema,
      normalizedRegion,
    );
    const generatedData = this.fakerGenerationService.generate(
      schema,
      command.rowCount,
      contextPools,
    );

    const baseName = this.fileNameWithoutExtension(command.fileName);

    if (command.outputFormat === 'sql') {
      return {
        fileName: `${baseName}_datos_generados.sql`,
        mimeType: 'application/sql; charset=utf-8',
        content: this.toSqlScript(generatedData),
      };
    }

    return {
      fileName: `${baseName}_datos_generados.json`,
      mimeType: 'application/json; charset=utf-8',
      content: JSON.stringify(generatedData, null, 2),
    };
  }

  private fileNameWithoutExtension(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
  }

  private toSqlScript(data: SyntheticPreview): string {
    const statements: string[] = [];

    for (const [tableName, rows] of Object.entries(data)) {
      if (!Array.isArray(rows) || rows.length === 0) {
        continue;
      }

      const columns = Object.keys(rows[0]);
      if (columns.length === 0) {
        continue;
      }

      for (const row of rows) {
        const values = columns.map((column) => this.toSqlValue(row[column]));
        statements.push(
          `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`,
        );
      }
    }

    return statements.join('\n');
  }

  private toSqlValue(value: unknown): string {
    if (value === null || typeof value === 'undefined') {
      return 'NULL';
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? `${value}` : 'NULL';
    }

    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }

    const escaped = String(value).replace(/'/g, "''");
    return `'${escaped}'`;
  }
}
