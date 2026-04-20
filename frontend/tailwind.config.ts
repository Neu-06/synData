import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/app/**/*.{ts,tsx}', './src/components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          sand: '#F4EFE7',
          coal: '#1E1B18',
          rust: '#C75C34',
          moss: '#4F6D3A',
          sky: '#5DA9E9',
        },
      },
      fontFamily: {
        heading: ['var(--font-heading)'],
        mono: ['var(--font-mono)'],
      },
      boxShadow: {
        panel: '0 24px 80px -38px rgba(17, 24, 39, 0.45)',
      },
    },
  },
  plugins: [],
};

export default config;
