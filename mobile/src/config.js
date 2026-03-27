import { Platform } from 'react-native';

// Production — Cloudflare tunnel subdomain
const PRODUCTION_URL = 'https://samadhan.rgod.tech';

const devFallback = Platform.select({
  android: 'http://10.0.2.2:3000',
  ios:     'http://localhost:3000',
  default: 'http://localhost:3000',
});

// EXPO_PUBLIC_BASE_URL in .env overrides (set __DEV__ local URL there during dev)
export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_BASE_URL || (__DEV__ ? devFallback : PRODUCTION_URL)
).replace(/\/$/, '');
