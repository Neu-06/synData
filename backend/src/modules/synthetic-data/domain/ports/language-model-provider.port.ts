import { SchemaGraph } from '../models/schema.types';

export type ContextPoolDictionary = Record<string, string[]>;

export interface ILanguageModelProvider {
  generateContextPools(
    schema: SchemaGraph,
    region: string,
  ): Promise<ContextPoolDictionary>;
}

export const LANGUAGE_MODEL_PROVIDER = Symbol('LANGUAGE_MODEL_PROVIDER');
