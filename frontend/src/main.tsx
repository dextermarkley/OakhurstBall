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
const page = (load: () => Promise<Record<string, unknown>>, name: string) => {
  const C = lazy(async () => ({ default: (await load())[name] as React.ComponentType }));
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
