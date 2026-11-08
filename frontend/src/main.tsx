import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import '@/index.css';
import { config, isProd, stage } from '@/config';
import { ConfirmProvider } from '@/components/confirm';
import { Toaster } from '@/components/ui/sonner';
import { Spinner } from '@/components/ui/spinner';
import { registerServiceWorker } from '@/pwa';
import { UpdateBanner } from '@/components/update-banner';
import { InstallBanner } from '@/components/install-banner';

Amplify.configure({
  Auth: { Cognito: { userPoolId: config.userPoolId, userPoolClientId: config.userPoolClientId } },
});

// Each area loads on demand: the kiosk never downloads the admin charts.
/**
 * Load a page's code. A failed load (a brief server hiccup, or a tab still
 * running a version whose files a deploy replaced) can't be retried in place,
 * because browsers remember the failure, so reload: up to 3 times a minute,
 * each a little later, then show the friendly error page.
 */
const RELOAD_KEY = 'chunkReloads';
async function loadWithRetry(load: () => Promise<Record<string, unknown>>) {
  try {
    const mod = await load();
    sessionStorage.removeItem(RELOAD_KEY);
    return mod;
  } catch (err) {
    const prev = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? 'null') as { n: number; t: number } | null;
    const n = prev && Date.now() - prev.t < 60_000 ? prev.n : 0;
    if (n < 3) {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ n: n + 1, t: Date.now() }));
      await new Promise((r) => setTimeout(r, [500, 2000, 5000][n]));
      window.location.reload();
      await new Promise(() => {}); // wait for the reload
    }
    throw err;
  }
}

/** Shown instead of React Router's developer error screen. */
function RouteError() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <img src="/pwa-192.png" alt="" className="size-14" />
      <div>
        <div className="text-lg font-semibold">This page didn’t load</div>
        <p className="mt-1 text-sm text-muted-foreground">Check your connection, then try again.</p>
      </div>
      <button
        type="button"
        onClick={() => {
          sessionStorage.removeItem(RELOAD_KEY);
          window.location.reload();
        }}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Try again
      </button>
    </div>
  );
}

const page = (load: () => Promise<Record<string, unknown>>, name: string) => {
  const C = lazy(async () => ({ default: (await loadWithRetry(load))[name] as React.ComponentType }));
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center" data-loading="route">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      }
    >
      <C />
      <InstallBanner />
      <UpdateBanner />
    </Suspense>
  );
};

const router = createBrowserRouter(
  [
    { path: '/', element: page(() => import('@/views/Home'), 'Home') },
    { path: '/kiosk', element: page(() => import('@/views/Kiosk'), 'Kiosk') },
    { path: '/player', element: page(() => import('@/views/Player'), 'Player') },
    { path: '/admin', element: page(() => import('@/views/Admin'), 'Admin') },
    { path: '/chat', element: page(() => import('@/views/Chat'), 'Chat') },
    { path: '/confirm/:token', element: page(() => import('@/views/Confirm'), 'ConfirmPage') },
    { path: '/paid', element: page(() => import('@/views/Paid'), 'Paid') },
    { path: '*', element: <Navigate to="/" replace /> },
  ].map((r) => ({ ...r, errorElement: <RouteError /> })),
);

// Test stages say so on every page, so nobody mistakes alpha for the real club.
if (!isProd) document.title = `[${stage.toUpperCase()}] ${document.title}`;
const StageBadge = () =>
  isProd ? null : (
    <div
      aria-label={`${stage} test site`}
      className="pointer-events-none fixed bottom-2 left-2 z-[60] rounded-md bg-amber-400 px-2 py-0.5 text-xs font-bold tracking-wide text-black uppercase shadow"
    >
      {stage} · test data
    </div>
  );

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfirmProvider>
      <StageBadge />
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors />
    </ConfirmProvider>
  </React.StrictMode>,
);

registerServiceWorker();
