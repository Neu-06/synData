export interface ColumnReference {
  table: string;
  column: string;
}

export interface ColumnSchema {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  reference?: ColumnReference;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
}

export interface SchemaGraph {
  tables: TableSchema[];
}

export type PrimitiveValue = string | number | boolean | null;
export type TableRows = Record<string, PrimitiveValue>[];
export type SyntheticPreview = Record<string, TableRows>;
