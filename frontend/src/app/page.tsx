import { SqlUploadPanel } from '@/components/sql-upload-panel';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-4 py-10 sm:px-8 sm:py-14">
      <section className="panel-grid w-full rounded-3xl border border-brand-coal/20 bg-white/80 p-6 shadow-panel backdrop-blur sm:p-10">
        <p className="font-mono text-xs uppercase tracking-[0.35em] text-brand-rust">
          SynData
        </p>

        <h1 className="mt-3 text-3xl font-semibold leading-tight sm:text-5xl">
          Generador sintetico de datos
          <span className="block text-brand-moss">con integridad referencial</span>
        </h1>

        {/* <p className="mt-4 max-w-2xl text-sm text-brand-coal/75 sm:text-base">
          Creando Datos Sintéticos con Énfasis.
        </p> */}

        <div className="mt-8">
          <SqlUploadPanel />
        </div>
      </section>
    </main>
  );
}
