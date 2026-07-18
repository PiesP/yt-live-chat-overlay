// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const AR: Record<string, string> = {
  // ── Pane tabs ──
  Comments: 'التعليقات',
  Appearance: 'المظهر والألوان',
  Advanced: 'متقدم',
  Translation: 'الترجمة',

  // ── Aria labels / misc ──
  'Live chat overlay': 'Live chat overlay',
  Paused: 'متوقف مؤقتًا',
  'Interface language changed to': 'تم تغيير لغة الواجهة إلى: ',

  // ── Canvas connection status ──
  'Connecting…': 'جارٍ الاتصال…',
  'Connection unstable': 'الاتصال غير مستقر',
  'Disconnected — Click to reload': 'تم قطع الاتصال — انقر لإعادة التحميل',
  'Waiting for live stream…': 'بانتظار البث المباشر…',

  // ── Section titles ──
  Cards: 'البطاقات',
  'Text Outline': 'حدود النص',
  'Safe Zone': 'المنطقة الآمنة',
  'Message Rate': 'معدل الرسائل',
  'Depth Layers': 'طبقات العمق',
  Font: 'الخط',
  Backlog: 'السجل',
  Timing: 'التوقيت',
  Tuning: 'الضبط',
  'Burst Detection': 'كشف الانفجار',
  Cache: 'الذاكرة المؤقتة',
  'Author Colors & Visibility': 'ألوان المؤلفين والرؤية',
  Interface: 'الواجهة',
  'Chat Translation': 'ترجمة الدردشة',
  'Translation backend service for processing messages': 'خدمة الترجمة الخلفية لمعالجة الرسائل',

  // ── Field labels ──
  'Author Rate Limit': 'حد معدل المؤلف',
  'Backlog Mode': 'وضع السجل',
  'Backlog Opacity (%)': 'شفافية السجل (%)',
  Bold: 'عريض',
  'Bottom Clear Zone (%)': 'المنطقة السفلية الخالية (%)',
  'Custom font stack…': 'خط مخصص…',
  'Danmaku Mode': 'وضع التعليقات المنسدلة',
  Enabled: 'مُفعَّل',
  Family: 'العائلة',
  'Ignore Min Length': 'تجاهل الحد الأدنى للطول',
  'Lane Gap (px)': 'تباعد الصفوف (بكسل)',
  Language: 'اللغة',
  'Membership Max Lines': 'الحد الأقصى لأسطر رسائل العضوية',
  'Min Length (chars)': 'الحد الأدنى للطول (حروف)',
  'Outline Opacity (%)': 'شفافية الحد (%)',
  'Outline Width (px)': 'عرض الحد (بكسل)',
  'Preserve User Colors': 'الاحتفاظ بألوان المستخدم',
  Regular: 'عادي',
  'Scroll Speed (px/s)': 'سرعة التمرير (بكسل/ث)',
  'Show SuperChat Amount': 'إظهار مبلغ الرسائل المميزة',
  'Size (px)': 'الحجم (px)',
  'SuperChat Max Lines': 'الحد الأقصى لأسطر الرسائل المميزة',
  'SuperChat Opacity (%)': 'شفافية الرسائل المميزة (%)',
  'Text Opacity (%)': 'شفافية النص (%)',
  'Top Clear Zone (%)': 'المنطقة العلوية الخالية (%)',
  Weight: 'الوزن',
  // ── Language names ──
  English: 'الإنجليزية',
  한국어: 'الكورية',
  日本語: 'اليابانية',
  Español: 'الإسبانية',
  中文: 'الصينية',
  العربية: 'العربية',
  'Duration Multiplier (×)': 'مضاعف المدة (×)',
  'Exit Padding (px)': 'حافة الخروج (بكسل)',
  'Min Scroll Duration (ms)': 'الحد الأدنى لمدة التمرير (مللي ثانية)',
  'Max Scroll Duration (ms)': 'الحد الأقصى لمدة التمرير (مللي ثانية)',
  'Top/Bottom Duration (ms)': 'مدة أعلى/أسفل (مللي ثانية)',
  'Max Queue Depth': 'الحد الأقصى لعمق قائمة الانتظار',
  'Tab Trim Target': 'هدف تقليم التبويب',
  'Max Message Age (ms)': 'الحد الأقصى لعمر الرسالة (مللي ثانية)',
  'Message Spacing (%)': 'تباعد الرسائل (%)',
  'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)':
    'بكسلات إضافية تمررها الرسالة بعد حافة الشاشة قبل إزالتها (20-400، الافتراضي 100)',
  'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)':
    'الحد الأدنى لمدة حركة التمرير — يمنع الرسائل القصيرة جداً من المرور بسرعة (1000-15000 مللي ثانية، الافتراضي 5000)',
  'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)':
    'الحد الأقصى لمدة حركة التمرير — يمنع الرسائل الطويلة جداً من الزحف (5-120 ثانية، الافتراضي 30000 مللي ثانية)',
  'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)':
    'مدة العرض الثابتة للرسائل في وضع أعلى/أسفل (1000-30000 مللي ثانية، الافتراضي 4000)',
  'Maximum pending queue depth before messages are dropped (50-1000, default 200)':
    'الحد الأقصى لعمق قائمة الانتظار قبل إسقاط الرسائل (50-1000، الافتراضي 200)',
  'Target active message count when trimming background tab (10-500, default 50)':
    'عدد الرسائل النشطة المستهدف عند تقليم التبويب الخلفي (10-500، الافتراضي 50)',
  'Maximum message age before fade-out removal (10-300s, default 60000ms)':
    'الحد الأقصى لعمر الرسالة قبل الإزالة التدريجية (10-300 ثانية، الافتراضي 60000 مللي ثانية)',
  'Gap between consecutive messages as percentage of message width (2-30%, default 8)':
    'الفجوة بين الرسائل المتتالية كنسبة مئوية من عرض الرسالة (2-30%، الافتراضي 8)',
  'Enable Translation': 'تفعيل الترجمة',
  Service: 'الخدمة',
  'Source Language': 'لغة المصدر',
  'Target Language': 'لغة الهدف',
  'Display Mode': 'وضع العرض',
  'Near Speed (%)': 'سرعة القريبة (%)',
  'Far Speed (%)': 'سرعة البعيدة (%)',
  'Far Opacity (%)': 'شفافية البعيدة (%)',

  // ── Select options ──
  'Scroll (RTL)': 'تمرير (يمين لليسار)',
  'Reverse (LTR)': 'عكسي (يسار لليمين)',
  'Top Fixed': 'أعلى ثابت',
  'Bottom Fixed': 'أسفل ثابت',
  'Playback-based (recommended)': 'بناءً على التشغيل (موصى به)',
  'Recent only': 'الأخيرة فقط',
  'Full (show all)': 'كامل (إظهار الكل)',
  'None (skip backlog)': 'بدون (تخطي السجل)',
  Off: 'إيقاف',
  'Normal (5 msg / 5s)': 'عادي (5 رسائل / 5 ثوانٍ)',
  'Strict (2 msg / 5s)': 'صارم (2 رسائل / 5 ثوانٍ)',
  'Auto (Browser)': 'تلقائي (المتصفح)',
  'Auto-detect': 'كشف تلقائي',
  'Auto (Chrome built-in)': 'تلقائي (مدمج في Chrome)',
  'Dual (original + translation)': 'مزدوج (الأصل + الترجمة)',
  'Replace (translation only)': 'استبدال (الترجمة فقط)',

  // ── Tooltips ──
  'Vertical gap between comment rows (negative = overlap)':
    'الفجوة الرأسية بين صفوف التعليقات (سالب = تداخل)',
  'Bold is more readable, Regular uses less GPU memory':
    'العريض أكثر قابلية للقراءة، العادي يستخدم ذاكرة GPU أقل',
  'Font family for comment text': 'خط نص التعليق',
  'Background opacity of Super Chat cards': 'شفافية خلفية بطاقات الرسائل المميزة',
  'Max body text lines before truncation (2-10)': 'الحد الأقصى لأسطر النص قبل الاقتطاع (2-10)',
  'Max body text lines for membership messages (1-5)': 'الحد الأقصى لأسطر رسائل العضوية (1-5)',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'استخدام لون النص الذي اختاره المؤلف من دردشة YouTube بدلاً من إعدادات التراكب الافتراضية',
  'Display the purchase amount badge on Super Chat cards':
    'إظهار شارة مبلغ الشراء على بطاقات الرسائل المميزة',
  'Keep top N% of video free of comments': 'إبقاء أعلى N% من الفيديو خالياً من التعليقات',
  'Keep bottom N% of video free of comments': 'إبقاء أسفل N% من الفيديو خالياً من التعليقات',
  'Show all messages regardless of minimum character length':
    'إظهار جميع الرسائل بغض النظر عن الحد الأدنى لعدد الحروف',
  'Minimum character count': 'الحد الأدنى لعدد الحروف',
  'Opacity of past messages relative to real-time messages':
    'شفافية الرسائل السابقة بالنسبة للرسائل الفورية',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'كم تبقى رسائل المشرف والمالك مرئية أطول (1.0 = نفس العادي، 2.0 = ضعف المدة)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'ترجمة رسائل الدردشة في الوقت الفعلي (يتطلب Chrome 138+ للترجمة المدمجة)',
  'Speed-based depth perception: fast messages appear near, slow messages appear far':
    'إدراك العمق القائم على السرعة: الرسائل السريعة تظهر قريبة، البعيدة تظهر بعيدة',
  'Speed boost for near-layer messages': 'تعزيز سرعة الرسائل القريبة',
  'Speed reduction for far-layer messages': 'تقليل سرعة الرسائل البعيدة',
  'Opacity dimming for far-layer messages': 'تعتيم شفافية الرسائل البعيدة',
  'How fast comments scroll across the screen in pixels per second':
    'مدى سرعة تمرير التعليقات عبر الشاشة بالبكسل في الثانية',
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    'لغة رسائل الدردشة الواردة. الكشف التلقائي يستخدم كشف اللغة المدمج في Chrome.',
  'Language to translate chat messages into. Auto detects from browser settings.':
    'اللغة التي تُترجم إليها رسائل الدردشة. يُكتشف تلقائياً من إعدادات المتصفح.',
  'Limits how frequently messages from the same author appear':
    'يحدد مدى تكرار ظهور رسائل نفس المؤلف',
  'Sets the overlay user interface language (does not filter comments by language)':
    'يضبط لغة واجهة المستخدم للتراكب (لا يصفّي التعليقات حسب اللغة)',

  // ── New Performance / Developer section titles ──
  Performance: 'الأداء',
  Developer: 'المطور',

  // ── New field labels ──
  'Max Concurrent Messages': 'الحد الأقصى للرسائل المتزامنة',
  'Fade Duration (ms)': 'مدة التلاشي (مللي ثانية)',
  'Min Poll Interval (ms)': 'الحد الأدنى لفاصل الاستطلاع (مللي ثانية)',
  'Max Poll Interval (ms)': 'الحد الأقصى لفاصل الاستطلاع (مللي ثانية)',
  'Max Injection Rate (msg/s)': 'الحد الأقصى لمعدل الحقن (رسالة/ث)',
  'Backlog Speed (×)': 'مضاعف سرعة السجل',
  'Recent Window (min)': 'النافذة الزمنية (دقائق)',
  'Log Level': 'مستوى السجل',
  'Debug Overlay': 'طبقة تصحيح',

  // ── New select options ──
  'Warnings only': 'التحذيرات فقط',
  Info: 'معلومات',
  'Debug (verbose)': 'تصحيح (مفصّل)',

  // ── New tooltips ──
  'Maximum number of messages visible on screen at once (30-300)':
    'الحد الأقصى لعدد الرسائل المرئية على الشاشة في وقت واحد (30-300)',
  'How long messages take to fade out (0 = instant, 50-1000)':
    'المدة التي تستغرقها الرسائل للتلاشي (0 = فوري، 50-1000)',
  'Minimum chat polling interval in milliseconds (50-5000)':
    'الحد الأدنى لفاصل استطلاع الدردشة (مللي ثانية، 50-5000)',
  'Maximum chat polling interval in milliseconds (1000-30000)':
    'الحد الأقصى لفاصل استطلاع الدردشة (مللي ثانية، 1000-30000)',
  'Maximum backlog message injection rate per second (0-50)':
    'الحد الأقصى لمعدل حقن رسائل السجل في الثانية (0-50)',
  'Animation speed multiplier for backlog messages (1-5)': 'مضاعف سرعة حركة رسائل السجل (1-5)',
  'Time window in minutes for recent-only backlog mode (1-30)':
    'النافذة الزمنية بالدقائق لوضع السجل الأخير فقط (1-30)',
  'Console diagnostic output verbosity': 'تفصيل مخرجات تشخيص وحدة التحكم',
  'Show performance debug overlay on the video player': 'إظهار تراكب تصحيح الأداء على مشغل الفيديو',

  // ── New tooltips (added 2026-05-28) ──
  'Text size in pixels (14-50)': 'حجم النص بالبكسل (14-50)',
  'Text outline stroke width in pixels (0-8)': 'عرض حد محيط النص بالبكسل (0-8)',
  'Text outline stroke opacity (0-100%)': 'شفافية حد النص (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'Globally enable or disable the chat overlay on YouTube live streams':
    'تفعيل أو تعطيل تراكب الدردشة على بثوث YouTube المباشرة عالمياً',
  'Comment display direction and behavior': 'اتجاه وسلوك عرض التعليقات',
  'Overall opacity of comment text (50-100%)': 'الشفافية الكلية لنص التعليقات (50-100%)',
  'Add a dark outline stroke around text for better readability':
    'إضافة حد داكن حول النص لتحسين قابلية القراءة',
  'How past chat messages are displayed relative to live playback':
    'كيف تُعرض رسائل الدردشة السابقة بالنسبة للتشغيل المباشر',
  'Dual shows original above translation, Replace shows translation only':
    'المزدوج يعرض الأصل فوق الترجمة، الاستبدال يعرض الترجمة فقط',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'Emoji Cache (MB)': 'ذاكرة الرموز التعبيرية المؤقتة (MB)',
  'Photo Cache (MB)': 'ذاكرة الصور المؤقتة (MB)',
  'Sticker Cache (MB)': 'ذاكرة الملصقات المؤقتة (MB)',
  'Text Cache (MB)': 'ذاكرة النصوص المؤقتة (MB)',
  'Translation Batch Size': 'حجم دفعة الترجمة',
  'Emoji Fetch Limit': 'حد جلب الرموز التعبيرية',
  'Failed Emoji Retry (min)': 'إعادة محاولة الرموز التعبيرية الفاشلة (دقائق)',
  'Max memory for emoji image cache (1-20 MB, default 3)':
    'الحد الأقصى للذاكرة المؤقتة لصور الرموز التعبيرية (1-20 MB، الافتراضي 3)',
  'Max memory for author photo cache (1-20 MB, default 2)':
    'الحد الأقصى للذاكرة المؤقتة لصور المؤلفين (1-20 MB، الافتراضي 2)',
  'Max memory for sticker image cache (1-20 MB, default 1)':
    'الحد الأقصى للذاكرة المؤقتة لصور الملصقات (1-20 MB، الافتراضي 1)',
  'Max memory for text bitmap cache (1-20 MB, default 4)':
    'الحد الأقصى للذاكرة المؤقتة للنصوص النقطية (1-20 MB، الافتراضي 4)',
  'Max translations applied per frame to avoid spikes (1-20, default 5)':
    'الحد الأقصى للترجمات المطبقة لكل إطار لتجنب الارتفاعات الحادة (1-20، الافتراضي 5)',
  'Max concurrent emoji fetch operations (1-20, default 6)':
    'الحد الأقصى لعمليات جلب الرموز التعبيرية المتزامنة (1-20، الافتراضي 6)',
  'How long to wait before retrying failed emoji fetches (1-60 min, default 5)':
    'المدة قبل إعادة محاولة جلب الرموز التعبيرية الفاشلة (1-60 دقيقة، الافتراضي 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'Burst Sample Window': 'نافذة عينة الانفجار',
  'Elevated Burst (msg/s)': 'انفجار مرتفع (رسالة/ث)',
  'High Burst (msg/s)': 'انفجار عالٍ (رسالة/ث)',
  'Extreme Burst (msg/s)': 'انفجار شديد (رسالة/ث)',
  'Backlog Injection Max': 'الحد الأقصى لحقن السجل',
  'Backlog Density Ramp (ms)': 'منحدر كثافة السجل (مللي ثانية)',
  'Live Poll Fallback (ms)': 'تراجع الاستطلاع المباشر (مللي ثانية)',
  'Poll Failure Limit': 'حد فشل الاستطلاع',
  'Speed Boost Threshold': 'عتبة تعزيز السرعة',
  'Backlog Pause (%)': 'إيقاف السجل (%)',
  'Backlog Resume (%)': 'استئناف السجل (%)',
  'Activity Timeout (ms)': 'مهلة النشاط (مللي ثانية)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'Burst rate sample window size': 'حجم نافذة عينة معدل الانفجار',
  'Messages per second threshold for elevated burst level':
    'عتبة الرسائل في الثانية لمستوى الانفجار المرتفع',
  'Messages per second threshold for high burst level':
    'عتبة الرسائل في الثانية لمستوى الانفجار العالي',
  'Messages per second threshold for extreme burst level':
    'عتبة الرسائل في الثانية لمستوى الانفجار الشديد',
  'Maximum backlog injection rate cap': 'الحد الأقصى لسقف معدل حقن السجل',
  'Density ramp duration for backlog injection in milliseconds':
    'مدة منحدر كثافة حقن السجل بالمللي ثانية',
  'Live poll fallback delay in milliseconds': 'تأخير تراجع الاستطلاع المباشر بالمللي ثانية',
  'Consecutive poll failures before circuit breaker trips':
    'إخفاقات الاستطلاع المتتالية قبل قطع قاطع الدائرة',
  'Pending messages to trigger speed boost': 'الرسائل المعلقة لتشغيل تعزيز السرعة',
  'Lane utilization ratio to pause backlog injection': 'نسبة استخدام المسار لإيقاف حقن السجل',
  'Lane utilization ratio to resume backlog injection': 'نسبة استخدام المسار لاستئناف حقن السجل',
  'Chat activity timeout in milliseconds': 'مهلة نشاط الدردشة بالمللي ثانية',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'Stagger Max Delay (ms)': 'الحد الأقصى لتأخير التدرج (مللي ثانية)',
  'Stagger Medium Delay (ms)': 'تأخير التدرج المتوسط (مللي ثانية)',
  'Emoji Fetch Timeout (ms)': 'مهلة جلب الرموز التعبيرية (مللي ثانية)',
  'Backlog Density Ramp Max (ms)': 'الحد الأقصى لمنحدر كثافة السجل (مللي ثانية)',
  'Backlog Injection Rate Min (msg/s)': 'الحد الأدنى لمعدل حقن السجل',
  'Speed Boost Max': 'الحد الأقصى لتعزيز السرعة',
  'Speed Boost Denominator': 'مقام تعزيز السرعة',
  'Backlog Toggle Cooldown (ms)': 'فترة تهدئة تبديل السجل (مللي ثانية)',
  'Replay Prefetch Pages': 'صفحات الجلب المسبق للإعادة',
  'Replay Batch Limit': 'حد دفعة الإعادة',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'Max stagger delay for messages in same batch': 'الحد الأقصى لتأخير التدرج للرسائل في نفس الدفعة',
  'Medium stagger delay when queue depth is medium':
    'تأخير التدرج المتوسط عندما يكون عمق قائمة الانتظار متوسطاً',
  'Timeout for emoji fetch operations': 'مهلة عمليات جلب الرموز التعبيرية',
  'Max density ramp duration for backlog injection': 'الحد الأقصى لمدة منحدر كثافة حقن السجل',
  'Minimum backlog injection rate (msg/s)': 'الحد الأدنى لمعدل حقن السجل (رسالة/ث)',
  'Max speed boost factor for burst compensation':
    'الحد الأقصى لمعامل تعزيز السرعة لتعويض الانفجار',
  'Speed boost denominator for EMA rate scaling': 'مقام تعزيز السرعة لتوسيع معدل EMA',
  'Cooldown between backlog pause toggles': 'فترة التهدئة بين تبديلات إيقاف السجل',
  'Max pages to prefetch in replay mode': 'الحد الأقصى للصفحات للجلب المسبق في وضع الإعادة',
  'Max batches to fetch in replay initialization': 'الحد الأقصى للدفعات للجلب في تهيئة الإعادة',

  // ── Modal chrome ──
  'Chat Overlay': 'تراكب الدردشة',
  'Close settings': 'إغلاق الإعدادات',
  'Settings categories': 'فئات الإعدادات',
  'Overlay Enabled': 'التراكب مُفعَّل',
  'Value adjusted to': 'تم ضبط القيمة على ',
  Reset: 'إعادة تعيين',
  Export: 'تصدير',
  Import: 'استيراد',
  Close: 'إغلاق',
  Done: 'تم',
  'Changes are saved automatically': 'يتم حفظ التغييرات تلقائيًا',
  'Reset all settings to defaults?': 'إعادة تعيين جميع الإعدادات إلى الافتراضية؟',
  Cancel: 'إلغاء',
  'Import failed: invalid settings format': 'فشل الاستيراد: تنسيق الإعدادات غير صالح',
  'Settings imported successfully': 'تم استيراد الإعدادات بنجاح',
  'Import failed: invalid JSON': 'فشل الاستيراد: JSON غير صالح',
  'Chat overlay settings': 'إعدادات تراكب الدردشة',
  'Reset overlay settings': 'إعادة تعيين إعدادات التراكب',
  'Reload overlay': 'إعادة تحميل التراكب',

  // ── Author grid ──
  Color: 'اللون',
  'Name Color': 'لون الاسم',
  Show: 'إظهار',
  'Show Name': 'إظهار الاسم',
  Normal: 'عادي',
  Member: 'عضو',
  Moderator: 'مشرف',
  Owner: 'مالك',
  Verified: 'موثّق',
  SuperChat: 'رسالة مميزة',
  'Loading chat history...': 'جارٍ تحميل سجل الدردشة...',
  'Short messages shown regardless of length': 'عرض الرسائل القصيرة بغض النظر عن الطول',

  // ── Toast / sync messages ──

  // ── Translation unsupported ──
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    'يتطلب الترجمة متصفحًا مزودًا بذكاء اصطناعي مدمج. استخدم Chrome 138+ أو Edge 143+ Canary.',

  // ── Added 2026-07-04 ──
  'Chat messages': 'رسائل الدردشة',
  'Ignore Reduced Motion': 'تجاهل تقليل الحركة',
  'Force scroll animations even when OS reduced-motion is enabled (requires page refresh)':
    'فرض رسوم التمرير المتحركة حتى عند تمكين تقليل الحركة في النظام (يتطلب تحديث الصفحة)',
  'CSS font-family value. Type to filter suggestions, or enter a custom font stack.':
    'قيمة CSS font-family. اكتب لتصفية الاقتراحات، أو أدخل مجموعة خطوط مخصصة.',
};
