import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type Product = {
  name?: string; arabic_label?: string; trade_name?: string; scientific_name?: string;
  active_ingredients?: string[]; reported_active?: string; strength?: string; dosage_form?: string;
  manufacturer?: string; reported_company?: string; market_status?: string;
  source_url: string; retrieved_on: string; evidence?: string[] | string;
};
export type Recognition = {
  id: string; status: 'IDENTIFIED' | 'NEEDS_CONFIRMATION' | 'NOT_IDENTIFIED';
  extracted_text: string; candidates: Product[]; user_selected_product?: Product;
};
export type Catalogue = { verified_products: Product[]; community_candidates?: Product[] };
export type Health = { status: string; catalogue_records?: number; ocr_languages?: string[] };

export const MARKET = 'EG';

export function defaultEndpoint() {
  const configured = process.env.EXPO_PUBLIC_SMARTMED_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin;
  const metro = Constants.expoConfig?.hostUri;
  const host = metro?.match(/^(?:exp:\/\/|https?:\/\/)?(\[[^\]]+\]|[^:/]+)(?::\d+)?$/i)?.[1];
  if (host && !['localhost', '127.0.0.1'].includes(host) && !host.endsWith('.exp.direct')) {
    return `http://${host}:8000`;
  }
  return Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://127.0.0.1:8000';
}

export function sanitizeEndpoint(value: string) {
  const typed = value.trim();
  if (!typed) return defaultEndpoint();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(typed) ? typed : `http://${typed}`);
  } catch {
    throw new Error('تعذّر قراءة العنوان. مثال: http://192.168.1.10:8000');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('اكتب عنوان الخادم فقط، مثل http://192.168.1.10:8000');
  }
  return url.origin;
}

export async function request<T>(
  base: string, path: string, device?: string, options?: RequestInit, timeout = 12000,
): Promise<T> {
  const headers = new Headers(options?.headers);
  if (device) headers.set('X-Device-Id', device);
  const controller = new AbortController();
  const pending = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${base}/api/v1${path}`, {
      ...options, headers, signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload === null) {
      throw new Error(typeof payload?.detail === 'string' ? payload.detail : 'تعذّر إتمام الطلب. تحقق من عنوان خادم SmartMed.');
    }
    return payload as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('انتهت مهلة الاتصال. تحقق من تشغيل الخادم ثم أعد المحاولة.');
    if (error instanceof TypeError) throw new Error('تعذّر الوصول إلى الخادم. افتح إعدادات الاتصال وتحقق من العنوان.');
    throw error;
  } finally {
    clearTimeout(pending);
  }
}
