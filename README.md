# SmartMed

تطبيق يقرأ النص من صور عبوات الأدوية ويعرض المرشحات من الفهرس المصري. الواجهة العربية تعمل على أندرويد وفي متصفح الكمبيوتر، والخادم يدعم تسجيل أدلة مستقلة لكل سوق. راجع [تقرير المصادر](docs/sources.md) و[نتائج تدقيق الأرشيف](docs/eg-drugs-audit.json).

## التشغيل

ضع الأرشيف المرفق في مجلد `data/` أو مرّر مساره الحالي مباشرة. يقرأ الاستيراد ملف CSV من داخل الأرشيف ويترك الأصل كما هو.

```sh
python smartmed.py audit-eg data/eg-drugs-main.zip
python smartmed.py import-eg data/eg-drugs-main.zip
python smartmed.py search EG فلورويوراسيل --include-candidates
python smartmed.py search AE Example
python -m unittest discover -s tests
```

يستبدل استيراد الأرشيف فهرس المرشحات المصري في معاملة واحدة. يُبقي السجلات ذات الأسماء أو الرموز الشريطية المتشابهة منفصلة. البحث الافتراضي يعرض الكتالوج المؤكد فقط. يمكن تحديد قاعدة مختلفة باستخدام `--db PATH` قبل الأمر. القاعدة والأرشيفات محلية.

## إضافة أدلة رسمية

بعد مراجعة المصدر وسماح شروطه بإعادة الاستخدام، جهّز ملف JSON Lines بسجل واحد لكل سطر، ثم نفّذ:

```sh
python smartmed.py import-evidence data/reviewed-evidence.jsonl
```

| الحقل | القيمة |
| --- | --- |
| `country` | رمز السوق. خريطة الجهات المراجعة مبدئيًا تقبل AE وSA وEG. |
| `record_id` | معرّف المنتج كما نشرته الجهة. |
| `trade_name`, `scientific_name` | الاسم التجاري والاسم العلمي في حقلين. الاسم العلمي اختياري عند غيابه. |
| `active_ingredients` | قائمة المواد الفعالة كما وردت في المصدر، مع الحفاظ على ترتيبها وربط التركيز بها في حقل التركيز. |
| `strength`, `dosage_form`, `manufacturer` | التركيز والشكل الصيدلاني والشركة المصنعة، كل منها في حقل مستقل. |
| `human` | القيمة المنطقية `true` عند وجود دليل لاستخدام بشري. |
| `market_status` | `registered` عند إثبات التسجيل، أو `availability_documented` عند توثيق التوفر. |
| `source_url`, `retrieved_on` | رابط HTTPS للسجل أو للتصدير الرسمي وتاريخ جلبه بصيغة YYYY-MM-DD. |
| `reuse_terms_url` | رابط شروط إعادة الاستخدام التي راجعها المستورد. |

يتحقق البرنامج من بنية الملف ونطاق الجهة. على المستورد فتح المستند ومراجعة كل حقل، والتأكد من الترخيص والهوية البشرية وحالة السوق قبل إضافته. حافظ على اختلاف معرفات المنتجات، وأدخل كل سوق بوثيقته. تبقى مشاهدات الأدلة منفصلة حسب السوق والمعرف والرابط وتاريخ الجلب. يعاد تشغيل استيراد الملف نفسه بأمان، ويرفض التعارض لنفس مفتاح الدليل. وسّع خريطة الجهات عند إضافة سوق بعد التحقق من نطاق الجهة وشروطها.

**الإسناد.** Egyptian Drug Database (eg-drugs) by Mahmoud Mohamed. بيانات المصدر مرخصة بموجب [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). يتضمن التحويل انتقاء الحقول وإزالة الفراغات الطرفية وفصل المرشحات عن الأدلة الرسمية. [المصدر الأصلي](https://github.com/mahmoudfalous/eg-drugs)

## تشغيل Windows من المتصفح

نزّل `SmartMed-Windows.zip` من [رابط التنزيل المباشر](https://raw.githubusercontent.com/Aishaas1/Smartmed/download-v1.2.0/SmartMed-Windows.zip) وفك الضغط. الحزمة تتضمن الواجهة المبنية وملف البيانات وملفي لغة Tesseract العربية والإنجليزية. ثبّت [Python 3.10 أو أحدث](https://www.python.org/downloads/windows/) و[Tesseract على Windows](https://tesseract-ocr.github.io/tessdoc/Installation.html) لتفعيل قراءة الصور. المشغّل يحمّل ملفات اللغة الموجودة في الحزمة. البحث يعمل فور استيراد البيانات.

افتح PowerShell في المجلد الذي يحتوي على `run-smartmed.ps1` وشغّل:

```powershell
Unblock-File .\run-smartmed.ps1
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\run-smartmed.ps1
```

إذا لم يكن Tesseract مثبتًا، يمكنك تثبيته عبر Windows Package Manager بإضافة `-InstallOcr` لأول تشغيل:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\run-smartmed.ps1 -InstallOcr
```

يفتح المشغّل المتصفح بعد جاهزية الخادم. إذا أغلقته، افتح `http://127.0.0.1:8000/` واترك نافذة PowerShell تعمل. ابحث عن «فلورويوراسيل» لتجربة الفهرس، أو اختر صورة واضحة، وحدد لغة النص ثم اضغط «قراءة الصورة». يظهر النص حتى لو لم توجد نتيجة من الفهرس. من «لغة الصوت» اختر العربية أو English ثم اضغط «استمع للنص». النطق يستخدم الأصوات المثبتة في المتصفح أو نظام الجهاز.

**إذا نزّلت كود المصدر من فرع main**، ضع `eg-drugs-main.zip` في `data/` وثبّت Node.js 22 LTS. ينشئ المشغّل حزمة المتصفح عند الحاجة. النسخة المجهزة تعمل في المتصفح دون Node.js.

## تشغيل أندرويد عبر Expo Go

1. شغّل الخادم بالأمر السابق مع إضافة `-Lan`، واتركه مفتوحًا. اسمح باتصال Python على الشبكات الخاصة إذا طلب Windows ذلك.
2. ثبّت إصدار [Expo Go المتوافق مع SDK 54](https://expo.dev/go) على الهاتف، ووصل الهاتف والكمبيوتر بنفس Wi‑Fi.
3. افتح PowerShell ثانية في مجلد المشروع:

```powershell
cd mobile
npm.cmd ci
npm.cmd start
```

4. امسح QR من Expo Go. يستخدم التطبيق عنوان شبكة Expo تلقائيًا. إذا بقيت الحالة «غير متصل»، افحص عنوان الكمبيوتر بأمر `ipconfig`. اضغط شارة الاتصال في التطبيق وأدخل عنوانًا مثل `http://192.168.1.10:8000` بعد استبدال الرقم، ثم اختر «فحص وحفظ الاتصال». لمحاكي Android Studio، استخدم `http://10.0.2.2:8000`.
5. عند تعثر الاتصال، جرّب فتح `http://عنوان-الكمبيوتر:8000/api/v1/health` من متصفح الهاتف للتحقق من الشبكة. تعرض شاشة الاتصال أيضًا ما إذا كان الفهرس مستوردًا ولغات OCR المتوفرة.

## تشغيل الخادم يدويًا

على Linux، ثبّت Tesseract وملفات اللغة `ara` و`eng` عبر مدير الحزم. يمكن استخدام `bash tools/install_arabic_ocr.sh` و`export TESSDATA_PREFIX="$PWD/data/tessdata"` إذا توفرت الإنجليزية فقط.

```sh
python -m pip install -r requirements.txt
python smartmed.py import-eg data/eg-drugs-main.zip
python -m unittest discover -s tests
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

لبناء واجهة المتصفح من المصدر، نفّذ `npm ci` ثم `npm run build:web` داخل `mobile` قبل بدء الخادم. يتوفر توثيق API على `/docs` وفحص الصحة على `/api/v1/health`. سجل التعرّف محفوظ محليًا في SQLite ومرتبط بمعرّف الجهاز. استخدم الخادم محليًا أو على شبكة تطوير خاصة.

## التعرف والبيانات البصرية

يقرأ الخادم العربية والإنجليزية بـ Tesseract عند توفر ملفي اللغة. يدعم JPEG وPNG وWebP حتى 8 ميغابايت و16 مليون بكسل. يعتمد التعرّف التلقائي على تطابق منتج رسمي وحيد في السوق مع الاسم التجاري والتركيز والشكل والمصنّع. تعرض المرشحات أوجه التطابق. اختيار المستخدم محفوظ منفصلًا عن حالة المطابقة. يبقى فهرس مصر مرجعًا للبحث فقط.

لاستخدام كاشف مدرّب، ثبّت Ultralytics واضبط `SMARTMED_YOLO_MODEL` على ملف محلي مدرّب على فئة العبوات `kemasan` أو `medicine_packaging`. في غياب الكاشف تُقرأ الصورة كاملة؛ عند رصد أكثر من عبوة تتطلب النتيجة تأكيدًا. لا يُضمّن المشروع نموذجًا مدربًا. يمكن فحص ملفات MedPackID المنشورة بأمر:

```sh
python tools/audit_medpack.py path/to/annotations_voc.zip --images path/to/images.zip
```

تعتمد معايرة النموذج وتقييم OCR على صور مرخّصة وممثلة للسوق المستهدف. تظل نتائج الاختبارات البرمجية الحالية مستقلة عن أداء التعرّف على عبوات حقيقية.

ملفات OCR المرفقة من [tessdata_fast 4.1.0](https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0) بموجب Apache 2.0. رخصتها مرفقة في الحزمة.
