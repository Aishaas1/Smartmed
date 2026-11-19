"""Audit the published VOC annotations and optional image ZIP without extracting members."""

import argparse
from collections import Counter
import hashlib
from io import BytesIO
import json
from pathlib import PurePosixPath
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from PIL import Image

SPLITS = {'train', 'val', 'test'}
LABELS = {'kemasan', 'pil'}
IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.webp'}


def member_key(name):
    path = PurePosixPath(name)
    return (path.parent.name, path.stem)


def annotations(archive):
    counts = Counter()
    labels = Counter()
    sizes = {}
    issues = Counter()
    original_labels = Counter()
    for member in archive.infolist():
        if not member.filename.lower().endswith('.xml'):
            continue
        key = member_key(member.filename)
        split, _ = key
        counts[split] += 1
        if split not in SPLITS or key in sizes or member.file_size > 65536:
            issues['unexpected_or_duplicate_xml'] += 1
            continue
        try:
            root = ET.fromstring(archive.read(member))
            width, height = (int(root.findtext('size/' + dim)) for dim in ('width', 'height'))
            if min(width, height) <= 0:
                raise ValueError('non-positive image size')
            sizes[key] = (width, height)
            for obj in root.findall('object'):
                original = obj.findtext('name') or '<missing>'
                original_labels[original] += 1
                label = original.strip().casefold()
                labels[(split, label)] += 1
                x1, y1, x2, y2 = (
                    int(obj.findtext('bndbox/' + coord)) for coord in ('xmin', 'ymin', 'xmax', 'ymax')
                )
                if label not in LABELS:
                    issues['unknown_classes'] += 1
                if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                    issues['invalid_boxes'] += 1
        except (TypeError, ValueError, ET.ParseError):
            issues['malformed_xml'] += 1
    return sizes, {
        'annotations_by_split': dict(sorted(counts.items())),
        'boxes_by_split': {split: {label: count for (entry, label), count in sorted(labels.items())
                                  if entry == split} for split in sorted(SPLITS)},
        'annotation_issues': dict(issues),
        'source_class_names': dict(sorted(original_labels.items())),
        'repeated_stems_across_splits': sum(count > 1 for count in
                                            Counter(stem for _, stem in sizes).values()),
    }


def check_images(archive, sizes):
    keys = set()
    seen_hashes = {}
    issues = Counter()
    counts = Counter()
    for member in archive.infolist():
        if PurePosixPath(member.filename).suffix.lower() not in IMAGE_SUFFIXES:
            continue
        key = member_key(member.filename)
        if key in keys:
            issues['duplicate_paths'] += 1
        keys.add(key)
        counts[key[0]] += 1
        if member.file_size > 40 * 1024 * 1024:
            issues['large_images_skipped'] += 1
            continue
        data = archive.read(member)
        digest = hashlib.sha256(data).digest()
        prior_split = seen_hashes.setdefault(digest, key[0])
        if prior_split != key[0]:
            issues['duplicate_bytes_across_splits'] += 1
        try:
            with Image.open(BytesIO(data)) as image:
                if key in sizes and sizes[key] != image.size:
                    issues['size_mismatches'] += 1
                image.verify()
        except (OSError, SyntaxError, Image.DecompressionBombError):
            issues['corrupt_images'] += 1
    return {
        'images_by_split': dict(sorted(counts.items())),
        'missing_annotations': len(keys - sizes.keys()),
        'missing_images': len(sizes.keys() - keys),
        'exact_duplicates': sum(counts.values()) - len(seen_hashes) - issues['large_images_skipped'],
        'image_issues': dict(issues),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('voc_zip')
    parser.add_argument('--images')
    args = parser.parse_args()
    with ZipFile(args.voc_zip) as archive:
        sizes, result = annotations(archive)
    if args.images:
        with ZipFile(args.images) as archive:
            result['images'] = check_images(archive, sizes)
    else:
        result['images'] = None
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
