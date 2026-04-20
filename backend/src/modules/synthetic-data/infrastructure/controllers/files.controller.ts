import {
  Body,
  BadRequestException,
  Controller,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import {
  OutputFormat,
  ProcessSqlUploadResult,
  ProcessSqlUploadUseCase,
} from '../../application/use-cases/process-sql-upload.use-case';
import { SqlDialect } from '../../domain/ports/sql-schema-extractor.port';

@Controller('files')
export class FilesController {
  private readonly allowedDialects: SqlDialect[] = [
    'postgresql',
    'mysql',
    'mariadb',
  ];
  private readonly allowedOutputFormats: OutputFormat[] = ['json', 'sql'];

  constructor(
    private readonly processSqlUploadUseCase: ProcessSqlUploadUseCase,
  ) {}

  @Post('upload-sql')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSql(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('dialect') dialect: string | undefined,
    @Body('rowCount') rowCount: string | undefined,
    @Body('region') region: string | undefined,
    @Body('outputFormat') outputFormat: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException(
        'Debes enviar un archivo .sql en el campo "file".',
      );
    }

    if (!file.originalname.toLowerCase().endsWith('.sql')) {
      throw new BadRequestException(
        'Solo se permiten archivos con extension .sql.',
      );
    }

    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('El archivo .sql no contiene informacion.');
    }

    const normalizedDialect = dialect?.toLowerCase();
    if (
      !normalizedDialect ||
      !this.allowedDialects.includes(normalizedDialect as SqlDialect)
    ) {
      throw new BadRequestException(
        'Dialecto invalido. Usa postgresql, mysql o mariadb.',
      );
    }

    const parsedRowCount = Number(rowCount);
    if (
      !Number.isInteger(parsedRowCount) ||
      parsedRowCount < 1 ||
      parsedRowCount > 50000
    ) {
      throw new BadRequestException(
        'rowCount debe ser un entero entre 1 y 50000.',
      );
    }

    const normalizedRegion = region?.trim();
    if (!normalizedRegion) {
      throw new BadRequestException('region es obligatoria.');
    }

    const normalizedOutputFormat = outputFormat?.toLowerCase() ?? 'json';
    if (!this.allowedOutputFormats.includes(normalizedOutputFormat as OutputFormat)) {
      throw new BadRequestException('outputFormat invalido. Usa json o sql.');
    }

    const result: ProcessSqlUploadResult = await this.processSqlUploadUseCase.execute({
      fileName: file.originalname,
      fileBuffer: file.buffer,
      dialect: normalizedDialect as SqlDialect,
      rowCount: parsedRowCount,
      region: normalizedRegion,
      outputFormat: normalizedOutputFormat as OutputFormat,
    });

    response.setHeader('Content-Type', result.mimeType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.fileName}"`,
    );
    response.status(200).send(result.content);
  }
}
