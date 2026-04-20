import { BadRequestException, Injectable } from '@nestjs/common';
import { Parser } from 'node-sql-parser';
import { ColumnSchema, SchemaGraph, TableSchema } from '../../../domain/models/schema.types';
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

    this.applyForeignKeyConstraints(columns, definitions);

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

    const rawColumn = definitionRecord.column;
    const columnNode = this.asRecord(rawColumn);
    const nestedColumnNode = this.asRecord(columnNode?.column);
    const columnExprNode = this.asRecord(columnNode?.expr);
    const nestedColumnExprNode = this.asRecord(nestedColumnNode?.expr);
    const definitionNode = this.asRecord(definitionRecord.definition);
    const nullableNode = this.asRecord(definitionNode?.nullable);

    const name =
      this.asString(columnNode?.column) ??
      this.asString(nestedColumnNode?.column) ??
      this.asString(nestedColumnExprNode?.value) ??
      this.asString(rawColumn) ??
      this.asString(columnExprNode?.column) ??
      this.asString(columnExprNode?.value) ??
      null;
    if (!name) {
      return null;
    }

    const rawDataType = definitionNode?.dataType;
    const dataType =
      this.asString(rawDataType) ??
      this.asString(this.asRecord(rawDataType)?.dataType) ??
      this.asString(this.asRecord(rawDataType)?.value) ??
      'varchar';
    const nullable = this.asString(nullableNode?.type) !== 'not null';
    const isPrimaryKey = Boolean(definitionNode?.primary_key);

    const inlineReference = this.parseReference(definitionNode?.reference_definition);

    return {
      name,
      dataType,
      nullable,
      isPrimaryKey,
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

  private applyForeignKeyConstraints(columns: ColumnSchema[], definitions: unknown[]): void {
    for (const definition of definitions) {
      if (typeof definition !== 'object' || definition === null) {
        continue;
      }

      const constraint = definition as ConstraintDefinition;
      if (constraint.resource !== 'constraint') {
        continue;
      }

      const constraintType = this.asString(constraint.constraint_type)?.toLowerCase();
      if (constraintType !== 'foreign key') {
        continue;
      }

      const sourceColumns = this.extractColumnNames(constraint.definition);
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

    const tableNode = referenceNode.table;
    const tableName =
      this.asString(tableNode) ?? this.asString(this.asRecord(tableNode)?.table) ?? undefined;

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
      return this.asString(this.asRecord(firstTable)?.table);
    }

    return this.asString(this.asRecord(tableNode)?.table) ?? this.asString(tableNode);
  }

  private extractColumnNames(columnsNode: unknown): string[] {
    if (!Array.isArray(columnsNode)) {
      return [];
    }

    return columnsNode
      .map((column) => {
        const rawColumn = this.asRecord(column);
        return this.asString(rawColumn?.column) ?? this.asString(column);
      })
      .filter((columnName): columnName is string => typeof columnName === 'string');
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
