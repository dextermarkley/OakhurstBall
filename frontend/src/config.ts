// Reads the runtime config injected by /config.js (window.OAKHURST_CONFIG).
export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  venmoHandle: string;
  /** 'prod', or a test stage like 'alpha' (shown as a badge). */
  stage?: string;
}

declare global {
  interface Window {
    OAKHURST_CONFIG?: AppConfig;
  }
}

export const config: AppConfig = window.OAKHURST_CONFIG ?? {
  apiUrl: '', // same origin: the site and API share the API Gateway domain
  region: 'us-east-2',
  userPoolId: 'REPLACE_ME',
  userPoolClientId: 'REPLACE_ME',
  venmoHandle: 'oakhurst-basketball',
};

export const stage = config.stage ?? 'prod';
export const isProd = stage === 'prod';

export const money = (cents: number): string =>
  `$${(Math.abs(cents) / 100).toFixed(2)}`;
