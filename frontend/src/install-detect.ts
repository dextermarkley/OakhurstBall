// Which phone + browser this is, for the install instructions. Pure, so it can be
// unit tested (test/install.test.mjs).

/** Where to point the instructions. */
export type InstallKind =
  | 'ios-safari' // Share → Add to Home Screen
  | 'ios-other' // Chrome/Firefox/Edge on iPhone: Share in the address bar (iOS 16.4+)
  | 'android-chrome' // ⋮ → Install app (or the one-tap prompt)
  | 'android-samsung' // ≡ → Add page to → Home screen
  | 'android-firefox' // ⋮ → Install
  | 'android-other'
  | 'in-app' // Instagram/Facebook/Gmail etc. browser: can't install, open in a real browser
  | 'none'; // not a phone

export function detectInstallKind(ua: string = navigator.userAgent): InstallKind {
  const iPhone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua) && /Mobile/.test(ua);
  if (!iPhone && !android) return 'none';
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|LinkedInApp|Twitter|GSA\/|; wv\)|MicroMessenger/.test(ua)) return 'in-app';
  if (iPhone) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (/SamsungBrowser/.test(ua)) return 'android-samsung';
  if (/Firefox/.test(ua)) return 'android-firefox';
  if (/Chrome/.test(ua) && !/EdgA|OPR|YaBrowser/.test(ua)) return 'android-chrome';
  return 'android-other';
}
