"""SmartMed API. Recognition history is scoped to a device-generated UUID."""

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from typing import Literal
from uuid import UUID, uuid4

from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.recognition import MAX_BYTES, OCRUnavailable, extract_text, ocr_languages, rank
from smartmed import ARAB_MARKETS, SCHEMA, normalize, search

app = FastAPI(title='SmartMed', version='1.2.0')
DB = Path(os.environ.get('SMARTMED_DB', 'smartmed.sqlite'))
API = '/api/v1'
MARKET_DIRECTORIES = {
    'AE': 'https://services.ede.gov.ae/drugdirectory?lang=en-US',
    'EG': 'https://eservices.edaegypt.gov.eg/EDASearch/SearchRegDrugs.aspx',
    'SA': 'https://www.sfda.gov.sa/en/drugs-list',
}
HISTORY = """
CREATE TABLE IF NOT EXISTS recognition_history (
    id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def database():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA + HISTORY)
    db.create_function('normalize', 1, normalize, deterministic=True)
    return db


def market(country):
    country = country.upper()
    if country not in ARAB_MARKETS:
        raise HTTPException(422, 'رمز سوق غير مدعوم')
    return country


def verified(row):
    product = dict(row)
    product['active_ingredients'] = json.loads(product['active_ingredients'])
    return product


@app.get(API + '/health')
def health():
    with closing(database()) as db:
        catalogue_records = db.execute('SELECT COUNT(*) FROM candidates').fetchone()[0]
    ocr_error = None
    try:
        languages = ocr_languages()
        if not languages:
            ocr_error = 'ملفات لغات التعرّف غير موجودة على الكمبيوتر.'
    except OCRUnavailable as exc:
        languages = []
        ocr_error = str(exc)
    return {'status': 'ok', 'catalogue_records': catalogue_records,
            'ocr_languages': languages, 'ocr_error': ocr_error}


@app.get(API + '/medicines/search')
def medicines(country: str, q: str = Query(min_length=1, max_length=160),
              include_candidates: bool = False):
    country = market(country)
    if not q.strip():
        raise HTTPException(422, 'أدخل اسمًا للبحث')
    with closing(database()) as db:
        result = search(db, country, q, include_candidates)
        term = normalize(q.strip())
        rows = db.execute("""
            SELECT * FROM verified_products WHERE country=? AND
            (instr(normalize(coalesce(scientific_name, '')), ?) > 0 OR
             instr(normalize(active_ingredients), ?) > 0)
            ORDER BY trade_name, record_id, retrieved_on DESC LIMIT 50
        """, (country, term, term))
        known = {(p['record_id'], p['source_url'], p['retrieved_on'])
                 for p in result['verified_products']}
        for row in rows:
            key = (row['record_id'], row['source_url'], row['retrieved_on'])
            if key not in known:
                result['verified_products'].append(verified(row))
        result['verified_products'] = result['verified_products'][:50]
        return dict(result, official_directory=MARKET_DIRECTORIES.get(country))


@app.get(API + '/medicines/{product_id}')
def product(product_id: str, country: str):
    with closing(database()) as db:
        rows = db.execute("""
            SELECT * FROM verified_products WHERE country=? AND record_id=?
            ORDER BY retrieved_on DESC, source_url
        """, (market(country), product_id)).fetchall()
    if not rows:
        raise HTTPException(404, 'لم يوجد سجل رسمي لهذا المنتج')
    return {'observations': [verified(row) for row in rows]}


@app.post(API + '/recognition')
def recognize(country: str, image: UploadFile = File(), x_device_id: UUID = Header(),
              language: Literal['auto', 'ara', 'eng'] = 'auto'):
    country = market(country)
    try:
        extracted = extract_text(image.file.read(MAX_BYTES + 1), language)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OCRUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except (subprocess.SubprocessError, OSError, RuntimeError, ImportError) as exc:
        raise HTTPException(503, 'تعذّرت قراءة النص من الصورة') from exc
    with closing(database()) as db, db:
        products = (verified(row) for row in db.execute(
            'SELECT * FROM verified_products WHERE country=?', (country,)))
        candidates = (dict(row) for row in db.execute(
            'SELECT * FROM candidates WHERE country=?', (country,)))
        text = extracted['extracted_text']
        result = rank(text, products, candidates, extracted['package_count']) if text else rank('', (), ())
        result.update(id=str(uuid4()), country=country, **extracted)
        db.execute('INSERT INTO recognition_history(id, device, payload) VALUES (?, ?, ?)',
                   (result['id'], str(x_device_id), json.dumps(result, ensure_ascii=False)))
    return result


def history_item(db, recognition_id, device):
    row = db.execute('SELECT payload FROM recognition_history WHERE id=? AND device=?',
                     (str(recognition_id), str(device))).fetchone()
    if not row:
        raise HTTPException(404, 'عملية التعرف غير موجودة')
    return json.loads(row['payload'])


@app.get(API + '/history')
def history(x_device_id: UUID = Header()):
    with closing(database()) as db:
        return [json.loads(row['payload']) for row in db.execute("""
            SELECT payload FROM recognition_history WHERE device=?
            ORDER BY created_at DESC, rowid DESC LIMIT 50
        """, (str(x_device_id),))]


@app.get(API + '/history/{recognition_id}')
def history_details(recognition_id: UUID, x_device_id: UUID = Header()):
    with closing(database()) as db:
        return history_item(db, recognition_id, x_device_id)


class Confirmation(BaseModel):
    candidate_index: int = Field(ge=0, le=9)


@app.post(API + '/recognition/{recognition_id}/confirm')
def confirm(recognition_id: UUID, selection: Confirmation, x_device_id: UUID = Header()):
    with closing(database()) as db, db:
        db.execute('BEGIN IMMEDIATE')
        result = history_item(db, recognition_id, x_device_id)
        if selection.candidate_index >= len(result['candidates']):
            raise HTTPException(422, 'المرشح غير موجود')
        result['user_selected_product'] = result['candidates'][selection.candidate_index]
        db.execute('UPDATE recognition_history SET payload=? WHERE id=? AND device=?',
                   (json.dumps(result, ensure_ascii=False), str(recognition_id), str(x_device_id)))
    return result


web_bundle = Path(__file__).resolve().parents[1] / 'mobile' / 'dist'
if (web_bundle / 'index.html').is_file():
    app.mount('/', StaticFiles(directory=web_bundle, html=True), name='smartmed-web')
