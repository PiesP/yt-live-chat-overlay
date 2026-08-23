// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const AR: Record<string, string> = {
  // ── Pane tabs ──
  Comments: 'التعليقات',
  Appearance: 'المظهر والألوان',
  Advanced: 'متقدم',
  Translation: 'الترجمة',

  // ── Aria labels / misc ──
  'app.name': 'تراكب الدردشة المباشرة',
  Paused: 'متوقف مؤقتًا',
  'app.langChanged': 'تم تغيير لغة الواجهة إلى: ',

  // ── Canvas connection status ──
  'status.connecting': 'جارٍ الاتصال…',
  'status.unstable': 'الاتصال غير مستقر',
  'status.disconnected': 'تم قطع الاتصال — انقر لإعادة التحميل',
  'status.waiting': 'بانتظار البث المباشر…',

  // ── Section titles ──
  Cards: 'البطاقات',
  'appearance.outline': 'حدود النص',
  'danmaku.safeZone': 'المنطقة الآمنة',
  'advanced.messageRate': 'معدل الرسائل',
  'advanced.depthLayers': 'طبقات العمق',
  Font: 'الخط',
  Backlog: 'السجل',
  Timing: 'التوقيت',
  Tuning: 'الضبط',
  'advanced.burst': 'كشف الانفجار',
  Cache: 'الذاكرة المؤقتة',
  'appearance.authors': 'ألوان المؤلفين والرؤية',
  Interface: 'الواجهة',
  'translation.chat': 'ترجمة الدردشة',
  'translation.serviceDesc': 'خدمة الترجمة الخلفية لمعالجة الرسائل',

  // ── Field labels ──
  'advanced.authorRateLimit': 'حد معدل المؤلف',
  'advanced.backlogMode': 'وضع السجل',
  'advanced.backlogOpacity': 'شفافية السجل (%)',
  Bold: 'عريض',
  'danmaku.bottomClearZone': 'المنطقة السفلية الخالية (%)',
  'danmaku.fontCustom': 'خط مخصص…',
  'danmaku.mode': 'وضع التعليقات المنسدلة',
  Enabled: 'مُفعَّل',
  Family: 'العائلة',
  'advanced.ignoreMinLength': 'تجاهل الحد الأدنى للطول',
  'danmaku.laneGap': 'تباعد الصفوف (بكسل)',
  Language: 'اللغة',
  'appearance.membershipMaxLines': 'الحد الأقصى لأسطر رسائل العضوية',
  'advanced.minLength': 'الحد الأدنى للطول (حروف)',
  'appearance.outlineOpacity': 'شفافية الحد (%)',
  'appearance.outlineWidth': 'عرض الحد (بكسل)',
  'appearance.preserveUserColors': 'الاحتفاظ بألوان المستخدم',
  Regular: 'عادي',
  'danmaku.scrollSpeed': 'سرعة التمرير (بكسل/ث)',
  'appearance.showSuperchatAmount': 'إظهار مبلغ الرسائل المميزة',
  'danmaku.fontSize': 'الحجم (px)',
  'appearance.superchatMaxLines': 'الحد الأقصى لأسطر الرسائل المميزة',
  'appearance.superchatOpacity': 'شفافية الرسائل المميزة (%)',
  'danmaku.textOpacity': 'شفافية النص (%)',
  'danmaku.topClearZone': 'المنطقة العلوية الخالية (%)',
  Weight: 'الوزن',
  // ── Language names ──
  English: 'الإنجليزية',
  한국어: 'الكورية',
  日本語: 'اليابانية',
  Español: 'الإسبانية',
  中文: 'الصينية',
  العربية: 'العربية',
  'danmaku.durationMul': 'مضاعف المدة (×)',
  'danmaku.exitPadding': 'حافة الخروج (بكسل)',
  'danmaku.minScrollDuration': 'الحد الأدنى لمدة التمرير (مللي ثانية)',
  'danmaku.maxScrollDuration': 'الحد الأقصى لمدة التمرير (مللي ثانية)',
  'danmaku.topBottomDuration': 'مدة أعلى/أسفل (مللي ثانية)',
  'advanced.maxQueueDepth': 'الحد الأقصى لعمق قائمة الانتظار',
  'advanced.tabTrimTarget': 'هدف تقليم التبويب',
  'advanced.maxMessageAge': 'الحد الأقصى لعمر الرسالة (مللي ثانية)',
  'danmaku.messageSpacing': 'تباعد الرسائل (%)',
  'danmaku.exitPaddingDesc':
    'بكسلات إضافية تمررها الرسالة بعد حافة الشاشة قبل إزالتها (20-400، الافتراضي 100)',
  'danmaku.minScrollDurationDesc':
    'الحد الأدنى لمدة حركة التمرير — يمنع الرسائل القصيرة جداً من المرور بسرعة (1000-15000 مللي ثانية، الافتراضي 5000)',
  'danmaku.maxScrollDurationDesc':
    'الحد الأقصى لمدة حركة التمرير — يمنع الرسائل الطويلة جداً من الزحف (5-120 ثانية، الافتراضي 30000 مللي ثانية)',
  'danmaku.topBottomDurationDesc':
    'مدة العرض الثابتة للرسائل في وضع أعلى/أسفل (1000-30000 مللي ثانية، الافتراضي 4000)',
  'advanced.maxQueueDepthDesc':
    'الحد الأقصى لعمق قائمة الانتظار قبل إسقاط الرسائل (50-1000، الافتراضي 200)',
  'advanced.tabTrimTargetDesc':
    'عدد الرسائل النشطة المستهدف عند تقليم التبويب الخلفي (10-500، الافتراضي 50)',
  'advanced.maxMessageAgeDesc':
    'الحد الأقصى لعمر الرسالة قبل الإزالة التدريجية (10-300 ثانية، الافتراضي 60000 مللي ثانية)',
  'danmaku.messageSpacingDesc':
    'الفجوة بين الرسائل المتتالية كنسبة مئوية من عرض الرسالة (2-30%، الافتراضي 8)',
  'translation.enable': 'تفعيل الترجمة',
  Service: 'الخدمة',
  'translation.source': 'لغة المصدر',
  'translation.target': 'لغة الهدف',
  'translation.displayMode': 'وضع العرض',
  'advanced.depthNearSpeed': 'سرعة القريبة (%)',
  'advanced.depthFarSpeed': 'سرعة البعيدة (%)',
  'advanced.depthFarOpacity': 'شفافية البعيدة (%)',

  // ── Select options ──
  'danmaku.scroll': 'تمرير (يمين لليسار)',
  'danmaku.reverse': 'عكسي (يسار لليمين)',
  'danmaku.top': 'أعلى ثابت',
  'danmaku.bottom': 'أسفل ثابت',
  'advanced.backlogPlayback': 'بناءً على التشغيل (موصى به)',
  'advanced.backlogRecent': 'الأخيرة فقط',
  'advanced.backlogFull': 'كامل (إظهار الكل)',
  'advanced.backlogNone': 'بدون (تخطي السجل)',
  Off: 'إيقاف',
  'advanced.authorRateLimitNormal': 'عادي (5 رسائل / 5 ثوانٍ)',
  'advanced.authorRateLimitStrict': 'صارم (2 رسائل / 5 ثوانٍ)',
  'translation.languageAuto': 'تلقائي (المتصفح)',
  'translation.sourceAuto': 'كشف تلقائي',
  'translation.serviceAuto': 'تلقائي (مدمج في Chrome)',
  'translation.displayModeDual': 'مزدوج (الأصل + الترجمة)',
  'translation.displayModeReplace': 'استبدال (الترجمة فقط)',

  // ── Tooltips ──
  'danmaku.laneGapDesc': 'الفجوة الرأسية بين صفوف التعليقات (0 = صفوف متجاورة)',
  'danmaku.fontWeightDesc': 'العريض أكثر قابلية للقراءة، العادي يستخدم ذاكرة GPU أقل',
  'danmaku.fontFamilyDesc': 'خط نص التعليق',
  'appearance.superchatOpacityDesc': 'شفافية خلفية بطاقات الرسائل المميزة',
  'appearance.superchatMaxLinesDesc': 'الحد الأقصى لأسطر النص قبل الاقتطاع (2-10)',
  'appearance.membershipMaxLinesDesc': 'الحد الأقصى لأسطر رسائل العضوية (1-5)',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'استخدام لون النص الذي اختاره المؤلف من دردشة YouTube بدلاً من إعدادات التراكب الافتراضية',
  'appearance.showSuperchatAmountDesc': 'إظهار شارة مبلغ الشراء على بطاقات الرسائل المميزة',
  'danmaku.topClearZoneDesc': 'إبقاء أعلى N% من الفيديو خالياً من التعليقات',
  'danmaku.bottomClearZoneDesc': 'إبقاء أسفل N% من الفيديو خالياً من التعليقات',
  'advanced.ignoreMinLengthDesc': 'إظهار جميع الرسائل بغض النظر عن الحد الأدنى لعدد الحروف',
  'advanced.minLengthDesc': 'الحد الأدنى لعدد الحروف',
  'advanced.backlogOpacityDesc': 'شفافية الرسائل السابقة بالنسبة للرسائل الفورية',
  'danmaku.durationMulDesc':
    'كم تبقى رسائل المشرف والمالك مرئية أطول (1.0 = نفس العادي، 2.0 = ضعف المدة)',
  'translation.enableDesc':
    'ترجمة رسائل الدردشة في الوقت الفعلي (يتطلب Chrome 138+ للترجمة المدمجة)',
  'advanced.depthLayersDesc':
    'إدراك العمق القائم على السرعة: الرسائل السريعة تظهر قريبة، البعيدة تظهر بعيدة',
  'advanced.depthNearSpeedDesc': 'تعزيز سرعة الرسائل القريبة',
  'advanced.depthFarSpeedDesc': 'تقليل سرعة الرسائل البعيدة',
  'advanced.depthFarOpacityDesc': 'تعتيم شفافية الرسائل البعيدة',
  'danmaku.scrollSpeedDesc': 'مدى سرعة تمرير التعليقات عبر الشاشة بالبكسل في الثانية',
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    'لغة رسائل الدردشة الواردة. الكشف التلقائي يستخدم كشف اللغة المدمج في Chrome.',
  'translation.sourceDesc':
    'اللغة التي تُترجم إليها رسائل الدردشة. يُكتشف تلقائياً من إعدادات المتصفح.',
  'advanced.authorRateLimitDesc': 'يحدد مدى تكرار ظهور رسائل نفس المؤلف',
  'translation.languageDesc': 'يضبط لغة واجهة المستخدم للتراكب (لا يصفّي التعليقات حسب اللغة)',

  // ── New Performance / Developer section titles ──
  Performance: 'الأداء',
  Developer: 'المطور',

  // ── New field labels ──
  'advanced.maxConcurrent': 'الحد الأقصى للرسائل المتزامنة',
  'advanced.fadeDuration': 'مدة التلاشي (مللي ثانية)',
  'advanced.minPollInterval': 'الحد الأدنى لفاصل الاستطلاع (مللي ثانية)',
  'advanced.maxPollInterval': 'الحد الأقصى لفاصل الاستطلاع (مللي ثانية)',
  'advanced.backlogInjectionRate': 'الحد الأقصى لمعدل الحقن (رسالة/ث)',
  'advanced.backlogSpeed': 'مضاعف سرعة السجل',
  'advanced.backlogRecentWindow': 'النافذة الزمنية (دقائق)',
  'advanced.logLevel': 'مستوى السجل',
  'advanced.debugOverlay': 'طبقة تصحيح',

  // ── New select options ──
  'advanced.logLevelWarn': 'التحذيرات فقط',
  Info: 'معلومات',
  'advanced.logLevelDebug': 'تصحيح (مفصّل)',

  // ── New tooltips ──
  'advanced.maxConcurrentDesc': 'الحد الأقصى لعدد الرسائل المرئية على الشاشة في وقت واحد (30-300)',
  'advanced.fadeDurationDesc': 'المدة التي تستغرقها الرسائل للتلاشي (0 = فوري، 50-1000)',
  'advanced.minPollIntervalDesc': 'الحد الأدنى لفاصل استطلاع الدردشة (مللي ثانية، 50-5000)',
  'advanced.maxPollIntervalDesc': 'الحد الأقصى لفاصل استطلاع الدردشة (مللي ثانية، 1000-30000)',
  'advanced.backlogInjectionRateDesc': 'الحد الأقصى لمعدل حقن رسائل السجل في الثانية (0-50)',
  'advanced.backlogSpeedDesc': 'مضاعف سرعة حركة رسائل السجل (1-5)',
  'advanced.backlogRecentWindowDesc': 'النافذة الزمنية بالدقائق لوضع السجل الأخير فقط (1-30)',
  'advanced.logLevelDesc': 'تفصيل مخرجات تشخيص وحدة التحكم',
  'advanced.debugOverlayDesc': 'إظهار تراكب تصحيح الأداء على مشغل الفيديو',

  // ── New tooltips (added 2026-05-28) ──
  'danmaku.fontSizeDesc': 'حجم النص بالبكسل (14-50)',
  'appearance.outlineWidthDesc': 'عرض حد محيط النص بالبكسل (0-8)',
  'appearance.outlineOpacityDesc': 'شفافية حد النص (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'app.enabledDesc': 'تفعيل أو تعطيل تراكب الدردشة على بثوث YouTube المباشرة عالمياً',
  'danmaku.modeDesc': 'اتجاه وسلوك عرض التعليقات',
  'danmaku.textOpacityDesc': 'الشفافية الكلية لنص التعليقات (50-100%)',
  'appearance.outlineEnabledDesc': 'إضافة حد داكن حول النص لتحسين قابلية القراءة',
  'advanced.backlogModeDesc': 'كيف تُعرض رسائل الدردشة السابقة بالنسبة للتشغيل المباشر',
  'translation.displayModeDesc': 'المزدوج يعرض الأصل فوق الترجمة، الاستبدال يعرض الترجمة فقط',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'advanced.emojiCache': 'ذاكرة الرموز التعبيرية المؤقتة (MB)',
  'advanced.photoCache': 'ذاكرة الصور المؤقتة (MB)',
  'advanced.stickerCache': 'ذاكرة الملصقات المؤقتة (MB)',
  'advanced.textCache': 'ذاكرة النصوص المؤقتة (MB)',
  'advanced.translationBatchSize': 'حجم دفعة الترجمة',
  'advanced.emojiFetchLimit': 'حد جلب الرموز التعبيرية',
  'advanced.emojiRetryMin': 'إعادة محاولة الرموز التعبيرية الفاشلة (دقائق)',
  'advanced.emojiCacheDesc':
    'الحد الأقصى للذاكرة المؤقتة لصور الرموز التعبيرية (1-20 MB، الافتراضي 3)',
  'advanced.photoCacheDesc': 'الحد الأقصى للذاكرة المؤقتة لصور المؤلفين (1-20 MB، الافتراضي 2)',
  'advanced.stickerCacheDesc': 'الحد الأقصى للذاكرة المؤقتة لصور الملصقات (1-20 MB، الافتراضي 1)',
  'advanced.textCacheDesc': 'الحد الأقصى للذاكرة المؤقتة للنصوص النقطية (1-20 MB، الافتراضي 4)',
  'advanced.translationBatchSizeDesc':
    'الحد الأقصى للترجمات المطبقة لكل إطار لتجنب الارتفاعات الحادة (1-20، الافتراضي 5)',
  'advanced.emojiFetchLimitDesc':
    'الحد الأقصى لعمليات جلب الرموز التعبيرية المتزامنة (1-20، الافتراضي 6)',
  'advanced.emojiRetryMinDesc':
    'المدة قبل إعادة محاولة جلب الرموز التعبيرية الفاشلة (1-60 دقيقة، الافتراضي 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'advanced.burstSampleWindow': 'نافذة عينة الانفجار',
  'advanced.burstElevated': 'انفجار مرتفع (رسالة/ث)',
  'advanced.burstHigh': 'انفجار عالٍ (رسالة/ث)',
  'advanced.burstExtreme': 'انفجار شديد (رسالة/ث)',
  'advanced.tuningBacklogInjectionMax': 'الحد الأقصى لحقن السجل',
  'advanced.tuningDensityRamp': 'منحدر كثافة السجل (مللي ثانية)',
  'advanced.tuningPollFallback': 'تراجع الاستطلاع المباشر (مللي ثانية)',
  'advanced.tuningPollFailureLimit': 'حد فشل الاستطلاع',
  'advanced.tuningSpeedBoostThreshold': 'عتبة تعزيز السرعة',
  'advanced.tuningBacklogPause': 'إيقاف السجل (%)',
  'advanced.tuningBacklogResume': 'استئناف السجل (%)',
  'advanced.tuningActivityTimeout': 'مهلة النشاط (مللي ثانية)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'advanced.burstSampleWindowDesc': 'حجم نافذة عينة معدل الانفجار',
  'advanced.burstElevatedDesc': 'عتبة الرسائل في الثانية لمستوى الانفجار المرتفع',
  'advanced.burstHighDesc': 'عتبة الرسائل في الثانية لمستوى الانفجار العالي',
  'advanced.burstExtremeDesc': 'عتبة الرسائل في الثانية لمستوى الانفجار الشديد',
  'advanced.tuningBacklogInjectionMaxDesc': 'الحد الأقصى لسقف معدل حقن السجل',
  'advanced.tuningDensityRampDesc': 'مدة منحدر كثافة حقن السجل بالمللي ثانية',
  'advanced.tuningPollFallbackDesc': 'تأخير تراجع الاستطلاع المباشر بالمللي ثانية',
  'advanced.tuningPollFailureLimitDesc': 'إخفاقات الاستطلاع المتتالية قبل قطع قاطع الدائرة',
  'advanced.tuningSpeedBoostThresholdDesc': 'الرسائل المعلقة لتشغيل تعزيز السرعة',
  'advanced.tuningBacklogPauseDesc': 'نسبة استخدام المسار لإيقاف حقن السجل',
  'advanced.tuningBacklogResumeDesc': 'نسبة استخدام المسار لاستئناف حقن السجل',
  'advanced.tuningActivityTimeoutDesc': 'مهلة نشاط الدردشة بالمللي ثانية',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'advanced.tuningStaggerMax': 'الحد الأقصى لتأخير التدرج (مللي ثانية)',
  'advanced.tuningStaggerMedium': 'تأخير التدرج المتوسط (مللي ثانية)',
  'advanced.tuningEmojiTimeout': 'مهلة جلب الرموز التعبيرية (مللي ثانية)',
  'advanced.tuningDensityRampMax': 'الحد الأقصى لمنحدر كثافة السجل (مللي ثانية)',
  'advanced.tuningInjectionRateMin': 'الحد الأدنى لمعدل حقن السجل',
  'advanced.tuningSpeedBoostMax': 'الحد الأقصى لتعزيز السرعة',
  'advanced.tuningSpeedBoostDenom': 'مقام تعزيز السرعة',
  'advanced.tuningToggleCooldown': 'فترة تهدئة تبديل السجل (مللي ثانية)',
  'advanced.replayPrefetchPages': 'صفحات الجلب المسبق للإعادة',
  'advanced.replayBatchLimit': 'حد دفعة الإعادة',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'advanced.tuningStaggerMaxDesc': 'الحد الأقصى لتأخير التدرج للرسائل في نفس الدفعة',
  'advanced.tuningStaggerMediumDesc': 'تأخير التدرج المتوسط عندما يكون عمق قائمة الانتظار متوسطاً',
  'advanced.tuningEmojiTimeoutDesc': 'مهلة عمليات جلب الرموز التعبيرية',
  'advanced.tuningDensityRampMaxDesc': 'الحد الأقصى لمدة منحدر كثافة حقن السجل',
  'advanced.tuningInjectionRateMinDesc': 'الحد الأدنى لمعدل حقن السجل (رسالة/ث)',
  'advanced.tuningSpeedBoostMaxDesc': 'الحد الأقصى لمعامل تعزيز السرعة لتعويض الانفجار',
  'advanced.tuningSpeedBoostDenomDesc': 'مقام تعزيز السرعة لتوسيع معدل EMA',
  'advanced.tuningToggleCooldownDesc': 'فترة التهدئة بين تبديلات إيقاف السجل',
  'advanced.replayPrefetchPagesDesc': 'الحد الأقصى للصفحات للجلب المسبق في وضع الإعادة',
  'advanced.replayBatchLimitDesc': 'الحد الأقصى للدفعات للجلب في تهيئة الإعادة',

  // ── Modal chrome ──
  'app.title': 'تراكب الدردشة',
  'app.close': 'إغلاق الإعدادات',
  'app.settingsCategories': 'فئات الإعدادات',
  'app.enabled': 'التراكب مُفعَّل',
  'format.valueAdjusted': 'تم ضبط القيمة على ',
  Reset: 'إعادة تعيين',
  Export: 'تصدير',
  Import: 'استيراد',
  Close: 'إغلاق',
  Done: 'تم',
  'app.autoSave': 'يتم حفظ التغييرات تلقائيًا',
  'reset.confirm': 'إعادة تعيين جميع الإعدادات إلى الافتراضية؟',
  Cancel: 'إلغاء',
  'import.invalidFormat': 'فشل الاستيراد: تنسيق الإعدادات غير صالح',
  'import.fileTooLarge': 'فشل الاستيراد: ملف الإعدادات كبير جدًا',
  'import.success': 'تم استيراد الإعدادات بنجاح',
  'actions.export': 'تصدير',
  'actions.import': 'استيراد',
  'actions.reset': 'إعادة تعيين',
  'import.invalidJson': 'فشل الاستيراد: JSON غير صالح',
  'app.settings': 'إعدادات تراكب الدردشة',
  'reset.confirmDesc': 'إعادة تعيين إعدادات التراكب',
  'app.reload': 'إعادة تحميل التراكب',

  // ── Author grid ──
  Color: 'اللون',
  'appearance.authorsNameColor': 'لون الاسم',
  'appearance.authorsBackground': 'الخلفية',
  Show: 'إظهار',
  'appearance.authorsShowName': 'إظهار الاسم',
  Normal: 'عادي',
  Member: 'عضو',
  Moderator: 'مشرف',
  Owner: 'مالك',
  Verified: 'موثّق',
  SuperChat: 'رسالة مميزة',
  'indicator.loading': 'جارٍ تحميل سجل الدردشة...',
  'format.shortMessagesShown': 'عرض الرسائل القصيرة بغض النظر عن الطول',

  // ── Toast / sync messages ──

  // ── Translation unsupported ──
  'translation.unsupported':
    'يتطلب الترجمة متصفحًا مزودًا بذكاء اصطناعي مدمج. استخدم Chrome 138+ أو Edge 143+ Canary.',

  // ── Added 2026-07-04 ──
  'chat.messages': 'رسائل الدردشة',
  'chat.membership': 'عضوية',
  'chat.superChat': 'رسالة مميزة',
  'advanced.ignoreReducedMotion': 'تجاهل تقليل الحركة',
  'advanced.ignoreReducedMotionDesc':
    'فرض رسوم التمرير المتحركة حتى عند تمكين تقليل الحركة في النظام (يتطلب تحديث الصفحة)',
  'danmaku.fontCustomDesc':
    'قيمة CSS font-family. اكتب لتصفية الاقتراحات، أو أدخل مجموعة خطوط مخصصة.',
  'pane.comments': 'التعليقات',
  'pane.appearance': 'المظهر',
  'pane.advanced': 'متقدم',
  'pane.translation': 'الترجمة',
  'appearance.cards': 'البطاقات',
  'danmaku.font': 'الخط',
  'danmaku.timing': 'التوقيت',
  'advanced.backlog': 'السجل',
  'advanced.cache': 'الذاكرة المؤقتة',
  'advanced.tuning': 'الضبط',
  'advanced.developer': 'المطور',
  'advanced.performance': 'الأداء',
  'advanced.authorRateLimitOff': 'إيقاف',
  'appearance.authorsSuperchat': 'رسالة مميزة',
  'translation.interface': 'الواجهة',
  'translation.service': 'الخدمة',
  'indicator.busy': 'الدردشة مشغولة',
  'indicator.heavy': 'الدردشة كثيفة — تم حذف بعض الرسائل',
  'indicator.overload': 'الدردشة محملة — يتم تخطي الرسائل',
  'advanced.logLevelInfo': 'معلومات',
  'app.cancel': 'إلغاء',
  'app.done': 'تم',
  'translation.language': 'اللغة',
  'appearance.outlineEnabled': 'مُفعَّل',
};
