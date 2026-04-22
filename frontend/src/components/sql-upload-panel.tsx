'use client';

import { ChangeEvent, FormEvent, useState } from 'react';

type SqlDialect = 'postgresql' | 'mysql' | 'mariadb';
type OutputFormat = 'json' | 'sql';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const REQUEST_TIMEOUT_MS = 120000;
const MIN_ROW_COUNT = 1;
const MAX_ROW_COUNT = 50000;
const DEFAULT_ROW_COUNT = 50;

export function SqlUploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [selectedDialect, setSelectedDialect] =
    useState<SqlDialect>('postgresql');
  const [selectedRegion, setSelectedRegion] = useState<string>('Latinoamerica');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('json');
  const [rowCount, setRowCount] = useState<number>(DEFAULT_ROW_COUNT);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setError(null);
  };

  const handleDialectChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedDialect(event.target.value as SqlDialect);
    setError(null);
  };

  const handleRegionChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedRegion(event.target.value);
    setError(null);
  };

  const handleOutputFormatChange = (
    event: ChangeEvent<HTMLSelectElement>,
  ): void => {
    setOutputFormat(event.target.value as OutputFormat);
    setError(null);
  };

  const handleRowCountChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const parsed = Number(event.target.value);

    if (!Number.isFinite(parsed)) {
      setRowCount(DEFAULT_ROW_COUNT);
      setError(null);
      return;
    }

    // Se fuerza un entero dentro de límites para mantener contrato con backend.
    const normalized = Math.min(
      MAX_ROW_COUNT,
      Math.max(MIN_ROW_COUNT, Math.trunc(parsed)),
    );
    setRowCount(normalized);
    setError(null);
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (!file) {
      setError('Selecciona un archivo .sql antes de enviar.');
      return;
    }

    if (!file.name.toLowerCase().endsWith('.sql')) {
      setError('El archivo debe tener extension .sql.');
      return;
    }

    if (
      !Number.isInteger(rowCount) ||
      rowCount < MIN_ROW_COUNT ||
      rowCount > MAX_ROW_COUNT
    ) {
      setError('La cantidad de registros por tabla debe estar entre 1 y 50000.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setDownloadMessage(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('dialect', selectedDialect);
      formData.append('rowCount', rowCount.toString());
      formData.append('region', selectedRegion);
      formData.append('outputFormat', outputFormat);

      const controller = new AbortController();
      // Timeout defensivo para evitar solicitudes colgadas en cargas pesadas.
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(`${API_BASE_URL}/api/files/upload-sql`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorPayload = (await response
            .json()
            .catch(() => null)) as { message?: string | string[] } | null;

          const message = Array.isArray(errorPayload?.message)
            ? errorPayload.message.join(' | ')
            : errorPayload?.message ?? 'No fue posible procesar el archivo SQL.';

          throw new Error(message);
        }

        const blob = await response.blob();
        const fileName = resolveFileName(
          response.headers.get('content-disposition'),
          outputFormat,
        );

        // Descarga programática del archivo generado sin recargar la página.
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(downloadUrl);

        setDownloadMessage(`Descarga iniciada: ${fileName}`);
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (requestError: unknown) {
      if (requestError instanceof Error && requestError.name === 'AbortError') {
        setError(
          'La solicitud tardo demasiado en responder (2 min). Intenta de nuevo o reduce el volumen.',
        );
        return;
      }

      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Ocurrio un error inesperado.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-brand-coal/15 bg-white/90 p-4 sm:p-6"
      >
        <label className="block">
            <span className="font-mono text-xs text-center uppercase tracking-[0.28em] text-brand-coal/70">
              Archivo de esquema
            </span>

            <input
              type="file"
              accept=".sql"
              onChange={handleFileChange}
              className="mt-3 block w-full cursor-pointer rounded-xl border border-brand-coal/20 bg-brand-sand/70 p-3 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-brand-sky/20 file:px-4 file:py-2 file:font-mono file:text-xs file:uppercase file:tracking-[0.2em] file:text-brand-coal hover:file:bg-brand-sky/35"
            />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          

          <label className="block">
            <span className="font-mono text-xs uppercase tracking-[0.28em] text-brand-coal/70">
              Dialecto SQL
            </span>
            <select
              value={selectedDialect}
              onChange={handleDialectChange}
              className="mt-3 block w-full rounded-xl border border-brand-coal/20 bg-brand-sand/70 p-3 text-sm text-brand-coal outline-none transition focus:border-brand-sky"
            >
              <option value="postgresql">postgresql</option>
              <option value="mysql">mysql</option>
              <option value="mariadb">mariadb</option>
            </select>
          </label>

          <label className="block">
            <span className="font-mono text-xs uppercase tracking-[0.28em] text-brand-coal/70">
              Region / Contexto
            </span>
            <select
              value={selectedRegion}
              onChange={handleRegionChange}
              className="mt-3 block w-full rounded-xl border border-brand-coal/20 bg-brand-sand/70 p-3 text-sm text-brand-coal outline-none transition focus:border-brand-sky"
            >
              <option value="Latinoamerica">Latinoamerica</option>
              <option value="Norteamerica">Norteamerica</option>
              <option value="Europa">Europa</option>
            </select>
          </label>

          <label className="block">
            <span className="font-mono text-xs uppercase tracking-[0.28em] text-brand-coal/70">
              Formato de salida
            </span>
            <select
              value={outputFormat}
              onChange={handleOutputFormatChange}
              className="mt-3 block w-full rounded-xl border border-brand-coal/20 bg-brand-sand/70 p-3 text-sm text-brand-coal outline-none transition focus:border-brand-sky"
            >
              <option value="json">json</option>
              <option value="sql">sql</option>
            </select>
          </label>

          <label className="block">
            <span className="font-mono text-xs uppercase tracking-[0.28em] text-brand-coal/70">
              Cantidad de Registros por Tabla
            </span>
            <input
              type="number"
              min={MIN_ROW_COUNT}
              max={MAX_ROW_COUNT}
              step={1}
              value={rowCount}
              onChange={handleRowCountChange}
              className="mt-3 block w-full rounded-xl border border-brand-coal/20 bg-brand-sand/70 p-3 text-sm text-brand-coal outline-none transition focus:border-brand-sky"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-brand-coal/70">
            {file ? `Seleccionado: ${file.name}` : 'Ningun archivo seleccionado.'}
          </p>

          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex items-center justify-center rounded-xl bg-brand-coal px-5 py-3 font-mono text-xs uppercase tracking-[0.2em] text-brand-sand transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? 'Procesando...' : 'Subir SQL'}
          </button>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-brand-rust/35 bg-brand-rust/10 px-3 py-2 text-sm text-brand-rust">
            {error}
          </p>
        ) : null}

        {downloadMessage ? (
          <p className="mt-4 rounded-lg border border-brand-moss/35 bg-brand-moss/10 px-3 py-2 text-sm text-brand-moss">
            {downloadMessage}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function resolveFileName(
  contentDisposition: string | null,
  outputFormat: OutputFormat,
): string {
  // Si el backend no envía filename, se usa un nombre de respaldo coherente con el formato.
  if (typeof contentDisposition === 'string') {
    const match = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (match && typeof match[1] === 'string' && match[1].trim().length > 0) {
      return match[1];
    }
  }

  return `datos_generados.${outputFormat}`;
}
