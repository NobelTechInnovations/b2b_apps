import { Inter } from 'next/font/google';
import { ToastProvider } from '@/components/ui/toast';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata = {
  title: { default: 'Nexus', template: '%s · Nexus' },
  description: 'One workspace. Only the apps your business actually needs.',
};

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1017' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * Theme is resolved before first paint so there is never a flash of the wrong
 * colour scheme. Deliberately inline and synchronous.
 */
const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('nexus-theme');
    var system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = stored === 'system' || !stored ? system : stored;
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={inter.variable}>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
