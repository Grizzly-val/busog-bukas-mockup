import type { Metadata } from 'next';
import { Poppins } from 'next/font/google';
import 'bootstrap/dist/css/bootstrap.min.css';
import './globals.css';
import TopNavbar from '@/components/TopNavbar';
import FooterDisclaimer from '@/components/FooterDisclaimer';
import BootstrapClient from '@/components/BootstrapClient';

const poppins = Poppins({
  variable: '--font-poppins',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Busog Bukas · Feeding Program Mockup',
  description: 'Visualization mockup of Busog Bukas, a feeding-program management SaaS for LGUs and schools.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={poppins.variable}>
      <body>
        <div className="bb-page">
          <TopNavbar />
          <main className="bb-main container py-4">{children}</main>
          <FooterDisclaimer />
        </div>
        <BootstrapClient />
      </body>
    </html>
  );
}
