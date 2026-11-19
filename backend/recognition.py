"""Text extraction and conservative candidate ranking."""

from functools import lru_cache
from io import BytesIO
import os
from pathlib import Path
import re
import subprocess
from threading import Lock
import unicodedata

from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError

from smartmed import normalize

MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000
TOKEN = re.compile(r'[^\W_]+', re.UNICODE)
STRENGTH = re.compile(
    r'(?<!\w)(\d+(?:[.,٫]\d+)?)\s*(mcg|mg|g|ml|iu|مجم|ملغ|مل|جم|%)(?!\w)', re.I
)
UNIT = {'مجم': 'mg', 'ملغ': 'mg', 'مل': 'ml', 'جم': 'g'}
DETECTOR_LOCK = Lock()


class OCRUnavailable(RuntimeError):
    pass


def tesseract_command():
    return os.environ.get('SMARTMED_TESSERACT') or 'tesseract'


@lru_cache(maxsize=1)
def ocr_languages():
    try:
        result = subprocess.run([tesseract_command(), '--list-langs'], capture_output=True,
                                text=True, check=True, timeout=5)
    except FileNotFoundError as exc:
        raise OCRUnavailable('محرك Tesseract غير مثبت. ثبّته على الكمبيوتر ثم أعد تشغيل SmartMed.') from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise OCRUnavailable('تعذّر تشغيل Tesseract. افحص التثبيت وملفات اللغة ثم أعد تشغيل SmartMed.') from exc
    installed = {line.strip() for line in result.stdout.splitlines()}
    return [lang for lang in ('ara', 'eng') if lang in installed]


@lru_cache(maxsize=1)
def detector(checkpoint):
    from ultralytics import YOLO

    if not Path(checkpoint).is_file():
        raise RuntimeError('Detector checkpoint is missing')
    return YOLO(checkpoint)


def package_region(image):
    checkpoint = os.environ.get('SMARTMED_YOLO_MODEL')
    if not checkpoint:
        return image, 'disabled', None
    with DETECTOR_LOCK:
        predictions = detector(checkpoint).predict(image.convert('RGB'), verbose=False)[0]
    packages = [
        [int(value) for value in box.xyxy[0].tolist()]
        for box in predictions.boxes
        if predictions.names[int(box.cls[0])].casefold() in {'kemasan', 'medicine_packaging'}
    ]
    if len(packages) == 1:
        x1, y1, x2, y2 = packages[0]
        if 0 <= x1 < x2 <= image.width and 0 <= y1 < y2 <= image.height:
            return image.crop((x1, y1, x2, y2)), 'cropped', len(packages)
    return image, 'full_image', len(packages)


def read_image(image, languages, layout):
    encoded = BytesIO()
    image.save(encoded, format='PNG')
    result = subprocess.run(
        [tesseract_command(), 'stdin', 'stdout', '-l', '+'.join(languages), '--psm', str(layout)],
        input=encoded.getvalue(), capture_output=True, check=True, timeout=14,
    )
    return result.stdout.decode('utf-8', errors='replace').strip()


def extract_text(data, language='auto'):
    if not data or len(data) > MAX_BYTES:
        raise ValueError('حجم الصورة خارج الحدود المسموحة')
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format not in {'PNG', 'JPEG', 'WEBP'}:
                raise ValueError('صيغة الصورة غير مدعومة')
            if source.width * source.height > MAX_PIXELS:
                raise ValueError('أبعاد الصورة أكبر من الحد المسموح')
            image = ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((2400, 2400))
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError('تعذّر قراءة الصورة') from exc
    languages = ocr_languages()
    if language != 'auto':
        if language not in languages:
            label = 'العربية (ara)' if language == 'ara' else 'الإنجليزية (eng)'
            raise OCRUnavailable(f'ملف لغة {label} غير متوفر في Tesseract على الكمبيوتر.')
        languages = [language]
    if not languages:
        raise OCRUnavailable('لم يجد Tesseract ملفات اللغة ara أو eng. أعد تشغيل حزمة SmartMed بعد تجهيزها.')
    image, detection, package_count = package_region(image)
    if 0 < max(image.size) < 1000:
        image = ImageOps.contain(image, (1000, 1000), Image.Resampling.LANCZOS)
    image = ImageOps.autocontrast(ImageOps.grayscale(image))
    text = read_image(image, languages, 11)
    if not any(char.isalnum() for char in text):
        enhanced = image.filter(ImageFilter.UnsharpMask(radius=1.5, percent=130, threshold=3))
        text = read_image(enhanced, languages, 6)
    if not any(char.isalnum() for char in text):
        text = ''
    return {
        'extracted_text': text[:6000],
        'ocr_languages': languages,
        'package_detection': detection,
        'package_count': package_count,
    }


def words(text):
    return TOKEN.findall(normalize(text))


def strengths(text):
    result = set()
    for number, unit in STRENGTH.findall(normalize(text)):
        digits = ''.join(str(unicodedata.decimal(ch)) if ch.isdecimal() else '.' for ch in number)
        result.add((digits, UNIT.get(unit, unit)))
    return result


def matches(text, value):
    needle = ' '.join(words(value or ''))
    return bool(needle and f' {needle} ' in f' {text} ')


def community_evidence(normalized, word_set, product):
    evidence = []
    for label in (product['name'], product['arabic_label']):
        if not label:
            continue
        if matches(normalized, label):
            return ['catalogue_label']
        tokens = words(label)
        if tokens and tokens[0].isalpha() and len(tokens[0]) >= 4 and tokens[0] in word_set:
            evidence = ['catalogue_name_word']
    return evidence


def rank(text, verified, community, package_count=None):
    tokens = words(text)
    normalized = ' '.join(tokens)
    word_set = set(tokens)
    observed_strength = strengths(text)
    candidates = []
    for product in verified:
        evidence = [
            key for key in ('trade_name', 'scientific_name', 'dosage_form', 'manufacturer')
            if matches(normalized, product[key])
        ]
        if not {'trade_name', 'scientific_name'}.intersection(evidence):
            continue
        if all(matches(normalized, value) for value in product['active_ingredients']):
            evidence.append('active_ingredients')
        expected_strength = strengths(product['strength'])
        if observed_strength and expected_strength and not expected_strength <= observed_strength:
            continue
        if expected_strength and expected_strength <= observed_strength:
            evidence.append('strength')
        candidates.append(dict(product, evidence=evidence, verified=True))
    for product in community:
        evidence = community_evidence(normalized, word_set, product)
        if evidence:
            candidates.append(dict(product, evidence=evidence, verified=False))
    candidates.sort(key=lambda item: (item['verified'], len(item['evidence'])), reverse=True)
    strong = [item for item in candidates if item['verified'] and
              {'trade_name', 'strength', 'dosage_form', 'manufacturer'} <= set(item['evidence'])]
    identified = strong[0] if len(strong) == len(candidates) == 1 and (
        package_count is None or package_count == 1
    ) else None
    status = 'IDENTIFIED' if identified else 'NEEDS_CONFIRMATION' if candidates else 'NOT_IDENTIFIED'
    return {'status': status, 'candidates': candidates[:10], 'matched_product': identified}
