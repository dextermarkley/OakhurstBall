// Camera QR scanner (rear camera, jsQR decode). Works inside a Home Screen web
// app, where links opened by the iOS Camera app would land in Safari instead.
// getUserMedia requires HTTPS, which the site always is.
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { CameraOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function QrScanner({ onResult, onCancel }: { onResult: (text: string) => boolean; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function scan() {
      if (stopped) return;
      const v = video.current;
      if (v && ctx && v.readyState === v.HAVE_ENOUGH_DATA) {
        // Decode a downscaled frame: plenty for a QR held up to the camera, and fast.
        const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data && onResult(code.data)) {
          stopped = true;
          return;
        }
      }
      raf = requestAnimationFrame(scan);
    }

    if (!navigator.mediaDevices) setError('This browser has no camera access.');
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = video.current!;
        v.srcObject = s;
        v.setAttribute('playsinline', 'true'); // iOS: don't go fullscreen
        return v.play().then(() => {
          raf = requestAnimationFrame(scan);
        });
      })
      .catch((e) =>
        setError(
          e?.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow the camera for this site in Settings → Safari → Camera.'
            : 'Could not start the camera on this device.',
        ),
      );

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="text-center">
      {error ? (
        <div className="py-8">
          <CameraOff className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      ) : (
        <>
          <div className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-2xl bg-black">
            <video ref={video} muted playsInline className="size-full object-cover" />
            {/* framing guide */}
            <div className="pointer-events-none absolute inset-[15%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">Point the camera at the pairing QR code.</p>
        </>
      )}
      <Button variant="ghost" className="mt-3" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
