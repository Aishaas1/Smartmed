from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend import app as backend
from backend.recognition import OCRUnavailable, rank
from smartmed import import_egypt


class ApiTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        db = patch.object(backend, 'DB', Path(temp.name, 'test.sqlite'))
        db.start()
        self.addCleanup(db.stop)
        self.client = TestClient(backend.app)
        self.addCleanup(self.client.close)
        self.device = {'X-Device-Id': str(uuid4())}

    def test_catalogue_search_is_scoped_to_market(self):
        row = dict(id='1', name='Fixture Tablet', arabic='عينة', active='Sample',
                   company='', barcode='', description='')
        with backend.database() as db:
            import_egypt(db, [row], 'fixture', 'fixture')
        params = {'q': 'عينة', 'include_candidates': True}
        egypt = self.client.get('/api/v1/medicines/search', params=dict(params, country='EG'))
        self.assertEqual(egypt.status_code, 200)
        self.assertEqual(len(egypt.json()['community_candidates']), 1)
        emirates = self.client.get('/api/v1/medicines/search', params=dict(params, country='AE'))
        self.assertEqual(emirates.json()['community_candidates'], [])

    def test_blank_image_and_device_scoped_history(self):
        image = BytesIO()
        Image.new('RGB', (300, 200), 'white').save(image, 'PNG')
        response = self.client.post('/api/v1/recognition?country=AE', headers=self.device,
                                    files={'image': ('blank.png', image.getvalue(), 'image/png')})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['status'], 'NOT_IDENTIFIED')
        identifier = response.json()['id']
        detail = '/api/v1/history/' + identifier
        self.assertEqual(self.client.get(detail, headers=self.device).status_code, 200)
        self.assertEqual(self.client.get(detail, headers={'X-Device-Id': str(uuid4())}).status_code, 404)
        self.assertEqual(self.client.post(f'/api/v1/recognition/{identifier}/confirm',
                                         headers=self.device, json={'candidate_index': 0}).status_code, 422)

    def test_rejects_non_image(self):
        response = self.client.post('/api/v1/recognition?country=AE', headers=self.device,
                                    files={'image': ('fake.png', b'fake', 'image/png')})
        self.assertEqual(response.status_code, 422)

    def test_requested_ocr_language_and_text_without_match(self):
        extracted = {'extracted_text': 'Unlisted label', 'ocr_languages': ['eng'],
                     'package_detection': 'disabled', 'package_count': None}
        with patch.object(backend, 'extract_text', return_value=extracted) as extract:
            response = self.client.post('/api/v1/recognition?country=EG&language=eng',
                                        headers=self.device, files={'image': ('label.png', b'fixture', 'image/png')})
        extract.assert_called_once_with(b'fixture', 'eng')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'NOT_IDENTIFIED')
        self.assertEqual(response.json()['extracted_text'], 'Unlisted label')

    def test_ocr_setup_error_is_visible_to_the_app(self):
        error = 'ملف لغة العربية (ara) غير متوفر'
        with patch.object(backend, 'ocr_languages', side_effect=OCRUnavailable(error)), \
                patch.object(backend, 'extract_text', side_effect=OCRUnavailable(error)):
            health = self.client.get('/api/v1/health').json()
            response = self.client.post('/api/v1/recognition?country=EG&language=ara',
                                        headers=self.device, files={'image': ('label.png', b'fixture', 'image/png')})
        self.assertEqual(health['ocr_error'], error)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['detail'], error)

    def test_ranking_requires_formulation_and_manufacturer(self):
        fixture = dict(trade_name='Sample', scientific_name=None,
                       active_ingredients=['ingredient'], strength='5 mg',
                       dosage_form='tablet', manufacturer='Factory')
        self.assertEqual(rank('Sample', [fixture], [])['status'], 'NEEDS_CONFIRMATION')
        self.assertEqual(rank('Sample 10 mg', [fixture], [])['status'], 'NOT_IDENTIFIED')
        self.assertEqual(rank('Sample 5 mg tablet Factory', [fixture], [])['status'], 'IDENTIFIED')
        self.assertEqual(rank('Sample 5 mg tablet Factory', [fixture, fixture], [])['status'],
                         'NEEDS_CONFIRMATION')
