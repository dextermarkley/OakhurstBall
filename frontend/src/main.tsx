import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import '@/index.css';
import { config } from '@/config';
import { ConfirmProvider } from '@/components/confirm';
import { Toaster } from '@/components/ui/sonner';
import { Spinner } from '@/components/ui/spinner';
import { registerServiceWorker } from '@/pwa';
import { UpdateBanner } from '@/components/update-banner';

Amplify.configure({
  Auth: { Cognito: { userPoolId: config.userPoolId, userPoolClientId: config.userPoolClientId } },
});

// Each area loads on demand: the kiosk never downloads the admin charts.
/**
 * Load a page's code, retrying a couple of times: the very first visit can hit a
 * brief 503 while the service worker downloads everything in parallel. If it
 * still fails (e.g. this tab is running a version whose files were replaced by a
 * deploy), reload once to pick up the current version.
 */
async function loadWithRetry(load: () => Promise<Record<string, unknown>>) {
  for (let attempt = 0; ; attempt++) {
    try {
      const mod = await load();
      sessionStorage.removeItem('chunkReload');
      return mod;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      if (!sessionStorage.getItem('chunkReload')) {
        sessionStorage.setItem('chunkReload', '1');
        window.location.reload();
        await new Promise(() => {}); // wait for the reload
      }
      throw err;
    }
  }
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
      <UpdateBanner />
    </Suspense>
  );
};

const router = createBrowserRouter([
  { path: '/', element: page(() => import('@/views/Home'), 'Home') },
  { path: '/kiosk', element: page(() => import('@/views/Kiosk'), 'Kiosk') },
  { path: '/player', element: page(() => import('@/views/Player'), 'Player') },
  { path: '/admin', element: page(() => import('@/views/Admin'), 'Admin') },
  { path: '/chat', element: page(() => import('@/views/Chat'), 'Chat') },
  { path: '/confirm/:token', element: page(() => import('@/views/Confirm'), 'ConfirmPage') },
  { path: '/paid', element: page(() => import('@/views/Paid'), 'Paid') },
  { path: '*', element: <Navigate to="/" replace /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfirmProvider>
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors />
    </ConfirmProvider>
  </React.StrictMode>,
);

registerServiceWorker();
