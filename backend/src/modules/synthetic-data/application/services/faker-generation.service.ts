import { faker, fakerEN, fakerEN_US, fakerES, fakerES_MX } from '@faker-js/faker';
import { Injectable } from '@nestjs/common';
import {
  ColumnSchema,
  PrimitiveValue,
  SchemaGraph,
  SyntheticPreview,
  TableRows,
} from '../../domain/models/schema.types';
import { ContextPoolDictionary } from '../../domain/ports/language-model-provider.port';

interface ResolveColumnValueParams {
  tableName: string;
  column: ColumnSchema;
  rowIndex: number;
  generated: SyntheticPreview;
  currentRow: Record<string, PrimitiveValue>;
  contextPools: ContextPoolDictionary;
  uniqueTracker: Map<string, Set<string>>;
}

@Injectable()
export class FakerGenerationService {
  private activeFaker = faker;

  generate(
    schema: SchemaGraph,
    rowCount: number,
    contextPools: ContextPoolDictionary,
    region: string,
  ): SyntheticPreview {
    // El locale se fija por solicitud para mantener coherencia cultural en nombres y ubicaciones.
    this.activeFaker = this.resolveFakerByRegion(region);

    const orderedTables = this.sortByDependencies(schema);
    const generated: SyntheticPreview = {};
    const uniqueTracker = new Map<string, Set<string>>();

    for (const table of orderedTables) {
      const rows: TableRows = [];

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row: Record<string, PrimitiveValue> = {};

        for (const column of table.columns) {
          row[column.name] = this.resolveColumnValue(
            {
              tableName: table.name,
              column,
              rowIndex,
              generated,
              currentRow: row,
              contextPools,
              uniqueTracker,
            },
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
        // Si hay ciclos entre tablas, se procesa el remanente para evitar bloqueo infinito.
        for (const table of pending.values()) {
          ordered.push(table);
        }
        pending.clear();
      }
    }

    return ordered;
  }

  private resolveColumnValue(params: ResolveColumnValueParams): PrimitiveValue {
    const {
      tableName,
      column,
      rowIndex,
      generated,
      currentRow,
      contextPools,
      uniqueTracker,
    } = params;

    const normalizedName = this.normalize(column.name);
    const normalizedType = this.normalize(column.dataType);

    // Las PK enteras se generan de forma determinista por fila para facilitar trazabilidad.
    if (column.isPrimaryKey && this.isIntegerLikeColumn(normalizedName, normalizedType)) {
      return rowIndex + 1;
    }

    // Las FK siempre priorizan valores ya generados en la tabla referenciada.
    if (column.reference) {
      const referenceValue = this.resolveForeignKeyValue(column, generated, rowIndex);
      return this.ensureUniqueIfNeeded(
        tableName,
        column,
        referenceValue,
        rowIndex,
        normalizedType,
        uniqueTracker,
      );
    }

    if (column.nullable && typeof column.defaultValue === 'undefined' && !column.isUnique) {
      if (this.activeFaker.number.int({ min: 1, max: 100 }) <= 4) {
        return null;
      }
    }

    let candidate: PrimitiveValue;

    // Si existe DEFAULT en esquema, se reutiliza en una fracción de casos para simular datos reales.
    if (
      typeof column.defaultValue !== 'undefined' &&
      this.activeFaker.number.int({ min: 1, max: 100 }) <= 18
    ) {
      candidate = this.coerceDefaultValue(column.defaultValue, normalizedType);
    } else if (this.isBooleanType(normalizedType)) {
      candidate = this.generateBooleanValue(normalizedName, column.defaultValue);
    } else if (this.isDateTimeType(normalizedType)) {
      candidate = this.generateDateTimeValue(normalizedType);
    } else if (this.isIntegerType(normalizedType)) {
      candidate = this.generateIntegerValue(normalizedName, rowIndex);
    } else if (this.isNumericType(normalizedType)) {
      candidate = this.generateNumericValue(normalizedName, column);
    } else if (this.isTextType(normalizedType)) {
      candidate = this.generateTextValue(
        tableName,
        column,
        rowIndex,
        currentRow,
        contextPools,
      );
    } else {
      candidate = this.activeFaker.lorem.word();
    }

    // Normaliza el valor final para cumplir tipo SQL y restricciones declaradas.
    candidate = this.applyTypeAndConstraintCoercion(candidate, column, normalizedType);

    if (candidate === null && !column.nullable) {
      candidate = this.applyTypeAndConstraintCoercion(
        this.fallbackNonNullValue(tableName, column, rowIndex, currentRow),
        column,
        normalizedType,
      );
    }

    return this.ensureUniqueIfNeeded(
      tableName,
      column,
      candidate,
      rowIndex,
      normalizedType,
      uniqueTracker,
    );
  }

  private pickFromContextPools(
    tableName: string,
    columnName: string,
    contextPools: ContextPoolDictionary,
  ): string | null {
    const normalizedTableName = this.normalize(tableName);
    const normalizedColumnName = this.normalize(columnName);
    const candidates = Object.entries(contextPools).filter(([, values]) =>
      Array.isArray(values) && values.length > 0,
    );

    // Se intenta primero un match exacto tabla.columna para evitar contaminación semántica.
    const exactMatches = candidates.filter(([key]) => {
      const normalizedKey = this.normalize(key);
      return (
        normalizedKey === `${normalizedTableName}.${normalizedColumnName}` ||
        normalizedKey === `${normalizedTableName}_${normalizedColumnName}` ||
        normalizedKey === `${normalizedTableName}${normalizedColumnName}`
      );
    });

    if (exactMatches.length > 0) {
      return this.activeFaker.helpers.arrayElement(
        this.activeFaker.helpers.arrayElement(exactMatches)[1],
      );
    }

    const tableAwareMatch = candidates.find(([key]) => {
      const normalizedKey = this.normalize(key);
      return (
        normalizedKey.includes(normalizedTableName) &&
        normalizedKey.includes(normalizedColumnName)
      );
    });

    if (tableAwareMatch) {
      return this.activeFaker.helpers.arrayElement(tableAwareMatch[1]);
    }

    const semanticTokens = this.semanticTokensForColumn(normalizedColumnName);
    const semanticMatch = candidates.find(([key]) => {
      const normalizedKey = this.normalize(key);

      if (
        normalizedKey.includes('.') &&
        !normalizedKey.startsWith(`${normalizedTableName}.`)
      ) {
        return false;
      }

      return semanticTokens.some((token) => normalizedKey.includes(token));
    });

    if (semanticMatch) {
      return this.activeFaker.helpers.arrayElement(semanticMatch[1]);
    }

    return null;
  }

  private generateTextValue(
    tableName: string,
    column: ColumnSchema,
    rowIndex: number,
    currentRow: Record<string, PrimitiveValue>,
    contextPools: ContextPoolDictionary,
  ): string {
    const normalizedTableName = this.normalize(tableName);
    const normalizedColumnName = this.normalize(column.name);

    if (normalizedColumnName.includes('email')) {
      return this.buildEmailValue(currentRow, rowIndex);
    }

    if (
      normalizedColumnName.includes('codigo') ||
      normalizedColumnName === 'code' ||
      normalizedColumnName.includes('_code')
    ) {
      return this.buildCodeValue(tableName, rowIndex);
    }

    if (
      normalizedColumnName.includes('telefono') ||
      normalizedColumnName.includes('phone') ||
      normalizedColumnName.includes('celular')
    ) {
      return this.activeFaker.phone.number();
    }

    const semanticPoolValue = this.pickFromContextPools(
      tableName,
      column.name,
      contextPools,
    );
    if (semanticPoolValue !== null) {
      return semanticPoolValue;
    }

    if (
      normalizedColumnName.includes('apellido') ||
      normalizedColumnName.includes('lastname')
    ) {
      return this.activeFaker.person.lastName();
    }

    if (
      normalizedColumnName.includes('nombre') ||
      normalizedColumnName.includes('name') ||
      normalizedColumnName.includes('cliente')
    ) {
      return this.generateNameByContext(normalizedTableName, normalizedColumnName);
    }

    if (
      normalizedColumnName.includes('empresa') ||
      normalizedColumnName.includes('razon_social')
    ) {
      return this.activeFaker.company.name();
    }

    if (
      normalizedColumnName.includes('direccion') ||
      normalizedColumnName.includes('address')
    ) {
      return this.activeFaker.location.streetAddress();
    }

    if (
      normalizedColumnName.includes('zona') ||
      normalizedColumnName.includes('ciudad') ||
      normalizedColumnName.includes('city')
    ) {
      return this.activeFaker.location.city();
    }

    if (normalizedColumnName.includes('producto')) {
      return this.activeFaker.commerce.productName();
    }

    if (normalizedColumnName.includes('categoria')) {
      return this.activeFaker.commerce.department();
    }

    return this.activeFaker.lorem.words({ min: 2, max: 4 });
  }

  private generateNameByContext(
    normalizedTableName: string,
    normalizedColumnName: string,
  ): string {
    if (
      normalizedTableName.includes('producto') ||
      normalizedTableName.includes('inventario') ||
      normalizedColumnName.includes('producto')
    ) {
      return this.activeFaker.commerce.productName();
    }

    if (
      normalizedTableName.includes('categoria') ||
      normalizedColumnName.includes('categoria')
    ) {
      return this.activeFaker.commerce.department();
    }

    if (
      normalizedTableName.includes('vendedor') ||
      normalizedTableName.includes('usuario') ||
      normalizedTableName.includes('cliente') ||
      normalizedTableName.includes('empleado') ||
      normalizedTableName.includes('persona')
    ) {
      if (normalizedColumnName.includes('nombres')) {
        return this.activeFaker.person.firstName();
      }

      return this.activeFaker.person.fullName();
    }

    return this.activeFaker.person.fullName();
  }

  private generateBooleanValue(
    normalizedColumnName: string,
    defaultValue: PrimitiveValue | undefined,
  ): boolean {
    if (typeof defaultValue === 'boolean') {
      return this.activeFaker.datatype.boolean({
        probability: defaultValue ? 0.85 : 0.15,
      });
    }

    if (normalizedColumnName.includes('activo')) {
      return this.activeFaker.datatype.boolean({ probability: 0.85 });
    }

    return this.activeFaker.datatype.boolean();
  }

  private generateDateTimeValue(normalizedType: string): string {
    const dateValue = this.activeFaker.date.recent({ days: 365 });

    if (normalizedType.includes('date') && !normalizedType.includes('time')) {
      return dateValue.toISOString().slice(0, 10);
    }

    if (normalizedType.includes('time') && !normalizedType.includes('date')) {
      return dateValue.toISOString().slice(11, 19);
    }

    return dateValue.toISOString();
  }

  private generateIntegerValue(normalizedColumnName: string, rowIndex: number): number {
    if (
      normalizedColumnName === 'id' ||
      normalizedColumnName.startsWith('id_') ||
      normalizedColumnName.endsWith('_id')
    ) {
      return rowIndex + 1;
    }

    if (
      normalizedColumnName.includes('cantidad') ||
      normalizedColumnName.includes('stock') ||
      normalizedColumnName.includes('existencia')
    ) {
      return this.activeFaker.number.int({ min: 0, max: 1000 });
    }

    if (normalizedColumnName.includes('anio') || normalizedColumnName.includes('year')) {
      return this.activeFaker.number.int({ min: 2000, max: 2035 });
    }

    return this.activeFaker.number.int({ min: 1, max: 100000 });
  }

  private generateNumericValue(normalizedColumnName: string, column: ColumnSchema): number {
    const scale = typeof column.numericScale === 'number' ? column.numericScale : 2;

    if (
      normalizedColumnName.includes('pct') ||
      normalizedColumnName.includes('porcentaje') ||
      normalizedColumnName.includes('percent') ||
      normalizedColumnName.includes('comision')
    ) {
      return this.activeFaker.number.float({
        min: 0,
        max: 35,
        fractionDigits: Math.max(0, scale),
      });
    }

    if (
      normalizedColumnName.includes('precio') ||
      normalizedColumnName.includes('monto') ||
      normalizedColumnName.includes('total') ||
      normalizedColumnName.includes('costo')
    ) {
      return this.activeFaker.number.float({
        min: 1,
        max: 6000,
        fractionDigits: Math.max(0, scale),
      });
    }

    if (
      normalizedColumnName.includes('stock') ||
      normalizedColumnName.includes('cantidad') ||
      normalizedColumnName.includes('existencia')
    ) {
      return this.activeFaker.number.float({
        min: 0,
        max: 2000,
        fractionDigits: Math.max(0, scale),
      });
    }

    return this.activeFaker.number.float({
      min: 0,
      max: 100000,
      fractionDigits: Math.max(0, scale),
    });
  }

  private fallbackNonNullValue(
    tableName: string,
    column: ColumnSchema,
    rowIndex: number,
    currentRow: Record<string, PrimitiveValue>,
  ): PrimitiveValue {
    const normalizedName = this.normalize(column.name);
    const normalizedType = this.normalize(column.dataType);

    if (this.isBooleanType(normalizedType)) {
      return false;
    }

    if (this.isIntegerType(normalizedType)) {
      return rowIndex + 1;
    }

    if (this.isNumericType(normalizedType)) {
      return 0;
    }

    if (this.isDateTimeType(normalizedType)) {
      return this.generateDateTimeValue(normalizedType);
    }

    if (normalizedName.includes('email')) {
      return this.buildEmailValue(currentRow, rowIndex);
    }

    if (normalizedName.includes('codigo')) {
      return this.buildCodeValue(tableName, rowIndex);
    }

    return 'sin_definir';
  }

  private resolveForeignKeyValue(
    column: ColumnSchema,
    generated: SyntheticPreview,
    rowIndex: number,
  ): PrimitiveValue {
    if (!column.reference) {
      return rowIndex + 1;
    }

    const referencedRows = generated[column.reference.table];
    if (Array.isArray(referencedRows) && referencedRows.length > 0) {
      const selected = this.activeFaker.helpers.arrayElement(referencedRows);
      const referencedValue = selected[column.reference.column];
      if (this.isPrimitiveValue(referencedValue)) {
        return referencedValue;
      }
    }

    return column.nullable ? null : rowIndex + 1;
  }

  private ensureUniqueIfNeeded(
    tableName: string,
    column: ColumnSchema,
    value: PrimitiveValue,
    rowIndex: number,
    normalizedType: string,
    uniqueTracker: Map<string, Set<string>>,
  ): PrimitiveValue {
    if (!column.isUnique && !column.isPrimaryKey) {
      return value;
    }

    if (value === null) {
      return value;
    }

    const trackerKey = `${tableName}.${column.name}`;
    const usedValues = uniqueTracker.get(trackerKey) ?? new Set<string>();
    if (!uniqueTracker.has(trackerKey)) {
      uniqueTracker.set(trackerKey, usedValues);
    }

    let candidate: PrimitiveValue = value;

    // Se limita el número de intentos para mantener latencia estable con volúmenes altos.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const token = this.buildUniquenessToken(candidate);
      if (!usedValues.has(token)) {
        usedValues.add(token);
        return candidate;
      }

      candidate = this.buildNextUniqueCandidate(candidate, rowIndex, attempt + 1);
      candidate = this.applyTypeAndConstraintCoercion(candidate, column, normalizedType);
    }

    return candidate;
  }

  private buildNextUniqueCandidate(
    value: PrimitiveValue,
    rowIndex: number,
    attempt: number,
  ): PrimitiveValue {
    if (typeof value === 'number') {
      return value + rowIndex + attempt + 1;
    }

    if (typeof value === 'string') {
      const cleanBase = value.replace(/_[0-9]+$/, '');
      return `${cleanBase}_${rowIndex + attempt + 1}`;
    }

    if (typeof value === 'boolean') {
      return attempt % 2 === 0 ? !value : value;
    }

    return `${rowIndex + attempt + 1}`;
  }

  private buildUniquenessToken(value: PrimitiveValue): string {
    if (value === null) {
      return 'null';
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value.toString() : 'NaN';
    }

    return String(value);
  }

  private buildCodeValue(tableName: string, rowIndex: number): string {
    const normalizedTableName = this
      .normalize(tableName)
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 5)
      .toUpperCase();
    const prefix = normalizedTableName.length > 0 ? normalizedTableName : 'COD';
    return `${prefix}-${String(rowIndex + 1).padStart(6, '0')}`;
  }

  private buildEmailValue(
    currentRow: Record<string, PrimitiveValue>,
    rowIndex: number,
  ): string {
    const firstNameCandidate = this.pickStringValue(currentRow, ['nombres', 'nombre']);
    const lastNameCandidate = this.pickStringValue(currentRow, ['apellidos', 'apellido']);

    const first = this.sanitizeForEmail(
      firstNameCandidate ?? this.activeFaker.person.firstName(),
    );
    const last = this.sanitizeForEmail(
      lastNameCandidate ?? this.activeFaker.person.lastName(),
    );

    return `${first}.${last}.${rowIndex + 1}@example.com`;
  }

  private pickStringValue(
    row: Record<string, PrimitiveValue>,
    candidates: string[],
  ): string | null {
    const normalizedCandidates = candidates.map((candidate) => this.normalize(candidate));

    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') {
        continue;
      }

      if (normalizedCandidates.includes(this.normalize(key))) {
        return value;
      }
    }

    return null;
  }

  private sanitizeForEmail(value: string): string {
    const sanitized = this
      .normalize(value)
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/(^\.+|\.+$)/g, '')
      .replace(/\.{2,}/g, '.');

    if (sanitized.length > 0) {
      return sanitized;
    }

    return 'usuario';
  }

  private coerceDefaultValue(
    defaultValue: PrimitiveValue,
    normalizedType: string,
  ): PrimitiveValue {
    if (defaultValue === null) {
      return null;
    }

    if (this.isBooleanType(normalizedType)) {
      if (typeof defaultValue === 'boolean') {
        return defaultValue;
      }

      if (typeof defaultValue === 'number') {
        return defaultValue !== 0;
      }

      return ['true', '1', 'si', 'yes'].includes(this.normalize(String(defaultValue)));
    }

    if (this.isIntegerType(normalizedType)) {
      const numberValue = Number(defaultValue);
      if (Number.isFinite(numberValue)) {
        return Math.trunc(numberValue);
      }
    }

    if (this.isNumericType(normalizedType)) {
      const numberValue = Number(defaultValue);
      if (Number.isFinite(numberValue)) {
        return numberValue;
      }
    }

    return defaultValue;
  }

  private applyTypeAndConstraintCoercion(
    value: PrimitiveValue,
    column: ColumnSchema,
    normalizedType: string,
  ): PrimitiveValue {
    if (value === null) {
      return null;
    }

    if (this.isBooleanType(normalizedType)) {
      if (typeof value === 'boolean') {
        return value;
      }

      if (typeof value === 'number') {
        return value !== 0;
      }

      return ['true', '1', 'si', 'yes'].includes(this.normalize(String(value)));
    }

    if (this.isIntegerType(normalizedType)) {
      const numericValue = Number(value);
      const safeValue = Number.isFinite(numericValue) ? Math.trunc(numericValue) : 0;
      return Math.trunc(this.applyNumericPrecision(safeValue, column, 0));
    }

    if (this.isNumericType(normalizedType)) {
      const numericValue = Number(value);
      const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
      const defaultScale =
        typeof column.numericScale === 'number' ? Math.max(0, column.numericScale) : 2;
      return this.applyNumericPrecision(safeValue, column, defaultScale);
    }

    if (this.isDateTimeType(normalizedType)) {
      const asDate = new Date(String(value));
      if (Number.isNaN(asDate.getTime())) {
        return this.generateDateTimeValue(normalizedType);
      }

      if (normalizedType.includes('date') && !normalizedType.includes('time')) {
        return asDate.toISOString().slice(0, 10);
      }

      if (normalizedType.includes('time') && !normalizedType.includes('date')) {
        return asDate.toISOString().slice(11, 19);
      }

      return asDate.toISOString();
    }

    const textValue = String(value);
    return this.applyMaxLength(textValue, column.maxLength);
  }

  private applyNumericPrecision(
    value: number,
    column: ColumnSchema,
    defaultScale: number,
  ): number {
    let candidate = Number.isFinite(value) ? value : 0;
    const scale =
      typeof column.numericScale === 'number'
        ? Math.max(0, Math.trunc(column.numericScale))
        : Math.max(0, Math.trunc(defaultScale));

    candidate = Number(candidate.toFixed(scale));

    // Aplica el rango máximo representable por PRECISION/SCALE.
    if (typeof column.numericPrecision === 'number') {
      const precision = Math.max(1, Math.trunc(column.numericPrecision));
      const integerDigits = Math.max(1, precision - scale);
      const maxInteger = Math.pow(10, integerDigits) - 1;
      const maxDecimal = scale > 0 ? 1 - Math.pow(10, -scale) : 0;
      const maxAbs = Number((maxInteger + maxDecimal).toFixed(scale));

      if (candidate > maxAbs) {
        candidate = maxAbs;
      }

      if (candidate < -maxAbs) {
        candidate = -maxAbs;
      }
    }

    return candidate;
  }

  private applyMaxLength(value: string, maxLength: number | undefined): string {
    if (typeof maxLength !== 'number' || maxLength <= 0) {
      return value;
    }

    if (value.length <= maxLength) {
      return value;
    }

    return value.slice(0, maxLength);
  }

  private resolveFakerByRegion(region: string) {
    const normalizedRegion = this.normalize(region);

    if (
      normalizedRegion.includes('latino') ||
      normalizedRegion.includes('sudamerica') ||
      normalizedRegion.includes('centroamerica') ||
      normalizedRegion.includes('mexico')
    ) {
      return fakerES_MX;
    }

    if (
      normalizedRegion.includes('norteamerica') ||
      normalizedRegion.includes('usa') ||
      normalizedRegion.includes('canada') ||
      normalizedRegion.includes('eeuu')
    ) {
      return fakerEN_US;
    }

    if (normalizedRegion.includes('europa') || normalizedRegion.includes('espana')) {
      return fakerES;
    }

    return fakerEN;
  }

  private isIntegerLikeColumn(normalizedName: string, normalizedType: string): boolean {
    return (
      this.isIntegerType(normalizedType) ||
      normalizedType.includes('serial') ||
      normalizedName === 'id' ||
      normalizedName.startsWith('id_') ||
      normalizedName.endsWith('_id')
    );
  }

  private isBooleanType(normalizedType: string): boolean {
    return normalizedType.includes('bool');
  }

  private isNumericType(normalizedType: string): boolean {
    return (
      normalizedType.includes('numeric') ||
      normalizedType.includes('decimal') ||
      normalizedType.includes('float') ||
      normalizedType.includes('double') ||
      normalizedType.includes('real')
    );
  }

  private isIntegerType(normalizedType: string): boolean {
    return (
      normalizedType.includes('int') ||
      normalizedType.includes('serial') ||
      normalizedType.includes('smallint') ||
      normalizedType.includes('bigint')
    );
  }

  private isDateTimeType(normalizedType: string): boolean {
    return (
      normalizedType.includes('date') ||
      normalizedType.includes('time') ||
      normalizedType.includes('timestamp')
    );
  }

  private isTextType(normalizedType: string): boolean {
    return (
      normalizedType.includes('char') ||
      normalizedType.includes('text') ||
      normalizedType.includes('uuid') ||
      normalizedType.includes('json')
    );
  }

  private isPrimitiveValue(value: unknown): value is PrimitiveValue {
    return (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    );
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
