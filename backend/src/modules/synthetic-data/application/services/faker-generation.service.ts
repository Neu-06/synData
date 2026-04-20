import { faker } from '@faker-js/faker';
import { Injectable } from '@nestjs/common';
import {
  ColumnSchema,
  PrimitiveValue,
  SchemaGraph,
  SyntheticPreview,
  TableRows,
} from '../../domain/models/schema.types';
import { ContextPoolDictionary } from '../../domain/ports/language-model-provider.port';

@Injectable()
export class FakerGenerationService {
  generate(
    schema: SchemaGraph,
    rowCount: number,
    contextPools: ContextPoolDictionary,
  ): SyntheticPreview {
    const orderedTables = this.sortByDependencies(schema);
    const generated: SyntheticPreview = {};

    for (const table of orderedTables) {
      const rows: TableRows = [];

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row: Record<string, PrimitiveValue> = {};

        for (const column of table.columns) {
          row[column.name] = this.resolveColumnValue(
            column,
            rowIndex,
            generated,
            contextPools,
          );
        }

        rows.push(row);
      }

      generated[table.name] = rows;
    }

    return generated;
  }

  private sortByDependencies(schema: SchemaGraph): SchemaGraph['tables'] {
    const pending = new Map(schema.tables.map((table) => [table.name, table]));
    const resolved = new Set<string>();
    const ordered: SchemaGraph['tables'] = [];

    while (pending.size > 0) {
      let progress = false;

      for (const [tableName, table] of pending) {
        const dependencies = table.columns
          .map((column) => column.reference?.table)
          .filter((dependency): dependency is string => Boolean(dependency));

        const canResolve = dependencies.every(
          (dependency) => resolved.has(dependency) || !pending.has(dependency),
        );

        if (canResolve) {
          ordered.push(table);
          resolved.add(tableName);
          pending.delete(tableName);
          progress = true;
        }
      }

      if (!progress) {
        for (const table of pending.values()) {
          ordered.push(table);
        }
        pending.clear();
      }
    }

    return ordered;
  }

  private resolveColumnValue(
    column: ColumnSchema,
    rowIndex: number,
    generated: SyntheticPreview,
    contextPools: ContextPoolDictionary,
  ): PrimitiveValue {
    const normalizedName = this.normalize(column.name);
    const lowerType = column.dataType.toLowerCase();

    if (column.isPrimaryKey && normalizedName.startsWith('id_')) {
      return rowIndex + 1;
    }

    if (column.reference) {
      const referencedRows = generated[column.reference.table];
      if (Array.isArray(referencedRows) && referencedRows.length > 0) {
        const selected = faker.helpers.arrayElement(referencedRows);
        const referencedValue = selected[column.reference.column];
        if (
          typeof referencedValue === 'string' ||
          typeof referencedValue === 'number' ||
          typeof referencedValue === 'boolean' ||
          referencedValue === null
        ) {
          return referencedValue;
        }
      }

      return rowIndex + 1;
    }

    const semanticPoolValue = this.pickFromContextPools(normalizedName, contextPools);
    if (semanticPoolValue !== null) {
      return semanticPoolValue;
    }

    if (lowerType.includes('bool')) {
      return faker.datatype.boolean();
    }

    if (
      lowerType.includes('numeric') ||
      lowerType.includes('decimal') ||
      lowerType.includes('float') ||
      lowerType.includes('double')
    ) {
      return Number(faker.commerce.price({ min: 10, max: 5000, dec: 2 }));
    }

    if (lowerType.includes('int')) {
      return faker.number.int({ min: 1, max: 100000 });
    }

    if (lowerType.includes('date') || lowerType.includes('time')) {
      return faker.date.recent().toISOString();
    }

    if (normalizedName.includes('email')) {
      return faker.internet.email();
    }

    if (normalizedName.includes('telefono') || normalizedName.includes('phone')) {
      return faker.phone.number();
    }

    if (normalizedName.includes('direccion')) {
      return faker.location.streetAddress();
    }

    if (normalizedName.includes('nombre') || normalizedName.includes('cliente')) {
      return faker.person.fullName();
    }

    if (lowerType.includes('char') || lowerType.includes('text')) {
      return faker.lorem.words({ min: 2, max: 4 });
    }

    return faker.lorem.word();
  }

  private pickFromContextPools(
    normalizedColumnName: string,
    contextPools: ContextPoolDictionary,
  ): string | null {
    const candidates = Object.entries(contextPools).filter(([, values]) => values.length > 0);

    const directMatch = candidates.find(([key]) => {
      const normalizedKey = this.normalize(key);
      return (
        normalizedKey.includes(normalizedColumnName) ||
        normalizedColumnName.includes(normalizedKey)
      );
    });

    if (directMatch) {
      return faker.helpers.arrayElement(directMatch[1]);
    }

    const semanticTokens = this.semanticTokensForColumn(normalizedColumnName);
    const semanticMatch = candidates.find(([key]) => {
      const normalizedKey = this.normalize(key);
      return semanticTokens.some((token) => normalizedKey.includes(token));
    });

    if (semanticMatch) {
      return faker.helpers.arrayElement(semanticMatch[1]);
    }

    return null;
  }

  private semanticTokensForColumn(normalizedColumnName: string): string[] {
    const tokens: string[] = [];

    if (normalizedColumnName.includes('nombre') || normalizedColumnName.includes('cliente')) {
      tokens.push('nombre', 'nombres', 'persona', 'personas', 'cliente', 'clientes');
    }

    if (normalizedColumnName.includes('razon_social') || normalizedColumnName.includes('empresa')) {
      tokens.push('empresa', 'empresas', 'razon', 'social');
    }

    if (normalizedColumnName.includes('ciudad')) {
      tokens.push('ciudad', 'ciudades');
    }

    if (normalizedColumnName.includes('categoria')) {
      tokens.push('categoria', 'categorias');
    }

    if (normalizedColumnName.includes('producto')) {
      tokens.push('producto', 'productos');
    }

    return tokens;
  }

  private normalize(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }
}
