import type { Metadata } from 'next';
import { IBM_Plex_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const headingFont = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-heading',
});

const monoFont = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'SynData MVP',
  description:
    'Plataforma DaaS para generar datos sinteticos desde esquemas SQL con integridad referencial.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body
        className={`${headingFont.variable} ${monoFont.variable} min-h-screen bg-brand-sand text-brand-coal antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
