"""SmartMed's evidence-backed medicine catalogue (Python 3.10+)."""

import argparse
from collections import Counter
from contextlib import closing
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import unicodedata
from urllib.parse import urlsplit
from zipfile import ZipFile

EG_ROOT = 'https://github.com/mahmoudfalous/eg-drugs'
EG_MEMBER = 'eg-drugs-main/data/eg_drugs.csv'
EG_CREDIT = 'Egyptian Drug Database (eg-drugs) by Mahmoud Mohamed'
AUTHORITIES = {'AE': 'ede.gov.ae', 'SA': 'sfda.gov.sa', 'EG': 'edaegypt.gov.eg'}
ARAB_MARKETS = frozenset(
    'AE BH DJ DZ EG IQ JO KM KW LB LY MA MR OM PS QA SA SD SO SY TN YE'.split()
)
FIELDS = (
    'trade_name', 'scientific_name', 'active_ingredients', 'strength',
    'dosage_form', 'manufacturer',
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS candidates (
    source_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    arabic_label TEXT,
    reported_active TEXT,
    reported_company TEXT,
    barcode TEXT,
    category TEXT,
    country TEXT NOT NULL DEFAULT 'EG',
    evidence TEXT NOT NULL DEFAULT 'community_listing',
    source_url TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    retrieved_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verified_products (
    country TEXT NOT NULL,
    record_id TEXT NOT NULL,
    trade_name TEXT NOT NULL,
    scientific_name TEXT,
    active_ingredients TEXT NOT NULL,
    strength TEXT NOT NULL,
    dosage_form TEXT NOT NULL,
    manufacturer TEXT NOT NULL,
    market_status TEXT NOT NULL,
    source_url TEXT NOT NULL,
    retrieved_on TEXT NOT NULL,
    reuse_terms_url TEXT NOT NULL,
    PRIMARY KEY (country, record_id, source_url, retrieved_on)
);
"""


def local_date():
    return datetime.now(timezone(timedelta(hours=3))).date().isoformat()


def egypt_rows(path):
    digest = hashlib.file_digest if hasattr(hashlib, 'file_digest') else None
    with open(path, 'rb') as archive:
        fingerprint = (digest(archive, 'sha256') if digest
                       else hashlib.sha256(archive.read())).hexdigest()
        archive.seek(0)
        with ZipFile(archive) as z, z.open(EG_MEMBER) as stream:
            revision = z.comment.decode('ascii', errors='replace').strip()
            reader = csv.DictReader(io.TextIOWrapper(stream, encoding='utf-8-sig'))
            rows = list(reader)
    return rows, fingerprint, revision


def audit(rows, fingerprint, revision):
    columns = ('id', 'name', 'arabic', 'active', 'company', 'barcode', 'description')
    counts = {key: Counter(row[key].strip() for row in rows) for key in columns}
    return {
        'rows': len(rows),
        'archive_sha256': fingerprint,
        'source_revision': revision,
        'missing': {key: counts[key][''] for key in columns},
        'repeated_value_groups': {
            key: sum(count > 1 for value, count in counts[key].items() if value)
            for key in ('id', 'name', 'arabic', 'barcode')
        },
        'categories': counts['description'].most_common(10),
    }


def import_egypt(db, rows, fingerprint, revision):
    if len({row['id'].strip() for row in rows if row['id'].strip()}) != len(rows):
        raise ValueError('Missing or duplicated source IDs')
    pinned = len(revision) == 40 and all(c in '0123456789abcdef' for c in revision)
    url = f'{EG_ROOT}/blob/{revision}/data/eg_drugs.csv' if pinned else EG_ROOT
    observed = local_date()
    values = [
        (*[row[key].strip() or None for key in
           ('id', 'name', 'arabic', 'active', 'company', 'barcode', 'description')],
         url, f'{revision} sha256:{fingerprint}', observed)
        for row in rows
    ]
    if not rows:
        raise ValueError('The source contained no rows')
    with db:
        db.execute('DELETE FROM candidates')
        db.executemany("""
            INSERT INTO candidates (
                source_id, name, arabic_label, reported_active, reported_company,
                barcode, category, source_url, source_revision, retrieved_on
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, values)


def https_host(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Expected an HTTPS URL without credentials')
    return parsed.hostname


def official_values(record):
    country = record['country'].strip().upper()
    status = record['market_status'].strip()
    if country not in ARAB_MARKETS:
        raise ValueError('Expected an Arab market code')
    authority = AUTHORITIES.get(country)
    if authority is None:
        raise ValueError('This market requires a reviewed authority mapping')
    if record['human'] is not True or status not in {'registered', 'availability_documented'}:
        raise ValueError('Expected explicit human-use and market evidence')
    source_url = record['source_url'].strip()
    host = https_host(source_url)
    if host != authority and not host.endswith('.' + authority):
        raise ValueError('Evidence domain does not match the market authority')
    retrieved = date.fromisoformat(record['retrieved_on'])
    if retrieved.isoformat() != record['retrieved_on'] or retrieved.isoformat() > local_date():
        raise ValueError('Expected a valid retrieval date in YYYY-MM-DD format')
    terms = record['reuse_terms_url'].strip()
    https_host(terms)
    ingredients = record['active_ingredients']
    if (not isinstance(ingredients, list) or not ingredients
            or any(not isinstance(item, str) or not item.strip() for item in ingredients)):
        raise ValueError('Expected a non-empty list of active ingredients')
    fields = dict(record)
    fields['active_ingredients'] = json.dumps([item.strip() for item in ingredients], ensure_ascii=False)
    fields['scientific_name'] = record.get('scientific_name') or ''
    values = [fields[key].strip() or None for key in FIELDS]
    record_id = record['record_id'].strip()
    if not record_id or any(value is None for key, value in zip(FIELDS, values) if key != 'scientific_name'):
        raise ValueError('Missing product identifier or formulation field')
    return (country, record_id, *values, status, source_url, retrieved.isoformat(), terms)


def import_official(db, path):
    count = 0
    with open(path, encoding='utf-8') as stream, db:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                values = official_values(json.loads(line))
                db.execute("""
                    INSERT INTO verified_products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT DO NOTHING
                """, values)
                existing = db.execute("""
                    SELECT * FROM verified_products
                    WHERE country=? AND record_id=? AND source_url=? AND retrieved_on=?
                """, (values[0], values[1], values[9], values[10])).fetchone()
                if tuple(existing) != values:
                    raise ValueError('Conflicting evidence for the same source record and date')
            except (ValueError, TypeError, AttributeError, KeyError) as error:
                raise ValueError(f'Line {line_number}: {error}') from error
            count += 1
        if not count:
            raise ValueError('No official evidence records supplied')
    return count


def normalize(text):
    return unicodedata.normalize('NFKC', text).casefold()


def search(db, country, name, include_candidates):
    db.create_function('normalize', 1, normalize, deterministic=True)
    term = normalize(name.strip())
    if not term:
        raise ValueError('Enter a product name')
    verified = db.execute("""
        SELECT * FROM verified_products
        WHERE country=? AND instr(normalize(trade_name), ?) > 0
        ORDER BY trade_name, record_id, retrieved_on DESC LIMIT 50
    """, (country, term))
    result = {'verified_products': []}
    for row in verified:
        product = dict(row)
        product['active_ingredients'] = json.loads(product['active_ingredients'])
        result['verified_products'].append(product)
    if include_candidates:
        candidates = db.execute("""
            SELECT * FROM candidates WHERE country=? AND
            (instr(normalize(name), ?) > 0 OR instr(normalize(coalesce(arabic_label, '')), ?) > 0)
            ORDER BY name, source_id LIMIT 50
        """, (country, term, term))
        result['community_candidates'] = [dict(row) for row in candidates]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=Path('smartmed.sqlite'))
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('audit-eg', 'import-eg', 'import-evidence'):
        commands.add_parser(name).add_argument('file', type=Path)
    query = commands.add_parser('search')
    query.add_argument('country', type=str.upper, choices=sorted(ARAB_MARKETS))
    query.add_argument('name')
    query.add_argument('--include-candidates', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'audit-eg':
            result = audit(*egypt_rows(args.file))
        else:
            with closing(sqlite3.connect(args.db)) as db:
                db.row_factory = sqlite3.Row
                db.executescript(SCHEMA)
                if args.command == 'import-eg':
                    rows, fingerprint, revision = egypt_rows(args.file)
                    import_egypt(db, rows, fingerprint, revision)
                    result = {'community_candidates': len(rows), 'attribution': EG_CREDIT}
                elif args.command == 'import-evidence':
                    result = {'evidence_records_processed': import_official(db, args.file)}
                else:
                    result = search(db, args.country, args.name, args.include_candidates)
    except (OSError, KeyError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
