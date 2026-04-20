import { SchemaGraph } from '../models/schema.types';

export type SqlDialect = 'postgresql' | 'mysql' | 'mariadb';

export interface ISqlSchemaExtractor {
  extractFromSql(sql: string, dialect: SqlDialect): Promise<SchemaGraph>;
}

export const SQL_SCHEMA_EXTRACTOR = Symbol('SQL_SCHEMA_EXTRACTOR');
