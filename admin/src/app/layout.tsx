import type { Metadata } from 'next';
import './globals.css';

const brand = process.env.NEXT_PUBLIC_BRAND ?? 'EvoLights';

export const metadata: Metadata = {
  title: `${brand} Admin`,
  description: `Operator console for ${brand} cloud`,
  // Private console — never index, never link-preview.
  robots: 'noindex,nofollow',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
