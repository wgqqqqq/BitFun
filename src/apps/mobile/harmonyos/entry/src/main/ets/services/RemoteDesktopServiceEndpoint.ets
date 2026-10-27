import { url } from '@kit.ArkTS';
import { OFFICIAL_RELAY_URL } from './AccountDeviceLink';

/** Only a separately deployed service may receive remote desktop credentials. */
export function normalizeRemoteDesktopServiceUrl(value: string): string {
  if (value.length > 2048) return '';
  try {
    const endpoint = url.URL.parseURL(value.trim());
    const official = url.URL.parseURL(OFFICIAL_RELAY_URL);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.hostname
      || endpoint.hostname.toLowerCase() === official.hostname.toLowerCase()) return '';
    const host = endpoint.hostname.toLowerCase();
    const local = host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) return '';
    return endpoint.toString().replace(/\/+$/, '');
  } catch (_error) { return ''; }
}
