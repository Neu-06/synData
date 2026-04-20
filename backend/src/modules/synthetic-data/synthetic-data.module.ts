import { Module } from '@nestjs/common';
import { FakerGenerationService } from './application/services/faker-generation.service';
import { ProcessSqlUploadUseCase } from './application/use-cases/process-sql-upload.use-case';
import { LANGUAGE_MODEL_PROVIDER } from './domain/ports/language-model-provider.port';
import { SQL_SCHEMA_EXTRACTOR } from './domain/ports/sql-schema-extractor.port';
import { OllamaAdapter } from './infrastructure/adapters/ollama/ollama.adapter';
import { NodeSqlParserAdapter } from './infrastructure/adapters/sql-parser/node-sql-parser.adapter';
import { FilesController } from './infrastructure/controllers/files.controller';

@Module({
  controllers: [FilesController],
  providers: [
    FakerGenerationService,
    ProcessSqlUploadUseCase,
    {
      provide: SQL_SCHEMA_EXTRACTOR,
      useClass: NodeSqlParserAdapter,
    },
    {
      provide: LANGUAGE_MODEL_PROVIDER,
      useClass: OllamaAdapter,
    },
  ],
})
export class SyntheticDataModule {}
