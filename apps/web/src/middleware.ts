import createMiddleware from 'next-intl/middleware';
import { defaultLocale, locales } from './i18n';

export default createMiddleware({
  locales: [...locales],
  defaultLocale
});

// matcher: mos e prek /api, /_next, fajllat statik
export const config = {
  matcher: ['/((?!api|_next|.*\\..*).*)']
};
