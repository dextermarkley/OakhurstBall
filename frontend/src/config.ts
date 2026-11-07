// Reads the runtime config injected by /config.js (window.OAKHURST_CONFIG).
export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  venmoHandle: string;
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

export const money = (cents: number): string =>
  `$${(Math.abs(cents) / 100).toFixed(2)}`;
