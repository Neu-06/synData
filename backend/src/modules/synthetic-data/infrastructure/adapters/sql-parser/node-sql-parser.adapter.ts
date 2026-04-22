import { BadRequestException, Injectable } from '@nestjs/common';
import { Parser } from 'node-sql-parser';
import {
  ColumnSchema,
  PrimitiveValue,
  SchemaGraph,
  TableSchema,
} from '../../../domain/models/schema.types';
import {
  ISqlSchemaExtractor,
  SqlDialect,
} from '../../../domain/ports/sql-schema-extractor.port';

interface CreateTableStatement {
  type?: unknown;
  keyword?: unknown;
  table?: unknown;
  create_definitions?: unknown;
}

interface ConstraintDefinition {
  resource?: unknown;
  constraint_type?: unknown;
  definition?: unknown;
  reference_definition?: unknown;
}

interface ParsedReference {
  table: string;
  columns: string[];
}

@Injectable()
export class NodeSqlParserAdapter implements ISqlSchemaExtractor {
  private readonly parser = new Parser();

  async extractFromSql(sql: string, dialect: SqlDialect): Promise<SchemaGraph> {
    const cleanedSql = this.cleanSqlString(sql);
    let astResult: unknown;

    try {
      astResult = this.parser.astify(cleanedSql, { database: dialect });
    } catch (error: unknown) {
      throw new BadRequestException(
        'Error al leer la estructura de la base de datos. Verifica la sintaxis de tu SQL.',
      );
    }

    const statements = Array.isArray(astResult) ? astResult : [astResult];
    const createTableStatements = statements.filter((statement) =>
      this.isCreateTableStatement(statement),
    );

    if (createTableStatements.length === 0) {
      throw new BadRequestException(
        'No se encontraron sentencias CREATE TABLE en el archivo.',
      );
    }

    const tables = createTableStatements.map((statement) => this.mapTable(statement));
    return { tables };
  }

  private cleanSqlString(sql: string): string {
    // Se eliminan comentarios y sentencias no estructurales para estabilizar el parseo AST.
    const withoutComments = sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\r\n]*/g, ' ');

    const withoutCreateDatabase = withoutComments.replace(
      /\bcreate\s+database\b[\s\S]*?;/gi,
      ' ',
    );

    const candidateStatements = withoutCreateDatabase
      .split(/;\s*(?:\r?\n|$)/g)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    const safeStatements = candidateStatements.filter((statement) =>
      /^\s*(create|alter)\s+table\b/i.test(statement),
    );

    return safeStatements.join(';\n');
  }

  private isCreateTableStatement(statement: unknown): statement is CreateTableStatement {
    if (typeof statement !== 'object' || statement === null) {
      return false;
    }

    const candidate = statement as CreateTableStatement;
    return candidate.type === 'create' && candidate.keyword === 'table';
  }

  private mapTable(statement: CreateTableStatement): TableSchema {
    const tableName = this.extractTableName(statement.table);
    if (!tableName) {
      throw new BadRequestException('No se pudo determinar el nombre de una tabla.');
    }

    const definitions = Array.isArray(statement.create_definitions)
      ? statement.create_definitions
      : [];

    const columns = definitions
      .map((definition) => this.mapColumnFromCreateDefinition(definition))
      .filter((column): column is ColumnSchema => column !== null);

    this.applyConstraintMetadata(columns, definitions);

    return {
      name: tableName,
      columns,
    };
  }

  private mapColumnFromCreateDefinition(definition: unknown): ColumnSchema | null {
    const definitionRecord = this.asRecord(definition);
    if (!definitionRecord) {
      return null;
    }

    const resourceType = this.asString(definitionRecord.resource)?.toLowerCase();
    if (resourceType !== 'column') {
      return null;
    }

    const rawColumn = definitionRecord.column;
    const definitionNode = this.asRecord(definitionRecord.definition);
    const nullableNode = this.asRecord(definitionRecord.nullable);

    // La librería puede anidar el nombre de columna en varios niveles según dialecto.
    const name = this.extractColumnName(rawColumn) ?? null;
    if (!name) {
      return null;
    }

    const rawDataType = definitionNode?.dataType;
    const dataType =
      this.asString(rawDataType) ??
      this.asString(this.asRecord(rawDataType)?.dataType) ??
      this.asString(this.asRecord(rawDataType)?.value) ??
      'varchar';
    const normalizedDataType = dataType.toLowerCase();
    const maxLength = this.asNumber(definitionNode?.length);
    const numericPrecision = this.isNumericType(normalizedDataType)
      ? maxLength
      : undefined;
    const numericScale = this.asNumber(definitionNode?.scale);
    const nullable = this.asString(nullableNode?.type)?.toLowerCase() !== 'not null';
    const isPrimaryKey = this.asTruthyBoolean(definitionRecord.primary_key);
    const isUnique =
      this.asTruthyBoolean(definitionRecord.unique) || isPrimaryKey;

    const inlineReference = this.parseReference(definitionRecord.reference_definition);
    const defaultValue = this.parseDefaultValue(definitionRecord.default_val);

    return {
      name,
      dataType,
      nullable: isPrimaryKey ? false : nullable,
      isPrimaryKey,
      isUnique,
      ...(typeof maxLength === 'number' ? { maxLength } : {}),
      ...(typeof numericPrecision === 'number' ? { numericPrecision } : {}),
      ...(typeof numericScale === 'number' ? { numericScale } : {}),
      ...(typeof defaultValue !== 'undefined' ? { defaultValue } : {}),
      ...(inlineReference
        ? {
            reference: {
              table: inlineReference.table,
              column: inlineReference.columns[0] ?? 'id',
            },
          }
        : {}),
    };
  }

  private applyConstraintMetadata(columns: ColumnSchema[], definitions: unknown[]): void {
    for (const definition of definitions) {
      const constraint = this.asRecord(definition) as ConstraintDefinition | undefined;
      if (!constraint) {
        continue;
      }

      if (this.asString(constraint.resource)?.toLowerCase() !== 'constraint') {
        continue;
      }

      const constraintType = this.asString(constraint.constraint_type)?.toLowerCase();
      const sourceColumns = this.extractColumnNames(constraint.definition);

      if (constraintType === 'primary key') {
        sourceColumns.forEach((sourceColumn) => {
          const column = columns.find((item) => item.name === sourceColumn);
          if (!column) {
            return;
          }

          column.isPrimaryKey = true;
          column.isUnique = true;
          column.nullable = false;
        });
        continue;
      }

      if (constraintType === 'unique') {
        // Un UNIQUE compuesto no implica unicidad individual por columna.
        if (sourceColumns.length !== 1) {
          continue;
        }

        sourceColumns.forEach((sourceColumn) => {
          const column = columns.find((item) => item.name === sourceColumn);
          if (!column) {
            return;
          }

          column.isUnique = true;
        });
        continue;
      }

      if (constraintType !== 'foreign key') {
        continue;
      }

      const targetReference = this.parseReference(constraint.reference_definition);

      if (!targetReference) {
        continue;
      }

      sourceColumns.forEach((sourceColumn, index) => {
        const column = columns.find((item) => item.name === sourceColumn);
        if (!column) {
          return;
        }

        column.reference = {
          table: targetReference.table,
          column: targetReference.columns[index] ?? targetReference.columns[0] ?? 'id',
        };
      });
    }
  }

  private parseReference(referenceDefinition: unknown): ParsedReference | undefined {
    const referenceNode = this.asRecord(referenceDefinition);
    if (!referenceNode) {
      return undefined;
    }

    const tableName = this.extractTableName(referenceNode.table);

    if (!tableName) {
      return undefined;
    }

    const columns = this.extractColumnNames(referenceNode.definition);

    return {
      table: tableName,
      columns: columns.length > 0 ? columns : ['id'],
    };
  }

  private extractTableName(tableNode: unknown): string | undefined {
    if (Array.isArray(tableNode)) {
      const firstTable = tableNode[0];
      const firstTableNode = this.asRecord(firstTable);
      return this.asString(firstTableNode?.table) ?? this.asString(firstTable);
    }

    return this.asString(this.asRecord(tableNode)?.table) ?? this.asString(tableNode);
  }

  private extractColumnNames(columnsNode: unknown): string[] {
    if (!Array.isArray(columnsNode)) {
      return [];
    }

    return columnsNode
      .map((column) => this.extractColumnName(column))
      .filter((columnName): columnName is string => typeof columnName === 'string');
  }

  private extractColumnName(columnNode: unknown): string | undefined {
    const columnRecord = this.asRecord(columnNode);
    if (!columnRecord) {
      return this.asString(columnNode);
    }

    const directColumnName = this.asString(columnRecord.column);
    if (directColumnName) {
      return directColumnName;
    }

    const nestedColumnNode = this.asRecord(columnRecord.column);
    const nestedColumnExpr = this.asRecord(nestedColumnNode?.expr);
    const nestedValue = this.asString(nestedColumnExpr?.value);
    if (nestedValue) {
      return nestedValue;
    }

    const directExprNode = this.asRecord(columnRecord.expr);
    const directExprValue = this.asString(directExprNode?.value);
    if (directExprValue) {
      return directExprValue;
    }

    return this.asString(columnRecord.value);
  }

  private parseDefaultValue(defaultNode: unknown): PrimitiveValue | undefined {
    // Convierte defaults del AST a primitivos del dominio para reutilizarlos en generación.
    const defaultRecord = this.asRecord(defaultNode);
    if (!defaultRecord) {
      return undefined;
    }

    const rawValue = defaultRecord.value;
    if (rawValue === null) {
      return null;
    }

    if (
      typeof rawValue === 'string' ||
      typeof rawValue === 'number' ||
      typeof rawValue === 'boolean'
    ) {
      return rawValue;
    }

    const valueNode = this.asRecord(rawValue);
    if (!valueNode) {
      return undefined;
    }

    const valueType = this.asString(valueNode.type)?.toLowerCase();
    const value = valueNode.value;

    if (valueType === 'null') {
      return null;
    }

    if (valueType === 'bool' && typeof value === 'boolean') {
      return value;
    }

    if (valueType === 'number' && typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    return undefined;
  }

  private isNumericType(normalizedDataType: string): boolean {
    return (
      normalizedDataType.includes('numeric') ||
      normalizedDataType.includes('decimal') ||
      normalizedDataType.includes('float') ||
      normalizedDataType.includes('double') ||
      normalizedDataType.includes('real')
    );
  }

  private asTruthyBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized.length > 0 && normalized !== 'false';
    }

    return Boolean(value);
  }

  private asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}
