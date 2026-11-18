import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from smartmed import SCHEMA, import_egypt, import_official, search


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        workspace = TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.file = Path(workspace.name, 'evidence.jsonl')
        self.record = {
            'country': 'AE', 'record_id': 'fixture-a', 'trade_name': 'Fixture',
            'scientific_name': 'Illustrative substance',
            'active_ingredients': ['Illustrative substance'],
            'strength': '5 mg', 'dosage_form': 'tablet',
            'manufacturer': 'Fixture company', 'market_status': 'registered',
            'human': True, 'source_url': 'https://services.ede.gov.ae/fixture',
            'retrieved_on': '2026-01-01',
            'reuse_terms_url': 'https://services.ede.gov.ae/fixture-terms',
        }

    def write(self, *records):
        self.file.write_text(''.join(json.dumps(record) + '\n' for record in records))

    def test_distinct_formulations_and_market_isolation(self):
        self.write(self.record, dict(self.record, record_id='fixture-b', strength='10 mg'))
        import_official(self.db, self.file)
        import_official(self.db, self.file)
        results = search(self.db, 'AE', 'FIXTURE', False)['verified_products']
        self.assertEqual({item['strength'] for item in results}, {'5 mg', '10 mg'})
        self.assertEqual(len(results), 2)
        self.assertEqual(search(self.db, 'EG', 'fixture', False)['verified_products'], [])

    def test_invalid_record_rolls_back_entire_batch(self):
        for changed in ({'human': False}, {'country': 'SA'},
                        {'source_url': 'https://dailymed.nlm.nih.gov/fixture'},
                        {'strength': '99 mg'}):
            with self.subTest(changed=changed):
                self.write(self.record, dict(self.record, **changed))
                with self.assertRaises(ValueError):
                    import_official(self.db, self.file)
                self.assertEqual(search(self.db, 'AE', 'fixture', False)['verified_products'], [])

    def test_egyptian_candidates_are_opt_in(self):
        row = dict(id='1', name='Fixture 5 mg tablets', arabic='عينة', active='Fixture',
                   company='Distributor', barcode='1234', description='Fixture', uses='Excluded')
        import_egypt(self.db, [row, dict(row, id='2')], 'fingerprint', 'revision')
        results = search(self.db, 'EG', 'عينة', True)
        self.assertEqual(results['verified_products'], [])
        self.assertEqual(len(results['community_candidates']), 2)
        self.assertNotIn('uses', results['community_candidates'][0])
        self.assertNotIn('community_candidates', search(self.db, 'EG', 'عينة', False))
        self.assertEqual(search(self.db, 'SA', 'عينة', True)['community_candidates'], [])
