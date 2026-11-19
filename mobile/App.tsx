import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as Speech from 'expo-speech';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, Linking, Pressable, SafeAreaView, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';

type Product = {
  name?: string; arabic_label?: string; trade_name?: string; scientific_name?: string;
  active_ingredients?: string[]; reported_active?: string; strength?: string; dosage_form?: string;
  manufacturer?: string; country: string; market_status?: string; record_id?: string;
  source_id?: string; source_url: string; retrieved_on: string; evidence?: string[]; verified?: boolean;
};
type Recognition = {
  id: string; status: 'IDENTIFIED' | 'NEEDS_CONFIRMATION' | 'NOT_IDENTIFIED';
  extracted_text: string; candidates: Product[]; user_selected_product?: Product;
};
type SearchResponse = {
  verified_products: Product[]; community_candidates?: Product[]; official_directory?: string | null;
};

const endpoint = (process.env.EXPO_PUBLIC_SMARTMED_API_URL ?? 'http://10.0.2.2:8000').replace(/\/$/, '');
const markets = {
  AE: 'الإمارات', BH: 'البحرين', DJ: 'جيبوتي', DZ: 'الجزائر', EG: 'مصر', IQ: 'العراق',
  JO: 'الأردن', KM: 'جزر القمر', KW: 'الكويت', LB: 'لبنان', LY: 'ليبيا', MA: 'المغرب',
  MR: 'موريتانيا', OM: 'عُمان', PS: 'فلسطين', QA: 'قطر', SA: 'السعودية', SD: 'السودان',
  SO: 'الصومال', SY: 'سوريا', TN: 'تونس', YE: 'اليمن',
};
type Country = keyof typeof markets;
const statuses = {
  IDENTIFIED: 'مطابقة قوية', NEEDS_CONFIRMATION: 'اختر المرشح بعد التحقق من العبوة',
  NOT_IDENTIFIED: 'تعذّر التعرف على المنتج',
};
const evidenceLabels: Record<string, string> = {
  trade_name: 'الاسم التجاري', scientific_name: 'الاسم العلمي', dosage_form: 'الشكل الصيدلاني',
  manufacturer: 'المصنّع', active_ingredients: 'المواد الفعالة', strength: 'التركيز',
  catalogue_label: 'اسم من الفهرس المصري',
  catalogue_name_word: 'كلمة مشتركة مع اسم من الفهرس المصري',
};

function Button({ label, onPress, disabled = false }: {
  label: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
      style={[styles.button, disabled && styles.disabled]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function ProductCard({ product, choose }: { product: Product; choose?: () => void }) {
  const name = product.arabic_label || product.trade_name || product.name || 'منتج';
  const market = markets[product.country as Country] || product.country;
  const fields = [
    product.market_status === 'registered' ? 'مسجل حسب المصدر'
      : product.market_status === 'availability_documented' ? 'التوفر موثّق حسب المصدر'
      : 'مرشح من الفهرس المصري',
    product.scientific_name && `الاسم العلمي • ${product.scientific_name}`,
    product.active_ingredients?.length && `المواد الفعالة • ${product.active_ingredients.join('، ')}`,
    product.reported_active && `المواد المذكورة في الفهرس • ${product.reported_active}`,
    product.strength && `التركيز • ${product.strength}`,
    product.dosage_form && `الشكل الصيدلاني • ${product.dosage_form}`,
    product.manufacturer && `المصنّع • ${product.manufacturer}`,
  ].filter(Boolean);
  return (
    <View style={styles.card}>
      <Text style={styles.subtitle}>{name}</Text>
      <Text style={styles.copy}>{[market, ...fields].join('\n')}</Text>
      {product.evidence?.length ? (
        <Text style={styles.copy}>الأدلة • {product.evidence.map(key => evidenceLabels[key] || key).join('، ')}</Text>
      ) : null}
      <Text style={styles.copy}>تاريخ جلب المصدر • {product.retrieved_on}</Text>
      <View style={styles.actions}>
        <Button label="المصدر" onPress={() => { void Linking.openURL(product.source_url).catch(() => {}); }} />
        <Button label="استمع" onPress={() => {
          void Speech.stop();
          Speech.speak([name, market, ...fields].join('. '), { language: 'ar' });
        }} />
        {choose ? <Button label="اختيار المرشح" onPress={choose} /> : null}
      </View>
    </View>
  );
}

export default function App() {
  const [device, setDevice] = useState('');
  const [country, setCountry] = useState<Country>('EG');
  const [query, setQuery] = useState('');
  const [image, setImage] = useState<ImagePicker.ImagePickerAsset>();
  const [results, setResults] = useState<Product[]>([]);
  const [directory, setDirectory] = useState<string | null>();
  const [recognition, setRecognition] = useState<Recognition>();
  const [history, setHistory] = useState<Recognition[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      const stored = await AsyncStorage.getItem('smartmed-device');
      const id = stored || randomUUID();
      if (!stored) await AsyncStorage.setItem('smartmed-device', id);
      setDevice(id);
    })().catch(() => setMessage('تعذّر تهيئة سجل هذا الجهاز'));
  }, []);

  async function api<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${endpoint}/api/v1${path}`, {
      ...options, headers: { 'X-Device-Id': device, ...options?.headers },
    });
    if (!response.ok) {
      const body: { detail?: unknown } = await response.json().catch(() => ({}));
      throw new Error(typeof body.detail === 'string' ? body.detail : 'تعذّر إتمام الطلب');
    }
    return response.json() as Promise<T>;
  }

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await step();
    } catch (error) {
      setMessage(error instanceof Error && error.message !== 'Network request failed'
        ? error.message : 'تعذّر الاتصال بالخادم');
    } finally {
      setBusy(false);
    }
  }

  async function pick(camera: boolean) {
    if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      setMessage('اسمح باستخدام الكاميرا من إعدادات الهاتف');
      return;
    }
    const selected = camera
      ? await ImagePicker.launchCameraAsync({ quality: 0.85 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (!selected.canceled) {
      setImage(selected.assets[0]);
      setRecognition(undefined);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>SmartMed</Text>
        <Text style={styles.copy}>ابحث حسب السوق أو التقط صورة للعبوة. تحقق من الاسم والتركيز على العبوة قبل الاعتماد على أي نتيجة.</Text>
        <Text style={styles.subtitle}>السوق • {markets[country]}</Text>
        <ScrollView horizontal contentContainerStyle={styles.actions}>
          {Object.entries(markets).map(([code, label]) => (
            <Button key={code} label={label} disabled={busy || code === country} onPress={() => {
              setCountry(code as Country);
              setResults([]);
              setDirectory(undefined);
              setRecognition(undefined);
              setMessage('');
            }} />
          ))}
        </ScrollView>
        <TextInput accessibilityLabel="اسم الدواء أو المادة الفعالة" placeholder="اسم الدواء أو المادة الفعالة"
          style={styles.input} value={query} maxLength={160} onChangeText={setQuery} />
        <View style={styles.actions}>
          <Button label="بحث" disabled={busy || !query.trim()} onPress={() => { void run(async () => {
            setResults([]);
            setDirectory(undefined);
            const data = await api<SearchResponse>(`/medicines/search?country=${country}&q=${encodeURIComponent(query.trim())}&include_candidates=true`);
            const found = [...data.verified_products, ...(data.community_candidates || [])];
            setResults(found);
            setDirectory(data.official_directory);
            if (!found.length) setMessage('لا توجد نتائج لهذا البحث في السوق المحدد');
          }); }} />
          <Button label="الكاميرا" disabled={busy} onPress={() => { void run(() => pick(true)); }} />
          <Button label="معرض الصور" disabled={busy} onPress={() => { void run(() => pick(false)); }} />
          <Button label="سجل التعرف" disabled={busy || !device} onPress={() => { void run(async () => {
            const entries = await api<Recognition[]>('/history');
            setHistory(entries);
            if (!entries.length) setMessage('سجل التعرف فارغ');
          }); }} />
        </View>
        {image ? (
          <>
            <Image source={{ uri: image.uri }} style={styles.preview} resizeMode="contain" accessibilityLabel="صورة العبوة" />
            <Button label="قراءة الصورة" disabled={busy || !device} onPress={() => { void run(async () => {
              setRecognition(undefined);
              const form = new FormData();
              form.append('image', {
                uri: image.uri, name: image.fileName || 'package.jpg', type: image.mimeType || 'image/jpeg',
              } as unknown as Blob);
              setRecognition(await api<Recognition>(`/recognition?country=${country}`, {
                method: 'POST', body: form,
              }));
            }); }} />
          </>
        ) : null}
        {busy ? <ActivityIndicator accessibilityLabel="جارٍ العمل" /> : null}
        {message ? <Text accessibilityLiveRegion="polite" style={styles.copy}>{message}</Text> : null}
        {directory ? <Button label="افتح دليل الجهة الرقابية" onPress={() => {
          void Linking.openURL(directory).catch(() => setMessage('تعذّر فتح الدليل الرسمي'));
        }} /> : null}
        {history.map((item, i) => (
          <Button key={item.id} label={`${i + 1}. ${statuses[item.status]}`} disabled={busy}
            onPress={() => setRecognition(item)} />
        ))}
        {recognition ? (
          <>
            <Text style={styles.subtitle}>{statuses[recognition.status]}</Text>
            {recognition.extracted_text ? <Text style={styles.copy}>{recognition.extracted_text}</Text> : null}
            {recognition.user_selected_product ? <Text style={styles.copy}>
              اختيارك • {recognition.user_selected_product.trade_name || recognition.user_selected_product.name}
            </Text> : null}
            {recognition.candidates.map((product, index) => (
              <ProductCard key={index} product={product} choose={busy ? undefined : () => { void run(async () => {
                setRecognition(await api<Recognition>(`/recognition/${recognition.id}/confirm`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ candidate_index: index }),
                }));
              }); }} />
            ))}
          </>
        ) : null}
        {results.map((product, index) => <ProductCard key={index} product={product} />)}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f2f7f6' },
  page: { padding: 22, gap: 14, paddingBottom: 42, paddingTop: 44 },
  title: { fontSize: 35, fontWeight: '800', color: '#113e39', textAlign: 'right' },
  subtitle: { fontSize: 20, fontWeight: '700', color: '#113e39', textAlign: 'right' },
  copy: { fontSize: 16, lineHeight: 25, color: '#25433f', textAlign: 'right', writingDirection: 'rtl' },
  input: { backgroundColor: '#fff', borderColor: '#a5bcb8', borderWidth: 1, padding: 13,
    borderRadius: 9, textAlign: 'right', fontSize: 16 },
  actions: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  button: { backgroundColor: '#115851', borderRadius: 9, padding: 11, minHeight: 44, justifyContent: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  disabled: { opacity: 0.5 },
  card: { padding: 15, backgroundColor: '#fff', borderRadius: 12, gap: 8 },
  preview: { height: 210, width: '100%', borderRadius: 10 },
});
