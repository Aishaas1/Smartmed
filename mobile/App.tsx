import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as Speech from 'expo-speech';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, Linking, Platform, Pressable, SafeAreaView, ScrollView,
  StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';

import { Catalogue, defaultEndpoint, Health, MARKET, Product, Recognition, request, sanitizeEndpoint } from './api';

const colors = {
  background: '#F1F7F5', ink: '#102E29', muted: '#4D655F', deep: '#063D35',
  green: '#0F6455', bright: '#C6F1C5', white: '#FFFFFF', line: '#D6E5DF', amber: '#7D4A17',
};
const statuses = {
  IDENTIFIED: 'مطابقة قوية', NEEDS_CONFIRMATION: 'راجع المنتجات المقترحة',
  NOT_IDENTIFIED: 'تعذّر التعرّف على العبوة',
};
const evidenceLabels: Record<string, string> = {
  trade_name: 'الاسم التجاري', scientific_name: 'الاسم العلمي', dosage_form: 'الشكل الصيدلاني',
  manufacturer: 'المصنّع', active_ingredients: 'المواد الفعالة', strength: 'التركيز',
  catalogue_label: 'اسم من الفهرس', catalogue_name_word: 'كلمة مشتركة مع الاسم',
};
type Icon = React.ComponentProps<typeof Ionicons>['name'];
type Screen = 'home' | 'search' | 'history' | 'connection';

function Action({ label, icon, onPress, secondary = false, disabled = false }: {
  label: string; icon: Icon; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} onPress={onPress}
      disabled={disabled} style={({ pressed }) => [
        styles.action, secondary && styles.secondary, (pressed || disabled) && styles.dim,
      ]}>
      <Ionicons name={icon} size={20} color={secondary ? colors.green : colors.deep} />
      <Text style={[styles.actionText, secondary && styles.secondaryText]}>{label}</Text>
    </Pressable>
  );
}

function ProductCard({ product, choose, selected, onError }: {
  product: Product; choose?: () => void; selected?: boolean; onError: (message: string) => void;
}) {
  const name = product.arabic_label || product.trade_name || product.name || 'دواء';
  const fields = [
    ['الاسم التجاري', product.trade_name], ['الاسم العلمي', product.scientific_name],
    ['المواد الفعالة', product.active_ingredients?.join('، ') || product.reported_active],
    ['التركيز', product.strength], ['الشكل الصيدلاني', product.dosage_form], ['المصنّع', product.manufacturer],
    ['الشركة المذكورة في الفهرس', product.reported_company],
  ].filter(([, value]) => value);
  const evidence = Array.isArray(product.evidence) ? product.evidence : [];
  return (
    <View style={[styles.card, selected && styles.selected]}>
      <View style={styles.productHeading}>
        <View style={styles.productIcon}><Ionicons name="medical-outline" size={22} color={colors.green} /></View>
        <View style={styles.grow}>
          <Text style={styles.productName}>{name}</Text>
          <Text style={styles.caption}>{selected ? 'اختيارك' : product.market_status ? 'سجل موثّق' : 'مرشح من الفهرس المصري'}</Text>
        </View>
      </View>
      {fields.map(([label, value]) => (
        <Text key={label} style={styles.copy}>{label} · {value}</Text>
      ))}
      {!!evidence.length && <Text style={styles.caption}>
        المطابقة · {evidence.map(key => evidenceLabels[key] || key).join('، ')}
      </Text>}
      <Text style={styles.caption}>تاريخ جلب المصدر · {product.retrieved_on}</Text>
      <View style={styles.row}>
        <Action secondary icon="link-outline" label="المصدر" onPress={() => {
          void Linking.openURL(product.source_url).catch(() => onError('تعذّر فتح رابط المصدر'));
        }} />
        <Action secondary icon="volume-medium-outline" label="استمع" onPress={() => {
          void Speech.stop().then(() => Speech.speak(
            [name, ...fields.map(([label, value]) => `${label} ${value}`)].join('. '),
            { language: 'ar', onError: () => onError('القراءة الصوتية غير متاحة على هذا الجهاز') },
          )).catch(() => onError('القراءة الصوتية غير متاحة على هذا الجهاز'));
        }} />
        {!!choose && <Action icon="checkmark-outline" label="اختيار" onPress={choose} />}
      </View>
    </View>
  );
}

export default function App() {
  const [device, setDevice] = useState('');
  const [screen, setScreen] = useState<Screen>('home');
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [serverInput, setServerInput] = useState('');
  const [health, setHealth] = useState<Health | null>();
  const [query, setQuery] = useState('');
  const [image, setImage] = useState<ImagePicker.ImagePickerAsset>();
  const [results, setResults] = useState<Product[]>([]);
  const [recognition, setRecognition] = useState<Recognition>();
  const [history, setHistory] = useState<Recognition[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    async function init() {
      let savedDevice: string | null = null;
      let savedServer: string | null = null;
      try {
        [savedDevice, savedServer] = await Promise.all([
          AsyncStorage.getItem('smartmed-device'), AsyncStorage.getItem('smartmed-server'),
        ]);
      } catch {}
      try {
        const id = savedDevice || randomUUID();
        if (active) {
          setDevice(id);
          if (savedServer) {
            setEndpoint(savedServer);
            setServerInput(savedServer);
          }
        }
        if (!savedDevice) await AsyncStorage.setItem('smartmed-device', id);
      } catch {
        if (active && !savedDevice) setMessage('تعذّر حفظ معرّف الجهاز أو تهيئته');
      }
    }
    void init();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setHealth(undefined);
    void request<Health>(endpoint, '/health', undefined, undefined, 5000).then(
      data => { if (active) setHealth(data.status === 'ok' ? data : null); },
      () => { if (active) setHealth(null); },
    );
    return () => { active = false; };
  }, [endpoint]);

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await step();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'تعذّر إتمام الطلب');
    } finally {
      setBusy(false);
    }
  }

  function navigate(target: Screen) {
    if (busy) return;
    setMessage('');
    setScreen(target);
    if (target === 'history' && device) {
      void run(async () => setHistory(await request<Recognition[]>(endpoint, '/history', device)));
    }
  }

  async function pick(camera: boolean) {
    if (camera && Platform.OS !== 'web' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      setMessage('اسمح باستخدام الكاميرا من إعدادات الهاتف');
      return;
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.85 };
    const response = camera ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    if (!response.canceled) {
      setImage(response.assets[0]);
      setRecognition(undefined);
    }
  }

  async function search() {
    setResults([]);
    const params = `country=${MARKET}&q=${encodeURIComponent(query.trim())}&include_candidates=true`;
    const data = await request<Catalogue>(endpoint, `/medicines/search?${params}`, device);
    const found = [...data.verified_products, ...(data.community_candidates || [])];
    setResults(found);
    if (!found.length) setMessage('ما وجدنا نتائج. جرّب الاسم كما يظهر على العبوة.');
  }

  async function recognize() {
    if (!image) return;
    setRecognition(undefined);
    const edit = ImageManipulator.manipulate(image.uri);
    if (Math.max(image.width, image.height) > 2000) {
      edit.resize(image.width >= image.height ? { width: 2000 } : { height: 2000 });
    }
    const rendered = await edit.renderAsync();
    const jpeg = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.86 });
    const form = new FormData();
    if (Platform.OS === 'web') {
      const blob = await fetch(jpeg.uri).then(res => res.blob());
      form.append('image', blob, 'package.jpg');
    } else {
      form.append('image', { uri: jpeg.uri, name: 'package.jpg', type: 'image/jpeg' } as unknown as Blob);
    }
    setRecognition(await request<Recognition>(endpoint, `/recognition?country=${MARKET}`, device,
      { method: 'POST', body: form }, 45000));
  }

  function choose(index: number) {
    if (!recognition) return;
    void run(async () => {
      const updated = await request<Recognition>(endpoint, `/recognition/${recognition.id}/confirm`, device, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_index: index }),
      });
      setRecognition(updated);
      setHistory(entries => entries.map(entry => entry.id === updated.id ? updated : entry));
    });
  }

  const nav: [Screen, string, Icon][] = [
    ['home', 'التعرّف', 'scan-outline'], ['search', 'البحث', 'search-outline'], ['history', 'السجل', 'time-outline'],
  ];
  const connectionLabel = health === undefined ? 'جارٍ الفحص' : health ? 'متصل' : 'غير متصل';
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <View style={styles.shell}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={styles.brandIcon}><Ionicons name="scan" size={24} color={colors.bright} /></View>
            <Text accessibilityRole="header" style={styles.brandName}>SmartMed</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="إعدادات الاتصال" onPress={() => navigate('connection')}
            style={styles.connection}>
            <View style={[styles.dot, health === null && styles.dotOffline]} />
            <Text style={styles.connectionText}>{connectionLabel}</Text>
            <Ionicons name="settings-outline" size={17} color={colors.green} />
          </Pressable>
        </View>
        <ScrollView key={screen} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {screen === 'home' && (
            <>
              <View style={styles.hero}>
                <View style={styles.heroArt} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <View style={styles.scanRing}><Ionicons name="scan-outline" size={103} color="#80BAA9" /></View>
                  <View style={styles.package}><Ionicons name="medical" size={34} color={colors.deep} /></View>
                  <View style={styles.spark}><Ionicons name="sparkles" size={17} color={colors.bright} /></View>
                </View>
                <Text accessibilityRole="header" style={styles.heroTitle}>اقرأ عبوة الدواء</Text>
                <Text style={styles.heroCopy}>صوّر الاسم على العبوة أو اختر صورة واضحة.</Text>
                <Action label="التقاط صورة" icon="camera-outline" disabled={busy} onPress={() => { void run(() => pick(true)); }} />
              </View>
              <Action secondary label="اختيار من المعرض" icon="images-outline" disabled={busy}
                onPress={() => { void run(() => pick(false)); }} />
              {image && (
                <View style={styles.card}>
                  <Image source={{ uri: image.uri }} style={styles.preview} resizeMode="contain" accessibilityLabel="صورة العبوة" />
                  <Action icon="scan-outline" label="قراءة الصورة" disabled={busy || !device}
                    onPress={() => { void run(recognize); }} />
                </View>
              )}
            </>
          )}
          {screen === 'search' && (
            <>
              <Text accessibilityRole="header" style={styles.heading}>ابحث عن دواء</Text>
              <Text style={styles.copy}>اكتب الاسم بالعربي أو بالإنجليزي كما يظهر على العبوة.</Text>
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={22} color={colors.green} />
                <TextInput accessibilityLabel="اسم الدواء" placeholder="اسم الدواء" placeholderTextColor={colors.muted}
                  value={query} onChangeText={setQuery} style={styles.searchInput} maxLength={160}
                  returnKeyType="search" onSubmitEditing={() => { if (!busy && query.trim()) void run(search); }} />
              </View>
              <Action icon="search-outline" label="بحث" disabled={busy || !query.trim()} onPress={() => { void run(search); }} />
              {results.map((product, index) => <ProductCard product={product} key={index} onError={setMessage} />)}
            </>
          )}
          {screen === 'history' && (
            <>
              <Text accessibilityRole="header" style={styles.heading}>سجل التعرّف</Text>
              {!busy && !history.length && <View style={styles.card}>
                <Text style={styles.copy}>ستظهر هنا نتائج قراءة الصور واختياراتك.</Text>
              </View>}
              {history.map(entry => (
                <Pressable accessibilityRole="button" key={entry.id} style={[styles.card, styles.productHeading]}
                  onPress={() => { setRecognition(entry); setScreen('home'); setImage(undefined); }}>
                  <View style={styles.productIcon}><Ionicons name="time-outline" size={24} color={colors.green} /></View>
                  <View style={styles.grow}>
                    <Text style={styles.productName}>{statuses[entry.status]}</Text>
                    <Text style={styles.caption} numberOfLines={2}>{entry.extracted_text || 'لم يُستخرج نص'}</Text>
                  </View>
                </Pressable>
              ))}
            </>
          )}
          {screen === 'connection' && (
            <>
              <Text accessibilityRole="header" style={styles.heading}>اتصال الخادم</Text>
              <View style={styles.card}>
                <Text style={styles.productName}>{connectionLabel}</Text>
                <Text selectable style={styles.ltr}>{endpoint}</Text>
                {health?.catalogue_records === 0 && <Text style={styles.notice}>الخادم يعمل. استورد ملف البيانات لتفعيل نتائج البحث.</Text>}
                {health?.ocr_languages && !health.ocr_languages.length && <Text style={styles.notice}>الخادم يعمل. ثبّت Tesseract لتفعيل قراءة الصور.</Text>}
                {!!health?.ocr_languages?.length && !health.ocr_languages.includes('ara') &&
                  <Text style={styles.notice}>قراءة الإنجليزية متاحة. أضف لغة ara في Tesseract لقراءة العربية.</Text>}
                <Text style={styles.copy}>إذا كنت تستخدم هاتفًا، اكتب عنوان IPv4 للكمبيوتر مع المنفذ 8000.</Text>
                <TextInput accessibilityLabel="عنوان الخادم" placeholder="http://192.168.1.10:8000"
                  placeholderTextColor={colors.muted} value={serverInput} onChangeText={setServerInput}
                  autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[styles.searchBox, styles.ltr]} />
                <Action label="فحص وحفظ الاتصال" icon="wifi-outline" disabled={busy} onPress={() => { void run(async () => {
                  const base = sanitizeEndpoint(serverInput);
                  const verified = await request<Health>(base, '/health', undefined, undefined, 5000);
                  if (verified.status !== 'ok') throw new Error('العنوان لا يشير إلى خادم SmartMed');
                  await AsyncStorage.setItem('smartmed-server', serverInput.trim() ? base : '');
                  setEndpoint(base);
                  setHealth(verified);
                  setMessage('تم الاتصال بخادم SmartMed');
                }); }} />
              </View>
            </>
          )}
          {busy && <ActivityIndicator color={colors.green} accessibilityLabel="جارٍ العمل" />}
          {message && <Text style={styles.notice} accessibilityLiveRegion="polite">{message}</Text>}
          {screen === 'home' && recognition && (
            <>
              <Text accessibilityRole="header" style={styles.heading}>{statuses[recognition.status]}</Text>
              <View style={styles.card}>
                <Text style={styles.caption}>النص المقروء</Text>
                <Text selectable style={styles.copy}>{recognition.extracted_text || 'لم يُقرأ نص واضح. جرّب صورة أقرب وبإضاءة جيدة.'}</Text>
              </View>
              {recognition.candidates.length > 0 && <Text style={styles.caption}>راجع الاسم والتركيز على العبوة قبل اختيار المرشح.</Text>}
              {recognition.candidates.map((product, index) => (
                <ProductCard key={index} product={product} choose={busy ? undefined : () => choose(index)}
                  onError={setMessage} selected={JSON.stringify(product) === JSON.stringify(recognition.user_selected_product)} />
              ))}
            </>
          )}
        </ScrollView>
        <View style={styles.nav}>
          {nav.map(([key, label, icon]) => (
            <Pressable key={key} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: screen === key }}
              onPress={() => navigate(key)} style={[styles.navItem, screen === key && styles.navActive]}>
              <Ionicons name={icon} size={22} color={screen === key ? colors.deep : colors.muted} />
              <Text style={styles.navText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  shell: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
  header: { paddingHorizontal: 20, paddingVertical: 11, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  brandIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.deep, alignItems: 'center', justifyContent: 'center' },
  brandName: { fontSize: 22, fontWeight: '800', color: colors.ink },
  connection: { flexDirection: 'row-reverse', alignItems: 'center', gap: 7, padding: 9, backgroundColor: colors.white, borderRadius: 20 },
  connectionText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  dotOffline: { backgroundColor: '#C47B34' },
  page: { padding: 20, gap: 14, paddingBottom: 24 },
  hero: { borderRadius: 28, backgroundColor: colors.deep, padding: 22, gap: 14, overflow: 'hidden' },
  heroArt: { height: 158, alignItems: 'center', justifyContent: 'center', backgroundColor: '#124D43', borderRadius: 19 },
  scanRing: { position: 'absolute', transform: [{ scale: 1.24 }] },
  package: { width: 62, height: 76, backgroundColor: colors.bright, borderRadius: 12, borderRightWidth: 8, borderRightColor: '#84C8A3',
    transform: [{ rotate: '-13deg' }], alignItems: 'center', justifyContent: 'center' },
  spark: { position: 'absolute', top: 30, right: '29%' },
  heroTitle: { fontSize: 31, fontWeight: '800', color: colors.white, textAlign: 'right' },
  heroCopy: { color: '#D4EBE5', fontSize: 16, lineHeight: 25, textAlign: 'right', writingDirection: 'rtl' },
  heading: { fontSize: 27, fontWeight: '800', color: colors.ink, textAlign: 'right' },
  copy: { fontSize: 16, lineHeight: 25, color: colors.ink, textAlign: 'right', writingDirection: 'rtl' },
  caption: { fontSize: 13, lineHeight: 21, color: colors.muted, textAlign: 'right', writingDirection: 'rtl' },
  notice: { padding: 13, borderRadius: 12, backgroundColor: '#F9EEDB', color: colors.amber, textAlign: 'right', fontSize: 15 },
  ltr: { textAlign: 'left', writingDirection: 'ltr', color: colors.ink },
  searchBox: { minHeight: 53, flexDirection: 'row-reverse', alignItems: 'center', gap: 10, paddingHorizontal: 14,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 15 },
  searchInput: { flex: 1, fontSize: 17, color: colors.ink, textAlign: 'right', paddingVertical: 12 },
  row: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  action: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: 47, paddingHorizontal: 13, borderRadius: 14, backgroundColor: colors.bright },
  secondary: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  actionText: { color: colors.deep, fontSize: 15, fontWeight: '700' },
  secondaryText: { color: colors.green },
  dim: { opacity: 0.55 },
  card: { padding: 15, backgroundColor: colors.white, borderRadius: 19, borderWidth: 1, borderColor: colors.line, gap: 10 },
  selected: { borderColor: colors.green },
  productHeading: { flexDirection: 'row-reverse', alignItems: 'center', gap: 11 },
  productIcon: { width: 43, height: 43, borderRadius: 13, backgroundColor: '#ECF6F1',
    alignItems: 'center', justifyContent: 'center' },
  productName: { color: colors.ink, fontSize: 17, fontWeight: '700', textAlign: 'right' },
  grow: { flex: 1 },
  preview: { height: 248, width: '100%', borderRadius: 13, backgroundColor: colors.background },
  nav: { flexDirection: 'row-reverse', gap: 5, padding: 8, marginHorizontal: 20, marginBottom: 9,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 19 },
  navItem: { alignItems: 'center', justifyContent: 'center', flex: 1, gap: 4, paddingVertical: 8, borderRadius: 13 },
  navActive: { backgroundColor: '#DDF1E8' },
  navText: { fontSize: 13, color: colors.ink, fontWeight: '600' },
});
