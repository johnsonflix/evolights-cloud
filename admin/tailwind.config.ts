import type { Config } from 'tailwindcss';

// Tailwind config kept intentionally minimal — the admin UI uses default
// utility classes only. Custom theme tokens go in src/app/globals.css.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand accent. The hex matches the EvoLights mark used in the
        // mobile app; keep in sync if marketing rebrand-rolls.
        brand: {
          DEFAULT: '#0ea5e9',
          dark:    '#0284c7',
        },
      },
    },
  },
  plugins: [],
};

export default config;
