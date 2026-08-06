// ==UserScript==
// @name         YouTube Live Chat Overlay
// @namespace    https://github.com/PiesP
// @version      0.45.0
// @author       PiesP
// @description  In-browser NicoNico-style comment overlay for YouTube live chat.
// @license      MIT
// @icon         https://www.youtube.com/favicon.ico
// @homepage     https://github.com/PiesP/yt-live-chat-overlay
// @homepageURL  https://github.com/PiesP/yt-live-chat-overlay
// @source       https://github.com/PiesP/yt-live-chat-overlay.git
// @supportURL   https://github.com/PiesP/yt-live-chat-overlay/issues
// @downloadURL  https://cdn.jsdelivr.net/gh/PiesP/yt-live-chat-overlay@release/yt-live-chat-overlay.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/PiesP/yt-live-chat-overlay@release/yt-live-chat-overlay.meta.js
// @match        https://www.youtube.com/*
// @grant        GM_addValueChangeListener
// @grant        GM_deleteValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_removeValueChangeListener
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function() {
	"use strict";
	var hasURLPattern = typeof URLPattern !== "undefined";
	var watchPattern = hasURLPattern ? new URLPattern({
		hostname: "www.youtube.com",
		pathname: "/watch"
	}) : null;
	var livePattern = hasURLPattern ? new URLPattern({
		hostname: "www.youtube.com",
		pathname: "/live/*"
	}) : null;
	function isYouTubeWatch(url) {
		if (watchPattern) return watchPattern.test(url);
		try {
			const u = new URL(url);
			return u.hostname === "www.youtube.com" && u.pathname === "/watch";
		} catch {
			return false;
		}
	}
	function isYouTubeLive(url) {
		if (livePattern) return livePattern.test(url);
		try {
			const u = new URL(url);
			return u.hostname === "www.youtube.com" && u.pathname.startsWith("/live/");
		} catch {
			return false;
		}
	}
	var currentLogLevel = "warn";
	var LOG_LEVEL_RANK = {
		warn: 0,
		info: 1,
		debug: 2
	};
	var shouldEmit = (level) => LOG_LEVEL_RANK[currentLogLevel] >= LOG_LEVEL_RANK[level];
	var overlayLog = {
		debug: (...args) => {
			if (shouldEmit("debug")) console.debug(...args);
		},
		info: (...args) => {
			if (shouldEmit("info")) console.info(...args);
		},
		warn: (...args) => {
			console.warn(...args);
		},
		error: (...args) => {
			console.error(...args);
		}
	};
	function setOverlayLogLevel(level) {
		currentLogLevel = level;
	}
	function createLogger(moduleName) {
		const prefix = `[${moduleName}]`;
		return {
			debug: (...args) => overlayLog.debug(prefix, ...args),
			info: (...args) => overlayLog.info(prefix, ...args),
			warn: (...args) => overlayLog.warn(prefix, ...args),
			error: (...args) => overlayLog.error(prefix, ...args)
		};
	}
	var log$29 = createLogger("PageWatcher");
	var YT_NAVIGATE_FINISH_EVENT$1 = "yt-navigate-finish";
	var PageWatcher = class PageWatcher {
		currentUrl = location.href;
		callbacks = new Set();
		restorePushState;
		restoreReplaceState;
		patchGenerations = {
			pushState: 0,
			replaceState: 0
		};
		static wrapperToState = new WeakMap();
		handleUrlMutation = () => {
			this.handlePotentialUrlChange("popstate");
		};
		handleYouTubeNavigateFinish = () => {
			log$29.debug("app.page-watcher.navigation-finished");
			const newUrl = location.href;
			if (newUrl !== this.currentUrl) this.currentUrl = newUrl;
			this.notifyCallbacks();
		};
		constructor() {
			this.restorePushState = this.patchHistoryMethod("pushState");
			this.restoreReplaceState = this.patchHistoryMethod("replaceState");
			window.addEventListener("popstate", this.handleUrlMutation);
			window.addEventListener(YT_NAVIGATE_FINISH_EVENT$1, this.handleYouTubeNavigateFinish);
		}
		patchHistoryMethod(methodName) {
			const previous = history[methodName];
			const currentState = PageWatcher.wrapperToState.get(previous);
			if (currentState?.owner === this && currentState.active) return () => {};
			const generation = ++this.patchGenerations[methodName];
			const state = {
				methodName,
				owner: this,
				previous,
				wrapper: void 0,
				generation,
				active: true
			};
			const patched = (...args) => {
				const result = state.previous.apply(history, args);
				if (state.active) this.handlePotentialUrlChange(methodName);
				return result;
			};
			state.wrapper = patched;
			PageWatcher.wrapperToState.set(patched, state);
			history[methodName] = patched;
			return () => {
				if (!state.active) return;
				state.active = false;
				if (history[methodName] !== state.wrapper || this.patchGenerations[methodName] !== state.generation) return;
				let restored = state.previous;
				while (true) {
					const previousState = PageWatcher.wrapperToState.get(restored);
					if (!previousState || previousState.active) break;
					restored = previousState.previous;
				}
				history[methodName] = restored;
			};
		}
		handlePotentialUrlChange(source) {
			const newUrl = location.href;
			if (newUrl === this.currentUrl) return;
			const previousUrl = this.currentUrl;
			this.currentUrl = newUrl;
			log$29.info("URL changed", {
				source,
				from: previousUrl,
				to: newUrl
			});
			this.notifyCallbacks();
		}
		notifyCallbacks() {
			for (const callback of this.callbacks) try {
				callback();
			} catch (error) {
				log$29.warn("app.page-watcher.callback-error", { error: String(error) });
			}
		}
		onChange(callback) {
			this.callbacks.add(callback);
		}
		isValidPage() {
			return isYouTubeWatch(location.href) || isYouTubeLive(location.href);
		}
		destroy() {
			window.removeEventListener("popstate", this.handleUrlMutation);
			window.removeEventListener(YT_NAVIGATE_FINISH_EVENT$1, this.handleYouTubeNavigateFinish);
			this.restorePushState?.();
			this.restoreReplaceState?.();
			this.callbacks.clear();
			log$29.debug("app.page-watcher.destroyed");
		}
	};
	function createChatPreflight() {
		let state = { phase: "idle" };
		return {
			get state() {
				return state;
			},
			get isTerminalAbsent() {
				return state.phase === "expected-absent";
			},
			get isSettling() {
				return state.phase === "settling";
			},
			startSettle(url) {
				if (state.phase === "expected-absent" && state.url === url) return;
				if (state.phase === "settling" && state.url === url) return;
				state = {
					phase: "settling",
					url
				};
			},
			markAbsent(url) {
				if (state.phase === "expected-absent" && state.url === url) return;
				state = {
					phase: "expected-absent",
					url
				};
			},
			reset() {
				state = { phase: "idle" };
			}
		};
	}
	var AR = {
		Comments: "التعليقات",
		Appearance: "المظهر والألوان",
		Advanced: "متقدم",
		Translation: "الترجمة",
		"app.name": "تراكب الدردشة المباشرة",
		Paused: "متوقف مؤقتًا",
		"app.langChanged": "تم تغيير لغة الواجهة إلى: ",
		"status.connecting": "جارٍ الاتصال…",
		"status.unstable": "الاتصال غير مستقر",
		"status.disconnected": "تم قطع الاتصال — انقر لإعادة التحميل",
		"status.waiting": "بانتظار البث المباشر…",
		Cards: "البطاقات",
		"appearance.outline": "حدود النص",
		"danmaku.safeZone": "المنطقة الآمنة",
		"advanced.messageRate": "معدل الرسائل",
		"advanced.depthLayers": "طبقات العمق",
		Font: "الخط",
		Backlog: "السجل",
		Timing: "التوقيت",
		Tuning: "الضبط",
		"advanced.burst": "كشف الانفجار",
		Cache: "الذاكرة المؤقتة",
		"appearance.authors": "ألوان المؤلفين والرؤية",
		Interface: "الواجهة",
		"translation.chat": "ترجمة الدردشة",
		"translation.serviceDesc": "خدمة الترجمة الخلفية لمعالجة الرسائل",
		"advanced.authorRateLimit": "حد معدل المؤلف",
		"advanced.backlogMode": "وضع السجل",
		"advanced.backlogOpacity": "شفافية السجل (%)",
		Bold: "عريض",
		"danmaku.bottomClearZone": "المنطقة السفلية الخالية (%)",
		"danmaku.fontCustom": "خط مخصص…",
		"danmaku.mode": "وضع التعليقات المنسدلة",
		Enabled: "مُفعَّل",
		Family: "العائلة",
		"advanced.ignoreMinLength": "تجاهل الحد الأدنى للطول",
		"danmaku.laneGap": "تباعد الصفوف (بكسل)",
		Language: "اللغة",
		"appearance.membershipMaxLines": "الحد الأقصى لأسطر رسائل العضوية",
		"advanced.minLength": "الحد الأدنى للطول (حروف)",
		"appearance.outlineOpacity": "شفافية الحد (%)",
		"appearance.outlineWidth": "عرض الحد (بكسل)",
		"appearance.preserveUserColors": "الاحتفاظ بألوان المستخدم",
		Regular: "عادي",
		"danmaku.scrollSpeed": "سرعة التمرير (بكسل/ث)",
		"appearance.showSuperchatAmount": "إظهار مبلغ الرسائل المميزة",
		"danmaku.fontSize": "الحجم (px)",
		"appearance.superchatMaxLines": "الحد الأقصى لأسطر الرسائل المميزة",
		"appearance.superchatOpacity": "شفافية الرسائل المميزة (%)",
		"danmaku.textOpacity": "شفافية النص (%)",
		"danmaku.topClearZone": "المنطقة العلوية الخالية (%)",
		Weight: "الوزن",
		English: "الإنجليزية",
		한국어: "الكورية",
		日本語: "اليابانية",
		Español: "الإسبانية",
		中文: "الصينية",
		العربية: "العربية",
		"danmaku.durationMul": "مضاعف المدة (×)",
		"danmaku.exitPadding": "حافة الخروج (بكسل)",
		"danmaku.minScrollDuration": "الحد الأدنى لمدة التمرير (مللي ثانية)",
		"danmaku.maxScrollDuration": "الحد الأقصى لمدة التمرير (مللي ثانية)",
		"danmaku.topBottomDuration": "مدة أعلى/أسفل (مللي ثانية)",
		"advanced.maxQueueDepth": "الحد الأقصى لعمق قائمة الانتظار",
		"advanced.tabTrimTarget": "هدف تقليم التبويب",
		"advanced.maxMessageAge": "الحد الأقصى لعمر الرسالة (مللي ثانية)",
		"danmaku.messageSpacing": "تباعد الرسائل (%)",
		"danmaku.exitPaddingDesc": "بكسلات إضافية تمررها الرسالة بعد حافة الشاشة قبل إزالتها (20-400، الافتراضي 100)",
		"danmaku.minScrollDurationDesc": "الحد الأدنى لمدة حركة التمرير — يمنع الرسائل القصيرة جداً من المرور بسرعة (1000-15000 مللي ثانية، الافتراضي 5000)",
		"danmaku.maxScrollDurationDesc": "الحد الأقصى لمدة حركة التمرير — يمنع الرسائل الطويلة جداً من الزحف (5-120 ثانية، الافتراضي 30000 مللي ثانية)",
		"danmaku.topBottomDurationDesc": "مدة العرض الثابتة للرسائل في وضع أعلى/أسفل (1000-30000 مللي ثانية، الافتراضي 4000)",
		"advanced.maxQueueDepthDesc": "الحد الأقصى لعمق قائمة الانتظار قبل إسقاط الرسائل (50-1000، الافتراضي 200)",
		"advanced.tabTrimTargetDesc": "عدد الرسائل النشطة المستهدف عند تقليم التبويب الخلفي (10-500، الافتراضي 50)",
		"advanced.maxMessageAgeDesc": "الحد الأقصى لعمر الرسالة قبل الإزالة التدريجية (10-300 ثانية، الافتراضي 60000 مللي ثانية)",
		"danmaku.messageSpacingDesc": "الفجوة بين الرسائل المتتالية كنسبة مئوية من عرض الرسالة (2-30%، الافتراضي 8)",
		"translation.enable": "تفعيل الترجمة",
		Service: "الخدمة",
		"translation.source": "لغة المصدر",
		"translation.target": "لغة الهدف",
		"translation.displayMode": "وضع العرض",
		"advanced.depthNearSpeed": "سرعة القريبة (%)",
		"advanced.depthFarSpeed": "سرعة البعيدة (%)",
		"advanced.depthFarOpacity": "شفافية البعيدة (%)",
		"danmaku.scroll": "تمرير (يمين لليسار)",
		"danmaku.reverse": "عكسي (يسار لليمين)",
		"danmaku.top": "أعلى ثابت",
		"danmaku.bottom": "أسفل ثابت",
		"advanced.backlogPlayback": "بناءً على التشغيل (موصى به)",
		"advanced.backlogRecent": "الأخيرة فقط",
		"advanced.backlogFull": "كامل (إظهار الكل)",
		"advanced.backlogNone": "بدون (تخطي السجل)",
		Off: "إيقاف",
		"advanced.authorRateLimitNormal": "عادي (5 رسائل / 5 ثوانٍ)",
		"advanced.authorRateLimitStrict": "صارم (2 رسائل / 5 ثوانٍ)",
		"translation.languageAuto": "تلقائي (المتصفح)",
		"translation.sourceAuto": "كشف تلقائي",
		"translation.serviceAuto": "تلقائي (مدمج في Chrome)",
		"translation.displayModeDual": "مزدوج (الأصل + الترجمة)",
		"translation.displayModeReplace": "استبدال (الترجمة فقط)",
		"danmaku.laneGapDesc": "الفجوة الرأسية بين صفوف التعليقات (0 = صفوف متجاورة)",
		"danmaku.fontWeightDesc": "العريض أكثر قابلية للقراءة، العادي يستخدم ذاكرة GPU أقل",
		"danmaku.fontFamilyDesc": "خط نص التعليق",
		"appearance.superchatOpacityDesc": "شفافية خلفية بطاقات الرسائل المميزة",
		"appearance.superchatMaxLinesDesc": "الحد الأقصى لأسطر النص قبل الاقتطاع (2-10)",
		"appearance.membershipMaxLinesDesc": "الحد الأقصى لأسطر رسائل العضوية (1-5)",
		"Use author's chosen text color from YouTube chat instead of overlay defaults": "استخدام لون النص الذي اختاره المؤلف من دردشة YouTube بدلاً من إعدادات التراكب الافتراضية",
		"appearance.showSuperchatAmountDesc": "إظهار شارة مبلغ الشراء على بطاقات الرسائل المميزة",
		"danmaku.topClearZoneDesc": "إبقاء أعلى N% من الفيديو خالياً من التعليقات",
		"danmaku.bottomClearZoneDesc": "إبقاء أسفل N% من الفيديو خالياً من التعليقات",
		"advanced.ignoreMinLengthDesc": "إظهار جميع الرسائل بغض النظر عن الحد الأدنى لعدد الحروف",
		"advanced.minLengthDesc": "الحد الأدنى لعدد الحروف",
		"advanced.backlogOpacityDesc": "شفافية الرسائل السابقة بالنسبة للرسائل الفورية",
		"danmaku.durationMulDesc": "كم تبقى رسائل المشرف والمالك مرئية أطول (1.0 = نفس العادي، 2.0 = ضعف المدة)",
		"translation.enableDesc": "ترجمة رسائل الدردشة في الوقت الفعلي (يتطلب Chrome 138+ للترجمة المدمجة)",
		"advanced.depthLayersDesc": "إدراك العمق القائم على السرعة: الرسائل السريعة تظهر قريبة، البعيدة تظهر بعيدة",
		"advanced.depthNearSpeedDesc": "تعزيز سرعة الرسائل القريبة",
		"advanced.depthFarSpeedDesc": "تقليل سرعة الرسائل البعيدة",
		"advanced.depthFarOpacityDesc": "تعتيم شفافية الرسائل البعيدة",
		"danmaku.scrollSpeedDesc": "مدى سرعة تمرير التعليقات عبر الشاشة بالبكسل في الثانية",
		"Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.": "لغة رسائل الدردشة الواردة. الكشف التلقائي يستخدم كشف اللغة المدمج في Chrome.",
		"translation.sourceDesc": "اللغة التي تُترجم إليها رسائل الدردشة. يُكتشف تلقائياً من إعدادات المتصفح.",
		"advanced.authorRateLimitDesc": "يحدد مدى تكرار ظهور رسائل نفس المؤلف",
		"translation.languageDesc": "يضبط لغة واجهة المستخدم للتراكب (لا يصفّي التعليقات حسب اللغة)",
		Performance: "الأداء",
		Developer: "المطور",
		"advanced.maxConcurrent": "الحد الأقصى للرسائل المتزامنة",
		"advanced.fadeDuration": "مدة التلاشي (مللي ثانية)",
		"advanced.minPollInterval": "الحد الأدنى لفاصل الاستطلاع (مللي ثانية)",
		"advanced.maxPollInterval": "الحد الأقصى لفاصل الاستطلاع (مللي ثانية)",
		"advanced.backlogInjectionRate": "الحد الأقصى لمعدل الحقن (رسالة/ث)",
		"advanced.backlogSpeed": "مضاعف سرعة السجل",
		"advanced.backlogRecentWindow": "النافذة الزمنية (دقائق)",
		"advanced.logLevel": "مستوى السجل",
		"advanced.debugOverlay": "طبقة تصحيح",
		"advanced.logLevelWarn": "التحذيرات فقط",
		Info: "معلومات",
		"advanced.logLevelDebug": "تصحيح (مفصّل)",
		"advanced.maxConcurrentDesc": "الحد الأقصى لعدد الرسائل المرئية على الشاشة في وقت واحد (30-300)",
		"advanced.fadeDurationDesc": "المدة التي تستغرقها الرسائل للتلاشي (0 = فوري، 50-1000)",
		"advanced.minPollIntervalDesc": "الحد الأدنى لفاصل استطلاع الدردشة (مللي ثانية، 50-5000)",
		"advanced.maxPollIntervalDesc": "الحد الأقصى لفاصل استطلاع الدردشة (مللي ثانية، 1000-30000)",
		"advanced.backlogInjectionRateDesc": "الحد الأقصى لمعدل حقن رسائل السجل في الثانية (0-50)",
		"advanced.backlogSpeedDesc": "مضاعف سرعة حركة رسائل السجل (1-5)",
		"advanced.backlogRecentWindowDesc": "النافذة الزمنية بالدقائق لوضع السجل الأخير فقط (1-30)",
		"advanced.logLevelDesc": "تفصيل مخرجات تشخيص وحدة التحكم",
		"advanced.debugOverlayDesc": "إظهار تراكب تصحيح الأداء على مشغل الفيديو",
		"danmaku.fontSizeDesc": "حجم النص بالبكسل (14-50)",
		"appearance.outlineWidthDesc": "عرض حد محيط النص بالبكسل (0-8)",
		"appearance.outlineOpacityDesc": "شفافية حد النص (0-100%)",
		"app.enabledDesc": "تفعيل أو تعطيل تراكب الدردشة على بثوث YouTube المباشرة عالمياً",
		"danmaku.modeDesc": "اتجاه وسلوك عرض التعليقات",
		"danmaku.textOpacityDesc": "الشفافية الكلية لنص التعليقات (50-100%)",
		"appearance.outlineEnabledDesc": "إضافة حد داكن حول النص لتحسين قابلية القراءة",
		"advanced.backlogModeDesc": "كيف تُعرض رسائل الدردشة السابقة بالنسبة للتشغيل المباشر",
		"translation.displayModeDesc": "المزدوج يعرض الأصل فوق الترجمة، الاستبدال يعرض الترجمة فقط",
		"advanced.emojiCache": "ذاكرة الرموز التعبيرية المؤقتة (MB)",
		"advanced.photoCache": "ذاكرة الصور المؤقتة (MB)",
		"advanced.stickerCache": "ذاكرة الملصقات المؤقتة (MB)",
		"advanced.textCache": "ذاكرة النصوص المؤقتة (MB)",
		"advanced.translationBatchSize": "حجم دفعة الترجمة",
		"advanced.emojiFetchLimit": "حد جلب الرموز التعبيرية",
		"advanced.emojiRetryMin": "إعادة محاولة الرموز التعبيرية الفاشلة (دقائق)",
		"advanced.emojiCacheDesc": "الحد الأقصى للذاكرة المؤقتة لصور الرموز التعبيرية (1-20 MB، الافتراضي 3)",
		"advanced.photoCacheDesc": "الحد الأقصى للذاكرة المؤقتة لصور المؤلفين (1-20 MB، الافتراضي 2)",
		"advanced.stickerCacheDesc": "الحد الأقصى للذاكرة المؤقتة لصور الملصقات (1-20 MB، الافتراضي 1)",
		"advanced.textCacheDesc": "الحد الأقصى للذاكرة المؤقتة للنصوص النقطية (1-20 MB، الافتراضي 4)",
		"advanced.translationBatchSizeDesc": "الحد الأقصى للترجمات المطبقة لكل إطار لتجنب الارتفاعات الحادة (1-20، الافتراضي 5)",
		"advanced.emojiFetchLimitDesc": "الحد الأقصى لعمليات جلب الرموز التعبيرية المتزامنة (1-20، الافتراضي 6)",
		"advanced.emojiRetryMinDesc": "المدة قبل إعادة محاولة جلب الرموز التعبيرية الفاشلة (1-60 دقيقة، الافتراضي 5)",
		"advanced.burstSampleWindow": "نافذة عينة الانفجار",
		"advanced.burstElevated": "انفجار مرتفع (رسالة/ث)",
		"advanced.burstHigh": "انفجار عالٍ (رسالة/ث)",
		"advanced.burstExtreme": "انفجار شديد (رسالة/ث)",
		"advanced.tuningBacklogInjectionMax": "الحد الأقصى لحقن السجل",
		"advanced.tuningDensityRamp": "منحدر كثافة السجل (مللي ثانية)",
		"advanced.tuningPollFallback": "تراجع الاستطلاع المباشر (مللي ثانية)",
		"advanced.tuningPollFailureLimit": "حد فشل الاستطلاع",
		"advanced.tuningSpeedBoostThreshold": "عتبة تعزيز السرعة",
		"advanced.tuningBacklogPause": "إيقاف السجل (%)",
		"advanced.tuningBacklogResume": "استئناف السجل (%)",
		"advanced.tuningActivityTimeout": "مهلة النشاط (مللي ثانية)",
		"advanced.burstSampleWindowDesc": "حجم نافذة عينة معدل الانفجار",
		"advanced.burstElevatedDesc": "عتبة الرسائل في الثانية لمستوى الانفجار المرتفع",
		"advanced.burstHighDesc": "عتبة الرسائل في الثانية لمستوى الانفجار العالي",
		"advanced.burstExtremeDesc": "عتبة الرسائل في الثانية لمستوى الانفجار الشديد",
		"advanced.tuningBacklogInjectionMaxDesc": "الحد الأقصى لسقف معدل حقن السجل",
		"advanced.tuningDensityRampDesc": "مدة منحدر كثافة حقن السجل بالمللي ثانية",
		"advanced.tuningPollFallbackDesc": "تأخير تراجع الاستطلاع المباشر بالمللي ثانية",
		"advanced.tuningPollFailureLimitDesc": "إخفاقات الاستطلاع المتتالية قبل قطع قاطع الدائرة",
		"advanced.tuningSpeedBoostThresholdDesc": "الرسائل المعلقة لتشغيل تعزيز السرعة",
		"advanced.tuningBacklogPauseDesc": "نسبة استخدام المسار لإيقاف حقن السجل",
		"advanced.tuningBacklogResumeDesc": "نسبة استخدام المسار لاستئناف حقن السجل",
		"advanced.tuningActivityTimeoutDesc": "مهلة نشاط الدردشة بالمللي ثانية",
		"advanced.tuningStaggerMax": "الحد الأقصى لتأخير التدرج (مللي ثانية)",
		"advanced.tuningStaggerMedium": "تأخير التدرج المتوسط (مللي ثانية)",
		"advanced.tuningEmojiTimeout": "مهلة جلب الرموز التعبيرية (مللي ثانية)",
		"advanced.tuningDensityRampMax": "الحد الأقصى لمنحدر كثافة السجل (مللي ثانية)",
		"advanced.tuningInjectionRateMin": "الحد الأدنى لمعدل حقن السجل",
		"advanced.tuningSpeedBoostMax": "الحد الأقصى لتعزيز السرعة",
		"advanced.tuningSpeedBoostDenom": "مقام تعزيز السرعة",
		"advanced.tuningToggleCooldown": "فترة تهدئة تبديل السجل (مللي ثانية)",
		"advanced.replayPrefetchPages": "صفحات الجلب المسبق للإعادة",
		"advanced.replayBatchLimit": "حد دفعة الإعادة",
		"advanced.tuningStaggerMaxDesc": "الحد الأقصى لتأخير التدرج للرسائل في نفس الدفعة",
		"advanced.tuningStaggerMediumDesc": "تأخير التدرج المتوسط عندما يكون عمق قائمة الانتظار متوسطاً",
		"advanced.tuningEmojiTimeoutDesc": "مهلة عمليات جلب الرموز التعبيرية",
		"advanced.tuningDensityRampMaxDesc": "الحد الأقصى لمدة منحدر كثافة حقن السجل",
		"advanced.tuningInjectionRateMinDesc": "الحد الأدنى لمعدل حقن السجل (رسالة/ث)",
		"advanced.tuningSpeedBoostMaxDesc": "الحد الأقصى لمعامل تعزيز السرعة لتعويض الانفجار",
		"advanced.tuningSpeedBoostDenomDesc": "مقام تعزيز السرعة لتوسيع معدل EMA",
		"advanced.tuningToggleCooldownDesc": "فترة التهدئة بين تبديلات إيقاف السجل",
		"advanced.replayPrefetchPagesDesc": "الحد الأقصى للصفحات للجلب المسبق في وضع الإعادة",
		"advanced.replayBatchLimitDesc": "الحد الأقصى للدفعات للجلب في تهيئة الإعادة",
		"app.title": "تراكب الدردشة",
		"app.close": "إغلاق الإعدادات",
		"app.settingsCategories": "فئات الإعدادات",
		"app.enabled": "التراكب مُفعَّل",
		"format.valueAdjusted": "تم ضبط القيمة على ",
		Reset: "إعادة تعيين",
		Export: "تصدير",
		Import: "استيراد",
		Close: "إغلاق",
		Done: "تم",
		"app.autoSave": "يتم حفظ التغييرات تلقائيًا",
		"reset.confirm": "إعادة تعيين جميع الإعدادات إلى الافتراضية؟",
		Cancel: "إلغاء",
		"import.invalidFormat": "فشل الاستيراد: تنسيق الإعدادات غير صالح",
		"import.success": "تم استيراد الإعدادات بنجاح",
		"actions.export": "تصدير",
		"actions.import": "استيراد",
		"actions.reset": "إعادة تعيين",
		"import.invalidJson": "فشل الاستيراد: JSON غير صالح",
		"app.settings": "إعدادات تراكب الدردشة",
		"reset.confirmDesc": "إعادة تعيين إعدادات التراكب",
		"app.reload": "إعادة تحميل التراكب",
		Color: "اللون",
		"appearance.authorsNameColor": "لون الاسم",
		"appearance.authorsBackground": "الخلفية",
		Show: "إظهار",
		"appearance.authorsShowName": "إظهار الاسم",
		Normal: "عادي",
		Member: "عضو",
		Moderator: "مشرف",
		Owner: "مالك",
		Verified: "موثّق",
		SuperChat: "رسالة مميزة",
		"indicator.loading": "جارٍ تحميل سجل الدردشة...",
		"format.shortMessagesShown": "عرض الرسائل القصيرة بغض النظر عن الطول",
		"translation.unsupported": "يتطلب الترجمة متصفحًا مزودًا بذكاء اصطناعي مدمج. استخدم Chrome 138+ أو Edge 143+ Canary.",
		"chat.messages": "رسائل الدردشة",
		"chat.membership": "عضوية",
		"chat.superChat": "رسالة مميزة",
		"advanced.ignoreReducedMotion": "تجاهل تقليل الحركة",
		"advanced.ignoreReducedMotionDesc": "فرض رسوم التمرير المتحركة حتى عند تمكين تقليل الحركة في النظام (يتطلب تحديث الصفحة)",
		"danmaku.fontCustomDesc": "قيمة CSS font-family. اكتب لتصفية الاقتراحات، أو أدخل مجموعة خطوط مخصصة.",
		"pane.comments": "التعليقات",
		"pane.appearance": "المظهر",
		"pane.advanced": "متقدم",
		"pane.translation": "الترجمة",
		"appearance.cards": "البطاقات",
		"danmaku.font": "الخط",
		"danmaku.timing": "التوقيت",
		"advanced.backlog": "السجل",
		"advanced.cache": "الذاكرة المؤقتة",
		"advanced.tuning": "الضبط",
		"advanced.developer": "المطور",
		"advanced.performance": "الأداء",
		"advanced.authorRateLimitOff": "إيقاف",
		"appearance.authorsSuperchat": "رسالة مميزة",
		"translation.interface": "الواجهة",
		"translation.service": "الخدمة",
		"indicator.busy": "الدردشة مشغولة",
		"indicator.heavy": "الدردشة كثيفة — تم حذف بعض الرسائل",
		"indicator.overload": "الدردشة محملة — يتم تخطي الرسائل",
		"advanced.logLevelInfo": "معلومات",
		"app.cancel": "إلغاء",
		"app.done": "تم",
		"translation.language": "اللغة",
		"appearance.outlineEnabled": "مُفعَّل"
	};
	var EN = {
		Comments: "Comments",
		Appearance: "Appearance",
		Advanced: "Advanced",
		Translation: "Translation",
		Paused: "Paused",
		Cards: "Cards",
		Font: "Font",
		Backlog: "Backlog",
		Timing: "Timing",
		Tuning: "Tuning",
		Cache: "Cache",
		Interface: "Interface",
		Bold: "Bold",
		Enabled: "Enabled",
		Family: "Family",
		Language: "Language",
		Regular: "Regular",
		Weight: "Weight",
		English: "English",
		한국어: "한국어",
		日本語: "日本語",
		Español: "Español",
		中文: "中文",
		العربية: "العربية",
		Service: "Service",
		Off: "Off",
		"Use author's chosen text color from YouTube chat instead of overlay defaults": "Use author's chosen text color from YouTube chat instead of overlay defaults",
		"Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.": "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.",
		Performance: "Performance",
		Developer: "Developer",
		Info: "Info",
		Reset: "Reset",
		Export: "Export",
		Import: "Import",
		Close: "Close",
		Done: "Done",
		Cancel: "Cancel",
		Color: "Color",
		Show: "Show",
		Normal: "Normal",
		Member: "Member",
		Moderator: "Moderator",
		Owner: "Owner",
		Verified: "Verified",
		SuperChat: "SuperChat",
		"advanced.authorRateLimit": "Author Rate Limit",
		"advanced.authorRateLimitDesc": "Limits how frequently messages from the same author appear",
		"advanced.authorRateLimitNormal": "Normal (5 msg / 5s)",
		"advanced.authorRateLimitStrict": "Strict (2 msg / 5s)",
		"advanced.backlogFull": "Full (show all)",
		"advanced.backlogInjectionRate": "Max Injection Rate (msg/s)",
		"advanced.backlogInjectionRateDesc": "Maximum backlog message injection rate per second (0-50)",
		"advanced.backlogMode": "Backlog Mode",
		"advanced.backlogModeDesc": "How past chat messages are displayed relative to live playback",
		"advanced.backlogNone": "None (skip backlog)",
		"advanced.backlogOpacity": "Backlog Opacity (%)",
		"advanced.backlogOpacityDesc": "Opacity of past messages relative to real-time messages",
		"advanced.backlogPlayback": "Playback-based (recommended)",
		"advanced.backlogRecent": "Recent only",
		"advanced.backlogRecentWindow": "Recent Window (min)",
		"advanced.backlogRecentWindowDesc": "Time window in minutes for recent-only backlog mode (1-30)",
		"advanced.backlogSpeed": "Backlog Speed (×)",
		"advanced.backlogSpeedDesc": "Animation speed multiplier for backlog messages (1-5)",
		"advanced.burst": "Burst Detection",
		"advanced.burstElevated": "Elevated Burst (msg/s)",
		"advanced.burstElevatedDesc": "Messages per second threshold for elevated burst level",
		"advanced.burstExtreme": "Extreme Burst (msg/s)",
		"advanced.burstExtremeDesc": "Messages per second threshold for extreme burst level",
		"advanced.burstHigh": "High Burst (msg/s)",
		"advanced.burstHighDesc": "Messages per second threshold for high burst level",
		"advanced.burstSampleWindow": "Burst Sample Window",
		"advanced.burstSampleWindowDesc": "Burst rate sample window size",
		"advanced.debugOverlay": "Debug Overlay",
		"advanced.debugOverlayDesc": "Show performance debug overlay on the video player",
		"advanced.depthFarOpacity": "Far Opacity (%)",
		"advanced.depthFarOpacityDesc": "Opacity dimming for far-layer messages",
		"advanced.depthFarSpeed": "Far Speed (%)",
		"advanced.depthFarSpeedDesc": "Speed reduction for far-layer messages",
		"advanced.depthLayers": "Depth Layers",
		"advanced.depthLayersDesc": "Speed-based depth perception: fast messages appear near, slow messages appear far",
		"advanced.depthNearSpeed": "Near Speed (%)",
		"advanced.depthNearSpeedDesc": "Speed boost for near-layer messages",
		"advanced.emojiCache": "Emoji Cache (MB)",
		"advanced.emojiCacheDesc": "Max memory for emoji image cache (1-20 MB, default 3)",
		"advanced.emojiFetchLimit": "Emoji Fetch Limit",
		"advanced.emojiFetchLimitDesc": "Max concurrent emoji fetch operations (1-20, default 6)",
		"advanced.emojiRetryMin": "Failed Emoji Retry (min)",
		"advanced.emojiRetryMinDesc": "How long to wait before retrying failed emoji fetches (1-60 min, default 5)",
		"advanced.fadeDuration": "Fade Duration (ms)",
		"advanced.fadeDurationDesc": "How long messages take to fade out (0 = instant, 50-1000)",
		"advanced.ignoreMinLength": "Ignore Min Length",
		"advanced.ignoreMinLengthDesc": "Show all messages regardless of minimum character length",
		"advanced.ignoreReducedMotion": "Ignore Reduced Motion",
		"advanced.ignoreReducedMotionDesc": "Force scroll animations even when OS reduced-motion is enabled (requires page refresh)",
		"advanced.logLevel": "Log Level",
		"advanced.logLevelDebug": "Debug (verbose)",
		"advanced.logLevelDesc": "Console diagnostic output verbosity",
		"advanced.logLevelWarn": "Warnings only",
		"advanced.maxConcurrent": "Max Concurrent Messages",
		"advanced.maxConcurrentDesc": "Maximum number of messages visible on screen at once (30-300)",
		"advanced.maxMessageAge": "Max Message Age (ms)",
		"advanced.maxMessageAgeDesc": "Maximum message age before fade-out removal (10-300s, default 60000ms)",
		"advanced.maxPollInterval": "Max Poll Interval (ms)",
		"advanced.maxPollIntervalDesc": "Maximum chat polling interval in milliseconds (1000-30000)",
		"advanced.maxQueueDepth": "Max Queue Depth",
		"advanced.maxQueueDepthDesc": "Maximum pending queue depth before messages are dropped (50-1000, default 200)",
		"advanced.messageRate": "Message Rate",
		"advanced.minLength": "Min Length (chars)",
		"advanced.minLengthDesc": "Minimum character count",
		"advanced.minPollInterval": "Min Poll Interval (ms)",
		"advanced.minPollIntervalDesc": "Minimum chat polling interval in milliseconds (50-5000)",
		"advanced.photoCache": "Photo Cache (MB)",
		"advanced.photoCacheDesc": "Max memory for author photo cache (1-20 MB, default 2)",
		"advanced.replayBatchLimit": "Replay Batch Limit",
		"advanced.replayBatchLimitDesc": "Max batches to fetch in replay initialization",
		"advanced.replayPrefetchPages": "Replay Prefetch Pages",
		"advanced.replayPrefetchPagesDesc": "Max pages to prefetch in replay mode",
		"advanced.stickerCache": "Sticker Cache (MB)",
		"advanced.stickerCacheDesc": "Max memory for sticker image cache (1-20 MB, default 1)",
		"advanced.tabTrimTarget": "Tab Trim Target",
		"advanced.tabTrimTargetDesc": "Target active message count when trimming background tab (10-500, default 50)",
		"advanced.textCache": "Text Cache (MB)",
		"advanced.textCacheDesc": "Max memory for text bitmap cache (1-20 MB, default 4)",
		"advanced.translationBatchSize": "Translation Batch Size",
		"advanced.translationBatchSizeDesc": "Max translations applied per frame to avoid spikes (1-20, default 5)",
		"advanced.tuningActivityTimeout": "Activity Timeout (ms)",
		"advanced.tuningActivityTimeoutDesc": "Chat activity timeout in milliseconds",
		"advanced.tuningBacklogInjectionMax": "Backlog Injection Max",
		"advanced.tuningBacklogInjectionMaxDesc": "Maximum backlog injection rate cap",
		"advanced.tuningBacklogPause": "Backlog Pause (%)",
		"advanced.tuningBacklogPauseDesc": "Lane utilization ratio to pause backlog injection",
		"advanced.tuningBacklogResume": "Backlog Resume (%)",
		"advanced.tuningBacklogResumeDesc": "Lane utilization ratio to resume backlog injection",
		"advanced.tuningDensityRamp": "Backlog Density Ramp (ms)",
		"advanced.tuningDensityRampDesc": "Density ramp duration for backlog injection in milliseconds",
		"advanced.tuningDensityRampMax": "Backlog Density Ramp Max (ms)",
		"advanced.tuningDensityRampMaxDesc": "Max density ramp duration for backlog injection",
		"advanced.tuningEmojiTimeout": "Emoji Fetch Timeout (ms)",
		"advanced.tuningEmojiTimeoutDesc": "Timeout for emoji fetch operations",
		"advanced.tuningInjectionRateMin": "Backlog Injection Rate Min (msg/s)",
		"advanced.tuningInjectionRateMinDesc": "Minimum backlog injection rate (msg/s)",
		"advanced.tuningPollFailureLimit": "Poll Failure Limit",
		"advanced.tuningPollFailureLimitDesc": "Consecutive poll failures before circuit breaker trips",
		"advanced.tuningPollFallback": "Live Poll Fallback (ms)",
		"advanced.tuningPollFallbackDesc": "Live poll fallback delay in milliseconds",
		"advanced.tuningSpeedBoostDenom": "Speed Boost Denominator",
		"advanced.tuningSpeedBoostDenomDesc": "Speed boost denominator for EMA rate scaling",
		"advanced.tuningSpeedBoostMax": "Speed Boost Max",
		"advanced.tuningSpeedBoostMaxDesc": "Max speed boost factor for burst compensation",
		"advanced.tuningSpeedBoostThreshold": "Speed Boost Threshold",
		"advanced.tuningSpeedBoostThresholdDesc": "Pending messages to trigger speed boost",
		"advanced.tuningStaggerMax": "Stagger Max Delay (ms)",
		"advanced.tuningStaggerMaxDesc": "Max stagger delay for messages in same batch",
		"advanced.tuningStaggerMedium": "Stagger Medium Delay (ms)",
		"advanced.tuningStaggerMediumDesc": "Medium stagger delay when queue depth is medium",
		"advanced.tuningToggleCooldown": "Backlog Toggle Cooldown (ms)",
		"advanced.tuningToggleCooldownDesc": "Cooldown between backlog pause toggles",
		"app.autoSave": "Changes are saved automatically",
		"app.close": "Close settings",
		"app.enabled": "Overlay Enabled",
		"app.enabledDesc": "Globally enable or disable the chat overlay on YouTube live streams",
		"app.langChanged": "Interface language changed to",
		"app.name": "Live chat overlay",
		"app.reload": "Reload overlay",
		"app.settings": "Chat overlay settings",
		"app.settingsCategories": "Settings categories",
		"app.title": "Chat Overlay",
		"appearance.authors": "Author Colors & Visibility",
		"appearance.authorsNameColor": "Name Color",
		"appearance.authorsBackground": "Background",
		"appearance.authorsShowName": "Show Name",
		"appearance.membershipMaxLines": "Membership Max Lines",
		"appearance.membershipMaxLinesDesc": "Max body text lines for membership messages (1-5)",
		"appearance.outline": "Text Outline",
		"appearance.outlineEnabledDesc": "Add a dark outline stroke around text for better readability",
		"appearance.outlineOpacity": "Outline Opacity (%)",
		"appearance.outlineOpacityDesc": "Text outline stroke opacity (0-100%)",
		"appearance.outlineWidth": "Outline Width (px)",
		"appearance.outlineWidthDesc": "Text outline stroke width in pixels (0-8)",
		"appearance.preserveUserColors": "Preserve User Colors",
		"appearance.showSuperchatAmount": "Show SuperChat Amount",
		"appearance.showSuperchatAmountDesc": "Display the purchase amount badge on Super Chat cards",
		"appearance.superchatMaxLines": "SuperChat Max Lines",
		"appearance.superchatMaxLinesDesc": "Max body text lines before truncation (2-10)",
		"appearance.superchatOpacity": "SuperChat Opacity (%)",
		"appearance.superchatOpacityDesc": "Background opacity of Super Chat cards",
		"chat.messages": "Chat messages",
		"chat.membership": "Membership",
		"chat.superChat": "Super Chat",
		"danmaku.bottom": "Bottom Fixed",
		"danmaku.bottomClearZone": "Bottom Clear Zone (%)",
		"danmaku.bottomClearZoneDesc": "Keep bottom N% of video free of comments",
		"danmaku.durationMul": "Duration Multiplier (×)",
		"danmaku.durationMulDesc": "How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)",
		"danmaku.exitPadding": "Exit Padding (px)",
		"danmaku.exitPaddingDesc": "Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)",
		"danmaku.fontCustom": "Custom font stack…",
		"danmaku.fontCustomDesc": "CSS font-family value. Type to filter suggestions, or enter a custom font stack.",
		"danmaku.fontFamilyDesc": "Font family for comment text",
		"danmaku.fontSize": "Size (px)",
		"danmaku.fontSizeDesc": "Text size in pixels (14-50)",
		"danmaku.fontWeightDesc": "Bold is more readable, Regular uses less GPU memory",
		"danmaku.laneGap": "Lane Gap (px)",
		"danmaku.laneGapDesc": "Vertical gap between comment rows (0 = adjacent rows)",
		"danmaku.maxScrollDuration": "Max Scroll Duration (ms)",
		"danmaku.maxScrollDurationDesc": "Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)",
		"danmaku.messageSpacing": "Message Spacing (%)",
		"danmaku.messageSpacingDesc": "Gap between consecutive messages as percentage of message width (2-30%, default 8)",
		"danmaku.minScrollDuration": "Min Scroll Duration (ms)",
		"danmaku.minScrollDurationDesc": "Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)",
		"danmaku.mode": "Danmaku Mode",
		"danmaku.modeDesc": "Comment display direction and behavior",
		"danmaku.reverse": "Reverse (LTR)",
		"danmaku.safeZone": "Safe Zone",
		"danmaku.scroll": "Scroll (RTL)",
		"danmaku.scrollSpeed": "Scroll Speed (px/s)",
		"danmaku.scrollSpeedDesc": "How fast comments scroll across the screen in pixels per second",
		"danmaku.textOpacity": "Text Opacity (%)",
		"danmaku.textOpacityDesc": "Overall opacity of comment text (50-100%)",
		"danmaku.top": "Top Fixed",
		"danmaku.topBottomDuration": "Top/Bottom Duration (ms)",
		"danmaku.topBottomDurationDesc": "Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)",
		"danmaku.topClearZone": "Top Clear Zone (%)",
		"danmaku.topClearZoneDesc": "Keep top N% of video free of comments",
		"format.shortMessagesShown": "Short messages shown regardless of length",
		"format.valueAdjusted": "Value adjusted to",
		"import.invalidFormat": "Import failed: invalid settings format",
		"import.invalidJson": "Import failed: invalid JSON",
		"import.success": "Settings imported successfully",
		"indicator.loading": "Loading chat history...",
		"reset.confirm": "Reset all settings to defaults?",
		"reset.confirmDesc": "Reset overlay settings",
		"status.connecting": "Connecting…",
		"status.disconnected": "Disconnected — Click to reload",
		"status.unstable": "Connection unstable",
		"status.waiting": "Waiting for live stream…",
		"translation.chat": "Chat Translation",
		"translation.displayMode": "Display Mode",
		"translation.displayModeDesc": "Dual shows original above translation, Replace shows translation only",
		"translation.displayModeDual": "Dual (original + translation)",
		"translation.displayModeReplace": "Replace (translation only)",
		"translation.enable": "Enable Translation",
		"translation.enableDesc": "Translate chat messages in real-time (requires Chrome 138+ for built-in translation)",
		"translation.languageAuto": "Auto (Browser)",
		"translation.languageDesc": "Sets the overlay user interface language (does not filter comments by language)",
		"translation.serviceAuto": "Auto (Chrome built-in)",
		"translation.serviceDesc": "Translation backend service for processing messages",
		"translation.source": "Source Language",
		"translation.sourceAuto": "Auto-detect",
		"translation.sourceDesc": "Language to translate chat messages into. Auto detects from browser settings.",
		"translation.target": "Target Language",
		"translation.unsupported": "Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.",
		"actions.export": "Export",
		"actions.import": "Import",
		"actions.reset": "Reset",
		"pane.comments": "Comments",
		"pane.appearance": "Appearance",
		"pane.advanced": "Advanced",
		"pane.translation": "Translation",
		"appearance.cards": "Cards",
		"danmaku.font": "Font",
		"danmaku.timing": "Timing",
		"advanced.backlog": "Backlog",
		"advanced.cache": "Cache",
		"advanced.tuning": "Tuning",
		"advanced.developer": "Developer",
		"advanced.performance": "Performance",
		"advanced.authorRateLimitOff": "Off",
		"appearance.authorsSuperchat": "SuperChat",
		"translation.interface": "Interface",
		"translation.service": "Service",
		"indicator.busy": "Chat busy",
		"indicator.heavy": "Chat heavy — some messages omitted",
		"indicator.overload": "Chat overload — skipping messages",
		"advanced.logLevelInfo": "Info",
		"app.cancel": "Cancel",
		"app.done": "Done",
		"translation.language": "Language",
		"appearance.outlineEnabled": "Enabled"
	};
	var ES = {
		Comments: "Comentarios",
		Appearance: "Tarjetas y Colores",
		Advanced: "Avanzado",
		Translation: "Traducción",
		"app.name": "Superposición de chat en vivo",
		Paused: "Pausado",
		"app.langChanged": "Idioma de interfaz cambiado a: ",
		"status.connecting": "Conectando…",
		"status.unstable": "Conexión inestable",
		"status.disconnected": "Desconectado — Haz clic para recargar",
		"status.waiting": "Esperando transmisión en vivo…",
		Cards: "Tarjetas",
		"appearance.outline": "Contorno de texto",
		"danmaku.safeZone": "Zona segura",
		"advanced.messageRate": "Frecuencia de mensajes",
		"advanced.depthLayers": "Capas de profundidad",
		Font: "Fuente",
		Backlog: "Historial",
		Timing: "Temporización",
		Tuning: "Ajustes",
		"advanced.burst": "Detección de ráfagas",
		Cache: "Caché",
		"appearance.authors": "Colores y visibilidad",
		Interface: "Interfaz",
		"translation.chat": "Traducción de chat",
		"translation.serviceDesc": "Servicio de traducción para procesar mensajes",
		"advanced.authorRateLimit": "Límite por autor",
		"advanced.backlogMode": "Modo de historial",
		"advanced.backlogOpacity": "Opacidad historial (%)",
		Bold: "Negrita",
		"danmaku.bottomClearZone": "Margen inferior (%)",
		"danmaku.fontCustom": "Fuente personalizada…",
		"danmaku.mode": "Modo Danmaku",
		Enabled: "Activado",
		Family: "Familia",
		"advanced.ignoreMinLength": "Ignorar long. mínima",
		"danmaku.laneGap": "Espacio entre líneas (px)",
		Language: "Idioma",
		"appearance.membershipMaxLines": "Líneas máx. membresía",
		"advanced.minLength": "Longitud mínima (caracteres)",
		"appearance.outlineOpacity": "Opacidad del contorno (%)",
		"appearance.outlineWidth": "Ancho del contorno (px)",
		"appearance.preserveUserColors": "Conservar colores de usuario",
		Regular: "Normal",
		"danmaku.scrollSpeed": "Velocidad (px/s)",
		"appearance.showSuperchatAmount": "Mostrar monto SuperChat",
		"danmaku.fontSize": "Tamaño (px)",
		"appearance.superchatMaxLines": "Líneas máx. SuperChat",
		"appearance.superchatOpacity": "Opacidad SuperChat (%)",
		"danmaku.textOpacity": "Opacidad del texto (%)",
		"danmaku.topClearZone": "Margen superior (%)",
		Weight: "Peso",
		English: "Inglés",
		한국어: "Coreano",
		日本語: "Japonés",
		Español: "Español",
		中文: "Chino",
		العربية: "Árabe",
		"danmaku.durationMul": "Multiplicador de duración (×)",
		"danmaku.exitPadding": "Margen de salida (px)",
		"danmaku.minScrollDuration": "Duración mín. desplazamiento (ms)",
		"danmaku.maxScrollDuration": "Duración máx. desplazamiento (ms)",
		"danmaku.topBottomDuration": "Duración superior/inferior (ms)",
		"advanced.maxQueueDepth": "Tamaño máx. de cola",
		"advanced.tabTrimTarget": "Cola en segundo plano máx.",
		"advanced.maxMessageAge": "Edad máx. de mensaje (ms)",
		"danmaku.messageSpacing": "Espacio entre mensajes (%)",
		"danmaku.exitPaddingDesc": "Píxeles extra que un mensaje se desplaza más allá del borde antes de eliminarse (20-400, predeterminado 100)",
		"danmaku.minScrollDurationDesc": "Duración mínima de animación de desplazamiento — evita que mensajes cortos pasen demasiado rápido (1000-15000ms, predet. 5000)",
		"danmaku.maxScrollDurationDesc": "Duración máxima de animación de desplazamiento — evita que mensajes largos vayan muy lento (5-120s, predet. 30000ms)",
		"danmaku.topBottomDurationDesc": "Duración fija de visualización para mensajes en modo superior/inferior (1000-30000ms, predet. 4000)",
		"advanced.maxQueueDepthDesc": "Profundidad máxima de cola pendiente antes de descartar mensajes (50-1000, predet. 200)",
		"advanced.tabTrimTargetDesc": "Objetivo de mensajes activos al recortar pestaña en segundo plano (10-500, predet. 50)",
		"advanced.maxMessageAgeDesc": "Edad máxima del mensaje antes de eliminación por desvanecimiento (10-300s, predet. 60000ms)",
		"danmaku.messageSpacingDesc": "Espacio entre mensajes consecutivos como porcentaje del ancho (2-30%, predet. 8)",
		"translation.enable": "Activar traducción",
		Service: "Servicio",
		"translation.source": "Idioma de origen",
		"translation.target": "Idioma de destino",
		"translation.displayMode": "Modo de visualización",
		"advanced.depthNearSpeed": "Velocidad cerca (%)",
		"advanced.depthFarSpeed": "Velocidad lejos (%)",
		"advanced.depthFarOpacity": "Opacidad lejos (%)",
		"danmaku.scroll": "Desplazar (der.→izq.)",
		"danmaku.reverse": "Inverso (izq.→der.)",
		"danmaku.top": "Fijo arriba",
		"danmaku.bottom": "Fijo abajo",
		"advanced.backlogPlayback": "Basado en reproducción (recomendado)",
		"advanced.backlogRecent": "Solo recientes",
		"advanced.backlogFull": "Completo (mostrar todo)",
		"advanced.backlogNone": "Ninguno (omitir historial)",
		Off: "Apagado",
		"advanced.authorRateLimitNormal": "Normal (5 mensajes / 5s)",
		"advanced.authorRateLimitStrict": "Estricto (2 msg / 5s)",
		"translation.languageAuto": "Automático (Navegador)",
		"translation.sourceAuto": "Detección automática",
		"translation.serviceAuto": "Automático (integrado en Chrome)",
		"translation.displayModeDual": "Dual (original + traducción)",
		"translation.displayModeReplace": "Reemplazar (solo traducción)",
		"danmaku.laneGapDesc": "Espacio vertical entre filas (0 = filas adyacentes)",
		"danmaku.fontWeightDesc": "Negrita es más legible, Normal usa menos memoria de GPU",
		"danmaku.fontFamilyDesc": "Familia tipográfica del texto",
		"danmaku.fontCustomDesc": "Valor CSS font-family, ej. \"Noto Sans KR\", sans-serif. Si no se encuentra, usa la fuente del sistema.",
		"appearance.superchatOpacityDesc": "Opacidad del fondo de tarjetas Super Chat",
		"appearance.superchatMaxLinesDesc": "Máximo de líneas antes de truncar (2-10)",
		"appearance.membershipMaxLinesDesc": "Máximo de líneas para mensajes de membresía (1-5)",
		"appearance.showSuperchatAmountDesc": "Mostrar la insignia de monto de compra en tarjetas Super Chat",
		"Use author's chosen text color from YouTube chat instead of overlay defaults": "Usar el color de texto del autor en lugar del predeterminado",
		"danmaku.topClearZoneDesc": "Mantener el N% superior del video sin comentarios",
		"danmaku.bottomClearZoneDesc": "Mantener el N% inferior del video sin comentarios",
		"advanced.ignoreMinLengthDesc": "Mostrar todos los mensajes sin importar la longitud mínima",
		"advanced.minLengthDesc": "Cantidad mínima de caracteres",
		"advanced.backlogOpacityDesc": "Opacidad de mensajes pasados respecto a los actuales",
		"danmaku.durationMulDesc": "Cuánto más tiempo permanecen visibles los mensajes de moderador y propietario (1.0 = igual, 2.0 = el doble)",
		"translation.enableDesc": "Traduce mensajes de chat en tiempo real (requiere Chrome 138+ con traducción integrada)",
		"advanced.depthLayersDesc": "Percepción de profundidad por velocidad: mensajes rápidos cerca, lentos lejos",
		"advanced.depthNearSpeedDesc": "Aumento de velocidad para mensajes cercanos",
		"advanced.depthFarSpeedDesc": "Reducción de velocidad para mensajes lejanos",
		"advanced.depthFarOpacityDesc": "Reducción de opacidad para mensajes lejanos",
		"danmaku.scrollSpeedDesc": "Velocidad a la que los comentarios cruzan la pantalla (píxeles/segundo)",
		"Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.": "Idioma de los mensajes de chat entrantes. La detección automática usa la detección de idioma integrada de Chrome.",
		"translation.sourceDesc": "Idioma al que traducir los mensajes. Auto detecta desde la configuración del navegador.",
		"advanced.authorRateLimitDesc": "Limita la frecuencia con la que aparecen mensajes del mismo autor",
		"translation.languageDesc": "Establece el idioma de la interfaz (no filtra comentarios por idioma)",
		Performance: "Rendimiento",
		Developer: "Desarrollador",
		"advanced.maxConcurrent": "Máx. mensajes",
		"advanced.fadeDuration": "Duración fundido (ms)",
		"advanced.minPollInterval": "Intervalo mín. sondeo (ms)",
		"advanced.maxPollInterval": "Intervalo máx. sondeo (ms)",
		"advanced.backlogInjectionRate": "Velocidad máx. (msg/s)",
		"advanced.backlogSpeed": "Multiplicador velocidad",
		"advanced.backlogRecentWindow": "Ventana (min)",
		"advanced.logLevel": "Nivel de registro",
		"advanced.debugOverlay": "Superposición depuración",
		"advanced.logLevelWarn": "Solo avisos",
		Info: "Información",
		"advanced.logLevelDebug": "Depuración (detallado)",
		"advanced.maxConcurrentDesc": "Número máximo de mensajes visibles en pantalla a la vez (30-300)",
		"advanced.fadeDurationDesc": "Tiempo de desvanecimiento de los mensajes (0 = instantáneo, 50-1000)",
		"advanced.minPollIntervalDesc": "Intervalo mínimo de sondeo del chat en milisegundos (50-5000)",
		"advanced.maxPollIntervalDesc": "Intervalo máximo de sondeo del chat en milisegundos (1000-30000)",
		"advanced.backlogInjectionRateDesc": "Velocidad máxima de inyección de mensajes del historial por segundo (0-50)",
		"advanced.backlogSpeedDesc": "Multiplicador de velocidad de animación para mensajes del historial (1-5)",
		"advanced.backlogRecentWindowDesc": "Ventana de tiempo en minutos para el modo de solo recientes (1-30)",
		"advanced.logLevelDesc": "Verbosidad de la salida de diagnóstico",
		"advanced.debugOverlayDesc": "Mostrar superposición de depuración de rendimiento en el reproductor de video",
		"danmaku.fontSizeDesc": "Tamaño del texto en píxeles (14-50)",
		"appearance.outlineWidthDesc": "Ancho del contorno de texto en píxeles (0-8)",
		"appearance.outlineOpacityDesc": "Opacidad del contorno de texto (0-100%)",
		"app.enabledDesc": "Activa o desactiva la superposición de chat en las transmisiones en vivo de YouTube",
		"danmaku.modeDesc": "Dirección y comportamiento de los comentarios",
		"danmaku.textOpacityDesc": "Opacidad general del texto de comentarios (50-100%)",
		"appearance.outlineEnabledDesc": "Añade un contorno oscuro alrededor del texto para mejorar la legibilidad",
		"advanced.backlogModeDesc": "Cómo se muestran los mensajes antiguos en relación con la reproducción en vivo",
		"translation.displayModeDesc": "Dual muestra el original encima de la traducción, Reemplazar muestra solo la traducción",
		"advanced.emojiCache": "Caché de emojis (MB)",
		"advanced.photoCache": "Caché de fotos (MB)",
		"advanced.stickerCache": "Caché de stickers (MB)",
		"advanced.textCache": "Caché de texto (MB)",
		"advanced.translationBatchSize": "Tamaño de lote de traducción",
		"advanced.emojiFetchLimit": "Límite de obtención de emojis",
		"advanced.emojiRetryMin": "Reintento de emoji fallido (min)",
		"advanced.emojiCacheDesc": "Memoria máxima para caché de emojis (1-20 MB, predet. 3)",
		"advanced.photoCacheDesc": "Memoria máxima para caché de fotos (1-20 MB, predet. 2)",
		"advanced.stickerCacheDesc": "Memoria máxima para caché de stickers (1-20 MB, predet. 1)",
		"advanced.textCacheDesc": "Memoria máxima para caché de texto (1-20 MB, predet. 4)",
		"advanced.translationBatchSizeDesc": "Traducciones máximas por fotograma (1-20, predet. 5)",
		"advanced.emojiFetchLimitDesc": "Operaciones simultáneas máximas de emojis (1-20, predet. 6)",
		"advanced.emojiRetryMinDesc": "Tiempo de espera antes de reintentar emojis fallidos (1-60 min, predet. 5)",
		"advanced.burstSampleWindow": "Ventana de muestra de ráfaga",
		"advanced.burstElevated": "Ráfaga elevada (msg/s)",
		"advanced.burstHigh": "Ráfaga alta (msg/s)",
		"advanced.burstExtreme": "Ráfaga extrema (msg/s)",
		"advanced.tuningBacklogInjectionMax": "Inyección máx. historial",
		"advanced.tuningDensityRamp": "Rampa de densidad historial (ms)",
		"advanced.tuningPollFallback": "Sondeo alternativo (ms)",
		"advanced.tuningPollFailureLimit": "Límite fallos sondeo",
		"advanced.tuningSpeedBoostThreshold": "Umbral aumento velocidad",
		"advanced.tuningBacklogPause": "Pausar historial (%)",
		"advanced.tuningBacklogResume": "Reanudar historial (%)",
		"advanced.tuningActivityTimeout": "Tiempo de espera (ms)",
		"advanced.burstSampleWindowDesc": "Tamaño de la ventana de muestreo de la tasa de ráfaga",
		"advanced.burstElevatedDesc": "Umbral de mensajes por segundo para el nivel de ráfaga elevado",
		"advanced.burstHighDesc": "Umbral de mensajes por segundo para el nivel de ráfaga alto",
		"advanced.burstExtremeDesc": "Umbral de mensajes por segundo para el nivel de ráfaga extremo",
		"advanced.tuningBacklogInjectionMaxDesc": "Límite máximo de velocidad de inyección del historial",
		"advanced.tuningDensityRampDesc": "Duración de la rampa de densidad para la inyección del historial en milisegundos",
		"advanced.tuningPollFallbackDesc": "Retraso alternativo del sondeo en vivo en milisegundos",
		"advanced.tuningPollFailureLimitDesc": "Fallos consecutivos de sondeo antes de que se active el interruptor",
		"advanced.tuningSpeedBoostThresholdDesc": "Mensajes pendientes para activar el aumento de velocidad",
		"advanced.tuningBacklogPauseDesc": "Relación de uso de carril para pausar la inyección del historial",
		"advanced.tuningBacklogResumeDesc": "Relación de uso de carril para reanudar la inyección del historial",
		"advanced.tuningActivityTimeoutDesc": "Tiempo de espera de actividad del chat en milisegundos",
		"advanced.tuningStaggerMax": "Retardo máx. escalonado (ms)",
		"advanced.tuningStaggerMedium": "Retardo escalonado medio (ms)",
		"advanced.tuningEmojiTimeout": "Tiempo de espera de emoji (ms)",
		"advanced.tuningDensityRampMax": "Rampa densidad historial máx. (ms)",
		"advanced.tuningInjectionRateMin": "Inyección historial mín.",
		"advanced.tuningSpeedBoostMax": "Aumento velocidad máx.",
		"advanced.tuningSpeedBoostDenom": "Denom. aumento velocidad",
		"advanced.tuningToggleCooldown": "Enfriamiento alternar historial (ms)",
		"advanced.replayPrefetchPages": "Páginas precarga repetición",
		"advanced.replayBatchLimit": "Límite lotes repetición",
		"advanced.tuningStaggerMaxDesc": "Retardo máximo escalonado para mensajes en el mismo lote",
		"advanced.tuningStaggerMediumDesc": "Retardo escalonado medio cuando la cola está a media capacidad",
		"advanced.tuningEmojiTimeoutDesc": "Tiempo de espera para operaciones de obtención de emojis",
		"advanced.tuningDensityRampMaxDesc": "Duración máxima de la rampa de densidad para la inyección del historial",
		"advanced.tuningInjectionRateMinDesc": "Tasa mínima de inyección del historial (msg/s)",
		"advanced.tuningSpeedBoostMaxDesc": "Factor máximo de aumento de velocidad para compensación de ráfagas",
		"advanced.tuningSpeedBoostDenomDesc": "Denominador de aumento de velocidad para escalado de tasa EMA",
		"advanced.tuningToggleCooldownDesc": "Enfriamiento entre cambios de pausa del historial",
		"advanced.replayPrefetchPagesDesc": "Máximo de páginas a precargar en modo repetición",
		"advanced.replayBatchLimitDesc": "Máximo de lotes a obtener en la inicialización de repetición",
		"app.title": "Superposición de Chat",
		"app.close": "Cerrar configuración",
		"app.settingsCategories": "Categorías",
		"app.enabled": "Superposición activada",
		"format.valueAdjusted": "Valor ajustado a ",
		Reset: "Restablecer",
		Export: "Exportar",
		Import: "Importar",
		Close: "Cerrar",
		Done: "Listo",
		"app.autoSave": "Los cambios se guardan automáticamente",
		"reset.confirm": "¿Restablecer todas las opciones a los valores predeterminados?",
		Cancel: "Cancelar",
		"import.invalidFormat": "Error de importación: formato no válido",
		"import.success": "Configuración importada correctamente",
		"actions.export": "Exportar",
		"actions.import": "Importar",
		"actions.reset": "Restablecer",
		"import.invalidJson": "Error de importación: JSON no válido",
		"app.settings": "Configuración de superposición de chat",
		"reset.confirmDesc": "Restablecer superposición",
		"app.reload": "Recargar superposición",
		Color: "Color",
		"appearance.authorsNameColor": "Color del nombre",
		"appearance.authorsBackground": "Fondo",
		Show: "Mostrar",
		"appearance.authorsShowName": "Mostrar nombre",
		Normal: "Normal",
		Member: "Miembro",
		Moderator: "Moderador",
		Owner: "Propietario",
		Verified: "Verificado",
		SuperChat: "SuperChat",
		"indicator.loading": "Cargando historial de chat...",
		"format.shortMessagesShown": "Mostrar mensajes cortos sin importar la longitud",
		"translation.unsupported": "La traducción requiere un navegador con IA integrada. Usa Chrome 138+ o Edge 143+ Canary.",
		"chat.messages": "Mensajes del chat",
		"chat.membership": "Membresía",
		"chat.superChat": "Super Chat",
		"advanced.ignoreReducedMotion": "Ignorar movimiento reducido",
		"advanced.ignoreReducedMotionDesc": "Forzar animaciones de desplazamiento incluso con movimiento reducido del SO activado (requiere recargar)",
		"pane.comments": "Comentarios",
		"pane.appearance": "Apariencia",
		"pane.advanced": "Avanzado",
		"pane.translation": "Traducción",
		"appearance.cards": "Tarjetas",
		"danmaku.font": "Fuente",
		"danmaku.timing": "Temporización",
		"advanced.backlog": "Historial",
		"advanced.cache": "Caché",
		"advanced.tuning": "Ajustes",
		"advanced.developer": "Desarrollador",
		"advanced.performance": "Rendimiento",
		"advanced.authorRateLimitOff": "Apagado",
		"appearance.authorsSuperchat": "SuperChat",
		"translation.interface": "Interfaz",
		"translation.service": "Servicio",
		"indicator.busy": "Chat ocupado",
		"indicator.heavy": "Chat cargado — algunos mensajes omitidos",
		"indicator.overload": "Chat sobrecargado — saltando mensajes",
		"advanced.logLevelInfo": "Información",
		"app.cancel": "Cancelar",
		"app.done": "Listo",
		"translation.language": "Idioma",
		"appearance.outlineEnabled": "Activado"
	};
	var JA = {
		Comments: "コメント",
		Appearance: "カードと色",
		Advanced: "詳細",
		Translation: "翻訳",
		"app.name": "ライブチャットオーバーレイ",
		Paused: "一時停止",
		"app.langChanged": "インターフェース言語が変更されました: ",
		"status.connecting": "接続中…",
		"status.unstable": "接続が不安定です",
		"status.disconnected": "切断されました — クリックして再読み込み",
		"status.waiting": "ライブストリームを待機中…",
		Cards: "カード",
		"appearance.outline": "テキスト縁取り",
		"danmaku.safeZone": "安全領域",
		"advanced.messageRate": "メッセージ頻度",
		"advanced.depthLayers": "深度レイヤー",
		Font: "フォント",
		Backlog: "バックログ",
		Timing: "タイミング",
		Cache: "キャッシュ",
		"advanced.burst": "バースト検出",
		Tuning: "チューニング",
		"appearance.authors": "投稿者の色と表示",
		Interface: "インターフェース",
		"translation.chat": "チャット翻訳",
		"translation.serviceDesc": "メッセージ処理用の翻訳バックエンドサービス",
		"advanced.authorRateLimit": "投稿者レート制限",
		"advanced.backlogMode": "バックログモード",
		"advanced.backlogOpacity": "バックログ不透明度 (%)",
		Bold: "ボールド",
		"danmaku.bottomClearZone": "下部余白 (%)",
		"danmaku.fontCustom": "カスタムフォント…",
		"danmaku.mode": "弾幕モード",
		Enabled: "有効",
		Family: "ファミリー",
		"advanced.ignoreMinLength": "最小文字数を無視",
		"danmaku.laneGap": "レーン間隔 (px)",
		Language: "言語",
		"appearance.membershipMaxLines": "メンバーシップ最大行数",
		"advanced.minLength": "最小文字数",
		"appearance.outlineOpacity": "縁取り不透明度 (%)",
		"appearance.outlineWidth": "縁取りの太さ (px)",
		"appearance.preserveUserColors": "ユーザー色を保持",
		Regular: "レギュラー",
		"danmaku.scrollSpeed": "スクロール速度 (px/s)",
		"appearance.showSuperchatAmount": "スパーチャット金額表示",
		"danmaku.fontSize": "サイズ (px)",
		"appearance.superchatMaxLines": "スパーチャット最大行数",
		"appearance.superchatOpacity": "スパーチャット不透明度 (%)",
		"danmaku.textOpacity": "テキスト不透明度 (%)",
		"danmaku.topClearZone": "上部余白 (%)",
		Weight: "太さ",
		English: "英語",
		한국어: "韓国語",
		日本語: "日本語",
		Español: "スペイン語",
		中文: "中国語",
		العربية: "アラビア語",
		"danmaku.durationMul": "表示時間倍率 (×)",
		"danmaku.exitPadding": "終了余白 (px)",
		"danmaku.minScrollDuration": "最小スクロール時間 (ms)",
		"danmaku.maxScrollDuration": "最大スクロール時間 (ms)",
		"danmaku.topBottomDuration": "上部/下部表示時間 (ms)",
		"advanced.maxQueueDepth": "キュー最大サイズ",
		"advanced.tabTrimTarget": "バックグラウンドキュー最大",
		"advanced.maxMessageAge": "最大メッセージ寿命 (ms)",
		"danmaku.messageSpacing": "メッセージ間隔 (%)",
		"danmaku.exitPaddingDesc": "メッセージが画面端を通過して削除されるまでの追加ピクセル (20-400, デフォルト 100)",
		"danmaku.minScrollDurationDesc": "最小スクロールアニメーション時間 — 短いメッセージが速すぎるのを防ぐ (1000-15000ms, デフォルト 5000)",
		"danmaku.maxScrollDurationDesc": "最大スクロールアニメーション時間 — 長いメッセージが遅すぎるのを防ぐ (5-120秒, デフォルト 30000ms)",
		"danmaku.topBottomDurationDesc": "上部/下部モードメッセージの固定表示時間 (1000-30000ms, デフォルト 4000)",
		"advanced.maxQueueDepthDesc": "メッセージがドロップされる前の最大待機キュー深度 (50-1000, デフォルト 200)",
		"advanced.tabTrimTargetDesc": "バックグラウンドタブ整理時の目標アクティブメッセージ数 (10-500, デフォルト 50)",
		"advanced.maxMessageAgeDesc": "フェードアウト除去前の最大メッセージ寿命 (10-300秒, デフォルト 60000ms)",
		"danmaku.messageSpacingDesc": "連続メッセージ間の間隔（メッセージ幅のパーセント） (2-30%, デフォルト 8)",
		"translation.enable": "翻訳を有効にする",
		Service: "サービス",
		"translation.source": "ソース言語",
		"translation.target": "対象言語",
		"translation.displayMode": "表示モード",
		"advanced.depthNearSpeed": "近接速度 (%)",
		"advanced.depthFarSpeed": "遠方速度 (%)",
		"advanced.depthFarOpacity": "遠方不透明度 (%)",
		"danmaku.scroll": "スクロール (右→左)",
		"danmaku.reverse": "逆方向 (左→右)",
		"danmaku.top": "上部固定",
		"danmaku.bottom": "下部固定",
		"advanced.backlogPlayback": "再生ベース (推奨)",
		"advanced.backlogRecent": "最近のみ",
		"advanced.backlogFull": "すべて表示",
		"advanced.backlogNone": "なし (スキップ)",
		Off: "オフ",
		"advanced.authorRateLimitNormal": "標準 (5件 / 5秒)",
		"advanced.authorRateLimitStrict": "厳格 (2件 / 5秒)",
		"translation.languageAuto": "自動 (ブラウザ)",
		"translation.sourceAuto": "自動検出",
		"translation.serviceAuto": "自動 (Chrome内蔵)",
		"translation.displayModeDual": "二重表示 (原文 + 翻訳)",
		"translation.displayModeReplace": "翻訳のみ表示",
		"danmaku.laneGapDesc": "コメント行の間隔 (0 = 行が隣接)",
		"danmaku.fontWeightDesc": "ボールドはより読みやすく、レギュラーはGPUメモリ消費が少なくなります",
		"danmaku.fontFamilyDesc": "コメントテキストのフォント",
		"danmaku.fontCustomDesc": "CSS font-family 値。例: \"Noto Sans KR\", sans-serif。フォントがなければシステム既定値。",
		"appearance.superchatOpacityDesc": "スパーチャットカードの背景不透明度",
		"appearance.superchatMaxLinesDesc": "本文の最大行数、超過分は省略 (2-10)",
		"appearance.membershipMaxLinesDesc": "メンバーシップメッセージの本文最大行数 (1-5)",
		"appearance.showSuperchatAmountDesc": "スパーチャットカードに購入金額バッジを表示します",
		"Use author's chosen text color from YouTube chat instead of overlay defaults": "オーバーレイ既定色の代わりにYouTubeチャットの投稿者テキスト色を使用",
		"danmaku.topClearZoneDesc": "動画上部N%にコメントを表示しない",
		"danmaku.bottomClearZoneDesc": "動画下部N%にコメントを表示しない",
		"advanced.ignoreMinLengthDesc": "最小文字数に関係なくすべてのメッセージを表示",
		"advanced.minLengthDesc": "最小文字数",
		"advanced.backlogOpacityDesc": "リアルタイムメッセージに対する過去メッセージの不透明度",
		"danmaku.durationMulDesc": "モデレーターと所有者のメッセージを通常より長く表示する倍率 (1.0 = 同じ, 2.0 = 2倍)",
		"translation.enableDesc": "チャットメッセージをリアルタイムで翻訳します (Chrome 138+の内蔵翻訳が必要)",
		"advanced.depthLayersDesc": "速度ベースの遠近感: 速いメッセージは近く、遅いメッセージは遠くに表示",
		"advanced.depthNearSpeedDesc": "近接レイヤーメッセージの速度ブースト",
		"advanced.depthFarSpeedDesc": "遠方レイヤーメッセージの速度低下",
		"advanced.depthFarOpacityDesc": "遠方レイヤーメッセージの不透明度減衰",
		"danmaku.scrollSpeedDesc": "コメントが画面を横切る速度(ピクセル/秒)",
		"Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.": "受信チャットメッセージの言語。自動検出はChrome内蔵の言語検出を使用します。",
		"translation.sourceDesc": "チャットメッセージの翻訳先言語。自動はブラウザ設定から検出します。",
		"advanced.authorRateLimitDesc": "同じ投稿者のメッセージ表示頻度を制限",
		"translation.languageDesc": "オーバーレイUIの言語を設定します(コメントの言語フィルターではありません)",
		Performance: "パフォーマンス",
		Developer: "開発者",
		"advanced.maxConcurrent": "最大メッセージ数",
		"advanced.fadeDuration": "フェード時間 (ms)",
		"advanced.minPollInterval": "最小ポーリング間隔 (ms)",
		"advanced.maxPollInterval": "最大ポーリング間隔 (ms)",
		"advanced.backlogInjectionRate": "最大速度 (msg/s)",
		"advanced.backlogSpeed": "速度倍率",
		"advanced.backlogRecentWindow": "時間枠 (分)",
		"advanced.logLevel": "ログレベル",
		"advanced.debugOverlay": "デバッグオーバーレイ",
		"advanced.logLevelWarn": "警告のみ",
		Info: "情報",
		"advanced.logLevelDebug": "デバッグ (詳細)",
		"advanced.maxConcurrentDesc": "画面上に同時に表示できる最大メッセージ数 (30-300)",
		"advanced.fadeDurationDesc": "メッセージのフェードアウト時間 (0 = 即時, 50-1000)",
		"advanced.minPollIntervalDesc": "チャットポーリングの最小間隔 (ミリ秒, 50-5000)",
		"advanced.maxPollIntervalDesc": "チャットポーリングの最大間隔 (ミリ秒, 1000-30000)",
		"advanced.backlogInjectionRateDesc": "1秒あたりのバックログメッセージ注入最大速度 (0-50)",
		"advanced.backlogSpeedDesc": "バックログメッセージのアニメーション速度倍率 (1-5)",
		"advanced.backlogRecentWindowDesc": "最近のみバックログモードの時間枠 (分, 1-30)",
		"advanced.logLevelDesc": "コンソール診断出力の詳細度",
		"advanced.debugOverlayDesc": "ビデオプレイヤーにパフォーマンスデバッグオーバーレイを表示",
		"danmaku.fontSizeDesc": "ピクセル単位のテキストサイズ (14-50)",
		"appearance.outlineWidthDesc": "テキスト縁取りの太さ (ピクセル, 0-8)",
		"appearance.outlineOpacityDesc": "テキスト縁取りの不透明度 (0-100%)",
		"app.enabledDesc": "YouTubeライブストリームでチャットオーバーレイをオン/オフします",
		"danmaku.modeDesc": "コメントの表示方向と動作",
		"danmaku.textOpacityDesc": "コメントテキスト全体の不透明度 (50-100%)",
		"appearance.outlineEnabledDesc": "明るい背景でもテキストを読みやすくするために黒い縁取りを追加します",
		"advanced.backlogModeDesc": "過去のチャットメッセージをライブ再生に対してどう表示するか",
		"translation.displayModeDesc": "二重表示は原文の上に翻訳を、置換は翻訳のみ表示します",
		"advanced.emojiCache": "絵文字キャッシュ (MB)",
		"advanced.photoCache": "写真キャッシュ (MB)",
		"advanced.stickerCache": "ステッカーキャッシュ (MB)",
		"advanced.textCache": "テキストキャッシュ (MB)",
		"advanced.translationBatchSize": "翻訳バッチサイズ",
		"advanced.emojiFetchLimit": "絵文字取得制限",
		"advanced.emojiRetryMin": "失敗した絵文字の再試行 (分)",
		"advanced.emojiCacheDesc": "絵文字画像キャッシュの最大メモリ (1-20 MB, デフォルト 3)",
		"advanced.photoCacheDesc": "投稿者写真キャッシュの最大メモリ (1-20 MB, デフォルト 2)",
		"advanced.stickerCacheDesc": "ステッカー画像キャッシュの最大メモリ (1-20 MB, デフォルト 1)",
		"advanced.textCacheDesc": "テキストビットマップキャッシュの最大メモリ (1-20 MB, デフォルト 4)",
		"advanced.translationBatchSizeDesc": "フレームごとの最大翻訳適用数 (1-20, デフォルト 5)",
		"advanced.emojiFetchLimitDesc": "最大同時絵文字取得数 (1-20, デフォルト 6)",
		"advanced.emojiRetryMinDesc": "失敗した絵文字の再試行までの待機時間 (1-60分, デフォルト 5)",
		"advanced.burstSampleWindow": "バーストサンプルウィンドウ",
		"advanced.burstElevated": "上昇バースト (msg/s)",
		"advanced.burstHigh": "高バースト (msg/s)",
		"advanced.burstExtreme": "極端なバースト (msg/s)",
		"advanced.tuningBacklogInjectionMax": "バックログ注入最大",
		"advanced.tuningDensityRamp": "バックログ密度ランプ (ms)",
		"advanced.tuningPollFallback": "ライブポーリングフォールバック (ms)",
		"advanced.tuningPollFailureLimit": "ポーリング失敗制限",
		"advanced.tuningSpeedBoostThreshold": "スピードブーストしきい値",
		"advanced.tuningBacklogPause": "バックログ一時停止 (%)",
		"advanced.tuningBacklogResume": "バックログ再開 (%)",
		"advanced.tuningActivityTimeout": "アクティビティタイムアウト (ms)",
		"advanced.burstSampleWindowDesc": "バーストレートのサンプルウィンドウサイズ",
		"advanced.burstElevatedDesc": "上昇バーストレベルの1秒あたりのメッセージしきい値",
		"advanced.burstHighDesc": "高バーストレベルの1秒あたりのメッセージしきい値",
		"advanced.burstExtremeDesc": "極端なバーストレベルの1秒あたりのメッセージしきい値",
		"advanced.tuningBacklogInjectionMaxDesc": "バックログ注入レートの最大上限",
		"advanced.tuningDensityRampDesc": "バックログ注入の密度ランプ時間（ミリ秒）",
		"advanced.tuningPollFallbackDesc": "ライブポールフォールバック遅延（ミリ秒）",
		"advanced.tuningPollFailureLimitDesc": "サーキットブレーカー作動前の連続ポーリング失敗数",
		"advanced.tuningSpeedBoostThresholdDesc": "スピードブーストをトリガーする保留メッセージ数",
		"advanced.tuningBacklogPauseDesc": "バックログ注入を一時停止するレーン使用率",
		"advanced.tuningBacklogResumeDesc": "バックログ注入を再開するレーン使用率",
		"advanced.tuningActivityTimeoutDesc": "チャットアクティビティタイムアウト（ミリ秒）",
		"advanced.tuningStaggerMax": "最大スタッガー遅延 (ms)",
		"advanced.tuningStaggerMedium": "中スタッガー遅延 (ms)",
		"advanced.tuningEmojiTimeout": "絵文字取得タイムアウト (ms)",
		"advanced.tuningDensityRampMax": "バックログ密度ランプ最大 (ms)",
		"advanced.tuningInjectionRateMin": "最小バックログ注入レート",
		"advanced.tuningSpeedBoostMax": "最大スピードブースト",
		"advanced.tuningSpeedBoostDenom": "スピードブースト分母",
		"advanced.tuningToggleCooldown": "バックログ切替クールダウン (ms)",
		"advanced.replayPrefetchPages": "リプレイプリフェッチページ",
		"advanced.replayBatchLimit": "リプレイバッチ制限",
		"advanced.tuningStaggerMaxDesc": "同一バッチ内のメッセージの最大スタッガー遅延",
		"advanced.tuningStaggerMediumDesc": "キューの深さが中程度のときのスタッガー遅延",
		"advanced.tuningEmojiTimeoutDesc": "絵文字取得操作のタイムアウト",
		"advanced.tuningDensityRampMaxDesc": "バックログ注入の最大密度ランプ時間",
		"advanced.tuningInjectionRateMinDesc": "最小バックログ注入レート (msg/s)",
		"advanced.tuningSpeedBoostMaxDesc": "バースト補償の最大スピードブースト係数",
		"advanced.tuningSpeedBoostDenomDesc": "EMAレートスケーリングのスピードブースト分母",
		"advanced.tuningToggleCooldownDesc": "バックログ一時停止切替間のクールダウン",
		"advanced.replayPrefetchPagesDesc": "リプレイモードでプリフェッチする最大ページ数",
		"advanced.replayBatchLimitDesc": "リプレイ初期化で取得する最大バッチ数",
		"app.title": "チャットオーバーレイ",
		"app.close": "設定を閉じる",
		"app.settingsCategories": "設定カテゴリ",
		"app.enabled": "オーバーレイ有効",
		"format.valueAdjusted": "調整後の値: ",
		Reset: "リセット",
		Export: "エクスポート",
		Import: "インポート",
		Close: "閉じる",
		Done: "完了",
		"app.autoSave": "変更は自動的に保存されます",
		"reset.confirm": "すべての設定を初期値にリセットしますか？",
		Cancel: "キャンセル",
		"import.invalidFormat": "インポート失敗: 設定形式が無効です",
		"import.success": "設定を正常にインポートしました",
		"actions.export": "エクスポート",
		"actions.import": "インポート",
		"actions.reset": "リセット",
		"import.invalidJson": "インポート失敗: 無効なJSON形式です",
		"app.settings": "チャットオーバーレイ設定",
		"reset.confirmDesc": "オーバーレイ設定をリセット",
		"app.reload": "オーバレイを再読み込み",
		Color: "色",
		"appearance.authorsNameColor": "名前の色",
		"appearance.authorsBackground": "背景",
		Show: "表示",
		"appearance.authorsShowName": "名前を表示",
		Normal: "一般",
		Member: "メンバー",
		Moderator: "モデレーター",
		Owner: "所有者",
		Verified: "認証済み",
		SuperChat: "スパーチャット",
		"indicator.loading": "チャット履歴を読み込み中...",
		"format.shortMessagesShown": "長さに関係なく短いメッセージを表示",
		"translation.unsupported": "翻訳機能には内蔵AIが必要です。Chrome 138+またはEdge 143+ Canaryをご利用ください。",
		"chat.messages": "チャットメッセージ",
		"chat.membership": "メンバーシップ",
		"chat.superChat": "スーパーチャット",
		"advanced.ignoreReducedMotion": "モーション低減を無視",
		"advanced.ignoreReducedMotionDesc": "OSのモーション低減設定が有効でもスクロールアニメーションを強制します（ページ再読み込みが必要）",
		"pane.comments": "コメント",
		"pane.appearance": "外観",
		"pane.advanced": "詳細設定",
		"pane.translation": "翻訳",
		"appearance.cards": "カード",
		"danmaku.font": "フォント",
		"danmaku.timing": "タイミング",
		"advanced.backlog": "バックログ",
		"advanced.cache": "キャッシュ",
		"advanced.tuning": "チューニング",
		"advanced.developer": "開発者",
		"advanced.performance": "パフォーマンス",
		"advanced.authorRateLimitOff": "オフ",
		"appearance.authorsSuperchat": "スーパーチャット",
		"translation.interface": "インターフェース",
		"translation.service": "サービス",
		"indicator.busy": "チャット混雑",
		"indicator.heavy": "チャット過多 — 一部省略",
		"indicator.overload": "チャット過負荷 — スキップ中",
		"advanced.logLevelInfo": "情報",
		"app.cancel": "キャンセル",
		"app.done": "完了",
		"translation.language": "言語",
		"appearance.outlineEnabled": "有効"
	};
	var KO = {
		Comments: "코멘트",
		Appearance: "카드 및 색상",
		Advanced: "고급",
		Translation: "번역",
		"app.name": "라이브 채팅 오버레이",
		Paused: "일시정지",
		"app.langChanged": "인터페이스 언어가 변경되었습니다: ",
		"status.connecting": "연결 중…",
		"status.unstable": "연결 불안정",
		"status.disconnected": "연결 끊김 — 클릭하여 새로고침",
		"status.waiting": "라이브 스트림 대기 중…",
		Cards: "카드",
		"appearance.outline": "텍스트 외곽선",
		"danmaku.safeZone": "안전 영역",
		"advanced.messageRate": "메시지 빈도",
		"advanced.depthLayers": "깊이 레이어",
		Font: "글꼴",
		Backlog: "백로그",
		Timing: "타이밍",
		Tuning: "튜닝",
		"advanced.burst": "버스트 감지",
		Cache: "캐시",
		"appearance.authors": "작성자 색상 및 표시",
		Interface: "인터페이스",
		"translation.chat": "채팅 번역",
		"translation.serviceDesc": "메시지 처리를 위한 번역 백엔드 서비스",
		"advanced.authorRateLimit": "작성자 빈도 제한",
		"advanced.backlogMode": "백로그 모드",
		"advanced.backlogOpacity": "백로그 불투명도 (%)",
		Bold: "볼드",
		"danmaku.bottomClearZone": "하단 여백 (%)",
		"danmaku.fontCustom": "사용자 지정 글꼴…",
		"danmaku.mode": "단마쿠 모드",
		Enabled: "활성화",
		Family: "글꼴",
		"advanced.ignoreMinLength": "최소 길이 무시",
		"danmaku.laneGap": "레인 간격 (px)",
		Language: "언어",
		"appearance.membershipMaxLines": "멤버십 최대 줄 수",
		"advanced.minLength": "최소 길이 (글자)",
		"appearance.outlineOpacity": "외곽선 불투명도 (%)",
		"appearance.outlineWidth": "외곽선 두께 (px)",
		"appearance.preserveUserColors": "사용자 색상 유지",
		Regular: "보통",
		"danmaku.scrollSpeed": "스크롤 속도 (px/s)",
		"appearance.showSuperchatAmount": "슈퍼챗 금액 표시",
		"danmaku.fontSize": "크기 (px)",
		"appearance.superchatMaxLines": "슈퍼챗 최대 줄 수",
		"appearance.superchatOpacity": "슈퍼챗 불투명도 (%)",
		"danmaku.textOpacity": "텍스트 불투명도 (%)",
		"danmaku.topClearZone": "상단 여백 (%)",
		Weight: "두께",
		English: "영어",
		한국어: "한국어",
		日本語: "일본어",
		Español: "스페인어",
		中文: "중국어",
		العربية: "아랍어",
		"danmaku.durationMul": "표시 시간 배율 (×)",
		"danmaku.exitPadding": "종료 여백 (px)",
		"danmaku.minScrollDuration": "최소 스크롤 시간 (ms)",
		"danmaku.maxScrollDuration": "최대 스크롤 시간 (ms)",
		"danmaku.topBottomDuration": "상단/하단 표시 시간 (ms)",
		"advanced.maxQueueDepth": "큐 최대 크기",
		"advanced.tabTrimTarget": "백그라운드 큐 최대",
		"advanced.maxMessageAge": "최대 메시지 수명 (ms)",
		"danmaku.messageSpacing": "메시지 간격 (%)",
		"translation.enable": "번역 활성화",
		Service: "서비스",
		"translation.source": "소스 언어",
		"translation.target": "대상 언어",
		"translation.displayMode": "표시 방식",
		"advanced.depthNearSpeed": "가까운 속도 (%)",
		"advanced.depthFarSpeed": "먼 속도 (%)",
		"advanced.depthFarOpacity": "먼 불투명도 (%)",
		"danmaku.scroll": "스크롤 (오른쪽→왼쪽)",
		"danmaku.reverse": "역방향 (왼쪽→오른쪽)",
		"danmaku.top": "상단 고정",
		"danmaku.bottom": "하단 고정",
		"advanced.backlogPlayback": "재생 기반 (권장)",
		"advanced.backlogRecent": "최근만",
		"advanced.backlogFull": "전체 (모두 표시)",
		"advanced.backlogNone": "없음 (백로그 건너뛰기)",
		Off: "끄기",
		"advanced.authorRateLimitNormal": "보통 (5개 / 5초)",
		"advanced.authorRateLimitStrict": "엄격 (2개 / 5초)",
		"translation.languageAuto": "자동 (브라우저)",
		"translation.sourceAuto": "자동 감지",
		"translation.serviceAuto": "자동 (Chrome 내장)",
		"translation.displayModeDual": "이중 표시 (원문 + 번역)",
		"translation.displayModeReplace": "번역만 표시",
		"danmaku.laneGapDesc": "댓글 행 사이 간격 (0 = 바로 이어지는 행)",
		"danmaku.fontCustomDesc": "CSS font-family 값. 예: \"Noto Sans KR\", sans-serif. 글꼴이 없으면 시스템 기본값을 사용합니다.",
		"appearance.superchatOpacityDesc": "슈퍼챗 카드의 배경 불투명도",
		"appearance.superchatMaxLinesDesc": "본문 텍스트 최대 줄 수, 초과 시 잘림 (2-10)",
		"appearance.membershipMaxLinesDesc": "멤버십 메시지 본문 최대 줄 수 (1-5)",
		"appearance.showSuperchatAmountDesc": "슈퍼챗 카드에 구매 금액 배지를 표시합니다",
		"Use author's chosen text color from YouTube chat instead of overlay defaults": "YouTube 채팅 작성자의 텍스트 색상을 오버레이 기본값 대신 사용",
		"danmaku.topClearZoneDesc": "영상 상단 N%를 댓글 없이 유지",
		"danmaku.bottomClearZoneDesc": "영상 하단 N%를 댓글 없이 유지",
		"advanced.ignoreMinLengthDesc": "최소 글자 수에 관계없이 모든 메시지 표시",
		"advanced.minLengthDesc": "최소 글자 수",
		"advanced.backlogOpacityDesc": "실시간 메시지 대비 과거 메시지의 불투명도",
		"danmaku.durationMulDesc": "관리자와 소유자의 메시지가 일반 메시지보다 얼마나 오래 표시될지 설정합니다 (1.0 = 동일, 2.0 = 2배)",
		"translation.enableDesc": "실시간으로 채팅 메시지를 번역합니다 (Chrome 138+ 내장 번역 필요)",
		"advanced.depthLayersDesc": "속도 기반 깊이감: 빠른 메시지는 가까이, 느린 메시지는 멀리 표시",
		"advanced.depthNearSpeedDesc": "가까운 레이어 메시지 속도 증가",
		"advanced.depthFarSpeedDesc": "먼 레이어 메시지 속도 감소",
		"advanced.depthFarOpacityDesc": "먼 레이어 메시지 불투명도 감소",
		"danmaku.scrollSpeedDesc": "댓글이 화면을 가로지르는 속도(초당 픽셀)",
		"danmaku.exitPaddingDesc": "메시지가 화면 가장자리를 지나 제거되기까지 추가로 이동하는 픽셀 (20-400, 기본 100)",
		"danmaku.minScrollDurationDesc": "최소 스크롤 애니메이션 시간 — 짧은 메시지가 너무 빠르게 지나가는 것을 방지 (1000-15000ms, 기본 5000)",
		"danmaku.maxScrollDurationDesc": "최대 스크롤 애니메이션 시간 — 긴 메시지가 너무 느리게 이동하는 것을 방지 (5-120초, 기본 30000ms)",
		"danmaku.topBottomDurationDesc": "상단/하단 모드 메시지의 고정 표시 시간 (1000-30000ms, 기본 4000)",
		"advanced.maxQueueDepthDesc": "메시지가 드롭되기 전 최대 대기 큐 깊이 (50-1000, 기본 200)",
		"advanced.tabTrimTargetDesc": "백그라운드 탭 정리 시 목표 활성 메시지 수 (10-500, 기본 50)",
		"advanced.maxMessageAgeDesc": "페이드아웃 제거 전 최대 메시지 수명 (10-300초, 기본 60000ms)",
		"danmaku.messageSpacingDesc": "연속 메시지 사이의 간격을 메시지 너비의 백분율로 표시 (2-30%, 기본 8)",
		"Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.": "수신 채팅 메시지의 언어입니다. 자동 감지는 Chrome 내장 언어 감지를 사용합니다.",
		"translation.sourceDesc": "채팅 메시지를 번역할 대상 언어. 자동은 브라우저 설정에서 감지합니다.",
		"advanced.authorRateLimitDesc": "동일 작성자의 메시지 표시 빈도를 제한",
		"translation.languageDesc": "오버레이 UI 언어를 설정합니다 (댓글 언어 필터 아님)",
		Performance: "성능",
		Developer: "개발자",
		"advanced.maxConcurrent": "최대 메시지 수",
		"advanced.fadeDuration": "페이드 시간 (ms)",
		"advanced.minPollInterval": "최소 폴링 간격 (ms)",
		"advanced.maxPollInterval": "최대 폴링 간격 (ms)",
		"advanced.backlogInjectionRate": "최대 속도 (msg/s)",
		"advanced.backlogSpeed": "속도 배율",
		"advanced.backlogRecentWindow": "시간 창 (분)",
		"advanced.logLevel": "로그 레벨",
		"advanced.debugOverlay": "디버그 오버레이",
		"advanced.logLevelWarn": "경고만",
		Info: "정보",
		"advanced.logLevelDebug": "디버그 (상세)",
		"advanced.maxConcurrentDesc": "화면에 동시 표시할 최대 메시지 수 (30-300)",
		"advanced.fadeDurationDesc": "메시지가 사라지는 페이드아웃 시간 (0 = 즉시, 50-1000)",
		"advanced.minPollIntervalDesc": "채팅 폴링 최소 간격 (밀리초, 50-5000)",
		"advanced.maxPollIntervalDesc": "채팅 폴링 최대 간격 (밀리초, 1000-30000)",
		"advanced.backlogInjectionRateDesc": "초당 백로그 메시지 주입 최대 속도 (0-50)",
		"advanced.backlogSpeedDesc": "백로그 메시지 애니메이션 속도 배율 (1-5)",
		"advanced.backlogRecentWindowDesc": "최근 전용 백로그 모드의 시간 창 (분, 1-30)",
		"advanced.logLevelDesc": "콘솔 진단 출력 상세도",
		"advanced.debugOverlayDesc": "비디오 플레이어에 성능 디버그 오버레이 표시",
		"danmaku.fontSizeDesc": "픽셀 단위 텍스트 크기 (14-50)",
		"appearance.outlineWidthDesc": "텍스트 외곽선 두께 (픽셀, 0-8)",
		"appearance.outlineOpacityDesc": "텍스트 외곽선 불투명도 (0-100%)",
		"app.enabledDesc": "YouTube 라이브 스트림에서 채팅 오버레이를 켜거나 끕니다",
		"danmaku.modeDesc": "댓글 표시 방향과 동작 방식",
		"danmaku.fontWeightDesc": "볼드는 더 읽기 쉽고, 보통은 GPU 메모리를 적게 사용합니다",
		"danmaku.fontFamilyDesc": "댓글 텍스트 글꼴",
		"danmaku.textOpacityDesc": "댓글 텍스트의 전체 불투명도 (50-100%)",
		"appearance.outlineEnabledDesc": "밝은 배경에서 텍스트 가독성을 높이기 위해 어두운 외곽선을 추가합니다",
		"advanced.backlogModeDesc": "과거 채팅 메시지를 라이브 재생 대비 어떻게 표시할지 설정합니다",
		"translation.displayModeDesc": "이중 표시는 원문 위에 번역을, 교체는 번역만 표시합니다",
		"advanced.emojiCache": "이모지 캐시 (MB)",
		"advanced.photoCache": "사진 캐시 (MB)",
		"advanced.stickerCache": "스티커 캐시 (MB)",
		"advanced.textCache": "텍스트 캐시 (MB)",
		"advanced.translationBatchSize": "번역 배치 크기",
		"advanced.emojiFetchLimit": "이모지 가져오기 제한",
		"advanced.emojiRetryMin": "실패한 이모지 재시도 (분)",
		"advanced.emojiCacheDesc": "이모지 이미지 캐시 최대 메모리 (1-20 MB, 기본 3)",
		"advanced.photoCacheDesc": "작성자 사진 캐시 최대 메모리 (1-20 MB, 기본 2)",
		"advanced.stickerCacheDesc": "스티커 이미지 캐시 최대 메모리 (1-20 MB, 기본 1)",
		"advanced.textCacheDesc": "텍스트 비트맵 캐시 최대 메모리 (1-20 MB, 기본 4)",
		"advanced.translationBatchSizeDesc": "프레임당 최대 번역 적용 수 (1-20, 기본 5)",
		"advanced.emojiFetchLimitDesc": "최대 동시 이모지 가져오기 (1-20, 기본 6)",
		"advanced.emojiRetryMinDesc": "실패한 이모지 재시도 대기 시간 (1-60분, 기본 5)",
		"advanced.burstSampleWindow": "버스트 샘플 창",
		"advanced.burstElevated": "상승 버스트 (msg/s)",
		"advanced.burstHigh": "높은 버스트 (msg/s)",
		"advanced.burstExtreme": "극심한 버스트 (msg/s)",
		"advanced.tuningBacklogInjectionMax": "백로그 주입 최대",
		"advanced.tuningDensityRamp": "백로그 밀도 램프 (ms)",
		"advanced.tuningPollFallback": "라이브 폴링 폴백 (ms)",
		"advanced.tuningPollFailureLimit": "폴링 실패 제한",
		"advanced.tuningSpeedBoostThreshold": "속도 부스트 임계값",
		"advanced.tuningBacklogPause": "백로그 일시 중지 (%)",
		"advanced.tuningBacklogResume": "백로그 재개 (%)",
		"advanced.tuningActivityTimeout": "활동 시간 초과 (ms)",
		"advanced.burstSampleWindowDesc": "버스트 속도 샘플 창 크기",
		"advanced.burstElevatedDesc": "상승 버스트 수준의 초당 메시지 임계값",
		"advanced.burstHighDesc": "높은 버스트 수준의 초당 메시지 임계값",
		"advanced.burstExtremeDesc": "극심한 버스트 수준의 초당 메시지 임계값",
		"advanced.tuningBacklogInjectionMaxDesc": "최대 백로그 주입 속도 상한",
		"advanced.tuningDensityRampDesc": "백로그 주입의 밀도 램프 지속 시간 (밀리초)",
		"advanced.tuningPollFallbackDesc": "라이브 폴링 폴백 지연 시간 (밀리초)",
		"advanced.tuningPollFailureLimitDesc": "차단기가 작동하기 전 연속 폴링 실패 횟수",
		"advanced.tuningSpeedBoostThresholdDesc": "속도 부스트를 트리거하는 대기 메시지 수",
		"advanced.tuningBacklogPauseDesc": "백로그 주입을 일시 중지하는 레인 사용률 비율",
		"advanced.tuningBacklogResumeDesc": "백로그 주입을 재개하는 레인 사용률 비율",
		"advanced.tuningActivityTimeoutDesc": "채팅 활동 시간 초과 (밀리초)",
		"advanced.tuningStaggerMax": "최대 스태거 지연 (ms)",
		"advanced.tuningStaggerMedium": "중간 스태거 지연 (ms)",
		"advanced.tuningEmojiTimeout": "이모지 가져오기 시간 초과 (ms)",
		"advanced.tuningDensityRampMax": "백로그 밀도 램프 최대 (ms)",
		"advanced.tuningInjectionRateMin": "최소 백로그 주입 속도",
		"advanced.tuningSpeedBoostMax": "최대 속도 부스트",
		"advanced.tuningSpeedBoostDenom": "속도 부스트 분모",
		"advanced.tuningToggleCooldown": "백로그 전환 쿨다운 (ms)",
		"advanced.replayPrefetchPages": "리플리 프리페치 페이지",
		"advanced.replayBatchLimit": "리플리 배치 제한",
		"advanced.tuningStaggerMaxDesc": "동일 배치 메시지의 최대 스태거 지연 시간",
		"advanced.tuningStaggerMediumDesc": "큐 깊이가 중간일 때 중간 스태거 지연 시간",
		"advanced.tuningEmojiTimeoutDesc": "이모지 가져오기 작업 시간 초과",
		"advanced.tuningDensityRampMaxDesc": "백로그 주입의 최대 밀도 램프 지속 시간",
		"advanced.tuningInjectionRateMinDesc": "최소 백로그 주입 속도 (msg/s)",
		"advanced.tuningSpeedBoostMaxDesc": "버스트 보상을 위한 최대 속도 부스트 계수",
		"advanced.tuningSpeedBoostDenomDesc": "EMA 속도 스케일링을 위한 속도 부스트 분모",
		"advanced.tuningToggleCooldownDesc": "백로그 일시 중지 전환 간 쿨다운",
		"advanced.replayPrefetchPagesDesc": "리플리 모드에서 프리페치할 최대 페이지 수",
		"advanced.replayBatchLimitDesc": "리플리 초기화에서 가져올 최대 배치 수",
		"app.title": "채팅 오버레이",
		"app.close": "설정 닫기",
		"app.settingsCategories": "설정 카테고리",
		"app.enabled": "오버레이 활성화",
		"format.valueAdjusted": "조정된 값: ",
		Reset: "초기화",
		Export: "내보내기",
		Import: "가져오기",
		Close: "닫기",
		Done: "완료",
		"app.autoSave": "모든 변경 사항이 자동으로 저장됩니다",
		"reset.confirm": "모든 설정을 기본값으로 초기화할까요?",
		Cancel: "취소",
		"import.invalidFormat": "가져오기 실패: 잘못된 설정 형식",
		"import.success": "설정을 성공적으로 가져왔습니다",
		"actions.export": "내보내기",
		"actions.import": "가져오기",
		"actions.reset": "초기화",
		"import.invalidJson": "가져오기 실패: 잘못된 JSON 형식",
		"app.settings": "채팅 오버레이 설정",
		"reset.confirmDesc": "오버레이 설정 초기화",
		"app.reload": "오버레이 새로고침",
		Color: "색상",
		"appearance.authorsNameColor": "이름 색상",
		"appearance.authorsBackground": "배경",
		Show: "표시",
		"appearance.authorsShowName": "이름 표시",
		Normal: "일반",
		Member: "멤버",
		Moderator: "관리자",
		Owner: "소유자",
		Verified: "인증됨",
		SuperChat: "슈퍼챗",
		"indicator.loading": "채팅 기록을 불러오는 중...",
		"format.shortMessagesShown": "길이에 관계없이 짧은 메시지 표시",
		"translation.unsupported": "번역 기능을 사용하려면 내장 AI가 있는 브라우저가 필요합니다. Chrome 138+ 또는 Edge 143+ Canary를 사용하세요.",
		"chat.messages": "채팅 메시지",
		"chat.membership": "멤버십",
		"chat.superChat": "슈퍼챗",
		"advanced.ignoreReducedMotion": "접근성 모션 무시",
		"advanced.ignoreReducedMotionDesc": "OS 모션 감소 설정이 켜져 있어도 스크롤 애니메이션을 강제로 사용합니다 (페이지 새로고침 필요)",
		"pane.comments": "댓글",
		"pane.appearance": "모양",
		"pane.advanced": "고급",
		"pane.translation": "번역",
		"appearance.cards": "카드",
		"danmaku.font": "글꼴",
		"danmaku.timing": "타이밍",
		"advanced.backlog": "백로그",
		"advanced.cache": "캐시",
		"advanced.tuning": "튜닝",
		"advanced.developer": "개발자",
		"advanced.performance": "성능",
		"advanced.authorRateLimitOff": "끄기",
		"appearance.authorsSuperchat": "슈퍼챗",
		"translation.interface": "인터페이스",
		"translation.service": "서비스",
		"indicator.busy": "채팅 혼잡",
		"indicator.heavy": "채팅 많음 — 일부 메시지 생략",
		"indicator.overload": "채팅 과부하 — 메시지 건너뜀",
		"advanced.logLevelInfo": "정보",
		"app.cancel": "취소",
		"app.done": "완료",
		"translation.language": "언어",
		"appearance.outlineEnabled": "활성화"
	};
	var ZH_CN = {
		Comments: "弹幕",
		Appearance: "卡片与颜色",
		Advanced: "高级",
		Translation: "翻译",
		"app.name": "实时聊天覆盖层",
		Paused: "已暂停",
		"app.langChanged": "界面语言已更改为：",
		"status.connecting": "连接中…",
		"status.unstable": "连接不稳定",
		"status.disconnected": "已断开 — 点击重新加载",
		"status.waiting": "等待直播…",
		Cards: "卡片",
		"appearance.outline": "文字描边",
		"danmaku.safeZone": "安全区域",
		"advanced.messageRate": "消息频率",
		"advanced.depthLayers": "深度图层",
		Font: "字体",
		Backlog: "回放",
		Timing: "时序",
		Tuning: "调优",
		"advanced.burst": "突发检测",
		Cache: "缓存",
		"appearance.authors": "用户颜色与显示",
		Interface: "界面",
		"translation.chat": "聊天翻译",
		"translation.serviceDesc": "用于处理消息的翻译后端服务",
		"advanced.authorRateLimit": "用户频率限制",
		"advanced.backlogMode": "回放模式",
		"advanced.backlogOpacity": "回放不透明度 (%)",
		Bold: "粗体",
		"danmaku.bottomClearZone": "底部留白 (%)",
		"danmaku.fontCustom": "自定义字体…",
		"danmaku.mode": "弹幕模式",
		Enabled: "启用",
		Family: "字体",
		"advanced.ignoreMinLength": "忽略最小长度",
		"danmaku.laneGap": "行间距 (px)",
		Language: "语言",
		"appearance.membershipMaxLines": "会员消息最大行数",
		"advanced.minLength": "最小长度 (字符)",
		"appearance.outlineOpacity": "描边不透明度 (%)",
		"appearance.outlineWidth": "描边宽度 (px)",
		"appearance.preserveUserColors": "保留用户颜色",
		Regular: "常规",
		"danmaku.scrollSpeed": "滚动速度 (px/s)",
		"appearance.showSuperchatAmount": "显示超级留言金额",
		"danmaku.fontSize": "大小 (px)",
		"appearance.superchatMaxLines": "超级留言最大行数",
		"appearance.superchatOpacity": "超级留言不透明度 (%)",
		"danmaku.textOpacity": "文字不透明度 (%)",
		"danmaku.topClearZone": "顶部留白 (%)",
		Weight: "粗细",
		English: "英语",
		한국어: "韩语",
		日本語: "日语",
		Español: "西班牙语",
		中文: "中文",
		العربية: "阿拉伯语",
		"danmaku.durationMul": "显示时长倍率 (×)",
		"danmaku.exitPadding": "退出边距 (px)",
		"danmaku.minScrollDuration": "最小滚动时间 (ms)",
		"danmaku.maxScrollDuration": "最大滚动时间 (ms)",
		"danmaku.topBottomDuration": "顶部/底部显示时间 (ms)",
		"advanced.maxQueueDepth": "队列最大容量",
		"advanced.tabTrimTarget": "后台队列最大容量",
		"advanced.maxMessageAge": "最大消息寿命 (ms)",
		"danmaku.messageSpacing": "消息间距 (%)",
		"danmaku.exitPaddingDesc": "消息滚动超过屏幕边缘后被移除的额外像素 (20-400, 默认 100)",
		"danmaku.minScrollDurationDesc": "最小滚动动画时长 — 防止短消息飞过 (1000-15000ms, 默认 5000)",
		"danmaku.maxScrollDurationDesc": "最大滚动动画时长 — 防止长消息爬行 (5-120秒, 默认 30000ms)",
		"danmaku.topBottomDurationDesc": "顶部/底部模式消息的固定显示时长 (1000-30000ms, 默认 4000)",
		"advanced.maxQueueDepthDesc": "消息被丢弃前的最大待处理队列深度 (50-1000, 默认 200)",
		"advanced.tabTrimTargetDesc": "后台标签页整理时的目标活动消息数 (10-500, 默认 50)",
		"advanced.maxMessageAgeDesc": "淡出移除前的最大消息寿命 (10-300秒, 默认 60000ms)",
		"danmaku.messageSpacingDesc": "连续消息之间的间距（消息宽度的百分比） (2-30%, 默认 8)",
		"translation.enable": "启用翻译",
		Service: "服务",
		"translation.source": "源语言",
		"translation.target": "目标语言",
		"translation.displayMode": "显示模式",
		"advanced.depthNearSpeed": "近处速度 (%)",
		"advanced.depthFarSpeed": "远处速度 (%)",
		"advanced.depthFarOpacity": "远处不透明度 (%)",
		"danmaku.scroll": "滚动 (右→左)",
		"danmaku.reverse": "反向 (左→右)",
		"danmaku.top": "顶部固定",
		"danmaku.bottom": "底部固定",
		"advanced.backlogPlayback": "基于播放进度 (推荐)",
		"advanced.backlogRecent": "仅最近",
		"advanced.backlogFull": "全部显示",
		"advanced.backlogNone": "无 (跳过回放)",
		Off: "关闭",
		"advanced.authorRateLimitNormal": "标准 (5条 / 5秒)",
		"advanced.authorRateLimitStrict": "严格 (2条 / 5秒)",
		"translation.languageAuto": "自动 (浏览器)",
		"translation.sourceAuto": "自动检测",
		"translation.serviceAuto": "自动 (Chrome内置)",
		"translation.displayModeDual": "双语 (原文 + 翻译)",
		"translation.displayModeReplace": "仅翻译",
		"danmaku.laneGapDesc": "弹幕行之间的垂直间距 (0 = 行紧邻)",
		"danmaku.fontWeightDesc": "粗体更易阅读，常规使用更少GPU内存",
		"danmaku.fontFamilyDesc": "评论文字字体",
		"danmaku.fontCustomDesc": "CSS font-family 值，例如 \"Noto Sans KR\", sans-serif。字体不存在时使用系统默认。",
		"appearance.superchatOpacityDesc": "超级留言卡片的背景不透明度",
		"appearance.superchatMaxLinesDesc": "正文最大行数，超出部分截断 (2-10)",
		"appearance.membershipMaxLinesDesc": "会员消息正文最大行数 (1-5)",
		"Use author's chosen text color from YouTube chat instead of overlay defaults": "使用YouTube聊天中用户自选文字颜色，而非覆盖层默认颜色",
		"appearance.showSuperchatAmountDesc": "在超级留言卡片上显示购买金额徽章",
		"danmaku.topClearZoneDesc": "视频顶部N%区域不显示弹幕",
		"danmaku.bottomClearZoneDesc": "视频底部N%区域不显示弹幕",
		"advanced.ignoreMinLengthDesc": "无论最小字符数如何，显示所有消息",
		"advanced.minLengthDesc": "最小字符数",
		"advanced.backlogOpacityDesc": "历史消息相对于实时消息的不透明度",
		"danmaku.durationMulDesc": "版主和频道主的消息比普通消息多显示多长时间 (1.0 = 相同, 2.0 = 两倍)",
		"translation.enableDesc": "实时翻译聊天消息 (需要 Chrome 138+ 内置翻译)",
		"advanced.depthLayersDesc": "基于速度的深度感知：快速消息显示在近处，慢速消息显示在远处",
		"advanced.depthNearSpeedDesc": "近处图层消息速度提升",
		"advanced.depthFarSpeedDesc": "远处图层消息速度降低",
		"advanced.depthFarOpacityDesc": "远处图层消息不透明度降低",
		"danmaku.scrollSpeedDesc": "弹幕滚过屏幕的速度(像素/秒)",
		"Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.": "传入聊天消息的语言。自动检测使用Chrome内置语言检测。",
		"translation.sourceDesc": "将聊天消息翻译成的目标语言。自动从浏览器设置检测。",
		"advanced.authorRateLimitDesc": "限制同一用户消息的显示频率",
		"translation.languageDesc": "设置覆盖层界面语言（不按语言过滤弹幕）",
		Performance: "性能",
		Developer: "开发者",
		"advanced.maxConcurrent": "最大消息数",
		"advanced.fadeDuration": "淡出时间 (ms)",
		"advanced.minPollInterval": "最小轮询间隔 (ms)",
		"advanced.maxPollInterval": "最大轮询间隔 (ms)",
		"advanced.backlogInjectionRate": "最大速率 (msg/s)",
		"advanced.backlogSpeed": "速度倍率",
		"advanced.backlogRecentWindow": "时间窗口 (分)",
		"advanced.logLevel": "日志级别",
		"advanced.debugOverlay": "调试叠加层",
		"advanced.logLevelWarn": "仅警告",
		Info: "信息",
		"advanced.logLevelDebug": "调试 (详细)",
		"advanced.maxConcurrentDesc": "屏幕上同时可见的最大消息数 (30-300)",
		"advanced.fadeDurationDesc": "消息淡出所需时间 (0 = 立即, 50-1000)",
		"advanced.minPollIntervalDesc": "聊天轮询最小间隔（毫秒，50-5000）",
		"advanced.maxPollIntervalDesc": "聊天轮询最大间隔（毫秒，1000-30000）",
		"advanced.backlogInjectionRateDesc": "每秒最大回放消息注入速率 (0-50)",
		"advanced.backlogSpeedDesc": "回放消息动画速度倍率 (1-5)",
		"advanced.backlogRecentWindowDesc": "仅最近回放模式的时间窗口（分钟，1-30）",
		"advanced.logLevelDesc": "控制台诊断输出详细程度",
		"advanced.debugOverlayDesc": "在视频播放器上显示性能调试覆盖层",
		"danmaku.fontSizeDesc": "像素文本大小 (14-50)",
		"appearance.outlineWidthDesc": "文本描边宽度（像素，0-8）",
		"appearance.outlineOpacityDesc": "文本描边不透明度 (0-100%)",
		"app.enabledDesc": "在YouTube直播中打开或关闭弹幕显示",
		"danmaku.modeDesc": "弹幕显示方向和行为",
		"danmaku.textOpacityDesc": "弹幕文字的整体不透明度 (50-100%)",
		"appearance.outlineEnabledDesc": "在文字周围添加深色描边，提高可读性",
		"advanced.backlogModeDesc": "历史聊天消息相对于直播播放的显示方式",
		"translation.displayModeDesc": "双语显示原文在上翻译在下，仅翻译只显示译文",
		"advanced.emojiCache": "表情缓存 (MB)",
		"advanced.photoCache": "头像缓存 (MB)",
		"advanced.stickerCache": "贴纸缓存 (MB)",
		"advanced.textCache": "文本缓存 (MB)",
		"advanced.translationBatchSize": "翻译批处理大小",
		"advanced.emojiFetchLimit": "表情获取限制",
		"advanced.emojiRetryMin": "失败表情重试 (分钟)",
		"advanced.emojiCacheDesc": "表情图片缓存最大内存 (1-20 MB, 默认 3)",
		"advanced.photoCacheDesc": "作者头像缓存最大内存 (1-20 MB, 默认 2)",
		"advanced.stickerCacheDesc": "贴纸图片缓存最大内存 (1-20 MB, 默认 1)",
		"advanced.textCacheDesc": "文本位图缓存最大内存 (1-20 MB, 默认 4)",
		"advanced.translationBatchSizeDesc": "每帧最大翻译数量 (1-20, 默认 5)",
		"advanced.emojiFetchLimitDesc": "最大并发表情获取数 (1-20, 默认 6)",
		"advanced.emojiRetryMinDesc": "失败表情重试前等待时间 (1-60分钟, 默认 5)",
		"advanced.burstSampleWindow": "突发采样窗口",
		"advanced.burstElevated": "上升突发 (msg/s)",
		"advanced.burstHigh": "高突发 (msg/s)",
		"advanced.burstExtreme": "极端突发 (msg/s)",
		"advanced.tuningBacklogInjectionMax": "回放注入上限",
		"advanced.tuningDensityRamp": "回放密度斜坡 (ms)",
		"advanced.tuningPollFallback": "实时轮询回退 (ms)",
		"advanced.tuningPollFailureLimit": "轮询失败限制",
		"advanced.tuningSpeedBoostThreshold": "速度提升阈值",
		"advanced.tuningBacklogPause": "回放暂停 (%)",
		"advanced.tuningBacklogResume": "回放恢复 (%)",
		"advanced.tuningActivityTimeout": "活动超时 (ms)",
		"advanced.burstSampleWindowDesc": "突发速率采样窗口大小",
		"advanced.burstElevatedDesc": "上升突发级别的每秒消息数阈值",
		"advanced.burstHighDesc": "高突发级别的每秒消息数阈值",
		"advanced.burstExtremeDesc": "极端突发级别的每秒消息数阈值",
		"advanced.tuningBacklogInjectionMaxDesc": "回放注入速率上限",
		"advanced.tuningDensityRampDesc": "回放注入的密度斜坡持续时间（毫秒）",
		"advanced.tuningPollFallbackDesc": "实时轮询回退延迟（毫秒）",
		"advanced.tuningPollFailureLimitDesc": "断路器跳闸前的连续轮询失败次数",
		"advanced.tuningSpeedBoostThresholdDesc": "触发速度提升的待处理消息数",
		"advanced.tuningBacklogPauseDesc": "暂停回放注入的通道利用率",
		"advanced.tuningBacklogResumeDesc": "恢复回放注入的通道利用率",
		"advanced.tuningActivityTimeoutDesc": "聊天活动超时时间（毫秒）",
		"advanced.tuningStaggerMax": "最大交错延迟 (ms)",
		"advanced.tuningStaggerMedium": "中等交错延迟 (ms)",
		"advanced.tuningEmojiTimeout": "表情获取超时 (ms)",
		"advanced.tuningDensityRampMax": "回放密度斜坡最大 (ms)",
		"advanced.tuningInjectionRateMin": "最小回放注入速率",
		"advanced.tuningSpeedBoostMax": "最大速度提升",
		"advanced.tuningSpeedBoostDenom": "速度提升分母",
		"advanced.tuningToggleCooldown": "回放切换冷却 (ms)",
		"advanced.replayPrefetchPages": "回放预取页数",
		"advanced.replayBatchLimit": "回放批量限制",
		"advanced.tuningStaggerMaxDesc": "同一批次消息的最大交错延迟",
		"advanced.tuningStaggerMediumDesc": "队列深度中等时的交错延迟",
		"advanced.tuningEmojiTimeoutDesc": "表情获取操作的超时时间",
		"advanced.tuningDensityRampMaxDesc": "回放注入的最大密度斜坡持续时间",
		"advanced.tuningInjectionRateMinDesc": "最小回放注入速率 (msg/s)",
		"advanced.tuningSpeedBoostMaxDesc": "突发补偿的最大速度提升系数",
		"advanced.tuningSpeedBoostDenomDesc": "EMA速率缩放的速度提升分母",
		"advanced.tuningToggleCooldownDesc": "回放暂停切换之间的冷却时间",
		"advanced.replayPrefetchPagesDesc": "回放模式下预取的最大页数",
		"advanced.replayBatchLimitDesc": "回放初始化时获取的最大批次数",
		"app.title": "弹幕显示",
		"app.close": "关闭设置",
		"app.settingsCategories": "设置分类",
		"app.enabled": "已启用覆盖层",
		"format.valueAdjusted": "已调整至 ",
		Reset: "重置",
		Export: "导出",
		Import: "导入",
		Close: "关闭",
		Done: "完成",
		"app.autoSave": "更改会自动保存",
		"reset.confirm": "将所有设置重置为默认值？",
		Cancel: "取消",
		"import.invalidFormat": "导入失败：设置格式无效",
		"import.success": "设置导入成功",
		"actions.export": "导出",
		"actions.import": "导入",
		"actions.reset": "重置",
		"import.invalidJson": "导入失败：JSON格式无效",
		"app.settings": "弹幕显示设置",
		"reset.confirmDesc": "重置覆盖层设置",
		"app.reload": "重新加载覆盖层",
		Color: "颜色",
		"appearance.authorsNameColor": "名称颜色",
		"appearance.authorsBackground": "背景",
		Show: "显示",
		"appearance.authorsShowName": "显示名称",
		Normal: "普通",
		Member: "会员",
		Moderator: "版主",
		Owner: "频道主",
		Verified: "已认证",
		SuperChat: "超级留言",
		"indicator.loading": "正在加载聊天记录...",
		"format.shortMessagesShown": "显示短消息，无论长度如何",
		"translation.unsupported": "翻译功能需要内置 AI 的浏览器。请使用 Chrome 138+ 或 Edge 143+ Canary。",
		"chat.messages": "聊天消息",
		"chat.membership": "会员",
		"chat.superChat": "超级留言",
		"advanced.ignoreReducedMotion": "忽略减少动态效果",
		"advanced.ignoreReducedMotionDesc": "即使操作系统开启了减少动态效果，也强制使用滚动动画（需要刷新页面）",
		"pane.comments": "弹幕",
		"pane.appearance": "外观",
		"pane.advanced": "高级",
		"pane.translation": "翻译",
		"appearance.cards": "卡片",
		"danmaku.font": "字体",
		"danmaku.timing": "时序",
		"advanced.backlog": "回放",
		"advanced.cache": "缓存",
		"advanced.tuning": "调优",
		"advanced.developer": "开发者",
		"advanced.performance": "性能",
		"advanced.authorRateLimitOff": "关闭",
		"appearance.authorsSuperchat": "超级留言",
		"translation.interface": "界面",
		"translation.service": "服务",
		"indicator.busy": "聊天繁忙",
		"indicator.heavy": "聊天较多 — 部分省略",
		"indicator.overload": "聊天过载 — 正在跳过",
		"advanced.logLevelInfo": "信息",
		"app.cancel": "取消",
		"app.done": "完成",
		"translation.language": "语言",
		"appearance.outlineEnabled": "已启用"
	};
	var LOCALE_CODES = [
		{
			code: "en",
			name: "English",
			dir: "ltr"
		},
		{
			code: "ko",
			name: "한국어",
			dir: "ltr"
		},
		{
			code: "ja",
			name: "日本語",
			dir: "ltr"
		},
		{
			code: "zh-CN",
			name: "简体中文",
			dir: "ltr"
		},
		{
			code: "es",
			name: "Español",
			dir: "ltr"
		},
		{
			code: "ar",
			name: "العربية",
			dir: "rtl"
		}
	].map((l) => l.code);
	function normalizeLocale(code) {
		const normalizedCode = code.trim();
		if (!normalizedCode) return null;
		const lower = normalizedCode.toLowerCase();
		const exact = LOCALE_CODES.find((l) => l.toLowerCase() === lower);
		if (exact) return exact;
		if (lower.includes("-")) {
			const region = normalizedCode.slice(0, 5);
			const regionMatch = LOCALE_CODES.find((l) => l.toLowerCase() === region.toLowerCase());
			if (regionMatch) return regionMatch;
		}
		const base = lower.slice(0, 2);
		const baseMatch = LOCALE_CODES.find((l) => l.toLowerCase().startsWith(base));
		if (baseMatch) return baseMatch;
		return null;
	}
	function detectLocale(options = {}) {
		const hasInjectedLanguageSource = Object.prototype.hasOwnProperty.call(options, "platformUILanguage") || Object.prototype.hasOwnProperty.call(options, "languages") || Object.prototype.hasOwnProperty.call(options, "singleLanguage");
		if (options.platformUILanguage) {
			const normalized = normalizeLocale(options.platformUILanguage);
			if (normalized) return normalized;
		}
		const navLanguages = options.languages;
		if (navLanguages && navLanguages.length > 0) for (const lang of navLanguages) {
			if (!lang) continue;
			const normalized = normalizeLocale(lang);
			if (normalized) return normalized;
		}
		const single = options.singleLanguage;
		if (single) {
			const normalized = normalizeLocale(single);
			if (normalized) return normalized;
		}
		if (!hasInjectedLanguageSource && typeof navigator !== "undefined") try {
			const uiLang = (typeof chrome !== "undefined" ? chrome : void 0)?.i18n?.getUILanguage?.() ?? void 0;
			if (uiLang) {
				const normalized = normalizeLocale(uiLang);
				if (normalized) return normalized;
			}
			const navLangs = navigator.languages;
			const browserLangs = navLangs ?? (navigator.language ? [navigator.language] : []);
			if (browserLangs.length > 0) for (const lang of browserLangs) {
				if (!lang) continue;
				const normalized = normalizeLocale(lang);
				if (normalized) return normalized;
			}
			if (navLangs && navLangs.length === 0 && navigator.language) {
				const normalized = normalizeLocale(navigator.language);
				if (normalized) return normalized;
			}
		} catch {}
		return options.defaultLocale ?? "en";
	}
	function getUILanguage() {
		try {
			if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) return chrome.i18n.getUILanguage();
			return;
		} catch (_error) {
			return;
		}
	}
	var activeLanguage = "en";
	function resolveActiveLanguage(setting) {
		activeLanguage = setting === "auto" ? detectBrowserLanguage() : setting;
	}
	function t(text) {
		const map = TRANSLATION_MAPS[activeLanguage];
		if (!map) return text;
		return map[text] ?? text;
	}
	function getActiveLanguage() {
		return activeLanguage;
	}
	function detectBrowserLanguage(getUILang, languages) {
		try {
			const uiLanguage = (getUILang ?? getUILanguage)();
			if (uiLanguage) return detectLocale({ platformUILanguage: uiLanguage });
			return detectLocale(languages ? { languages } : {});
		} catch {
			return "en";
		}
	}
	function resolveTranslationTarget(target) {
		if (target !== "auto") return target;
		return detectBrowserLanguage();
	}
	var TRANSLATION_MAPS = {
		en: EN,
		ko: KO,
		ja: JA,
		es: ES,
		"zh-CN": ZH_CN,
		ar: AR
	};
	var SPEED_TIER = {
		FAR: 0,
		MID: 1,
		NEAR: 2,
		BACKLOG: 3
	};
	var SAFETY_MARGIN_RATIO = .15;
	var ANTI_BLOCK_FREE_RATIO = .05;
	var TRANSLATION_FONT_SCALE = .85;
	var TRANSLATION_OPACITY_SCALE = .8;
	var FAR_LAYER_DESATURATION_FACTOR = .3;
	var OUTLINE_STROKE_SCALE = .85;
	var MS_TO_S = 1e3;
	var SIN_TABLE = (() => {
		const t = new Float64Array(256);
		for (let i = 0; i < 256; i++) t[i] = Math.sin(i / 256 * 2 * Math.PI);
		return t;
	})();
	var SIN_LUT_SCALE = 256 / 2e3;
	function hashStringForTier(str) {
		let hash = 5381;
		for (let i = 0; i < str.length; i++) hash = (hash << 5) + hash + str.charCodeAt(i) | 0;
		return (hash >>> 0) / 4294967296;
	}
	var EMPTY_CHAT_MESSAGE = {
		text: "",
		content: [],
		kind: "text",
		timestamp: 0,
		authorType: "normal"
	};
	function computeScrollDuration(totalDistance, velocity, durationMin, durationMax, exitPaddingPx) {
		if (Number.isNaN(totalDistance) || Number.isNaN(velocity) || velocity <= 0) return durationMin;
		const velocityFloor = Math.max(durationMin, exitPaddingPx / velocity * MS_TO_S);
		return Math.max(velocityFloor, Math.min(durationMax, totalDistance / velocity * MS_TO_S));
	}
	var DEFAULT_FONT_FAMILY = "system-ui, -apple-system, sans-serif";
	var superChatColors = {
		blue: {
			r: 30,
			g: 136,
			b: 229
		},
		cyan: {
			r: 0,
			g: 191,
			b: 255
		},
		green: {
			r: 15,
			g: 157,
			b: 88
		},
		yellow: {
			r: 255,
			g: 202,
			b: 40
		},
		orange: {
			r: 245,
			g: 124,
			b: 0
		},
		magenta: {
			r: 233,
			g: 30,
			b: 99
		},
		red: {
			r: 230,
			g: 33,
			b: 23
		}
	};
	var SUPERCHAT_TIER_KEYS = Object.keys(superChatColors);
	var colors = {
		authorNormal: "#FFFFFF",
		authorMember: "#0F9D58",
		authorModerator: "#5E84F1",
		authorOwner: "#FFD600",
		authorVerified: "#AAAAAA",
		authorBackground: {
			normal: "#00000000",
			member: "#00000000",
			moderator: "#1B3A6F59",
			owner: "#6B4F0059",
			verified: "#00000000"
		},
		superChat: superChatColors,
		membership: {
			background: {
				r: 15,
				g: 157,
				b: 88
			},
			borderRgb: {
				r: 45,
				g: 220,
				b: 120
			},
			backgroundAlpha: .28,
			borderAlpha: .75,
			borderAlphaAmplitude: .15,
			text: "#ffffff",
			headerText: "#ffffff"
		}
	};
	var spacing = {
		xxs: 2,
		xs: 4,
		sm: 8,
		md: 12,
		lg: 16
	};
	var DEFAULT_TEXT_COLOR = "#ffffff";
	var SUPERCHAT_AMOUNT_BADGE_FILL = "rgba(255, 255, 255, 0.24)";
	var SUPERCHAT_AMOUNT_BADGE_STROKE = "rgba(255, 255, 255, 0.35)";
	var AUTHOR_PHOTO_SHADOW = "rgba(0, 0, 0, 0.6)";
	var DEBUG_OVERLAY_BG = "rgba(0, 0, 0, 0.8)";
	var INDICATOR_Z_INDEX = "99999";
	var BACKLOG_INDICATOR_BG = "rgba(0, 0, 0, 0.75)";
	var rendererLayout = {
		authorPhotoSize: 24,
		authorFontScale: .85,
		emojiSize: 1.2,
		superchatStickerSize: 2,
		kindPriority: {
			superchat: 200,
			membership: 100,
			text: 0
		},
		burstSpeedMultiplier: {
			normal: 1,
			elevated: 1.1,
			high: 1.2,
			extreme: 1.35
		},
		paddingH: 12,
		messageBackgroundRadius: 6,
		superchatMinWidth: 280,
		superchatMaxWidth: 640,
		superchat: {
			paddingH: 24,
			paddingV: 20
		},
		membership: {
			paddingH: 16,
			paddingV: 12
		},
		superchatBadge: {
			paddingH: 12,
			paddingV: 8,
			radius: 12
		},
		queueMaxSize: 200,
		backgroundQueueMax: 50,
		maxMessageAgeMs: 6e4,
		fullscreenUpdateDelayMs: 100,
		overlayZIndex: "100",
		superchatCardRadius: 6,
		membershipCardRadius: 6,
		superchatAccentBarWidth: 4,
		superchatBadgeStrokeWidth: 1,
		membershipBorderWidth: 2,
		authorNameMaxWidth: 560,
		headwayGapRatio: .08
	};
	var statusBarLayout = {
		fontSize: 14,
		paddingX: 14,
		paddingY: 6,
		bottomOffset: 24,
		pillRadius: 6,
		dotRadius: 4,
		dotGap: 8,
		colors: {
			connected: {
				bg: "rgba(0,200,100,0.30)",
				dot: "rgba(0,255,140,0.80)",
				text: "rgba(255,255,255,0.75)"
			},
			connecting: {
				bg: "rgba(255,200,0,0.30)",
				dot: "rgba(255,220,0,0.85)",
				text: "rgba(255,255,255,0.75)"
			},
			degraded: {
				bg: "rgba(255,140,0,0.30)",
				dot: "rgba(255,160,0,0.85)",
				text: "rgba(255,255,255,0.75)"
			},
			disconnected: {
				bg: "rgba(220,50,50,0.45)",
				dot: "rgba(255,60,60,0.90)",
				text: "rgba(255,255,255,0.85)"
			},
			standby: {
				bg: "rgba(0,0,0,0.50)",
				dot: "rgba(255,255,255,0.50)",
				text: "rgba(255,255,255,0.70)"
			}
		}
	};
	function sleep(ms, signal) {
		if (ms <= 0) {
			if (signal?.aborted) return Promise.reject(signal.reason instanceof DOMException ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason instanceof DOMException ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
				return;
			}
			const timeoutId = setTimeout(() => {
				signal?.removeEventListener("abort", handleAbort);
				resolve();
			}, ms);
			const handleAbort = () => {
				clearTimeout(timeoutId);
				reject(signal?.reason instanceof DOMException ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
			};
			signal?.addEventListener("abort", handleAbort, { once: true });
		});
	}
	function clearSafeTimeout(id) {
		if (id !== null) clearTimeout(id);
		return null;
	}
	function clearSafeInterval(id) {
		if (id !== null) clearInterval(id);
		return null;
	}
	function clearSafeAnimationFrame(id) {
		if (id !== null) cancelAnimationFrame(id);
		return null;
	}
	function isAbortError(error, options = {}) {
		if (!(error instanceof DOMException)) return false;
		if (error.name === "AbortError") return true;
		if (options.checkTimeout && error.name === "TimeoutError") return true;
		return false;
	}
	function throwIfAborted$1(signal) {
		if (signal?.aborted) throw signal.reason === void 0 ? new DOMException("The operation was aborted.", "AbortError") : signal.reason;
	}
	var throwIfAborted = throwIfAborted$1;
	var log$28 = createLogger("Dom");
	var SCREEN_READER_CSS = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
	var DEFAULT_WAIT_ATTEMPTS = 5;
	var DEFAULT_WAIT_INTERVAL_MS = 500;
	var PLAYER_LOOKUP_INTERVAL_MS = 1e3;
	var PLAYER_CONTAINER_SELECTORS = ["#movie_player", ".html5-video-player"];
	var VIDEO_SELECTORS = ["#movie_player video", "video.html5-main-video"];
	var isVisibleElement = (element) => element.offsetWidth > 0 && element.offsetHeight > 0;
	function findElementMatch(selectors, options = {}) {
		const { root = document, predicate } = options;
		for (const selector of selectors) {
			const element = root.querySelector(selector);
			if (!element) continue;
			if (predicate && !predicate(element)) continue;
			return {
				element,
				selector
			};
		}
		return null;
	}
	async function pollForPlayerContainer(attempts, intervalMs, signal) {
		for (let attempt = 0; attempt < attempts; attempt++) {
			throwIfAborted(signal);
			const element = findElementMatch(PLAYER_CONTAINER_SELECTORS, { predicate: isVisibleElement });
			if (element) {
				log$28.debug("dom.player.found-polling", { selector: element.selector });
				return element.element;
			}
			if (attempt === attempts - 1) break;
			await sleep(intervalMs, signal);
		}
		log$28.debug("dom.player.not-found");
		return null;
	}
	async function findPlayerContainerElement(options = {}) {
		const attempts = Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WAIT_ATTEMPTS));
		const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
		const { signal } = options;
		const immediate = findElementMatch(PLAYER_CONTAINER_SELECTORS, { predicate: isVisibleElement });
		if (immediate) {
			log$28.debug("dom.player.found-immediate", { selector: immediate.selector });
			return immediate.element;
		}
		throwIfAborted(signal);
		if (typeof MutationObserver !== "undefined") {
			let onAbort;
			return new Promise((resolve, reject) => {
				let fallbackTimer;
				const observer = new MutationObserver(() => {
					const element = findElementMatch(PLAYER_CONTAINER_SELECTORS, { predicate: isVisibleElement });
					if (element) {
						observer.disconnect();
						clearTimeout(fallbackTimer);
						log$28.debug("dom.player.found-observer", { selector: element.selector });
						resolve(element.element);
					}
				});
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				fallbackTimer = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, intervalMs * attempts);
				onAbort = () => {
					observer.disconnect();
					clearTimeout(fallbackTimer);
					reject(new DOMException("Aborted", "AbortError"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			}).then((found) => {
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				if (found) return found;
				return pollForPlayerContainer(attempts, intervalMs, signal);
			});
		}
		return pollForPlayerContainer(attempts, intervalMs, signal);
	}
	function forEachSlot(laneIndex, slotCount, fn) {
		for (let offset = 0; offset < slotCount; offset++) fn(laneIndex + offset, offset);
	}
	function ensurePlayerPositioning(element) {
		if (window.getComputedStyle(element).position === "static") element.style.position = "relative";
	}
	var log$27 = createLogger("Overlay");
	var OVERLAY_ID = "yt-live-chat-overlay";
	var OVERLAY_SELECTOR = `#${OVERLAY_ID}`;
	var getLocalizedName = (lang) => lang === "ar" ? t("العربية") : lang === "zh-CN" ? t("中文") : lang === "ko" ? t("한국어") : lang === "ja" ? t("日本語") : lang === "es" ? t("Español") : t("English");
	var calculateOverlayDimensionsFromRect = (width, height) => {
		if (width === 0 || height === 0) return null;
		return {
			width: Math.round(width),
			height: Math.round(height)
		};
	};
	var areOverlayDimensionsEqual = (previous, next) => previous?.width === next?.width && previous?.height === next?.height;
	var Overlay = class Overlay {
		container = null;
		playerElement = null;
		resizeObserver = null;
		dimensions = null;
		settings = null;
		fullscreenHandler = null;
		fullscreenUpdateTimer = null;
		dimensionChangeCallbacks = new Set();
		resizePending = false;
		resizeRafId = null;
		liveRegion = null;
		liveRegionTimer = null;
		seenMessageIds = new Set();
		static LIVE_REGION_DEBOUNCE_MS = 500;
		static SEEN_SNIPPET_MAX = 200;
		isUserPaused = false;
		userPauseCallbacks = new Set();
		pauseIndicatorEl = null;
		keyboardHandler = null;
		async findPlayerContainer(signal) {
			const player = await findPlayerContainerElement({
				intervalMs: PLAYER_LOOKUP_INTERVAL_MS,
				signal
			});
			if (player) log$27.debug("Player dimensions:", {
				width: player.offsetWidth,
				height: player.offsetHeight
			});
			return player;
		}
		createContainerElement() {
			const container = document.createElement("div");
			container.id = OVERLAY_ID;
			container.style.position = "absolute";
			container.style.inset = "0";
			container.style.pointerEvents = "none";
			container.style.overflow = "hidden";
			container.style.zIndex = rendererLayout.overlayZIndex;
			container.style.contain = "layout style paint";
			container.setAttribute("role", "region");
			container.setAttribute("aria-label", t("app.title"));
			const initialLang = getActiveLanguage();
			container.lang = initialLang;
			container.dir = initialLang === "ar" ? "rtl" : "ltr";
			return container;
		}
		updateDimensions() {
			if (!this.playerElement || !this.container || !this.settings) {
				if (this.dimensions !== null) {
					this.dimensions = null;
					this.notifyDimensionChangeCallbacks();
				}
				return;
			}
			const rect = this.container.getBoundingClientRect();
			const nextDimensions = calculateOverlayDimensionsFromRect(rect.width, rect.height);
			if (areOverlayDimensionsEqual(this.dimensions, nextDimensions)) return;
			this.dimensions = nextDimensions;
			this.notifyDimensionChangeCallbacks();
		}
		clearFullscreenUpdateTimer() {
			this.fullscreenUpdateTimer = clearSafeTimeout(this.fullscreenUpdateTimer);
		}
		observeResize() {
			if (!this.playerElement) return;
			let latestEntry = null;
			this.resizeObserver = new ResizeObserver((entries) => {
				const entry = entries[0];
				if (!entry) return;
				latestEntry = entry;
				if (this.resizePending) return;
				this.resizePending = true;
				if (this.resizeRafId !== null) cancelAnimationFrame(this.resizeRafId);
				this.resizeRafId = requestAnimationFrame(() => {
					this.resizeRafId = null;
					this.resizePending = false;
					if (!latestEntry) return;
					const { width, height } = latestEntry.contentRect;
					this.updateDimensionsFromRect(width, height);
				});
			});
			this.resizeObserver.observe(this.playerElement);
		}
		updateDimensionsFromRect(width, height) {
			const nextDimensions = calculateOverlayDimensionsFromRect(width, height);
			if (areOverlayDimensionsEqual(this.dimensions, nextDimensions)) return;
			this.dimensions = nextDimensions;
			this.notifyDimensionChangeCallbacks();
		}
		observeFullscreen() {
			this.fullscreenHandler = () => {
				this.clearFullscreenUpdateTimer();
				this.fullscreenUpdateTimer = setTimeout(() => {
					this.fullscreenUpdateTimer = null;
					this.updateDimensions();
				}, rendererLayout.fullscreenUpdateDelayMs);
			};
			document.addEventListener("fullscreenchange", this.fullscreenHandler);
		}
		disconnectResizeObserver() {
			if (!this.resizeObserver) return;
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
			if (this.resizeRafId !== null) {
				cancelAnimationFrame(this.resizeRafId);
				this.resizeRafId = null;
			}
			this.resizePending = false;
		}
		detachFullscreenHandler() {
			this.clearFullscreenUpdateTimer();
			if (!this.fullscreenHandler) return;
			document.removeEventListener("fullscreenchange", this.fullscreenHandler);
			this.fullscreenHandler = null;
		}
		async create(settings, signal) {
			this.disconnectResizeObserver();
			this.detachFullscreenHandler();
			if (this.container) {
				this.container.remove();
				this.container = null;
			}
			const strayOverlays = document.querySelectorAll(OVERLAY_SELECTOR);
			for (const el of strayOverlays) el.remove();
			this.playerElement = await this.findPlayerContainer(signal);
			throwIfAborted$1(signal);
			this.settings = settings;
			if (!this.playerElement) return false;
			this.container = this.createContainerElement();
			ensurePlayerPositioning(this.playerElement);
			this.playerElement.appendChild(this.container);
			this.observeResize();
			this.observeFullscreen();
			this.updateDimensions();
			this.liveRegion = document.createElement("div");
			this.liveRegion.setAttribute("role", "log");
			this.liveRegion.setAttribute("aria-live", "polite");
			this.liveRegion.setAttribute("aria-label", t("chat.messages"));
			this.liveRegion.className = "yt-live-chat-overlay-live-region";
			this.liveRegion.style.cssText = SCREEN_READER_CSS;
			this.container.appendChild(this.liveRegion);
			this.attachKeyboardHandler();
			log$27.info("app.overlay.created");
			return true;
		}
		updateSettings(settings) {
			this.settings = settings;
			this.updateDimensions();
		}
		updateLanguage() {
			if (this.container) {
				const lang = getActiveLanguage();
				this.container.lang = lang;
				this.container.dir = lang === "ar" ? "rtl" : "ltr";
				this.container.setAttribute("aria-label", `${t("app.name")} — ${getLocalizedName(lang)}`);
				this.announceLanguageChange(lang);
			}
		}
		announceLanguageChange(lang) {
			if (!this.liveRegion) return;
			const langName = getLocalizedName(lang);
			this.liveRegion.textContent = `${t("app.langChanged")}${langName}`;
		}
		updateLiveRegion(messages) {
			if (!this.liveRegion) return;
			if (this.liveRegionTimer !== null) clearTimeout(this.liveRegionTimer);
			this.liveRegionTimer = setTimeout(() => {
				this.liveRegionTimer = null;
				if (!this.liveRegion) return;
				const newMessages = [];
				for (const message of messages) if (!this.seenMessageIds.has(message.id)) {
					newMessages.push(message);
					this.seenMessageIds.add(message.id);
					if (this.seenMessageIds.size > Overlay.SEEN_SNIPPET_MAX) {
						let removed = 0;
						for (const id of this.seenMessageIds) {
							this.seenMessageIds.delete(id);
							if (++removed >= 50) break;
						}
					}
				}
				if (newMessages.length === 0) return;
				const frag = document.createDocumentFragment();
				for (const message of newMessages) {
					const p = document.createElement("p");
					p.dataset.messageId = message.id;
					p.textContent = this.formatAccessibleMessage(message);
					frag.appendChild(p);
				}
				const maxChildren = 30;
				while (this.liveRegion.children.length >= maxChildren) {
					const first = this.liveRegion.firstElementChild;
					if (first) first.remove();
					else break;
				}
				this.liveRegion.appendChild(frag);
			}, Overlay.LIVE_REGION_DEBOUNCE_MS);
		}
		formatAccessibleMessage(message) {
			const parts = [];
			if (message.kind === "superchat") {
				parts.push(t("chat.superChat"));
				if (message.superChatAmount) parts.push(message.superChatAmount);
			} else if (message.kind === "membership") {
				parts.push(t("chat.membership"));
				if (message.membershipHeader) parts.push(message.membershipHeader);
			}
			if (message.author) parts.push(message.author);
			if (message.text) parts.push(message.text);
			return parts.join(" — ");
		}
		getDimensions() {
			return this.dimensions;
		}
		toggleUserPause() {
			this.isUserPaused = !this.isUserPaused;
			for (const cb of this.userPauseCallbacks) try {
				cb(this.isUserPaused);
			} catch {}
			this.showPauseIndicator(this.isUserPaused);
			return this.isUserPaused;
		}
		onUserPauseChanged(callback) {
			this.userPauseCallbacks.add(callback);
			return () => {
				this.userPauseCallbacks.delete(callback);
			};
		}
		showPauseIndicator(show) {
			if (!this.container) return;
			if (show) {
				if (!this.pauseIndicatorEl) {
					const el = document.createElement("div");
					el.textContent = t("app.paused");
					el.style.cssText = "position:absolute;top:8px;right:8px;z-index:100;background:rgba(0,0,0,0.7);color:#fff;font:14px/1.4 sans-serif;padding:4px 10px;border-radius:4px;pointer-events:none";
					this.container.appendChild(el);
					this.pauseIndicatorEl = el;
				}
				this.pauseIndicatorEl.style.display = "block";
			} else if (this.pauseIndicatorEl) this.pauseIndicatorEl.style.display = "none";
		}
		attachKeyboardHandler() {
			this.keyboardHandler = (e) => {
				const tag = e.target?.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
				if (e.target?.isContentEditable) return;
				if (e.code === "Space" && e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					e.stopPropagation();
					this.toggleUserPause();
				}
			};
			document.addEventListener("keydown", this.keyboardHandler);
		}
		onDimensionsChanged(callback) {
			this.dimensionChangeCallbacks.add(callback);
			return () => {
				this.dimensionChangeCallbacks.delete(callback);
			};
		}
		getContainer() {
			return this.container;
		}
		notifyDimensionChangeCallbacks() {
			for (const callback of this.dimensionChangeCallbacks) try {
				callback(this.dimensions);
			} catch (error) {
				log$27.warn("app.overlay.callback-error", { error: String(error) });
			}
		}
		destroy() {
			this.disconnectResizeObserver();
			this.detachFullscreenHandler();
			if (this.container) this.container.remove();
			this.container = null;
			this.playerElement = null;
			this.dimensions = null;
			this.settings = null;
			this.dimensionChangeCallbacks.clear();
			this.liveRegion = null;
			if (this.liveRegionTimer !== null) {
				clearTimeout(this.liveRegionTimer);
				this.liveRegionTimer = null;
			}
			this.seenMessageIds.clear();
			if (this.keyboardHandler) {
				document.removeEventListener("keydown", this.keyboardHandler);
				this.keyboardHandler = null;
			}
			if (this.pauseIndicatorEl) {
				this.pauseIndicatorEl.remove();
				this.pauseIndicatorEl = null;
			}
			log$27.debug("app.overlay.destroyed");
		}
	};
	var LONG_IDLE_RESTART_MS = 6e4;
	var ABSOLUTE_MAX_IDLE_RESTART_MS = 18e5;
	var DIMENSIONS_NULL_GRACE_MS = 5e3;
	var RESTART_BACKOFF_DELAYS_MS = [
		5e3,
		15e3,
		3e4,
		6e4
	];
	var MAX_WATCHDOG_RESTARTS = RESTART_BACKOFF_DELAYS_MS.length;
	var RESTART_WINDOW_MS = 3e5;
	function classifyRuntimeHealthFailure(input) {
		const { idleDurationMs, renderable, chat, runtimeActive, videoPaused, chatInBackoff, dimensionsNullSince, now } = input;
		let reason = null;
		if (idleDurationMs >= ABSOLUTE_MAX_IDLE_RESTART_MS) reason = "very-long-idle";
		else if (!videoPaused && !chatInBackoff) {
			if (!renderable) reason = "overlay-not-renderable";
			else if (idleDurationMs >= LONG_IDLE_RESTART_MS) reason = "chat-source-stale";
			else if (runtimeActive && chat && (!chat.observerAlive || !chat.recentlyActive)) reason = chat.observerAlive ? "chat-source-stale" : "chat-source-stopped";
		}
		if (reason === "overlay-not-renderable" && dimensionsNullSince !== null && now - dimensionsNullSince < DIMENSIONS_NULL_GRACE_MS) return null;
		return reason;
	}
	function getWatchdogRestartDelay(attempt) {
		if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_WATCHDOG_RESTARTS) return null;
		return RESTART_BACKOFF_DELAYS_MS[Math.min(attempt - 1, RESTART_BACKOFF_DELAYS_MS.length - 1)];
	}
	var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
	var asRecord = (value) => isRecord(value) ? value : null;
	var getString = (value) => typeof value === "string" && value.length > 0 ? value : void 0;
	function getNumber(value) {
		const n = typeof value === "string" ? Number(value) : value;
		return typeof n === "number" && Number.isFinite(n) ? n : void 0;
	}
	function getNestedRecord(root, path) {
		let current = root;
		for (const key of path) {
			if (!isRecord(current)) return null;
			current = current[key];
		}
		return isRecord(current) ? current : null;
	}
	var MAX_PROCESSED = 3e3;
	var findFirstNestedByKey = (root, key, extract) => {
		const stack = [root];
		let processed = 0;
		while (stack.length > 0) {
			if (++processed > MAX_PROCESSED) break;
			const current = stack.pop();
			if (!isRecord(current)) continue;
			const candidate = current[key];
			const result = extract(candidate);
			if (result !== null) return result;
			const entries = Object.entries(current);
			const pushValue = (value) => {
				if (Array.isArray(value)) for (let index = value.length - 1; index >= 0; index--) stack.push(value[index]);
				else stack.push(value);
			};
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				if (entry?.[0] !== "contents") pushValue(entry?.[1]);
			}
			const contents = current.contents;
			if (contents !== void 0) pushValue(contents);
		}
		return null;
	};
	function findFirstNestedRecordByKey(root, key, predicate) {
		return findFirstNestedByKey(root, key, (v) => {
			if (!isRecord(v)) return null;
			if (predicate && !predicate(v)) return null;
			return v;
		});
	}
	var findFirstNestedStringByKey = (root, key) => findFirstNestedByKey(root, key, (v) => getString(v) ?? null) ?? void 0;
	var toContinuationData = (value) => {
		if (!isRecord(value)) return null;
		const continuation = getString(value.continuation);
		if (!continuation) return null;
		const result = { continuation };
		const clickTrackingParams = getString(value.clickTrackingParams);
		if (clickTrackingParams) result.clickTrackingParams = clickTrackingParams;
		const timeoutMs = getNumber(value.timeoutMs);
		if (timeoutMs !== void 0) result.timeoutMs = timeoutMs;
		return result;
	};
	var pickContinuation = (continuations, keys) => {
		if (!Array.isArray(continuations)) return null;
		for (const item of continuations) {
			if (!isRecord(item)) continue;
			for (const key of keys) {
				const continuation = toContinuationData(item[key]);
				if (continuation) return continuation;
			}
		}
		return null;
	};
	var extractInitialChatContinuation = (renderer) => pickContinuation(renderer.continuations, [
		"reloadContinuationData",
		"invalidationContinuationData",
		"timedContinuationData",
		"liveChatReplayContinuationData",
		"playerSeekContinuationData"
	]);
	var extractNextLiveContinuation = (continuations) => pickContinuation(continuations, [
		"invalidationContinuationData",
		"timedContinuationData",
		"reloadContinuationData"
	]);
	var extractReplayContinuation = (continuations) => pickContinuation(continuations, ["liveChatReplayContinuationData"]);
	var extractPlayerSeekContinuation = (continuations) => pickContinuation(continuations, ["playerSeekContinuationData"]);
	var log$26 = createLogger("Youtubei");
	var YoutubeInnertubeRequestError = class extends Error {
		status;
		constructor(message, status) {
			super(message);
			this.status = status;
			this.name = "YoutubeInnertubeRequestError";
		}
	};
	var ENDPOINT_RETRY_MAX_ATTEMPTS = 4;
	var ENDPOINT_RETRY_BASE_DELAY_MS = 1e3;
	var isRetryableError = (error) => {
		if (error instanceof DOMException && error.name === "AbortError") return false;
		if (error instanceof YoutubeInnertubeRequestError) {
			const s = error.status;
			return s === 429 || s === 503 || s === 504;
		}
		return error instanceof TypeError;
	};
	function getVideoIdFromUrl(href) {
		try {
			const url = new URL(href, location.origin);
			if (isYouTubeWatch(url.href)) {
				const videoId = url.searchParams.get("v");
				return videoId && videoId.trim().length > 0 ? videoId : null;
			}
			if (isYouTubeLive(url.href)) {
				const [, videoId] = url.pathname.split("/").filter((s) => s !== "");
				return videoId && videoId.trim().length > 0 ? videoId : null;
			}
		} catch {
			return null;
		}
		return null;
	}
	var buildWatchUrl = (videoId) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
	var readYtcfg = () => {
		const ytcfg = window.ytcfg;
		if (!isRecord(ytcfg)) return null;
		const data = isRecord(ytcfg.data_) ? ytcfg.data_ : ytcfg;
		return isRecord(data) ? data : null;
	};
	var tryGetInitialDataFromWindow = () => {
		if (isRecord(window.ytInitialData)) return window.ytInitialData;
		return null;
	};
	var fetchWatchHtml = async (videoId, signal) => {
		const response = await fetch(buildWatchUrl(videoId), {
			credentials: "include",
			cache: "no-store",
			mode: "same-origin",
			referrerPolicy: "origin-when-cross-origin",
			headers: { accept: "text/html,application/json" },
			signal: signal ?? null
		});
		if (!response.ok) throw new YoutubeInnertubeRequestError(`Failed to load watch page HTML (${response.status} ${response.statusText})`, response.status);
		return response.text();
	};
	var extractJsonObjectFromHtml = (html, markers) => {
		for (const marker of markers) {
			const markerIndex = html.indexOf(marker);
			if (markerIndex === -1) continue;
			const searchStart = markerIndex + marker.length - 1;
			const objectStart = html.indexOf("{", searchStart);
			if (objectStart === -1) continue;
			let braceDepth = 0;
			let inString = false;
			let stringDelimiter = "";
			let escapeNext = false;
			for (let index = objectStart; index < html.length; index++) {
				const current = html[index];
				if (!current) continue;
				if (escapeNext) {
					escapeNext = false;
					continue;
				}
				if (current === "\\") {
					escapeNext = true;
					continue;
				}
				if (current === "\"" || current === "'") {
					if (!inString) {
						inString = true;
						stringDelimiter = current;
					} else if (current === stringDelimiter) {
						inString = false;
						stringDelimiter = "";
					}
					continue;
				}
				if (inString) continue;
				if (current === "{") {
					braceDepth += 1;
					continue;
				}
				if (current !== "}") continue;
				braceDepth -= 1;
				if (braceDepth !== 0) continue;
				const candidate = html.slice(objectStart, index + 1);
				try {
					const parsed = JSON.parse(candidate);
					return isRecord(parsed) ? parsed : null;
				} catch {
					break;
				}
			}
		}
		return null;
	};
	var extractInitialDataFromHtml = (html) => extractJsonObjectFromHtml(html, [
		"var ytInitialData = ",
		"window[\"ytInitialData\"] = ",
		"window.ytInitialData = "
	]);
	var extractYtcfgFromHtml = (html) => extractJsonObjectFromHtml(html, ["ytcfg.set({", "window.ytcfg.set({"]);
	var extractVideoIdFromInitialData = (initialData) => {
		const watchEndpoint = getNestedRecord(initialData, ["currentVideoEndpoint", "watchEndpoint"]);
		if (!watchEndpoint) return null;
		return getString(watchEndpoint.videoId);
	};
	function findLiveChatRenderer(initialData) {
		const directRenderer = getNestedRecord(initialData, [
			"contents",
			"twoColumnWatchNextResults",
			"conversationBar",
			"liveChatRenderer"
		]);
		if (directRenderer) return directRenderer;
		const withContinuations = findFirstNestedRecordByKey(initialData, "liveChatRenderer", (value) => isRecord(value) && Array.isArray(value.continuations));
		if (withContinuations) return withContinuations;
		const withActions = findFirstNestedRecordByKey(initialData, "liveChatRenderer", (value) => isRecord(value) && Array.isArray(value.actions));
		if (withActions) return withActions;
		log$26.debug("Chat renderer not found — page structure:", {
			hasTwoColumn: !!getNestedRecord(initialData, ["contents", "twoColumnWatchNextResults"]),
			hasConversationBar: !!getNestedRecord(initialData, [
				"contents",
				"twoColumnWatchNextResults",
				"conversationBar"
			]),
			topLevelKeys: Object.keys(initialData).slice(0, 8)
		});
		return null;
	}
	var resolveApiKey = (ytcfg) => getString(ytcfg.INNERTUBE_API_KEY) ?? findFirstNestedStringByKey(ytcfg, "innertubeApiKey");
	var resolveClientContext = (ytcfg) => {
		const client = { ...getNestedRecord(ytcfg, ["INNERTUBE_CONTEXT", "client"]) ?? {} };
		if (!getString(client.clientName)) client.clientName = "WEB";
		if (!getString(client.clientVersion)) {
			const version = getString(ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION);
			if (version) client.clientVersion = version;
		}
		if (!getString(client.hl)) client.hl = document.documentElement.lang || navigator.language || "en";
		if (!getString(client.timeZone)) client.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (getNumber(client.utcOffsetMinutes) === void 0) client.utcOffsetMinutes = -new Date().getTimezoneOffset();
		return client;
	};
	async function bootstrapChatSession(signal) {
		const videoId = getVideoIdFromUrl(location.href);
		if (!videoId) return {
			status: "unavailable",
			reason: "Current URL is not a supported YouTube watch page"
		};
		let cachedHtml = null;
		const getHtml = async () => {
			if (cachedHtml === null) cachedHtml = await fetchWatchHtml(videoId, signal);
			return cachedHtml;
		};
		try {
			let ytcfg = readYtcfg();
			if (!ytcfg) ytcfg = extractYtcfgFromHtml(await getHtml());
			if (!ytcfg) return {
				status: "retryable",
				reason: "Could not resolve YouTube page configuration"
			};
			let initialData = tryGetInitialDataFromWindow();
			if (initialData) {
				const windowVideoId = extractVideoIdFromInitialData(initialData);
				if (!windowVideoId || windowVideoId !== videoId) initialData = null;
			}
			if (!initialData) initialData = extractInitialDataFromHtml(await getHtml());
			if (!initialData) return {
				status: "retryable",
				reason: "Could not extract ytInitialData from watch page"
			};
			const dataVideoId = extractVideoIdFromInitialData(initialData);
			if (dataVideoId && dataVideoId !== videoId) return {
				status: "retryable",
				reason: `initialData videoId (${dataVideoId}) does not match current URL videoId (${videoId})`
			};
			const liveChatRenderer = findLiveChatRenderer(initialData);
			if (!liveChatRenderer) {
				const playabilityStatus = getNestedRecord(initialData, ["playabilityStatus"]);
				if ((playabilityStatus ? getString(playabilityStatus.status) : void 0) === "LIVE_STREAM_OFFLINE") return {
					status: "waiting",
					reason: "Stream not yet started — live chat renderer unavailable"
				};
				return {
					status: "unavailable",
					reason: "Watch page does not expose a live chat renderer for this video"
				};
			}
			const initialContinuation = extractInitialChatContinuation(liveChatRenderer);
			if (!initialContinuation) return {
				status: "unavailable",
				reason: "Live chat renderer does not expose an initial continuation token"
			};
			const clientContext = resolveClientContext(ytcfg);
			if (!clientContext) return {
				status: "retryable",
				reason: "Could not build Innertube client context"
			};
			const apiKey = resolveApiKey(ytcfg);
			const clientVersionHeader = getString(ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION) ?? getString(clientContext.clientVersion);
			const data = {
				videoId,
				isReplay: liveChatRenderer.isReplay === true,
				...apiKey ? { apiKey } : {},
				clientContext,
				clientNameHeader: getString(ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME) ?? "1",
				...clientVersionHeader ? { clientVersionHeader } : {},
				ytcfg,
				initialContinuation
			};
			log$26.debug("Bootstrap ready", {
				videoId,
				isReplay: data.isReplay
			});
			return {
				status: "ready",
				data
			};
		} catch (error) {
			if (isAbortError(error)) throw error;
			return {
				status: "retryable",
				reason: error instanceof Error ? error.message : "Failed to bootstrap chat session"
			};
		}
	}
	var createInnertubeHeaders = (data) => {
		const headers = {
			accept: "*/*",
			"accept-language": document.documentElement.lang || navigator.language || "en",
			"cache-control": "no-store",
			"content-type": "application/json",
			pragma: "no-cache",
			"x-youtube-client-name": data.clientNameHeader
		};
		if (data.clientVersionHeader) headers["x-youtube-client-version"] = data.clientVersionHeader;
		const visitorData = getString(data.ytcfg.VISITOR_DATA) ?? getString(data.clientContext.visitorData) ?? findFirstNestedStringByKey(data.ytcfg, "visitorData");
		if (visitorData) headers["x-goog-visitor-id"] = visitorData;
		return headers;
	};
	var buildEndpointUrl = (endpoint, apiKey) => {
		const url = new URL(`/youtubei/v1/live_chat/${endpoint}`, location.origin);
		url.searchParams.set("prettyPrint", "false");
		if (apiKey) url.searchParams.set("key", apiKey);
		return url.toString();
	};
	var buildInnertubeBody = (data, continuation, currentPlayerState) => {
		const body = {
			context: { client: data.clientContext },
			continuation: continuation.continuation
		};
		if (continuation.clickTrackingParams) body.clickTracking = { clickTrackingParams: continuation.clickTrackingParams };
		if (currentPlayerState) body.currentPlayerState = currentPlayerState;
		return body;
	};
	var fetchChatEndpoint = async (endpoint, data, continuation, signal, playerOffsetMs) => {
		let lastError;
		for (let attempt = 0; attempt < ENDPOINT_RETRY_MAX_ATTEMPTS; attempt++) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			try {
				const response = await fetch(buildEndpointUrl(endpoint, data.apiKey), {
					method: "POST",
					credentials: "include",
					cache: "no-store",
					mode: "same-origin",
					referrerPolicy: "origin-when-cross-origin",
					headers: createInnertubeHeaders(data),
					body: JSON.stringify(buildInnertubeBody(data, continuation, playerOffsetMs === void 0 ? void 0 : { playerOffsetMs: String(playerOffsetMs) })),
					signal: signal ?? null
				});
				if (!response.ok) throw new YoutubeInnertubeRequestError(`Innertube ${endpoint} request failed (${response.status} ${response.statusText})`, response.status);
				return response.json();
			} catch (error) {
				if (isAbortError(error)) throw error;
				lastError = error;
				if (attempt === 3 || !isRetryableError(error)) {
					log$26.warn(`Innertube ${endpoint} request failed (attempt ${attempt + 1}/${ENDPOINT_RETRY_MAX_ATTEMPTS}):`, error);
					throw error;
				}
				const delayMs = ENDPOINT_RETRY_BASE_DELAY_MS * 2 ** attempt;
				log$26.info(`Innertube ${endpoint} request failed (attempt ${attempt + 1}/${ENDPOINT_RETRY_MAX_ATTEMPTS}), retrying in ${delayMs}ms:`, lastError);
				try {
					await sleep(delayMs, signal);
				} catch {
					throw new DOMException("Aborted", "AbortError");
				}
			}
		}
		throw lastError;
	};
	var fetchLiveChat = async (data, continuation, signal) => fetchChatEndpoint("get_live_chat", data, continuation, signal);
	var fetchReplayChat = async (data, continuation, playerOffsetMs, signal) => fetchChatEndpoint("get_live_chat_replay", data, continuation, signal, playerOffsetMs);
	function getLiveChatPayload(response) {
		const liveChatContinuation = getNestedRecord(response, ["continuationContents", "liveChatContinuation"]);
		if (!liveChatContinuation) return null;
		return {
			actions: Array.isArray(liveChatContinuation.actions) ? liveChatContinuation.actions : [],
			continuations: Array.isArray(liveChatContinuation.continuations) ? liveChatContinuation.continuations : []
		};
	}
	var log$25 = createLogger("Standby");
	var RECHECK_INTERVAL_MS = 5e3;
	var RETRY_DELAY_MS = 3e3;
	var RECHECK_MAX_MS = 6e4;
	var RECHECK_FACTOR = 2;
	var StandbyController = class {
		getAbortSignal;
		isDisposed;
		onStreamDetected;
		mode = false;
		pollTimer = null;
		pollDelay = RECHECK_INTERVAL_MS;
		retryTimer = null;
		paused = false;
		pollController = null;
		renderer = null;
		pollGeneration = 0;
		constructor(getAbortSignal, isDisposed, onStreamDetected) {
			this.getAbortSignal = getAbortSignal;
			this.isDisposed = isDisposed;
			this.onStreamDetected = onStreamDetected;
		}
		setRenderer(renderer) {
			this.renderer = renderer;
		}
		enter() {
			this.mode = true;
			this.paused = false;
			this.renderer?.setStandbyStatus(true);
			this.pollDelay = RECHECK_INTERVAL_MS;
			this.schedulePoll();
		}
		exit() {
			if (!this.mode) return;
			this.mode = false;
			this.paused = false;
			this.pollGeneration++;
			this.abortPoll();
			this.stopPolling();
			this.retryTimer = clearSafeTimeout(this.retryTimer);
			this.renderer?.setStandbyStatus(false);
		}
		isStandby() {
			return this.mode;
		}
		pause() {
			if (!this.mode || this.paused) return;
			this.paused = true;
			this.pollGeneration++;
			this.abortPoll();
			this.stopPolling();
			this.retryTimer = clearSafeTimeout(this.retryTimer);
		}
		resume() {
			if (!this.mode || !this.paused) return;
			this.paused = false;
			if (this.isDisposed()) return;
			this.poll();
		}
		destroy() {
			this.exit();
		}
		stopPolling() {
			this.pollTimer = clearSafeTimeout(this.pollTimer);
		}
		abortPoll() {
			this.pollController?.abort();
			this.pollController = null;
		}
		schedulePoll() {
			if (!this.mode || this.paused || this.isDisposed()) return;
			this.pollTimer = setTimeout(() => {
				this.pollTimer = null;
				this.poll();
			}, this.pollDelay);
		}
		async poll() {
			if (this.isDisposed() || !this.mode || this.paused) return;
			const gen = this.pollGeneration;
			const controller = new AbortController();
			this.pollController = controller;
			const sessionSignal = this.getAbortSignal();
			const signal = AbortSignal.any([sessionSignal, controller.signal]);
			try {
				const result = await bootstrapChatSession(signal);
				if (gen !== this.pollGeneration || this.paused || !this.mode || this.isDisposed()) return;
				if (result.status === "ready") {
					log$25.info("app.standby.stream-detected");
					this.stopPolling();
					this.onStreamDetected("standby-resolved");
					return;
				}
				this.pollDelay = Math.min(this.pollDelay * RECHECK_FACTOR, RECHECK_MAX_MS);
				if (result.status === "retryable") {
					this.scheduleRetry();
					return;
				}
				this.schedulePoll();
			} catch (error) {
				if (!isAbortError(error)) {
					log$25.warn("app.standby.poll-failed", { error: String(error) });
					this.scheduleRetry();
				}
			} finally {
				if (this.pollController === controller) this.pollController = null;
			}
		}
		scheduleRetry() {
			if (this.retryTimer !== null) return;
			if (!this.mode || this.paused || this.isDisposed()) return;
			this.retryTimer = setTimeout(() => {
				this.retryTimer = null;
				this.poll();
			}, RETRY_DELAY_MS);
		}
	};
	var log$24 = createLogger("VideoPauseController");
	var REBIND_DEBOUNCE_MS = 100;
	var VideoPauseController = class {
		videoPauseCleanup = null;
		rebindTimer = null;
		start(callbacks) {
			this.videoPauseCleanup?.();
			const handlePause = () => {
				if (callbacks.isDisposed()) return;
				log$24.debug("app.video.paused");
				callbacks.pauseable.setPaused(true);
			};
			const handlePlay = () => {
				if (callbacks.isDisposed()) return;
				log$24.debug("app.video.playing");
				callbacks.pauseable.setPaused(false);
			};
			const handleWaiting = () => {
				if (callbacks.isDisposed()) return;
				log$24.debug("app.video.buffering");
				callbacks.pauseable.setPaused(true);
			};
			const handleEnterPiP = () => {
				if (callbacks.isDisposed()) return;
				log$24.debug("app.video.pip-enter");
				callbacks.pauseable.setPaused(true);
			};
			const handleLeavePiP = () => {
				if (callbacks.isDisposed()) return;
				if (currentVideo && !currentVideo.paused) {
					log$24.debug("app.video.pip-leave");
					callbacks.pauseable.setPaused(false);
				} else log$24.debug("app.video.pip-leave-still-paused");
			};
			const attachListeners = (video) => {
				video.addEventListener("pause", handlePause);
				video.addEventListener("play", handlePlay);
				video.addEventListener("waiting", handleWaiting);
				video.addEventListener("playing", handlePlay);
				video.addEventListener("enterpictureinpicture", handleEnterPiP);
				video.addEventListener("leavepictureinpicture", handleLeavePiP);
				if (video.paused) handlePause();
				else handlePlay();
			};
			const detachListeners = (video) => {
				if (!video) return;
				video.removeEventListener("pause", handlePause);
				video.removeEventListener("play", handlePlay);
				video.removeEventListener("waiting", handleWaiting);
				video.removeEventListener("playing", handlePlay);
				video.removeEventListener("enterpictureinpicture", handleEnterPiP);
				video.removeEventListener("leavepictureinpicture", handleLeavePiP);
			};
			const scheduleRebind = () => {
				if (this.rebindTimer) return;
				this.rebindTimer = setTimeout(() => {
					this.rebindTimer = null;
					rebindVideo();
				}, REBIND_DEBOUNCE_MS);
			};
			const initial = findElementMatch(VIDEO_SELECTORS)?.element;
			let currentVideo = initial;
			if (initial) attachListeners(initial);
			else log$24.debug("app.video.no-element");
			const rebindVideo = () => {
				const nextVideo = findElementMatch(VIDEO_SELECTORS)?.element;
				if (nextVideo && nextVideo !== currentVideo) {
					detachListeners(currentVideo);
					currentVideo = nextVideo;
					attachListeners(currentVideo);
					log$24.debug("app.video.rebound-listeners");
				}
			};
			const playerContainer = findElementMatch(PLAYER_CONTAINER_SELECTORS)?.element ?? null;
			if (playerContainer) {
				if (this.videoPauseCleanup) {
					this.videoPauseCleanup();
					this.videoPauseCleanup = null;
				}
				const observer = new MutationObserver(() => scheduleRebind());
				observer.observe(playerContainer, {
					childList: true,
					subtree: true
				});
				this.videoPauseCleanup = () => {
					this.rebindTimer = clearSafeTimeout(this.rebindTimer);
					detachListeners(currentVideo);
					observer.disconnect();
					this.videoPauseCleanup = null;
				};
			} else this.videoPauseCleanup = () => {
				detachListeners(currentVideo);
				this.videoPauseCleanup = null;
			};
		}
		stop() {
			this.videoPauseCleanup?.();
		}
	};
	var log$23 = createLogger("DomChatWatcher");
	var CHAT_CONTAINER_SELECTORS = [
		"yt-live-chat-item-list-renderer #items",
		"#chat-messages yt-live-chat-item-list-renderer #items",
		"yt-live-chat-item-list-renderer"
	];
	var TEXT_MESSAGE_RENDERER_SELECTOR = "yt-live-chat-text-message-renderer";
	var AUTHOR_NAME_SELECTOR = "#author-name";
	var MESSAGE_SELECTOR = "#message";
	function installDomChatWatcher(onMessages) {
		let observer = null;
		let mutationBatchPending = false;
		let mutationRafId = null;
		let pendingMutations = [];
		let isPaused = false;
		const extractMessages = (addedNodes) => {
			const messages = [];
			const now = Date.now();
			for (let i = 0; i < addedNodes.length; i++) {
				const node = addedNodes[i];
				if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
				const el = node;
				const textRenderers = el.matches(TEXT_MESSAGE_RENDERER_SELECTOR) ? [el] : Array.from(el.querySelectorAll(TEXT_MESSAGE_RENDERER_SELECTOR));
				for (const textRenderer of textRenderers) {
					const authorEl = textRenderer.querySelector(AUTHOR_NAME_SELECTOR);
					const messageEl = textRenderer.querySelector(MESSAGE_SELECTOR);
					const author = authorEl?.textContent?.trim() ?? "";
					const text = messageEl?.textContent?.trim() ?? "";
					if (!text) continue;
					const rawId = textRenderer.id;
					const message = {
						...rawId ? { id: rawId } : {},
						text,
						content: [{
							type: "text",
							content: text
						}],
						kind: "text",
						timestamp: now,
						author,
						authorType: "normal"
					};
					messages.push(message);
				}
			}
			return messages;
		};
		const handleMutations = (mutations) => {
			const allMessages = [];
			for (const mutation of mutations) {
				if (mutation.type !== "childList") continue;
				if (mutation.addedNodes.length === 0) continue;
				const messages = extractMessages(mutation.addedNodes);
				allMessages.push(...messages);
			}
			if (allMessages.length > 0) {
				log$23.debug("chat.dom-watcher.captured", { count: allMessages.length });
				onMessages(allMessages);
			}
		};
		const onMutation = (mutations) => {
			if (isPaused) return;
			pendingMutations.push(mutations);
			if (!mutationBatchPending) {
				mutationBatchPending = true;
				mutationRafId = requestAnimationFrame(() => {
					mutationBatchPending = false;
					mutationRafId = null;
					for (const batch of pendingMutations) handleMutations(batch);
					pendingMutations.length = 0;
				});
			}
		};
		for (const selector of CHAT_CONTAINER_SELECTORS) {
			const container = document.querySelector(selector);
			if (!container) continue;
			observer = new MutationObserver(onMutation);
			observer.observe(container, {
				childList: true,
				subtree: true
			});
			const handleVisibility = () => {
				if (document.visibilityState !== "visible") {
					observer?.disconnect();
					isPaused = true;
					if (mutationRafId !== null) {
						cancelAnimationFrame(mutationRafId);
						mutationRafId = null;
					}
					mutationBatchPending = false;
					pendingMutations = [];
				} else {
					isPaused = false;
					observer?.disconnect();
					observer?.observe(container, {
						childList: true,
						subtree: true
					});
				}
			};
			document.addEventListener("visibilitychange", handleVisibility);
			log$23.info("chat.dom-watcher.installed", { selector });
			return () => {
				document.removeEventListener("visibilitychange", handleVisibility);
				if (mutationRafId !== null) {
					cancelAnimationFrame(mutationRafId);
					mutationRafId = null;
				}
				observer?.disconnect();
				observer = null;
				log$23.info("chat.dom-watcher.removed");
			};
		}
		log$23.info("No chat container found — DOM watcher not installed. YouTube chat may be in a cross-origin iframe (#chatframe) inaccessible from the content script. Falling back to fetch interceptor.");
		return null;
	}
	function parseAnyColor(colorString) {
		if (colorString.startsWith("#")) {
			const hex = colorString.slice(1);
			if (hex.length < 3) return null;
			if (hex.length === 3) {
				const r = parseInt(hex[0] + hex[0], 16);
				const g = parseInt(hex[1] + hex[1], 16);
				const b = parseInt(hex[2] + hex[2], 16);
				return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? {
					r,
					g,
					b
				} : null;
			}
			if (hex.length === 4) {
				const r = parseInt(hex[0] + hex[0], 16);
				const g = parseInt(hex[1] + hex[1], 16);
				const b = parseInt(hex[2] + hex[2], 16);
				return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? {
					r,
					g,
					b
				} : null;
			}
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? {
				r,
				g,
				b
			} : null;
		}
		const match = colorString.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		if (!match) return null;
		return {
			r: Number(match[1]),
			g: Number(match[2]),
			b: Number(match[3])
		};
	}
	function relativeLuminance(rgb) {
		const [rs, gs, bs] = [
			rgb.r / 255,
			rgb.g / 255,
			rgb.b / 255
		];
		const r = rs <= .03928 ? rs / 12.92 : ((rs + .055) / 1.055) ** 2.4;
		const g = gs <= .03928 ? gs / 12.92 : ((gs + .055) / 1.055) ** 2.4;
		const b = bs <= .03928 ? bs / 12.92 : ((bs + .055) / 1.055) ** 2.4;
		return .2126 * r + .7152 * g + .0722 * b;
	}
	var OUTLINE_COLOR_CACHE_MAX = 64;
	var outlineColorCache = new Map();
	function computeOutlineColor(textColor, opacity) {
		const cacheKey = `${textColor}|${Math.round(opacity * 100) / 100}`;
		const cached = outlineColorCache.get(cacheKey);
		if (cached !== void 0) return cached;
		const rgb = parseAnyColor(textColor);
		let result;
		if (!rgb) result = `rgba(0, 0, 0, ${opacity})`;
		else result = relativeLuminance(rgb) > .5 ? `rgba(0, 0, 0, ${opacity})` : `rgba(255, 255, 255, ${opacity})`;
		if (outlineColorCache.size >= OUTLINE_COLOR_CACHE_MAX) {
			const oldestKey = outlineColorCache.keys().next().value;
			if (oldestKey !== void 0) outlineColorCache.delete(oldestKey);
		}
		outlineColorCache.set(cacheKey, result);
		return result;
	}
	function toRgba(color, alpha) {
		const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)/);
		if (!match) return color;
		return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
	}
	function computeReadableTextColor(backgroundColor) {
		const rgb = parseAnyColor(backgroundColor);
		if (!rgb) return "#ffffff";
		return relativeLuminance(rgb) > .5 ? "#000000" : "#ffffff";
	}
	function desaturateColor(color, factor) {
		let r, g, b;
		if (color.startsWith("#")) {
			const hex = color.slice(1);
			if (hex.length === 3) {
				r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
				g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
				b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
			} else {
				r = parseInt(hex.slice(0, 2), 16);
				g = parseInt(hex.slice(2, 4), 16);
				b = parseInt(hex.slice(4, 6), 16);
			}
		} else {
			const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
			if (!match) return color;
			const [, rStr = "0", gStr = "0", bStr = "0"] = match;
			r = parseInt(rStr, 10);
			g = parseInt(gStr, 10);
			b = parseInt(bStr, 10);
		}
		const gray = .299 * r + .587 * g + .114 * b;
		return `rgb(${Math.round(r + (gray - r) * factor)},${Math.round(g + (gray - g) * factor)},${Math.round(b + (gray - b) * factor)})`;
	}
	function resolveSuperChatRgb(superChat, colors) {
		const sourceColor = superChat.headerBackgroundColor || superChat.backgroundColor;
		return (sourceColor ? parseAnyColor(sourceColor) : null) ?? colors[superChat.tier] ?? colors.blue;
	}
	var AUTHOR_TYPE_PRIORITY = {
		normal: 0,
		verified: 1,
		member: 2,
		moderator: 3,
		owner: 4
	};
	var EMOJI_TEXT_PATTERN = /\p{Emoji}/u;
	var EMOJI_ALIAS_PATTERN = /^:[^:\s][^:]*:$/u;
	function stripControlCharacters(text) {
		return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
	}
	function normalizeInlineText(text) {
		return stripControlCharacters(text).replace(/[\u2026]+$/g, "").replace(/\s+/g, " ").trim();
	}
	var FULLY_OPAQUE_THRESHOLD = .999;
	var NEAR_WHITE_THRESHOLD = 240;
	var NEAR_BLACK_THRESHOLD = 15;
	function truncateText(text) {
		const normalized = normalizeInlineText(text);
		const codePoints = Array.from(normalized);
		if (codePoints.length > 80) return `${codePoints.slice(0, 79).join("")}\u2026`;
		return normalized;
	}
	function truncateForKind(text, kind) {
		if (kind === "text") return truncateText(text);
		return normalizeInlineText(text);
	}
	function hasEmojiContent(segments) {
		return segments.some((segment) => segment.type === "emoji" || segment.type === "text" && EMOJI_TEXT_PATTERN.test(segment.content));
	}
	function getTranslatableText(message) {
		let result = "";
		for (const seg of message.content) if (seg.type === "text" && seg.content.length > 0) result += seg.content;
		return result.trim();
	}
	function colorIntToCss(value) {
		const intValue = parseColorInt(value);
		if (intValue === void 0) return void 0;
		const argb = intValue >>> 0;
		const alpha = (argb >>> 24 & 255) / 255;
		const red = argb >>> 16 & 255;
		const green = argb >>> 8 & 255;
		const blue = argb & 255;
		if (alpha >= FULLY_OPAQUE_THRESHOLD) return `rgb(${red}, ${green}, ${blue})`;
		return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`;
	}
	function parseColorInt(value) {
		if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
		if (typeof value === "string") {
			const n = Number(value);
			return Number.isFinite(n) ? n : void 0;
		}
	}
	function determineSuperChatTier(backgroundColor) {
		const rgb = backgroundColor ? parseAnyColor(backgroundColor) : null;
		if (!rgb) return "blue";
		let bestTier = "blue";
		let bestSquaredDistance = Number.POSITIVE_INFINITY;
		for (const tier of SUPERCHAT_TIER_KEYS) {
			const tierColor = colors.superChat[tier];
			const dr = rgb.r - tierColor.r;
			const dg = rgb.g - tierColor.g;
			const db = rgb.b - tierColor.b;
			const squaredDistance = dr * dr + dg * dg + db * db;
			if (squaredDistance < bestSquaredDistance) {
				bestSquaredDistance = squaredDistance;
				bestTier = tier;
			}
		}
		return bestTier;
	}
	function extractUserColor(renderer) {
		const colorInt = parseColorInt(renderer.authorNameTextColor);
		if (colorInt === void 0) return void 0;
		const cssColor = colorIntToCss(colorInt);
		if (!cssColor) return void 0;
		const rgbaMatch = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
		if (rgbaMatch) {
			const r = parseInt(rgbaMatch[1] ?? "0", 10);
			const g = parseInt(rgbaMatch[2] ?? "0", 10);
			const b = parseInt(rgbaMatch[3] ?? "0", 10);
			if (r > NEAR_WHITE_THRESHOLD && g > NEAR_WHITE_THRESHOLD && b > NEAR_WHITE_THRESHOLD) return void 0;
			if (r < NEAR_BLACK_THRESHOLD && g < NEAR_BLACK_THRESHOLD && b < NEAR_BLACK_THRESHOLD) return void 0;
		}
		return cssColor;
	}
	function extractAccessibilityLabel(value) {
		const record = asRecord(value);
		if (!record) return;
		return getString(asRecord(asRecord(record.accessibility)?.accessibilityData)?.label);
	}
	var ALLOWED_IMAGE_HOST_SUFFIXES = [
		"ggpht.com",
		"googleusercontent.com",
		"gstatic.com",
		"ytimg.com"
	];
	function isAllowedImageHostname(hostname) {
		const normalized = hostname.toLowerCase();
		return ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
	}
	function isAllowedImageUrl(url) {
		try {
			const parsed = new URL(url);
			return parsed.protocol === "https:" && isAllowedImageHostname(parsed.hostname);
		} catch {
			return false;
		}
	}
	function normalizeYouTubeImageUrl(url) {
		const trimmed = url.trim();
		if (trimmed.length === 0) return null;
		try {
			const normalizedUrl = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
			const parsed = new URL(normalizedUrl);
			if (!isAllowedImageHostname(parsed.hostname)) return null;
			if (parsed.protocol === "http:") parsed.protocol = "https:";
			return parsed.protocol === "https:" ? parsed.toString() : null;
		} catch {
			return null;
		}
	}
	function extractBestThumbnail(value) {
		if (!isRecord(value)) return null;
		const thumbnails = Array.isArray(value.thumbnails) ? value.thumbnails : Array.isArray(value.sources) ? value.sources : [];
		const candidates = [];
		const seenUrls = new Set();
		for (const candidate of thumbnails) {
			if (!isRecord(candidate)) continue;
			const url = getString(candidate.url);
			const normalizedUrl = url ? normalizeYouTubeImageUrl(url) : null;
			if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
			seenUrls.add(normalizedUrl);
			const width = getNumber(candidate.width);
			const nextThumbnail = { url: normalizedUrl };
			if (width !== void 0) nextThumbnail.width = width;
			const height = getNumber(candidate.height);
			if (height !== void 0) nextThumbnail.height = height;
			candidates.push(nextThumbnail);
		}
		if (candidates.length === 0) return null;
		candidates.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
		const best = candidates[0];
		if (!best) return null;
		if (candidates.length > 1) {
			const fallback = candidates[1];
			if (fallback) best.candidateUrl = fallback.url;
		}
		return best;
	}
	function createImageAsset(value, alt, fallbackText) {
		const thumbnail = extractBestThumbnail(value);
		if (!thumbnail) return null;
		const asset = {
			url: thumbnail.url,
			alt
		};
		if (thumbnail.candidateUrl) asset.candidateUrl = thumbnail.candidateUrl;
		if (fallbackText && fallbackText.length > 0) asset.fallbackText = fallbackText;
		if (thumbnail.width !== void 0) asset.width = thumbnail.width;
		if (thumbnail.height !== void 0) asset.height = thumbnail.height;
		return asset;
	}
	function getEmojiShortcuts(emojiData) {
		return Array.isArray(emojiData.shortcuts) ? emojiData.shortcuts.filter((shortcut) => typeof shortcut === "string") : [];
	}
	function getEmojiAltText(emojiData) {
		return getEmojiShortcuts(emojiData)[0] ?? extractAccessibilityLabel(emojiData.image) ?? extractAccessibilityLabel(emojiData) ?? getString(emojiData.emojiId) ?? "";
	}
	function getEmojiVisibleFallbackText(emojiData) {
		const shortcuts = getEmojiShortcuts(emojiData);
		const aliasPattern = EMOJI_ALIAS_PATTERN;
		const nonAliasShortcut = shortcuts.find((s) => !aliasPattern.test(s));
		if (nonAliasShortcut) return normalizeInlineText(nonAliasShortcut);
		const label = extractAccessibilityLabel(emojiData.image) ?? extractAccessibilityLabel(emojiData);
		if (label && !aliasPattern.test(label)) return normalizeInlineText(label);
		return "";
	}
	function parseEmoji(emojiData) {
		const emojiAsset = createImageAsset(emojiData.image, getEmojiAltText(emojiData), getEmojiVisibleFallbackText(emojiData));
		if (!emojiAsset) return null;
		return emojiAsset;
	}
	var log$22 = createLogger("ChatMessageParser");
	var EMPTY_MESSAGE_BODY = Object.freeze({
		text: "",
		content: [],
		visibleLength: 0
	});
	function extractChatEvents(actions, getSettings) {
		const settings = getSettings();
		const events = [];
		for (const action of actions) {
			if (!isRecord(action)) continue;
			const replayAction = asRecord(action.replayChatItemAction);
			if (replayAction) {
				const offsetMs = getNumber(replayAction.videoOffsetTimeMsec);
				const nestedActions = Array.isArray(replayAction.actions) ? replayAction.actions : [];
				for (const nestedAction of nestedActions) {
					const event = parseChatEventFromAction(nestedAction, offsetMs, settings);
					if (event) events.push(event);
				}
				continue;
			}
			const event = parseChatEventFromAction(action, void 0, settings);
			if (event) events.push(event);
		}
		return events;
	}
	function parseChatEventFromAction(action, offsetMs, settings) {
		if (!isRecord(action)) return null;
		const actionTimestampUsec = getNumber(action.timestampUsec);
		const timestampOverride = actionTimestampUsec !== void 0 ? Math.round(actionTimestampUsec / 1e3) : void 0;
		const extraction = extractActionItem(action);
		if (!extraction) return null;
		const supportedRenderer = extractSupportedRenderer(extraction.item);
		if (!supportedRenderer) return null;
		const message = parseRendererMessage(supportedRenderer.renderer, supportedRenderer.kind, settings, timestampOverride);
		if (!message) return null;
		message.actionType = extraction.actionType;
		if (offsetMs !== void 0) message.videoOffsetMs = offsetMs;
		return { message };
	}
	function parseRendererMessage(renderer, kind, settings, timestampOverride) {
		const author = extractDisplayText(renderer.authorName) ?? "";
		const authorType = extractAuthorType(renderer.authorBadges);
		const userColor = extractUserColor(renderer);
		const parsedBody = extractRendererBody(renderer, kind, authorType, settings);
		if (!parsedBody) return null;
		const message = {
			text: parsedBody.text,
			content: parsedBody.content,
			kind,
			timestamp: timestampOverride ?? Date.now(),
			author,
			authorType
		};
		const id = getString(renderer.id);
		if (id) message.id = id;
		if (userColor) message.userColor = userColor;
		const authorPhotoUrl = extractBestThumbnail(renderer.authorPhoto)?.url;
		if (authorPhotoUrl) message.authorPhotoUrl = authorPhotoUrl;
		if (kind === "superchat") {
			const superChatInfo = parseSuperChatInfo(renderer);
			if (!superChatInfo) {
				log$22.warn("chat.parser.super-chat-skip", { reason: "no-purchase-info" });
				return null;
			}
			message.superChat = superChatInfo;
		}
		if (kind === "membership") {
			const headerText = parseMembershipHeaderText(renderer);
			if (headerText) message.membershipHeader = headerText;
		}
		return message;
	}
	function extractRendererBody(renderer, kind, authorType, settings) {
		const parsedBody = kind === "membership" ? parseMembershipBody(renderer) : parseMessageContent(renderer.message, kind);
		if (kind === "text" && !isSubstantialMessage(parsedBody, authorType, settings)) return null;
		return parsedBody;
	}
	function isSubstantialMessage(body, authorType, settings) {
		if (settings.allowShortTextMessages) return true;
		if (authorType === "moderator" || authorType === "owner" || authorType === "member") return true;
		if (hasEmojiContent(body.content) || EMOJI_TEXT_PATTERN.test(body.text)) return true;
		const minLength = Math.max(1, settings.minTextLength);
		return body.visibleLength >= minLength;
	}
	function parseSuperChatInfo(renderer) {
		const amount = extractDisplayText(renderer.purchaseAmountText);
		if (!amount) return null;
		const backgroundColor = colorIntToCss(renderer.bodyBackgroundColor ?? renderer.backgroundColor);
		const headerBackgroundColor = colorIntToCss(renderer.headerBackgroundColor);
		const superChatInfo = {
			amount,
			tier: determineSuperChatTier(headerBackgroundColor || backgroundColor)
		};
		if (backgroundColor) superChatInfo.backgroundColor = backgroundColor;
		if (headerBackgroundColor) superChatInfo.headerBackgroundColor = headerBackgroundColor;
		const stickerAlt = extractAccessibilityLabel(renderer.sticker) ?? extractAccessibilityLabel(renderer.headerOverlayImage) ?? "Super Chat Sticker";
		const sticker = createImageAsset(renderer.sticker, stickerAlt) ?? createImageAsset(renderer.headerOverlayImage, stickerAlt);
		if (sticker) superChatInfo.sticker = sticker;
		return superChatInfo;
	}
	function extractActionItem(action) {
		if (!isRecord(action)) return null;
		const addChatItemAction = asRecord(action.addChatItemAction);
		if (addChatItemAction) {
			const item = asRecord(addChatItemAction.item);
			if (item) return {
				item,
				actionType: "add"
			};
		}
		const replaceChatItemAction = asRecord(action.replaceChatItemAction);
		if (replaceChatItemAction) {
			const item = asRecord(replaceChatItemAction.item);
			if (item) return {
				item,
				actionType: "replace"
			};
		}
		return null;
	}
	function extractSupportedRenderer(item) {
		const textRenderer = asRecord(item.liveChatTextMessageRenderer);
		if (textRenderer) return {
			kind: "text",
			renderer: textRenderer
		};
		const paidMessageRenderer = asRecord(item.liveChatPaidMessageRenderer);
		if (paidMessageRenderer) return {
			kind: "superchat",
			renderer: paidMessageRenderer
		};
		const paidStickerRenderer = asRecord(item.liveChatPaidStickerRenderer);
		if (paidStickerRenderer) return {
			kind: "superchat",
			renderer: paidStickerRenderer
		};
		const membershipRenderer = asRecord(item.liveChatMembershipItemRenderer);
		if (membershipRenderer) return {
			kind: "membership",
			renderer: membershipRenderer
		};
		return null;
	}
	function parseMembershipBody(renderer) {
		const messageBody = parseMessageContent(renderer.message, "membership");
		return messageBody.visibleLength > 0 || messageBody.text.length > 0 ? messageBody : parseMessageContent(renderer.headerSubtext, "membership");
	}
	function parseMembershipHeaderText(renderer) {
		return extractDisplayText(renderer.headerPrimaryText);
	}
	function extractDisplayText(value) {
		if (!isRecord(value)) return;
		const simpleText = getString(value.simpleText);
		if (simpleText) return simpleText.trim() || void 0;
		return (Array.isArray(value.runs) ? value.runs : []).map((run) => {
			if (!isRecord(run)) return "";
			const runText = getString(run.text);
			if (runText) return runText;
			const emoji = asRecord(run.emoji);
			return emoji ? getEmojiVisibleFallbackText(emoji) : "";
		}).join("").trim() || void 0;
	}
	function parseMessageContent(value, kind = "text") {
		if (!isRecord(value)) return EMPTY_MESSAGE_BODY;
		const simpleText = getString(value.simpleText);
		if (simpleText !== void 0) return finalizeMessageBody(simpleText, simpleText.length > 0 ? [{
			type: "text",
			content: simpleText
		}] : [], kind);
		const runs = Array.isArray(value.runs) ? value.runs : [];
		const segments = [];
		let plainText = "";
		for (const run of runs) {
			if (!isRecord(run)) continue;
			const runText = getString(run.text);
			if (runText !== void 0) {
				if (runText.length > 0) {
					appendTextSegment(segments, runText);
					plainText += runText;
				}
				continue;
			}
			const emojiData = asRecord(run.emoji);
			if (!emojiData) continue;
			const emoji = parseEmoji(emojiData);
			if (emoji) {
				segments.push({
					type: "emoji",
					emoji
				});
				plainText += emoji.fallbackText || "​";
				continue;
			}
			const fallbackText = getEmojiVisibleFallbackText(emojiData) || "​";
			appendTextSegment(segments, fallbackText);
			plainText += fallbackText;
		}
		return finalizeMessageBody(plainText, segments, kind);
	}
	function finalizeMessageBody(plainText, segments, kind) {
		if (kind !== "text") {
			const content = [...segments];
			return {
				text: truncateForKind(plainText, kind),
				content,
				visibleLength: getVisibleContentLength(content)
			};
		}
		const content = normalizeAndTruncateRegularContent(segments);
		return {
			text: projectContentText(content),
			content,
			visibleLength: getVisibleContentLength(content)
		};
	}
	function normalizeAndTruncateRegularContent(segments) {
		const normalized = normalizeRegularContentSegments(segments);
		if (countCodePoints(projectContentText(normalized)) <= 80) return normalized;
		const truncated = [];
		const payloadLimit = 79;
		let projectedLength = 0;
		for (const segment of normalized) {
			const remaining = payloadLimit - projectedLength;
			if (remaining <= 0) break;
			if (segment.type === "text") {
				const codePoints = Array.from(segment.content);
				appendTextSegment(truncated, codePoints.slice(0, remaining).join(""));
				projectedLength += Math.min(codePoints.length, remaining);
				if (codePoints.length > remaining) break;
				continue;
			}
			const fallbackLength = countCodePoints(getEmojiProjection(segment));
			if (fallbackLength > remaining) break;
			truncated.push(segment);
			projectedLength += fallbackLength;
		}
		appendTextSegment(truncated, "…");
		return truncated;
	}
	function normalizeRegularContentSegments(segments) {
		const normalized = [];
		let hasContent = false;
		let pendingSpace = false;
		for (const segment of segments) {
			if (segment.type === "emoji") {
				if (pendingSpace && hasContent) appendTextSegment(normalized, " ");
				normalized.push(segment);
				hasContent = true;
				pendingSpace = false;
				continue;
			}
			for (const codePoint of stripControlCharacters(segment.content)) {
				if (/\s/u.test(codePoint)) {
					pendingSpace = hasContent;
					continue;
				}
				if (pendingSpace) appendTextSegment(normalized, " ");
				appendTextSegment(normalized, codePoint);
				hasContent = true;
				pendingSpace = false;
			}
		}
		removeTrailingYouTubeEllipsis(normalized);
		return normalized;
	}
	function removeTrailingYouTubeEllipsis(segments) {
		const last = segments.at(-1);
		if (last?.type !== "text") return;
		last.content = last.content.replace(/[\u2026]+$/u, "");
		if (last.content.length === 0) segments.pop();
	}
	function getEmojiProjection(segment) {
		return segment.emoji.fallbackText || "​";
	}
	function projectContentText(segments) {
		return segments.map((segment) => segment.type === "text" ? segment.content : getEmojiProjection(segment)).join("");
	}
	function appendTextSegment(segments, content) {
		if (content.length === 0) return;
		const lastSegment = segments[segments.length - 1];
		if (lastSegment?.type === "text") {
			lastSegment.content += content;
			return;
		}
		segments.push({
			type: "text",
			content
		});
	}
	function countCodePoints(s) {
		let count = 0;
		for (const _ of s) count++;
		return count;
	}
	function getVisibleContentLength(segments) {
		let visibleLength = 0;
		for (const segment of segments) {
			if (segment.type === "emoji") {
				visibleLength += 1;
				continue;
			}
			const cleaned = stripControlCharacters(segment.content).replace(/\s+/g, "");
			visibleLength += countCodePoints(cleaned);
		}
		return visibleLength;
	}
	function extractAuthorType(value) {
		let resolvedType = "normal";
		if (!Array.isArray(value)) return resolvedType;
		for (const badgeEntry of value) {
			const nextType = classifyAuthorBadge(badgeEntry);
			if (AUTHOR_TYPE_PRIORITY[nextType] > AUTHOR_TYPE_PRIORITY[resolvedType]) resolvedType = nextType;
		}
		return resolvedType;
	}
	function classifyAuthorBadge(value) {
		const badgeEntry = asRecord(value);
		if (!badgeEntry) return "normal";
		const liveBadge = asRecord(badgeEntry.liveChatAuthorBadgeRenderer);
		const metadataBadge = asRecord(badgeEntry.metadataBadgeRenderer);
		const badge = liveBadge ?? metadataBadge ?? badgeEntry;
		const iconType = getString(asRecord(badge.icon)?.iconType)?.toUpperCase() ?? "";
		const style = getString(metadataBadge?.style ?? badge.style)?.toUpperCase() ?? "";
		const label = [
			getString(badge.tooltip),
			extractAccessibilityLabel(badge),
			extractAccessibilityLabel(liveBadge),
			extractAccessibilityLabel(metadataBadge)
		].filter((s) => Boolean(s)).join(" ").toUpperCase();
		if (iconType.includes("OWNER") || label.includes("OWNER")) return "owner";
		if (iconType.includes("MODERATOR") || label.includes("MODERATOR") || label.includes(" MOD ")) return "moderator";
		if (iconType.includes("SPONSOR") || style.includes("MEMBERS_ONLY") || isRecord(badge.customThumbnail) || isRecord(liveBadge?.customThumbnail) || label.includes("MEMBER") || label.includes("MEMBERSHIP") || label.includes("SPONSOR")) return "member";
		if (style.includes("VERIFIED") || iconType.includes("VERIFIED") || label.includes("VERIFIED")) return "verified";
		return "normal";
	}
	var log$21 = createLogger("FetchInterceptor");
	var MAX_RESPONSE_IDENTITY_CACHE_SIZE = 64;
	function createResponseIdentity(text) {
		let first = 2166136261;
		let second = 2654435769;
		for (let index = 0; index < text.length; index++) {
			const codeUnit = text.charCodeAt(index);
			first = Math.imul(first ^ codeUnit, 16777619);
			second = Math.imul(second ^ codeUnit, 2246822507);
			second = second << 13 | second >>> 19;
		}
		return `${text.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
	}
	function rememberResponseIdentity(cache, text) {
		const identity = createResponseIdentity(text);
		if (cache.has(identity)) return false;
		if (cache.size >= MAX_RESPONSE_IDENTITY_CACHE_SIZE) {
			const oldest = cache.values().next().value;
			if (oldest !== void 0) cache.delete(oldest);
		}
		cache.add(identity);
		return true;
	}
	var CHAT_ENDPOINT_RE = /youtubei\/v1\/live_chat\/(get_live_chat|get_live_chat_replay)/;
	var activeInterceptor = null;
	function installFetchInterceptor(getSettings, onMessages) {
		if (activeInterceptor) {
			activeInterceptor.restore();
			activeInterceptor = null;
		}
		const originalFetch = window.fetch;
		const responseIdentityCache = new Set();
		let isActive = true;
		function interceptedFetch(input, init) {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input instanceof Request ? input.url : "";
			if (!url || !CHAT_ENDPOINT_RE.test(url)) return originalFetch.call(this, input, init);
			const response = originalFetch.call(this, input, init);
			(async () => {
				try {
					const res = await response;
					if (!isActive) return;
					const text = await res.clone().text();
					if (!isActive) return;
					if (!rememberResponseIdentity(responseIdentityCache, text)) {
						log$21.debug("chat.interceptor.skip-duplicate");
						return;
					}
					const payload = getLiveChatPayload(JSON.parse(text));
					if (payload && payload.actions.length > 0) {
						const events = extractChatEvents(payload.actions, getSettings);
						if (events.length > 0) {
							const messages = events.map((e) => e.message);
							log$21.debug("chat.interceptor.messages-received", { count: messages.length });
							if (isActive) onMessages(messages);
						}
					}
				} catch (error) {
					log$21.debug("chat.interceptor.parse-failed", { error: String(error) });
				}
			})();
			return response;
		}
		window.fetch = interceptedFetch;
		const restore = () => {
			isActive = false;
			responseIdentityCache.clear();
			if (window.fetch === interceptedFetch) window.fetch = originalFetch;
			if (activeInterceptor?.restore === restore) activeInterceptor = null;
			log$21.info("chat.interceptor.removed");
		};
		activeInterceptor = {
			restore,
			interceptedFn: interceptedFetch
		};
		log$21.info("chat.interceptor.installed");
		return restore;
	}
	var log$20 = createLogger("[ChatPanelObserver]");
	var CHAT_PANEL_SELECTORS = [
		"#chatframe",
		"#chat.ytd-live-chat-frame",
		"ytd-live-chat-frame"
	];
	var MUTATION_CHECK_INTERVAL_MS = 500;
	var STABLE_DELAY_MS = 300;
	var ChatPanelObserver = class {
		observer = null;
		pollTimer = null;
		callback = null;
		lastState = null;
		debounceTimer = null;
		isPaused = false;
		start(callback) {
			if (this.pollTimer !== null) {
				log$20.debug("chat.panel-observer.already-started");
				this.callback = callback;
				return;
			}
			this.callback = callback;
			this.check();
			this.observer = new MutationObserver(() => this.scheduleCheck());
			const target = document.querySelector("#columns") ?? document.body;
			this.observer.observe(target, {
				childList: true,
				subtree: true
			});
			this.pollTimer = setInterval(() => this.scheduleCheck(), MUTATION_CHECK_INTERVAL_MS);
			log$20.info("chat.panel-observer.started");
		}
		stop() {
			this.observer?.disconnect();
			this.observer = null;
			if (this.pollTimer !== null) {
				clearInterval(this.pollTimer);
				this.pollTimer = null;
			}
			if (this.debounceTimer !== null) {
				clearTimeout(this.debounceTimer);
				this.debounceTimer = null;
			}
			this.callback = null;
			this.lastState = null;
			this.isPaused = false;
		}
		pause() {
			if (this.isPaused) return;
			this.isPaused = true;
			this.observer?.disconnect();
			this.observer = null;
			if (this.pollTimer !== null) {
				clearInterval(this.pollTimer);
				this.pollTimer = null;
			}
			if (this.debounceTimer !== null) {
				clearTimeout(this.debounceTimer);
				this.debounceTimer = null;
			}
		}
		resume() {
			if (!this.isPaused) return;
			this.isPaused = false;
			if (!this.callback) return;
			this.observer = new MutationObserver(() => this.scheduleCheck());
			const target = document.querySelector("#columns") ?? document.body;
			this.observer.observe(target, {
				childList: true,
				subtree: true
			});
			this.pollTimer = setInterval(() => this.scheduleCheck(), MUTATION_CHECK_INTERVAL_MS);
		}
		getLastState() {
			return this.lastState;
		}
		scheduleCheck() {
			if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				this.debounceTimer = null;
				this.check();
			}, STABLE_DELAY_MS);
		}
		check() {
			const now = performance.now();
			const element = this.findChatPanel();
			const isOpen = element !== null;
			if (isOpen === (this.lastState?.isOpen ?? false) && element === this.lastState?.element) return;
			const state = {
				isOpen,
				element,
				timestamp: now
			};
			if (isOpen) log$20.info("chat.panel.opened");
			else log$20.info("chat.panel.closed");
			this.lastState = state;
			this.callback?.(state);
		}
		findChatPanel() {
			for (const selector of CHAT_PANEL_SELECTORS) {
				const el = document.querySelector(selector);
				if (el && this.isVisible(el)) return el;
			}
			return null;
		}
		isVisible(el) {
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return false;
			const style = getComputedStyle(el);
			if (style.display === "none" || style.visibility === "hidden") return false;
			return true;
		}
	};
	function recordDensitySample(ring, write, filled, count) {
		ring[write] = count;
		return {
			write: (write + 1) % 5,
			filled: filled < 5 ? filled + 1 : 5
		};
	}
	function computeErrorBackoffMs(fallbackMs, consecutiveErrors, limits) {
		if (consecutiveErrors === 0) return null;
		const delayed = fallbackMs * 2 ** consecutiveErrors;
		return Math.min(limits.maxPollIntervalMs, Math.max(limits.minPollIntervalMs, delayed));
	}
	function computeBurstAdjustedMs(fallbackMs, emaRate, limits) {
		if (emaRate === void 0) return null;
		if (emaRate >= 30) return 0;
		if (emaRate >= 10) return Math.max(limits.minPollIntervalMs, Math.round(Math.min(limits.maxPollIntervalMs, fallbackMs) * .3));
		return null;
	}
	function computeDensityAdjustedMs(fallbackMs, densityRing, densityRingFilled, limits) {
		if (densityRingFilled < 2) return Math.max(limits.minPollIntervalMs, Math.min(limits.maxPollIntervalMs, fallbackMs));
		let sum = 0;
		for (let i = 0; i < densityRingFilled; i++) sum += densityRing[i];
		const avgCount = sum / densityRingFilled;
		if (avgCount >= 30) return 0;
		let base = Math.max(limits.minPollIntervalMs, Math.min(limits.maxPollIntervalMs, fallbackMs));
		if (avgCount >= 10) base = Math.max(limits.minPollIntervalMs, Math.round(base * .3));
		if (avgCount <= 1) base = Math.min(limits.maxPollIntervalMs, Math.round(base * 1.2));
		return Math.max(limits.minPollIntervalMs, Math.min(limits.maxPollIntervalMs, base));
	}
	function calculateAdaptiveDelay(timeoutMs, livePollFallbackMs, consecutiveErrors, emaRate, densityRing, densityRingFilled, limits) {
		const fallback = timeoutMs > 0 ? timeoutMs : livePollFallbackMs;
		const errorBackoff = computeErrorBackoffMs(fallback, consecutiveErrors, limits);
		if (errorBackoff !== null) return errorBackoff;
		const burstAdjusted = computeBurstAdjustedMs(fallback, emaRate, limits);
		if (burstAdjusted !== null) return burstAdjusted;
		return computeDensityAdjustedMs(fallback, densityRing, densityRingFilled, limits);
	}
	var log$19 = createLogger("BootstrapResolver");
	var BOOTSTRAP_MAX_ATTEMPTS = 5;
	var BOOTSTRAP_RETRY_DELAY_MS = 1e3;
	async function resolveBootstrap(signal) {
		let lastResult = null;
		for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
			throwIfAborted$1(signal);
			const result = await bootstrapChatSession(signal);
			if (result.status === "ready") return {
				status: "ready",
				data: result.data
			};
			if (result.status === "waiting") return {
				status: "waiting",
				reason: result.reason
			};
			if (result.status === "unavailable") return {
				status: "unavailable",
				reason: result.reason
			};
			lastResult = result;
			if (attempt < BOOTSTRAP_MAX_ATTEMPTS) {
				log$19.debug("chat.bootstrap.retry", {
					attempt,
					max: 5,
					status: result.status,
					reason: result.reason
				});
				await sleep(BOOTSTRAP_RETRY_DELAY_MS, signal);
			}
		}
		return {
			status: lastResult?.status ?? "retryable",
			reason: lastResult?.reason ?? "Chat bootstrap did not become available"
		};
	}
	async function refreshBootstrap(signal) {
		const resolution = await resolveBootstrap(signal);
		if (resolution.status !== "ready") {
			log$19.warn("chat.bootstrap.refresh-failed", { reason: resolution.reason });
			return null;
		}
		return resolution.data;
	}
	function logBootstrapFailure(resolution) {
		if (resolution.status === "waiting") {
			log$19.info("chat.bootstrap.waiting", { reason: resolution.reason });
			return;
		}
		if (resolution.status === "retryable") {
			log$19.warn("chat.bootstrap.retry-exhausted", {
				reason: resolution.reason,
				attempts: 5
			});
			return;
		}
		if (resolution.status === "unavailable") log$19.info("chat.bootstrap.unavailable", { reason: resolution.reason });
	}
	function createMessageIdRegistry(maxSize) {
		const ids = new Map();
		const effectiveMax = Math.max(1, maxSize);
		return {
			has(id) {
				return ids.has(id);
			},
			mark(id) {
				ids.delete(id);
				ids.set(id, true);
				while (ids.size > effectiveMax) {
					const oldest = ids.keys().next().value;
					if (oldest !== void 0) ids.delete(oldest);
				}
			},
			clear() {
				ids.clear();
			}
		};
	}
	var log$18 = createLogger("ChatSource");
	var RECENT_MESSAGE_BUFFER_SIZE = 100;
	var MessageBuffer = class {
		messages = [];
		push(message) {
			this.messages.push(message);
			const overflow = this.messages.length - RECENT_MESSAGE_BUFFER_SIZE;
			if (overflow > 0) this.messages.splice(0, overflow);
		}
		getLatest(limit) {
			if (limit <= 0) return [];
			return this.messages.slice(-limit);
		}
		clear() {
			this.messages.length = 0;
		}
	};
	var pollLoopLog = createLogger("PollLoop");
	var PollLoopManager = class {
		generation = 0;
		alive = false;
		launch(runner, signal) {
			const generation = ++this.generation;
			this.alive = true;
			(async () => {
				try {
					await runner(signal);
				} catch (error) {
					if (!isAbortError(error)) pollLoopLog.warn("Polling loop stopped unexpectedly:", error);
				} finally {
					if (generation === this.generation) this.alive = false;
				}
			})();
		}
		stop() {
			this.generation += 1;
			this.alive = false;
		}
		isAlive() {
			return this.alive;
		}
	};
	var ChatSource = class ChatSource {
		getSettings;
		callback = null;
		pollController = null;
		pollLoopManager = new PollLoopManager();
		pauseReasons = new Set();
		get isPaused() {
			return this.pauseReasons.size > 0;
		}
		pauseAbortController = null;
		lastActivityTime = 0;
		bootstrap = null;
		bootstrapPreseeded = false;
		messageBuffer = new MessageBuffer();
		burstRateProvider;
		static SEEN_IDS_MAX = 5e3;
		seenMessageIds = createMessageIdRegistry(ChatSource.SEEN_IDS_MAX);
		constructor(getSettings) {
			this.getSettings = getSettings;
		}
		setInitialBootstrap(data) {
			this.bootstrap = data;
			this.bootstrapPreseeded = true;
		}
		async start(callback, signal) {
			this.pollController?.abort();
			this.pollLoopManager.stop();
			const initialBootstrap = this.bootstrapPreseeded ? this.bootstrap : null;
			this.bootstrapPreseeded = false;
			const pollController = new AbortController();
			this.pollController = pollController;
			this.callback = callback;
			this.resetSessionState();
			this.bootstrap = initialBootstrap;
			const combinedSignal = signal ? AbortSignal.any([pollController.signal, signal]) : pollController.signal;
			try {
				return await this.bootstrapAndLaunchPolling(combinedSignal);
			} catch (error) {
				if (isAbortError(error)) return "retryable";
				throw error;
			}
		}
		stop() {
			this.pollController?.abort();
			this.pollController = null;
			this.pollLoopManager.stop();
			this.callback = null;
			this.resetSessionState();
			log$18.debug("chat.source.monitoring-stopped");
		}
		isActive(timeoutMs = this.getSettings().activityTimeoutMs) {
			return Date.now() - this.lastActivityTime < Math.max(0, timeoutMs);
		}
		getHealthSnapshot(options = {}) {
			const activeTimeoutMs = options.activeTimeoutMs ?? this.getSettings().activityTimeoutMs;
			return {
				observerAlive: this.isObserverAlive(),
				recentlyActive: this.isActive(activeTimeoutMs),
				isInBackoff: false,
				consecutiveErrors: 0
			};
		}
		getLatestMessages(limit) {
			return this.messageBuffer.getLatest(limit);
		}
		isObserverAlive() {
			return this.pollLoopManager.isAlive() && this.pollController !== null && !this.pollController.signal.aborted && this.callback !== null;
		}
		getPlaybackSnapshot() {
			const match = findElementMatch(VIDEO_SELECTORS);
			if (!match) return null;
			const { element: video } = match;
			if (!Number.isFinite(video.currentTime)) return null;
			return {
				offsetMs: Math.max(0, Math.floor(video.currentTime * 1e3)),
				paused: video.paused
			};
		}
		markActivity() {
			this.lastActivityTime = Date.now();
		}
		async pollWhilePaused(timeoutMs, pollIntervalMs = 250, signal) {
			const startTime = Date.now();
			while (Date.now() - startTime < timeoutMs) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				await sleep(pollIntervalMs, signal);
				if (!this.getPlaybackSnapshot()?.paused) break;
			}
		}
		async refreshBootstrap(signal, accept = () => true) {
			const result = await refreshBootstrap(signal);
			if (!result || !accept(result)) return null;
			this.bootstrap = result;
			return result;
		}
		emitMessage(message) {
			if (!this.callback) return;
			const deduped = this.filterNewMessages([message]);
			if (deduped.length === 0) return;
			const [msg] = deduped;
			if (!msg) return;
			this.messageBuffer.push(msg);
			this.callback(msg);
		}
		emitBatch(messages, isInitialSeed) {
			if (!this.callback || messages.length === 0) return;
			const deduped = this.filterNewMessages(messages);
			if (deduped.length === 0) return;
			for (const message of deduped) this.messageBuffer.push(message);
			this.callback(deduped, isInitialSeed);
		}
		async requestPayload(fetchFn, continuation, ...fetchArgs) {
			if (!this.bootstrap) return null;
			this.markActivity();
			const payload = getLiveChatPayload(await fetchFn(this.bootstrap, continuation, ...fetchArgs));
			if (!payload) {
				log$18.warn("chat.source.parse-failed");
				return null;
			}
			return payload;
		}
		launchPollLoop(signal, runner) {
			this.pollLoopManager.launch(runner, signal);
		}
		resetSessionState() {
			this.bootstrap = null;
			this.lastActivityTime = 0;
			this.messageBuffer.clear();
			this.seenMessageIds.clear();
		}
		setPauseReason(reason, paused) {
			if (paused) {
				const wasEmpty = this.pauseReasons.size === 0;
				this.pauseReasons.add(reason);
				if (wasEmpty) this.pauseAbortController = new AbortController();
			} else {
				this.pauseReasons.delete(reason);
				if (this.pauseReasons.size === 0) {
					this.pauseAbortController?.abort();
					this.pauseAbortController = null;
					this.markActivity();
				}
			}
		}
		isVisibilityOnlyPause() {
			return this.pauseReasons.size === 1 && this.pauseReasons.has("visibility");
		}
		setPaused(paused) {
			this.setPauseReason("general", paused);
		}
		async waitWhilePaused(sessionSignal) {
			while (this.pauseReasons.size > 0) {
				if (sessionSignal?.aborted) throw new DOMException("Aborted", "AbortError");
				const pauseSignal = this.pauseAbortController?.signal;
				if (!pauseSignal || pauseSignal.aborted) continue;
				const wakeSignal = sessionSignal ? AbortSignal.any([pauseSignal, sessionSignal]) : pauseSignal;
				if (!wakeSignal.aborted) await new Promise((resolve) => {
					wakeSignal.addEventListener("abort", () => resolve(), { once: true });
				});
				if (sessionSignal?.aborted) throw new DOMException("Aborted", "AbortError");
			}
		}
		injectExternalMessages(messages) {
			if (!this.callback || messages.length === 0) return;
			if (this.pauseReasons.size > 0 && document.visibilityState !== "hidden") {
				const playback = this.getPlaybackSnapshot();
				if (playback && !playback.paused) {
					log$18.warn("pauseReasons state drift detected — tab visible + video playing but reasons active. Force-clearing pause reasons to recover message delivery.");
					this.pauseReasons.delete("general");
					if (this.pauseReasons.size === 0) {
						this.pauseAbortController?.abort();
						this.pauseAbortController = null;
						this.markActivity();
					}
				}
			}
			if (this.pauseReasons.size > 0) return;
			const deduped = this.filterNewMessages(messages);
			if (deduped.length === 0) return;
			for (const message of deduped) this.messageBuffer.push(message);
			this.callback(deduped, false);
		}
		filterNewMessages(messages) {
			const result = [];
			for (const msg of messages) {
				if (msg.actionType !== "replace") {
					const dedupKey = msg.id ?? this.computeContentHash(msg);
					if (this.seenMessageIds.has(dedupKey)) continue;
					this.seenMessageIds.mark(dedupKey);
				}
				result.push(msg);
			}
			return result;
		}
		computeContentHash(msg) {
			const text = msg.text ?? "";
			return `hash:${msg.author ?? ""}:${msg.videoOffsetMs ?? msg.timestamp ?? 0}:${text.slice(0, 80)}`;
		}
		async bootstrapAndLaunchPolling(signal) {
			if (!this.bootstrap) {
				const bootstrapResolution = await resolveBootstrap(signal);
				if (bootstrapResolution.status !== "ready") {
					logBootstrapFailure(bootstrapResolution);
					if (bootstrapResolution.status === "waiting") return "waiting";
					return bootstrapResolution.status === "unavailable" ? "unavailable" : "retryable";
				}
				this.bootstrap = bootstrapResolution.data;
			}
			if (!await this.seedCurrentSession(signal)) return "retryable";
			this.launchCurrentPollLoop(signal);
			log$18.debug("chat.source.replay-poll-started");
			return "started";
		}
	};
	var log$17 = createLogger("LiveChatSource");
	var LIVE_SEED_CUTOFF_MS = 6e4;
	var LIVE_BOOTSTRAP_REFRESH_BASE = 5;
	var LIVE_BOOTSTRAP_REFRESH_MAX = 50;
	var LIVE_POLL_TIMEOUT_MS = 2e4;
	var LiveChatSource = class extends ChatSource {
		liveContinuation = null;
		consecutiveErrors = 0;
		densityRing = new Uint16Array(5);
		densityRingWrite = 0;
		densityRingFilled = 0;
		seedCurrentSession(signal) {
			return this.initializeLiveSession(signal);
		}
		launchCurrentPollLoop(signal) {
			this.launchPollLoop(signal, (loopSignal) => this.runLiveLoop(loopSignal));
		}
		getHealthSnapshot(options) {
			return {
				...super.getHealthSnapshot(options),
				consecutiveErrors: this.consecutiveErrors
			};
		}
		resetSessionState() {
			super.resetSessionState();
			this.liveContinuation = null;
			this.consecutiveErrors = 0;
			this.densityRing.fill(0);
			this.densityRingWrite = 0;
			this.densityRingFilled = 0;
		}
		async initializeLiveSession(signal) {
			if (!this.bootstrap) return false;
			try {
				const payload = await this.requestLivePayload(this.bootstrap.initialContinuation, signal);
				if (!payload) return false;
				await this.handleLivePayload(payload, true, signal);
				return true;
			} catch (error) {
				if (isAbortError(error)) throw error;
				log$17.warn("chat.live.init-failed", { error: String(error) });
				return false;
			}
		}
		recordMessageCount(count) {
			const next = recordDensitySample(this.densityRing, this.densityRingWrite, this.densityRingFilled, count);
			this.densityRingWrite = next.write;
			this.densityRingFilled = next.filled;
		}
		getLimits() {
			const s = this.getSettings();
			return {
				minPollIntervalMs: s.minPollIntervalMs,
				maxPollIntervalMs: s.maxPollIntervalMs
			};
		}
		calculateAdaptiveDelay(timeoutMs) {
			return calculateAdaptiveDelay(timeoutMs, this.getSettings().livePollFallbackMs, this.consecutiveErrors, this.burstRateProvider?.(), this.densityRing, this.densityRingFilled, this.getLimits());
		}
		async runLiveLoop(signal) {
			while (!signal?.aborted) {
				throwIfAborted$1(signal);
				await this.waitWhilePaused(signal);
				if (this.getPlaybackSnapshot()?.paused) {
					await this.pollWhilePaused(this.getSettings().livePollFallbackMs, 250, signal);
					continue;
				}
				const timeoutMs = this.liveContinuation?.timeoutMs ?? this.getSettings().livePollFallbackMs;
				const delayMs = this.calculateAdaptiveDelay(timeoutMs);
				if (delayMs > 0) await sleep(delayMs, signal);
				throwIfAborted$1(signal);
				await this.waitWhilePaused(signal);
				const continuation = this.liveContinuation;
				if (!continuation) {
					await this.refreshLiveContinuation(signal);
					continue;
				}
				try {
					const payload = await this.requestLivePayload(continuation, signal);
					if (!payload) {
						await this.refreshLiveContinuation(signal);
						continue;
					}
					await this.handleLivePayload(payload, false, signal);
				} catch (error) {
					if (isAbortError(error)) throw error;
					this.consecutiveErrors += 1;
					if (this.consecutiveErrors >= this.getSettings().livePollFailureLimit) {
						log$17.error(`Live poll failed ${this.consecutiveErrors} times consecutively; circuit breaker tripped — stopping poll loop for watchdog restart`);
						throw new Error(`Live poll consecutive failure limit (${this.getSettings().livePollFailureLimit}) reached`);
					}
					if (error instanceof YoutubeInnertubeRequestError) log$17.warn("Live poll request failed:", {
						status: error.status,
						message: error.message
					});
					else if (error instanceof TypeError) log$17.warn("Live poll network error:", {
						name: error.name,
						message: error.message
					});
					else if (error instanceof SyntaxError) log$17.warn("Live poll JSON parse error (possible API change):", {
						name: error.name,
						message: error.message
					});
					else {
						const errName = error instanceof Error ? error.name : typeof error;
						const errMsg = error instanceof Error ? error.message : String(error);
						log$17.warn("Live poll request failed:", {
							name: errName,
							message: errMsg
						});
					}
					const isParseError = error instanceof SyntaxError;
					const refreshInterval = Math.min(LIVE_BOOTSTRAP_REFRESH_MAX, LIVE_BOOTSTRAP_REFRESH_BASE * 2 ** Math.floor((this.consecutiveErrors - 1) / LIVE_BOOTSTRAP_REFRESH_BASE));
					const needsPeriodicRefresh = this.consecutiveErrors > 0 && this.consecutiveErrors % refreshInterval === 0;
					const isNetworkError = error instanceof TypeError;
					if (isParseError || needsPeriodicRefresh && !isNetworkError) await this.refreshLiveContinuation(signal);
				}
			}
		}
		async requestLivePayload(continuation, signal) {
			const timeoutSignal = AbortSignal.timeout(LIVE_POLL_TIMEOUT_MS);
			const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			try {
				return await this.requestPayload(fetchLiveChat, continuation, mergedSignal);
			} catch (error) {
				if (isAbortError(error) && timeoutSignal.aborted && !signal?.aborted) log$17.warn("chat.live.poll-timeout", { timeoutMs: LIVE_POLL_TIMEOUT_MS });
				throw error;
			}
		}
		async handleLivePayload(payload, isInitialSeed = false, signal) {
			const events = extractChatEvents(payload.actions, this.getSettings);
			if (events.length > 0) {
				let messages;
				if (isInitialSeed) {
					const offsetMs = this.getPlaybackSnapshot()?.offsetMs ?? 0;
					const cutoffMs = Math.max(0, offsetMs - LIVE_SEED_CUTOFF_MS);
					const filtered = events.filter((e) => {
						if (e.message.kind === "superchat" || e.message.kind === "membership") return true;
						if (e.offsetMs === void 0) return true;
						if (e.offsetMs < cutoffMs) return false;
						return e.offsetMs <= offsetMs + LIVE_SEED_CUTOFF_MS;
					});
					messages = filtered.map((e) => e.message);
					if (filtered.length < events.length) log$17.debug(`Initial seed filtered: ${events.length} → ${filtered.length} (playback at ${Math.round(offsetMs / 1e3)}s)`);
				} else messages = events.map((e) => e.message);
				if (messages.length > 0) {
					this.emitBatch(messages, isInitialSeed);
					this.recordMessageCount(messages.length);
				}
			}
			this.consecutiveErrors = 0;
			const nextContinuation = extractNextLiveContinuation(payload.continuations);
			if (!nextContinuation) {
				log$17.warn("chat.live.missing-continuation");
				await this.refreshLiveContinuation(signal);
			} else this.liveContinuation = nextContinuation;
		}
		async refreshLiveContinuation(signal) {
			const bootstrap = await this.refreshBootstrap(signal);
			if (bootstrap) this.liveContinuation = bootstrap.initialContinuation ?? null;
		}
	};
	var MAX_BUFFERED_REPLAY_MESSAGES = 3e3;
	var REPLAY_EMIT_TOLERANCE_MS = 2e3;
	var ReplayBuffer = class {
		buffer = [];
		bufferOffset = 0;
		seenIds = new Set();
		get isEmpty() {
			return this.buffer.length - this.bufferOffset <= 0;
		}
		insert(message, offsetMs) {
			if (message.id && this.seenIds.has(message.id)) return;
			let lo = this.bufferOffset;
			let hi = this.buffer.length;
			while (lo < hi) {
				const mid = lo + hi >>> 1;
				const item = this.buffer[mid];
				if (!item) break;
				if (item.offsetMs <= offsetMs) lo = mid + 1;
				else hi = mid;
			}
			this.buffer.splice(lo, 0, {
				message,
				offsetMs
			});
			if (message.id) this.seenIds.add(message.id);
			this.trim(MAX_BUFFERED_REPLAY_MESSAGES);
		}
		appendEvents(events, minimumOffsetMs = 0) {
			let highestOffsetMs = -1;
			for (const event of events) {
				const offsetMs = event.message.videoOffsetMs ?? event.offsetMs;
				if (offsetMs === void 0) continue;
				highestOffsetMs = Math.max(highestOffsetMs, offsetMs);
				if (offsetMs < minimumOffsetMs) continue;
				this.insert(event.message, offsetMs);
			}
			return highestOffsetMs;
		}
		flushUpTo(currentOffsetMs, maxBatch) {
			if (this.buffer.length - this.bufferOffset <= 0) return [];
			const batch = [];
			while (this.buffer.length - this.bufferOffset > 0 && batch.length < maxBatch) {
				const next = this.buffer[this.bufferOffset];
				if (!next) break;
				if (next.offsetMs > currentOffsetMs + REPLAY_EMIT_TOLERANCE_MS) break;
				this.bufferOffset++;
				if (next.message.id) this.seenIds.delete(next.message.id);
				if (next.offsetMs < currentOffsetMs - REPLAY_EMIT_TOLERANCE_MS) continue;
				batch.push(next.message);
			}
			if (this.bufferOffset > 64) {
				this.buffer.splice(0, this.bufferOffset);
				this.bufferOffset = 0;
			}
			return batch;
		}
		clear() {
			this.buffer = [];
			this.bufferOffset = 0;
			this.seenIds.clear();
		}
		drainUpTo(maxOffsetMs) {
			if (maxOffsetMs == null) return this.drainAll();
			const messages = [];
			let drainEnd = this.bufferOffset;
			for (let i = this.bufferOffset; i < this.buffer.length; i++) {
				const item = this.buffer[i];
				if (!item) continue;
				if (item.offsetMs > maxOffsetMs) break;
				messages.push(item.message);
				drainEnd = i + 1;
			}
			if (messages.length === 0) return [];
			this.bufferOffset = drainEnd;
			for (const msg of messages) if (msg.id) this.seenIds.delete(msg.id);
			return messages;
		}
		drainAll() {
			const messages = [];
			for (let i = this.bufferOffset; i < this.buffer.length; i++) {
				const item = this.buffer[i];
				if (item) messages.push(item.message);
			}
			this.buffer = [];
			this.bufferOffset = 0;
			this.seenIds.clear();
			return messages;
		}
		trim(maxSize) {
			const effectiveLength = this.buffer.length - this.bufferOffset;
			if (effectiveLength <= maxSize) return;
			const overflow = effectiveLength - maxSize;
			const trimEnd = this.bufferOffset + overflow;
			for (let i = this.bufferOffset; i < trimEnd; i++) {
				const id = this.buffer[i]?.message.id;
				if (id) this.seenIds.delete(id);
			}
			this.bufferOffset = trimEnd;
			if (this.bufferOffset > 500) {
				this.buffer = this.buffer.slice(this.bufferOffset);
				this.bufferOffset = 0;
			}
		}
	};
	var log$16 = createLogger("ReplayChatSource");
	var REPLAY_FETCH_MIN_DELTA_MS = 1e3;
	var REPLAY_CONSECUTIVE_FAILURE_LIMIT = 5;
	var REPLAY_FAILURE_BACKOFF_MS = 5e3;
	var REPLAY_TOTAL_FAILURE_LIMIT = 15;
	var REPLAY_PREFETCH_WINDOW_MS = 5e3;
	var BACKGROUND_FETCH_INTERVAL_MS = 1e3;
	var REPLAY_PREFETCH_MIN_INTERVAL_MS = 250;
	var RAF_FLUSH_BATCH_SIZE = 5;
	var REPLAY_FETCH_TIMEOUT_MS = 2e4;
	var ReplayChatSource = class extends ChatSource {
		replayMode = null;
		replayPlayerSeekContinuation = null;
		replayContinuation = null;
		replayFallbackLastOffsetMs = -1;
		lastReplayRequestedOffsetMs = -1e3;
		replayConsecutiveFailures = 0;
		replayTotalFailuresSinceSuccess = 0;
		replayNextAllowedFetchAt = 0;
		replayBuffer = new ReplayBuffer();
		seekListenerCleanup = null;
		seekSignal = null;
		seekAbortController = null;
		seekGeneration = 0;
		cooperativeLoopTimer = null;
		cooperativeLoopRunning = false;
		cooperativeLoopGeneration = 0;
		prefetchContinuation = null;
		prefetchPagesFetched = 0;
		prefetchMode = null;
		prefetchBackoffUntil = 0;
		prefetchNextAllowedAt = 0;
		prefetchGeneration = 0;
		drainPendingMessages() {
			const currentOffsetMs = this.getPlaybackSnapshot()?.offsetMs;
			const maxOffsetMs = currentOffsetMs != null ? currentOffsetMs + 5e3 : void 0;
			return this.replayBuffer.drainUpTo(maxOffsetMs);
		}
		seedCurrentSession(signal) {
			return this.initializeReplaySession(signal);
		}
		launchCurrentPollLoop(signal) {
			this.startCooperativeLoop(signal);
			this.installSeekListeners(signal);
		}
		isObserverAlive() {
			return this.cooperativeLoopRunning && this.callback !== null;
		}
		getHealthSnapshot(options = {}) {
			return {
				...super.getHealthSnapshot(options),
				isInBackoff: Date.now() < this.replayNextAllowedFetchAt
			};
		}
		resetSessionState() {
			super.resetSessionState();
			this.resetReplayState();
		}
		startCooperativeLoop(signal) {
			this.stopCooperativeLoop();
			this.stopPrefetch();
			this.cooperativeLoopRunning = true;
			const gen = ++this.cooperativeLoopGeneration;
			const tick = async () => {
				if (signal?.aborted || gen !== this.cooperativeLoopGeneration) {
					this.cooperativeLoopRunning = false;
					this.cooperativeLoopTimer = null;
					return;
				}
				if (this.isPaused) this.markActivity();
				const playback = this.getPlaybackSnapshot();
				const isPlaying = playback && !playback.paused;
				const mayFetchWhilePaused = !this.isPaused || this.isVisibilityOnlyPause();
				if (!this.isPaused && isPlaying) {
					this.markActivity();
					this.flushReplayBuffer(playback.offsetMs);
				}
				if (isPlaying && mayFetchWhilePaused) {
					let mainPollSucceeded = false;
					try {
						if (this.replayMode === "playerSeek") mainPollSucceeded = await this.pollPlayerSeekReplay(playback, signal);
						else if (this.replayMode === "continuation") mainPollSucceeded = await this.pollContinuationReplay(playback.offsetMs, signal);
					} catch (error) {
						if (!isAbortError(error)) log$16.debug("chat.replay.fetch-failed", { error: String(error) });
					}
					if (signal?.aborted || gen !== this.cooperativeLoopGeneration) return;
					if (!this.prefetchMode && mainPollSucceeded) this.startPrefetch();
				}
				const now = Date.now();
				const prefetchContinuation = this.prefetchContinuation;
				if (prefetchContinuation && this.shouldPrefetch(now, signal)) {
					const prefetchGeneration = this.prefetchGeneration;
					this.prefetchNextAllowedAt = now + REPLAY_PREFETCH_MIN_INTERVAL_MS;
					try {
						const payload = await this.requestReplayPayload(prefetchContinuation, signal);
						if (signal?.aborted || gen !== this.cooperativeLoopGeneration) return;
						if (!this.isPrefetchGenerationCurrent(prefetchGeneration)) {} else if (payload) {
							const events = extractChatEvents(payload.actions, this.getSettings);
							this.replayBuffer.appendEvents(events, -1);
							this.markActivity();
							this.prefetchContinuation = this.prefetchMode === "playerSeek" ? extractPlayerSeekContinuation(payload.continuations) : extractReplayContinuation(payload.continuations);
							this.prefetchPagesFetched += 1;
						} else this.prefetchContinuation = null;
					} catch (error) {
						if (!this.isPrefetchGenerationCurrent(prefetchGeneration)) {} else if (isAbortError(error)) this.prefetchContinuation = null;
						else {
							log$16.debug("chat.replay.prefetch-failed", { error: String(error) });
							this.prefetchBackoffUntil = Date.now() + 5e3;
						}
					}
				}
				const hasPendingFlushes = !this.replayBuffer.isEmpty;
				const videoPaused = playback?.paused ?? true;
				const adaptiveDelay = hasPendingFlushes && !this.isPaused && !videoPaused ? 16 : BACKGROUND_FETCH_INTERVAL_MS;
				if (!signal?.aborted && gen === this.cooperativeLoopGeneration) this.cooperativeLoopTimer = setTimeout(tick, adaptiveDelay);
			};
			this.cooperativeLoopTimer = setTimeout(tick, 0);
		}
		shouldPrefetch(now, signal) {
			return Boolean(this.prefetchContinuation && this.prefetchPagesFetched < this.getSettings().replayPrefetchPages && !signal?.aborted && now >= this.prefetchBackoffUntil && now >= this.prefetchNextAllowedAt);
		}
		isPrefetchGenerationCurrent(generation) {
			return generation === this.prefetchGeneration;
		}
		stopCooperativeLoop() {
			this.cooperativeLoopGeneration++;
			this.cooperativeLoopTimer = clearSafeTimeout(this.cooperativeLoopTimer);
			this.cooperativeLoopRunning = false;
			this.clearSeekListener();
		}
		clearSeekListener() {
			const cleanup = this.seekListenerCleanup;
			this.seekListenerCleanup = null;
			this.seekSignal = null;
			cleanup?.();
		}
		stopPrefetch() {
			this.prefetchGeneration++;
			this.prefetchContinuation = null;
			this.prefetchPagesFetched = 0;
			this.prefetchMode = null;
			this.prefetchBackoffUntil = 0;
			this.prefetchNextAllowedAt = 0;
		}
		startPrefetch() {
			this.stopPrefetch();
			if (!this.replayMode) return;
			this.prefetchContinuation = this.replayMode === "playerSeek" ? this.replayPlayerSeekContinuation : this.replayContinuation;
			this.prefetchPagesFetched = 0;
			this.prefetchMode = this.replayMode;
			this.prefetchBackoffUntil = 0;
		}
		installSeekListeners(signal) {
			this.clearSeekListener();
			const el = findElementMatch(VIDEO_SELECTORS);
			if (!el) return;
			this.seekSignal = signal ?? null;
			const v = el.element;
			const onSeeked = () => {
				if (signal?.aborted) return;
				const offsetMs = Math.max(0, Math.floor(v.currentTime * 1e3));
				this.handleSeeked(offsetMs);
			};
			v.addEventListener("seeked", onSeeked);
			this.seekListenerCleanup = () => {
				v.removeEventListener("seeked", onSeeked);
			};
		}
		handleSeeked(offsetMs) {
			if (!this.callback) return;
			const gen = ++this.seekGeneration;
			this.seekAbortController?.abort();
			this.seekAbortController = new AbortController();
			const seekSignal = this.seekSignal ? AbortSignal.any([this.seekAbortController.signal, this.seekSignal]) : this.seekAbortController.signal;
			this.replayBuffer.clear();
			this.lastReplayRequestedOffsetMs = offsetMs;
			this.replayConsecutiveFailures = 0;
			this.replayTotalFailuresSinceSuccess = 0;
			this.stopPrefetch();
			if (this.replayMode === "playerSeek" && this.replayPlayerSeekContinuation) (async () => {
				try {
					if (gen !== this.seekGeneration) return;
					const seekSuccess = await this.fetchReplayPlayerSeek(offsetMs, seekSignal);
					if (gen !== this.seekGeneration) return;
					this.flushReplayBuffer(offsetMs);
					if (seekSuccess) this.startPrefetch();
				} catch (error) {
					if (!isAbortError(error)) log$16.debug("chat.replay.seek-fetch-failed", { error: String(error) });
				}
			})();
			else if (this.replayMode === "continuation") (async () => {
				try {
					if (gen !== this.seekGeneration) return;
					const pollSuccess = await this.pollContinuationReplay(offsetMs, seekSignal);
					if (gen !== this.seekGeneration) return;
					if (pollSuccess) this.startPrefetch();
				} catch (error) {
					if (!isAbortError(error)) log$16.debug("chat.replay.continuation-failed", { error: String(error) });
				}
			})();
		}
		resetReplayState() {
			this.seekGeneration++;
			this.replayMode = null;
			this.replayPlayerSeekContinuation = null;
			this.replayContinuation = null;
			this.replayFallbackLastOffsetMs = -1;
			this.lastReplayRequestedOffsetMs = -1e3;
			this.replayConsecutiveFailures = 0;
			this.replayTotalFailuresSinceSuccess = 0;
			this.replayNextAllowedFetchAt = 0;
			this.replayBuffer.clear();
			this.seekAbortController?.abort();
			this.seekAbortController = null;
			this.stopCooperativeLoop();
			this.stopPrefetch();
		}
		async initializeReplaySession(signal) {
			if (!this.bootstrap) return false;
			this.resetReplayState();
			try {
				const initialPayload = await this.requestReplayPayload(this.bootstrap.initialContinuation, signal);
				if (!initialPayload) return false;
				const playerSeekContinuation = extractPlayerSeekContinuation(initialPayload.continuations);
				if (playerSeekContinuation) {
					this.replayMode = "playerSeek";
					this.replayPlayerSeekContinuation = playerSeekContinuation;
					const currentOffsetMs = this.getPlaybackSnapshot()?.offsetMs ?? 0;
					const seeded = await this.fetchReplayPlayerSeek(currentOffsetMs, signal);
					this.flushReplayBuffer(currentOffsetMs);
					return seeded;
				}
				const replayContinuation = extractReplayContinuation(initialPayload.continuations);
				if (!replayContinuation) {
					log$16.warn("chat.replay.no-seek-data");
					return false;
				}
				this.replayMode = "continuation";
				this.replayContinuation = replayContinuation;
				const currentOffsetMs = this.getPlaybackSnapshot()?.offsetMs ?? 0;
				const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
				this.replayFallbackLastOffsetMs = this.replayBuffer.appendEvents(extractChatEvents(initialPayload.actions, this.getSettings), minimumOffsetMs);
				let batchesFetched = 0;
				while (this.replayContinuation && this.replayFallbackLastOffsetMs < minimumOffsetMs && batchesFetched < this.getSettings().replayBatchLimit) {
					throwIfAborted$1(signal);
					if (!await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal)) break;
					batchesFetched += 1;
				}
				this.flushReplayBuffer(currentOffsetMs);
				return true;
			} catch (error) {
				if (isAbortError(error)) throw error;
				log$16.info("chat.replay.init-failed", { error: String(error) });
				return false;
			}
		}
		requestReplayPayload(continuation, signal, playerOffsetMs) {
			const timeoutSignal = AbortSignal.timeout(REPLAY_FETCH_TIMEOUT_MS);
			const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			return this.requestPayload(fetchReplayChat, continuation, playerOffsetMs, mergedSignal).catch((error) => {
				if (isAbortError(error) && timeoutSignal.aborted && !signal?.aborted) log$16.warn("chat.replay.fetch-timeout", { timeoutMs: REPLAY_FETCH_TIMEOUT_MS });
				throw error;
			});
		}
		flushReplayBuffer(currentOffsetMs) {
			if (!this.callback) return;
			const batch = this.replayBuffer.flushUpTo(currentOffsetMs, RAF_FLUSH_BATCH_SIZE);
			if (batch.length === 0) return;
			this.emitBatch(batch, false);
		}
		async fetchReplayPlayerSeek(offsetMs, signal) {
			if (!this.replayPlayerSeekContinuation) return false;
			try {
				const payload = await this.requestReplayPayload(this.replayPlayerSeekContinuation, signal, offsetMs);
				if (!payload) {
					this.recordReplayFailure();
					return false;
				}
				const nextPlayerSeekContinuation = extractPlayerSeekContinuation(payload.continuations);
				this.replayBuffer.appendEvents(extractChatEvents(payload.actions, this.getSettings), Math.max(0, offsetMs - REPLAY_PREFETCH_WINDOW_MS));
				this.replayPlayerSeekContinuation = nextPlayerSeekContinuation;
				this.lastReplayRequestedOffsetMs = offsetMs;
				this.replayConsecutiveFailures = 0;
				this.replayTotalFailuresSinceSuccess = 0;
				this.replayNextAllowedFetchAt = 0;
				return nextPlayerSeekContinuation !== null || payload.actions.length > 0;
			} catch (error) {
				if (isAbortError(error)) throw error;
				log$16.debug("chat.replay.player-seek-failed", { error: String(error) });
				this.recordReplayFailure();
				return false;
			}
		}
		async fetchNextReplayFallbackBatch(minimumOffsetMs, signal) {
			if (!this.replayContinuation) return false;
			try {
				const payload = await this.requestReplayPayload(this.replayContinuation, signal);
				if (!payload) {
					this.recordReplayFailure();
					return false;
				}
				const events = extractChatEvents(payload.actions, this.getSettings);
				this.replayFallbackLastOffsetMs = this.replayBuffer.appendEvents(events, minimumOffsetMs);
				this.replayContinuation = extractReplayContinuation(payload.continuations);
				this.replayConsecutiveFailures = 0;
				this.replayTotalFailuresSinceSuccess = 0;
				this.replayNextAllowedFetchAt = 0;
				return this.replayContinuation !== null || events.length > 0;
			} catch (error) {
				if (isAbortError(error)) throw error;
				log$16.debug("chat.replay.continuation-request-failed", { error: String(error) });
				this.recordReplayFailure();
				return false;
			}
		}
		recordReplayFailure() {
			this.replayConsecutiveFailures += 1;
			this.replayTotalFailuresSinceSuccess += 1;
			if (this.replayConsecutiveFailures >= REPLAY_CONSECUTIVE_FAILURE_LIMIT) {
				const backoffUntil = Date.now() + REPLAY_FAILURE_BACKOFF_MS;
				this.replayNextAllowedFetchAt = backoffUntil;
				this.replayConsecutiveFailures = 0;
				log$16.warn(`Replay fetch failed ${REPLAY_CONSECUTIVE_FAILURE_LIMIT} times consecutively; backing off for ${REPLAY_FAILURE_BACKOFF_MS}ms`);
			}
		}
		needsReplaySessionRecovery() {
			return this.replayTotalFailuresSinceSuccess >= REPLAY_TOTAL_FAILURE_LIMIT;
		}
		async pollPlayerSeekReplay(playback, signal) {
			if (playback.paused || Date.now() < this.replayNextAllowedFetchAt || !this.shouldFetchReplayAtOffset(playback.offsetMs)) return false;
			if (await this.fetchReplayPlayerSeek(playback.offsetMs, signal)) return true;
			if (!this.needsReplaySessionRecovery()) return false;
			log$16.warn(`Replay fetch failed ${REPLAY_TOTAL_FAILURE_LIMIT} total times; re-initializing replay session`);
			if (!await this.refreshBootstrap(signal, (candidate) => candidate.isReplay)) return false;
			const initialized = await this.initializeReplaySession(signal);
			if (initialized) {
				this.startCooperativeLoop(signal);
				this.installSeekListeners(signal);
			}
			return initialized;
		}
		shouldFetchReplayAtOffset(currentOffsetMs) {
			if (this.replayMode !== "playerSeek" || !this.replayPlayerSeekContinuation) return false;
			if (this.replayBuffer.isEmpty) return true;
			return currentOffsetMs - this.lastReplayRequestedOffsetMs >= REPLAY_FETCH_MIN_DELTA_MS;
		}
		async pollContinuationReplay(currentOffsetMs, signal) {
			if (Date.now() < this.replayNextAllowedFetchAt) return false;
			const minimumOffsetMs = Math.max(0, currentOffsetMs - REPLAY_PREFETCH_WINDOW_MS);
			let batches = 0;
			let keepAheadFetched = false;
			let lastOffsetBeforeLoop = this.replayFallbackLastOffsetMs;
			while (this.replayContinuation && this.replayFallbackLastOffsetMs >= 0 && this.replayFallbackLastOffsetMs < minimumOffsetMs && batches < this.getSettings().replayBatchLimit) {
				throwIfAborted$1(signal);
				if (!await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal)) break;
				if (this.replayFallbackLastOffsetMs <= lastOffsetBeforeLoop) break;
				lastOffsetBeforeLoop = this.replayFallbackLastOffsetMs;
				batches += 1;
			}
			if (this.replayContinuation && this.replayNextAllowedFetchAt <= Date.now() && this.replayFallbackLastOffsetMs < currentOffsetMs + REPLAY_PREFETCH_WINDOW_MS) keepAheadFetched = await this.fetchNextReplayFallbackBatch(minimumOffsetMs, signal);
			return batches > 0 || keepAheadFetched;
		}
	};
	var STANDARD_STICKER_DECODED_BYTES = 1048576;
	function getStickerCacheBytes(configuredMb) {
		return Math.max(configuredMb * 1e6, STANDARD_STICKER_DECODED_BYTES);
	}
	var ResizableByteLimitedCache = class {
		_map = new Map();
		_currentBytes = 0;
		_maxBytes;
		_estimateSize;
		_onEvict;
		_maxEntries;
		constructor(maxBytes, estimateSize, onEvict, maxEntries = Number.POSITIVE_INFINITY) {
			this._assertValidMaxBytes(maxBytes);
			if (maxEntries !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxEntries) || maxEntries < 0)) throw new RangeError("maxEntries must be a non-negative integer");
			this._maxBytes = maxBytes;
			this._estimateSize = estimateSize;
			this._onEvict = onEvict;
			this._maxEntries = maxEntries;
		}
		get maxBytes() {
			return this._maxBytes;
		}
		get currentBytes() {
			return this._currentBytes;
		}
		get size() {
			return this._map.size;
		}
		resize(newMaxBytes) {
			this._assertValidMaxBytes(newMaxBytes);
			this._maxBytes = newMaxBytes;
			const evicted = [];
			while (this._currentBytes > this._maxBytes && this._map.size > 0) {
				const oldestKey = this._map.keys().next().value;
				if (oldestKey === void 0) break;
				const entry = this._remove(oldestKey);
				if (entry) evicted.push(entry.value);
			}
			this._notifyEvictions(evicted);
		}
		get(key) {
			const entry = this._map.get(key);
			if (!entry) return void 0;
			this._map.delete(key);
			this._map.set(key, entry);
			return entry.value;
		}
		set(key, value) {
			const size = this._estimateSize(value);
			this._assertValidSize(size);
			if (size > this._maxBytes || this._maxEntries < 1) {
				this._onEvict?.(value);
				return false;
			}
			const evicted = [];
			const existing = this._remove(key);
			if (existing) evicted.push(existing.value);
			while ((this._currentBytes + size > this._maxBytes || this._map.size >= this._maxEntries) && this._map.size > 0) {
				const oldestKey = this._map.keys().next().value;
				if (oldestKey === void 0) break;
				const entry = this._remove(oldestKey);
				if (entry) evicted.push(entry.value);
			}
			this._map.set(key, {
				value,
				size
			});
			this._currentBytes += size;
			this._notifyEvictions(evicted);
			return true;
		}
		delete(key) {
			const entry = this._remove(key);
			if (!entry) return false;
			this._onEvict?.(entry.value);
			return true;
		}
		take(key) {
			const entry = this._map.get(key);
			if (!entry) return void 0;
			this._map.delete(key);
			this._currentBytes -= entry.size;
			return entry.value;
		}
		has(key) {
			return this._map.has(key);
		}
		clear() {
			const values = this._onEvict ? Array.from(this._map.values(), (entry) => entry.value) : [];
			this._map.clear();
			this._currentBytes = 0;
			this._notifyEvictions(values);
		}
		touch(key) {
			this.get(key);
		}
		_assertValidMaxBytes(maxBytes) {
			if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a finite, non-negative number");
		}
		_assertValidSize(size) {
			if (!Number.isFinite(size) || size < 0) throw new RangeError("estimateSize must return a finite, non-negative number");
		}
		_remove(key) {
			const entry = this._map.get(key);
			if (!entry) return void 0;
			this._map.delete(key);
			this._currentBytes -= entry.size;
			return entry;
		}
		_notifyEvictions(values) {
			if (!this._onEvict) return;
			let firstError;
			let cleanupFailed = false;
			for (const value of values) try {
				this._onEvict(value);
			} catch (error) {
				if (!cleanupFailed) {
					firstError = error;
					cleanupFailed = true;
				}
			}
			if (cleanupFailed) throw firstError;
		}
	};
	function schedulerYield() {
		if (typeof globalThis.scheduler !== "undefined" && typeof globalThis.scheduler.yield === "function") return globalThis.scheduler.yield();
		return new Promise((resolve) => setTimeout(resolve, 0));
	}
	var FAILED_EMOJI_FETCH_CAP = 500;
	var FAILED_EMOJI_FETCH_EVICT_COUNT = 250;
	var ImageFetchManager = class ImageFetchManager {
		static log = createLogger("ImageFetchManager");
		emojiCache;
		authorPhotoCache;
		stickerCache;
		emojiFetching = new Set();
		emojiFetchingStarted = new Map();
		failedEmojiFetches = new Map();
		imageLoading = new Set();
		uncacheableImageUrlsByCache = new Map();
		inFlightImages = new Set();
		imageLoadTimeouts = new Map();
		emojiUrlToImage = new Map();
		bitmapGeneration = new Map();
		workerBitmapCache = new ResizableByteLimitedCache(1e7, (bitmap) => bitmap.width * bitmap.height * 4, (bitmap) => bitmap.close());
		emojiCleanupIntervalId = null;
		isEmojiCleanupPaused = false;
		isDestroyed = false;
		emojiFetchLimit = 10;
		failedEmojiRetryMins = 5;
		emojiFetchTimeoutMs = 1e4;
		useWorkerMode = false;
		renderWorker = null;
		onImageReadyCallback;
		constructor() {
			this.emojiCache = new ResizableByteLimitedCache(0, (img) => img.naturalWidth * img.naturalHeight * 4, void 0, 500);
			this.authorPhotoCache = new ResizableByteLimitedCache(0, (img) => img.naturalWidth * img.naturalHeight * 4);
			this.stickerCache = new ResizableByteLimitedCache(0, (img) => img.naturalWidth * img.naturalHeight * 4);
		}
		updateConfig(settings, worker) {
			if (this.isDestroyed) return;
			const wasWorkerMode = this.useWorkerMode;
			this.emojiFetchLimit = settings.emojiFetchLimit;
			this.failedEmojiRetryMins = settings.failedEmojiRetryMins;
			this.emojiFetchTimeoutMs = settings.emojiFetchTimeoutMs;
			this.renderWorker = worker;
			this.useWorkerMode = worker !== null;
			if (wasWorkerMode && !this.useWorkerMode) {
				this.workerBitmapCache.clear();
				this.bitmapGeneration.clear();
			}
			this.resizeImageCache(this.emojiCache, settings.emojiCacheMb * 1e6);
			this.resizeImageCache(this.authorPhotoCache, settings.photoCacheMb * 1e6);
			this.resizeImageCache(this.stickerCache, getStickerCacheBytes(settings.stickerCacheMb));
			this.startEmojiCleanupInterval();
		}
		startEmojiCleanupInterval() {
			if (this.isDestroyed || this.isEmojiCleanupPaused || this.emojiCleanupIntervalId !== null) return;
			this.emojiCleanupIntervalId = setInterval(() => {
				if (this.isDestroyed || this.isEmojiCleanupPaused) return;
				this.cleanupStaleEmojiFetching();
			}, 5e3);
		}
		setOnImageReady(cb) {
			if (this.isDestroyed) return;
			this.onImageReadyCallback = cb;
		}
		loadImage(url, cache) {
			if (this.isDestroyed) return;
			if (cache.has(url)) return;
			if (this.imageLoading.has(url)) return;
			if (this.isImageUncacheable(url, cache)) return;
			if (!isAllowedImageUrl(url)) {
				ImageFetchManager.log.debug("media.image.blocked", {
					reason: "not-in-cdn-whitelist",
					url
				});
				return;
			}
			this.imageLoading.add(url);
			const img = new Image();
			this.inFlightImages.add(img);
			const clearLoadTimeout = () => {
				const timeout = this.imageLoadTimeouts.get(img);
				if (timeout !== void 0) clearTimeout(timeout);
				this.imageLoadTimeouts.delete(img);
			};
			img.crossOrigin = "anonymous";
			img.onload = () => {
				clearLoadTimeout();
				this.imageLoading.delete(url);
				this.inFlightImages.delete(img);
				if (this.isDestroyed) return;
				if (!cache.set(url, img)) {
					this.recordUncacheableImage(url, cache);
					return;
				}
				this.preConvertForWorker(url, img);
			};
			img.onerror = () => {
				clearLoadTimeout();
				this.imageLoading.delete(url);
				this.inFlightImages.delete(img);
				if (this.isDestroyed) return;
			};
			this.imageLoadTimeouts.set(img, setTimeout(() => {
				this.imageLoadTimeouts.delete(img);
				img.onload = null;
				img.onerror = null;
				img.src = "";
				this.imageLoading.delete(url);
				this.inFlightImages.delete(img);
			}, this.emojiFetchTimeoutMs));
			img.src = url;
		}
		resizeImageCache(cache, maxBytes) {
			if (cache.maxBytes !== maxBytes) this.uncacheableImageUrlsByCache.delete(cache);
			cache.resize(maxBytes);
		}
		isImageUncacheable(url, cache) {
			return this.uncacheableImageUrlsByCache.get(cache)?.has(url) ?? false;
		}
		recordUncacheableImage(url, cache) {
			let urls = this.uncacheableImageUrlsByCache.get(cache);
			if (!urls) {
				urls = new Set();
				this.uncacheableImageUrlsByCache.set(cache, urls);
			}
			urls.add(url);
			if (urls.size <= 500) return;
			const oldest = urls.values().next().value;
			if (oldest !== void 0) urls.delete(oldest);
		}
		preConvertForWorker(url, img) {
			if (!this.useWorkerMode || !this.renderWorker) return;
			if (!img.complete || img.naturalWidth === 0) return;
			const generation = Symbol(url);
			this.bitmapGeneration.set(url, generation);
			createImageBitmap(img).then((bitmap) => {
				if (this.isDestroyed || !this.useWorkerMode || !this.renderWorker) {
					if (generation === this.bitmapGeneration.get(url)) this.bitmapGeneration.delete(url);
					bitmap.close();
					return;
				}
				if (generation !== this.bitmapGeneration.get(url)) {
					bitmap.close();
					return;
				}
				this.bitmapGeneration.delete(url);
				if (!this.workerBitmapCache.set(url, bitmap)) bitmap.close();
			}).catch(() => {
				if (generation === this.bitmapGeneration.get(url)) this.bitmapGeneration.delete(url);
			});
		}
		prefetchImages(message) {
			if (this.isDestroyed) return;
			for (const seg of message.content) {
				if (seg.type !== "emoji") continue;
				const emojiUrl = seg.emoji.url;
				if (!isAllowedImageUrl(emojiUrl)) {
					ImageFetchManager.log.debug("media.image.emoji-blocked", {
						reason: "not-in-cdn-whitelist",
						url: emojiUrl
					});
					continue;
				}
				if (this.emojiFetching.has(emojiUrl)) continue;
				if (this.emojiCache.has(emojiUrl)) continue;
				if (this.isImageUncacheable(emojiUrl, this.emojiCache)) continue;
				if (this.isEmojiFetchFailed(emojiUrl)) continue;
				if (this.emojiFetching.size >= this.emojiFetchLimit) continue;
				this.emojiFetching.add(emojiUrl);
				this.emojiFetchingStarted.set(emojiUrl, performance.now());
				const url = emojiUrl;
				const img = new Image();
				this.inFlightImages.add(img);
				this.emojiUrlToImage.set(url, img);
				img.crossOrigin = "anonymous";
				img.onload = () => {
					if (this.isDestroyed) return;
					this.inFlightImages.delete(img);
					this.emojiUrlToImage.delete(url);
					this.emojiFetching.delete(url);
					this.emojiFetchingStarted.delete(url);
					if (!this.emojiCache.set(url, img)) {
						this.recordUncacheableImage(url, this.emojiCache);
						return;
					}
					this.preConvertForWorker(url, img);
					this.onImageReadyCallback?.(url, "emoji");
				};
				img.onerror = () => {
					if (this.isDestroyed) return;
					this.inFlightImages.delete(img);
					this.emojiUrlToImage.delete(url);
					this.emojiFetching.delete(url);
					this.emojiFetchingStarted.delete(url);
					this.failedEmojiFetches.set(url, Date.now());
					if (this.failedEmojiFetches.size > FAILED_EMOJI_FETCH_CAP) {
						let evicted = 0;
						for (const key of this.failedEmojiFetches.keys()) {
							this.failedEmojiFetches.delete(key);
							if (++evicted >= FAILED_EMOJI_FETCH_EVICT_COUNT) break;
						}
					}
				};
				img.src = url;
			}
			if (message.authorPhotoUrl) this.loadImage(message.authorPhotoUrl, this.authorPhotoCache);
			const stickerUrl = message.superChat?.sticker?.url;
			if (stickerUrl) this.loadImage(stickerUrl, this.stickerCache);
		}
		isEmojiFetchFailed(url) {
			const ts = this.failedEmojiFetches.get(url);
			if (ts === void 0) return false;
			this.failedEmojiFetches.delete(url);
			this.failedEmojiFetches.set(url, ts);
			return true;
		}
		cleanupStaleEmojiFetching() {
			if (this.isDestroyed) return;
			const now = performance.now();
			for (const [url, startedAt] of this.emojiFetchingStarted) if (now - startedAt > this.emojiFetchTimeoutMs) {
				this.emojiFetching.delete(url);
				this.emojiFetchingStarted.delete(url);
				const img = this.emojiUrlToImage.get(url);
				if (img) {
					img.onload = null;
					img.onerror = null;
					img.src = "";
					this.inFlightImages.delete(img);
					this.emojiUrlToImage.delete(url);
				}
			}
			if (this.failedEmojiFetches.size > 0) {
				const cutoff = Date.now() - this.failedEmojiRetryMins * 6e4;
				for (const [url, failedAt] of this.failedEmojiFetches) if (failedAt < cutoff) this.failedEmojiFetches.delete(url);
			}
		}
		pause() {
			if (this.isEmojiCleanupPaused) return;
			this.isEmojiCleanupPaused = true;
			this.emojiCleanupIntervalId = clearSafeInterval(this.emojiCleanupIntervalId);
		}
		resume() {
			if (!this.isEmojiCleanupPaused) return;
			this.isEmojiCleanupPaused = false;
			this.startEmojiCleanupInterval();
		}
		destroy() {
			this.isDestroyed = true;
			this.emojiCleanupIntervalId = clearSafeInterval(this.emojiCleanupIntervalId);
			for (const img of this.inFlightImages) {
				const timeout = this.imageLoadTimeouts.get(img);
				if (timeout !== void 0) clearTimeout(timeout);
				img.onload = null;
				img.onerror = null;
				img.src = "";
			}
			this.imageLoadTimeouts.clear();
			this.inFlightImages.clear();
			this.emojiUrlToImage.clear();
			this.emojiFetching.clear();
			this.emojiFetchingStarted.clear();
			this.failedEmojiFetches.clear();
			this.imageLoading.clear();
			this.uncacheableImageUrlsByCache.clear();
			this.workerBitmapCache.clear();
			this.bitmapGeneration.clear();
			this.emojiCache.clear();
			this.authorPhotoCache.clear();
			this.stickerCache.clear();
			this.renderWorker = null;
			this.useWorkerMode = false;
			delete this.onImageReadyCallback;
		}
	};
	function applyDevicePixelRatio(canvas, ctx, dims) {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = dims.width * dpr;
		canvas.height = dims.height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		return dpr;
	}
	function updateCanvasDpr(canvas, ctx, dims, lastDpr) {
		const dpr = window.devicePixelRatio || 1;
		if (dpr === lastDpr) return lastDpr;
		canvas.width = dims.width * dpr;
		canvas.height = dims.height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		return dpr;
	}
	function setupOffscreenObserver(canvas, onOffscreen, onVisible) {
		const observer = new IntersectionObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			if (!entry.isIntersecting) onOffscreen();
			else onVisible();
		}, { threshold: 0 });
		observer.observe(canvas);
		return observer;
	}
	function disconnectObserver(observer) {
		if (observer) observer.disconnect();
	}
	function startOffscreenPoll(canvas, onVisible) {
		const intervalId = setInterval(() => {
			const rect = canvas.getBoundingClientRect();
			const viewportW = window.innerWidth;
			const viewportH = window.innerHeight;
			const isRectVisible = rect.width > 0 && rect.height > 0 && rect.left < viewportW && rect.top < viewportH && rect.right > 0 && rect.bottom > 0;
			const docVisible = document.visibilityState === "visible";
			if (isRectVisible && docVisible) {
				clearInterval(intervalId);
				onVisible();
			}
		}, 1e3);
		return () => {
			clearInterval(intervalId);
		};
	}
	function createDrainBatch(candidates) {
		return {
			candidates,
			committed: [],
			unplaceable: [],
			batchIndex: 0
		};
	}
	function recordDrainResult(batch, message, result) {
		if (result.oversized) batch.unplaceable.push(message);
		if (!result.placed) return false;
		batch.batchIndex++;
		batch.committed.push(message);
		return true;
	}
	function commitDrainBatch(queue, batch) {
		if (batch.committed.length > 0) queue.removeAll(batch.committed);
		if (batch.unplaceable.length > 0) queue.removeAll(batch.unplaceable);
	}
	function addMessageToLaneIndex(lanes, message, slotCount) {
		message.laneArrayIndices.length = slotCount;
		for (let slot = 0; slot < slotCount; slot++) {
			const lane = message.laneIndex + slot;
			let laneMessages = lanes.get(lane);
			if (!laneMessages) {
				laneMessages = [];
				lanes.set(lane, laneMessages);
			}
			message.laneArrayIndices[slot] = laneMessages.length;
			laneMessages.push(message);
		}
	}
	function removeMessageFromLaneIndex(lanes, message, slotCount) {
		for (let slot = 0; slot < slotCount; slot++) {
			const lane = message.laneIndex + slot;
			const laneMessages = lanes.get(lane);
			if (!laneMessages || laneMessages.length === 0) continue;
			const index = message.laneArrayIndices[slot];
			if (index === void 0 || index < 0 || index >= laneMessages.length) continue;
			const lastMessage = laneMessages[laneMessages.length - 1];
			if (lastMessage !== message) {
				laneMessages[index] = lastMessage;
				const swappedSlot = lane - lastMessage.laneIndex;
				if (swappedSlot >= 0 && swappedSlot < lastMessage.laneArrayIndices.length) lastMessage.laneArrayIndices[swappedSlot] = index;
			}
			laneMessages.pop();
			if (laneMessages.length === 0) lanes.delete(lane);
		}
	}
	function createFastRandom(seed) {
		let s = seed != null ? seed : Date.now() ^ Math.random() * 4294967295 >>> 0;
		return () => {
			s = Math.imul(1664525, s) + 1013904223 >>> 0;
			return s / 4294967295;
		};
	}
	var fastRandom = createFastRandom();
	function getCachedGradient(ctx, cache, baseColor, h, topAlpha, scAlpha, bottomAlpha) {
		const key = `${baseColor}|${h}|${topAlpha}|${scAlpha}|${bottomAlpha}`;
		const cached = cache.get(key);
		if (cached) return cached;
		if (cache.size >= 64) {
			const oldestKey = cache.keys().next().value;
			if (oldestKey !== void 0) cache.delete(oldestKey);
		}
		const grad = ctx.createLinearGradient(0, 0, 0, h);
		grad.addColorStop(0, toRgba(baseColor, topAlpha));
		grad.addColorStop(.48, toRgba(baseColor, scAlpha));
		grad.addColorStop(1, toRgba(baseColor, bottomAlpha));
		cache.set(key, grad);
		return grad;
	}
	function fastSin(elapsedMs) {
		return SIN_TABLE[(elapsedMs * SIN_LUT_SCALE | 0) & 255];
	}
	function computePulseAlpha(elapsedMs, baseAlpha, amplitude) {
		return fastSin(elapsedMs) * amplitude + baseAlpha;
	}
	var measureCtx = null;
	var textMeasureCallback = null;
	function setTextMeasureCallback(cb) {
		textMeasureCallback = cb;
	}
	var widthCache = new Map();
	var totalCacheEntries = 0;
	var WIDTH_CACHE_MAX = 1e3;
	var WIDTH_CACHE_EVICT_BATCH = Math.floor(WIDTH_CACHE_MAX * .1);
	var fontMetricsCache = new Map();
	function measureBoundingBoxWidth(m) {
		const rawBbWidth = Math.abs(m.actualBoundingBoxLeft) + Math.abs(m.actualBoundingBoxRight);
		const bbWidth = Number.isFinite(rawBbWidth) ? rawBbWidth : 0;
		const advanceWidth = Number.isFinite(m.width) ? Math.max(0, m.width) : 0;
		return Math.ceil(Math.max(bbWidth, advanceWidth));
	}
	var CSP_WIDTH_FACTOR = .6;
	var HEIGHT_FALLBACK_FACTOR = 1.1;
	function getCtx() {
		if (measureCtx === false) return null;
		if (!measureCtx) try {
			const canvas = document.createElement("canvas");
			canvas.width = 0;
			canvas.height = 0;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				measureCtx = false;
				return null;
			}
			measureCtx = ctx;
		} catch {
			measureCtx = false;
			return null;
		}
		return measureCtx;
	}
	function clearTextMeasurementCaches() {
		widthCache.clear();
		spaceWidthCache.clear();
		totalCacheEntries = 0;
		fontMetricsCache.clear();
	}
	var spaceWidthCache = new Map();
	function measureTextWidth(text, font) {
		if (text === " ") {
			const cached = spaceWidthCache.get(font);
			if (cached !== void 0) return cached;
		}
		const fontCache = widthCache.get(font);
		if (fontCache) {
			const cached = fontCache.get(text);
			if (cached !== void 0) return cached;
		}
		const ctx = getCtx();
		if (!ctx) {
			const capture = font.match(/(\d+)px/)?.[1];
			const fontSize = capture ? Number.parseInt(capture, 10) : 16;
			return Math.ceil(text.length * fontSize * CSP_WIDTH_FACTOR);
		}
		ctx.font = font;
		const t0 = textMeasureCallback ? performance.now() : 0;
		const m = ctx.measureText(text);
		if (textMeasureCallback) textMeasureCallback(performance.now() - t0);
		const width = measureBoundingBoxWidth(m);
		while (totalCacheEntries >= WIDTH_CACHE_MAX) {
			const oldestFont = widthCache.keys().next().value;
			if (oldestFont === void 0) break;
			const entries = widthCache.get(oldestFont);
			if (!entries || entries.size === 0) {
				widthCache.delete(oldestFont);
				continue;
			}
			let evicted = 0;
			for (const key of entries.keys()) {
				entries.delete(key);
				totalCacheEntries--;
				evicted++;
				if (evicted >= WIDTH_CACHE_EVICT_BATCH && entries.size > 0) break;
			}
			if (entries.size === 0) widthCache.delete(oldestFont);
		}
		if (text === " ") {
			spaceWidthCache.set(font, width);
			return width;
		}
		let innerCache = widthCache.get(font);
		if (!innerCache) {
			innerCache = new Map();
			widthCache.set(font, innerCache);
		}
		innerCache.set(text, width);
		totalCacheEntries++;
		return width;
	}
	function getFontMetrics(font, fontSize) {
		const cached = fontMetricsCache.get(font);
		if (cached) return cached;
		const ctx = getCtx();
		if (!ctx) {
			const fallback = Math.ceil(fontSize * HEIGHT_FALLBACK_FACTOR) / 2;
			return {
				ascent: fallback,
				descent: fallback
			};
		}
		ctx.font = font;
		const m = ctx.measureText("Mg");
		const ascent = m.actualBoundingBoxAscent ?? m.fontBoundingBoxAscent ?? 0;
		const descent = m.actualBoundingBoxDescent ?? m.fontBoundingBoxDescent ?? 0;
		const metrics = {
			ascent: Math.ceil(ascent),
			descent: Math.ceil(descent)
		};
		fontMetricsCache.set(font, metrics);
		return metrics;
	}
	function measureTextHeight(font, fontSize) {
		const metrics = getFontMetrics(font, fontSize);
		if (metrics.ascent > 0 && metrics.descent > 0) return metrics.ascent + metrics.descent;
		return Math.ceil(fontSize * HEIGHT_FALLBACK_FACTOR);
	}
	function getFontString(sizePx, weight = "bold", fontFamily = DEFAULT_FONT_FAMILY) {
		return `${weight === "bold" ? "bold" : "400"} ${sizePx}px ${fontFamily}`;
	}
	var MAX_TEXT_BITMAP_DIMENSION = 8192;
	function getSafeTextHeight(metrics, fontSize) {
		const rawAscent = metrics.actualBoundingBoxAscent;
		const rawDescent = metrics.actualBoundingBoxDescent;
		const ascent = Number.isFinite(rawAscent) ? Math.max(0, rawAscent) : Math.ceil(fontSize * .8);
		const descent = Number.isFinite(rawDescent) ? Math.max(0, rawDescent) : Math.ceil(fontSize * .2);
		return Math.max(1, Math.ceil(ascent + descent));
	}
	function canCacheTextBitmap(pixelWidth, pixelHeight, maxBytes) {
		if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) return false;
		if (pixelWidth <= 0 || pixelHeight <= 0) return false;
		if (pixelWidth > MAX_TEXT_BITMAP_DIMENSION || pixelHeight > MAX_TEXT_BITMAP_DIMENSION) return false;
		const requiredBytes = pixelWidth * pixelHeight * 4;
		return maxBytes === void 0 || requiredBytes <= maxBytes;
	}
	function resolveEmojiFields(seg) {
		return {
			emojiUrl: seg.emojiUrl || seg.emoji?.url || "",
			emojiAlt: seg.emojiAlt || seg.emoji?.alt,
			emojiFallbackText: seg.emojiFallbackText || seg.emoji?.fallbackText
		};
	}
	function getRenderableEmojiFallbackText(seg) {
		const { emojiAlt, emojiFallbackText } = resolveEmojiFields(seg);
		if (emojiFallbackText) return emojiFallbackText;
		return emojiAlt && !EMOJI_ALIAS_PATTERN.test(emojiAlt) ? emojiAlt : "";
	}
	function toSharedContentSegment(seg) {
		if (seg.type === "emoji") {
			const { url, alt, fallbackText } = seg.emoji ?? {};
			const result = { type: "emoji" };
			if (url !== void 0) result.emojiUrl = url;
			if (alt !== void 0) result.emojiAlt = alt;
			if (fallbackText !== void 0) result.emojiFallbackText = fallbackText;
			return result;
		}
		const result = { type: "text" };
		if (seg.content !== void 0) result.content = seg.content;
		return result;
	}
	function toSharedContentSegments(segments) {
		return segments.map((seg) => toSharedContentSegment(seg));
	}
	function getDisplayText(segments) {
		return segments.filter((s) => s.type === "text" && !!s.content).map((s) => s.content).join("");
	}
	var _graphemeSegmenter;
	function getGraphemeSegmenter() {
		if (_graphemeSegmenter === void 0) try {
			_graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
		} catch {
			_graphemeSegmenter = void 0;
		}
		return _graphemeSegmenter;
	}
	function splitGraphemeClusters(text) {
		const seg = getGraphemeSegmenter();
		if (seg) return Array.from(seg.segment(text), (s) => s.segment);
		return Array.from(text);
	}
	function measureTextAdvanceWidth(text, measureTextFn, letterSpacing = "0px") {
		const measuredWidth = measureTextFn(text);
		const baseWidth = Number.isFinite(measuredWidth) ? Math.max(0, measuredWidth) : 0;
		const parsedSpacing = Number.parseFloat(letterSpacing);
		const spacingPx = Number.isFinite(parsedSpacing) ? Math.max(0, parsedSpacing) : 0;
		if (spacingPx === 0) return baseWidth;
		return baseWidth + Math.max(0, splitGraphemeClusters(text).length - 1) * spacingPx;
	}
	function measureEmojiAdvanceWidth(segment, emojiSize, measureTextFn, letterSpacing = "0px") {
		const fallbackText = getRenderableEmojiFallbackText(segment);
		const fallbackWidth = fallbackText ? measureTextAdvanceWidth(fallbackText, measureTextFn, letterSpacing) : 0;
		return Math.max(emojiSize, fallbackWidth) + spacing.xs;
	}
	function reverseRtlText(text) {
		let hasRtl = false;
		for (const ch of text) {
			const cp = ch.codePointAt(0);
			if (cp === void 0) continue;
			if (cp >= 1424 && cp <= 2303 || cp >= 64285 && cp <= 65276) {
				hasRtl = true;
				break;
			}
			if (/\S/u.test(ch)) break;
		}
		if (!hasRtl) return text;
		return splitGraphemeClusters(text).reverse().join("");
	}
	function wrapCharSegments(word, maxWidth, measureTextFn) {
		const segments = [];
		let current = "";
		let currentWidth = 0;
		const chars = splitGraphemeClusters(word);
		for (let i = 0; i < chars.length; i++) {
			const ch = chars[i];
			const chWidth = measureTextFn(ch);
			if (currentWidth + chWidth > maxWidth && current.length > 0) {
				segments.push({
					text: current,
					width: currentWidth
				});
				current = ch;
				currentWidth = chWidth;
			} else {
				current += ch;
				currentWidth += chWidth;
			}
		}
		if (current.length > 0) segments.push({
			text: current,
			width: currentWidth
		});
		return segments;
	}
	function buildWrappedLines(segments, maxWidth, emojiSize, measureTextFn) {
		const pieces = [];
		for (const seg of segments) if (seg.type === "text") {
			const words = (seg.content ?? "").split(/\s+/).filter((w) => w.length > 0);
			for (const word of words) pieces.push({
				type: "text",
				text: word,
				width: measureTextFn(word)
			});
		} else {
			const url = seg.emojiUrl ?? seg.emoji?.url ?? "";
			const alt = seg.emojiAlt ?? seg.emoji?.alt;
			const fallbackText = seg.emojiFallbackText ?? seg.emoji?.fallbackText;
			if (url || getRenderableEmojiFallbackText(seg)) pieces.push({
				type: "emoji",
				emojiUrl: url,
				...alt ? { emojiAlt: alt } : {},
				...fallbackText ? { emojiFallbackText: fallbackText } : {},
				width: measureEmojiAdvanceWidth(seg, emojiSize, measureTextFn)
			});
		}
		const lines = [];
		if (pieces.length === 0) return {
			lines,
			maxLineWidth: 0
		};
		let currentLine = [];
		let currentWidth = 0;
		let prevIsText = false;
		const spaceWidth = measureTextFn(" ");
		let maxLineWidth = 0;
		for (const piece of pieces) {
			const gap = prevIsText ? spaceWidth : 0;
			const needed = gap + piece.width;
			if (piece.type === "text" && piece.width > maxWidth) {
				if (currentLine.length > 0) {
					maxLineWidth = Math.max(maxLineWidth, currentWidth);
					lines.push(currentLine);
				}
				const charSegs = wrapCharSegments(piece.text, maxWidth, measureTextFn);
				if (charSegs.length <= 1) {
					currentLine = [piece];
					currentWidth = piece.width;
					prevIsText = true;
					continue;
				}
				for (let i = 0; i < charSegs.length - 1; i++) {
					const cs = charSegs[i];
					lines.push([{
						type: "text",
						text: cs.text,
						width: cs.width
					}]);
					maxLineWidth = Math.max(maxLineWidth, cs.width);
				}
				const lastSeg = charSegs[charSegs.length - 1];
				currentLine = [{
					type: "text",
					text: lastSeg.text,
					width: lastSeg.width
				}];
				currentWidth = lastSeg.width;
				prevIsText = true;
				continue;
			}
			if (currentLine.length > 0 && currentWidth + needed > maxWidth) {
				maxLineWidth = Math.max(maxLineWidth, currentWidth);
				lines.push(currentLine);
				currentLine = [piece];
				currentWidth = piece.width;
				prevIsText = piece.type === "text";
				continue;
			}
			if (gap > 0) currentWidth += gap;
			currentLine.push(piece);
			currentWidth += piece.width;
			prevIsText = piece.type === "text";
		}
		if (currentLine.length > 0) {
			maxLineWidth = Math.max(maxLineWidth, currentWidth);
			lines.push(currentLine);
		}
		return {
			lines,
			maxLineWidth
		};
	}
	function strokeTextOutline(ctx, text, x, y, textColor, outlineWidthPx, outlineOpacity) {
		if (outlineWidthPx <= 0 || outlineOpacity <= 0) return;
		const strokeWidth = Math.max(.5, outlineWidthPx * OUTLINE_STROKE_SCALE);
		ctx.save();
		ctx.strokeStyle = computeOutlineColor(textColor, Math.min(1, outlineOpacity));
		ctx.lineWidth = strokeWidth;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		ctx.miterLimit = 2;
		ctx.strokeText(text, x, y);
		ctx.restore();
	}
	var _roundRectCapable = new WeakSet();
	function hasRoundRect(ctx) {
		if (_roundRectCapable.has(ctx)) return true;
		if (typeof ctx.roundRect === "function") {
			_roundRectCapable.add(ctx);
			return true;
		}
		return false;
	}
	function drawRoundRect(ctx, x, y, w, h, r) {
		ctx.beginPath();
		if (hasRoundRect(ctx)) {
			ctx.roundRect(x, y, w, h, r);
			return;
		}
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + w - r, y);
		ctx.arcTo(x + w, y, x + w, y + r, r);
		ctx.lineTo(x + w, y + h - r);
		ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
		ctx.lineTo(x + r, y + h);
		ctx.arcTo(x, y + h, x, y + h - r, r);
		ctx.lineTo(x, y + r);
		ctx.arcTo(x, y, x + r, y, r);
		ctx.closePath();
	}
	function renderRegularMessageBackground(ctx, x, y, width, height, color) {
		if (width <= 0 || height <= 0 || color.endsWith("00")) return;
		const radius = Math.min(rendererLayout.messageBackgroundRadius, width / 2, height / 2);
		ctx.fillStyle = color;
		drawRoundRect(ctx, x, y, width, height, radius);
		ctx.fill();
	}
	function cacheTextBitmap(key, text, font, fontSize, fillColor, strokeWidth, strokeColor, ctx, textBitmapCache, letterSpacing = "0px") {
		if (!ctx) return;
		ctx.save();
		ctx.font = font;
		ctx.textBaseline = "top";
		const metrics = ctx.measureText(text);
		const rawBbWidth = Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight);
		const bbWidth = Number.isFinite(rawBbWidth) ? rawBbWidth : 0;
		const measuredWidth = Number.isFinite(metrics.width) ? metrics.width : 0;
		const textWidth = bbWidth > 0 ? Math.ceil(bbWidth) : Math.ceil(measuredWidth);
		const lsPx = parseFloat(letterSpacing) || 0;
		const lsExtraWidth = lsPx > 0 ? Math.ceil(Math.max(0, [...text].length - 1) * lsPx) : 0;
		const width = textWidth + Math.ceil(strokeWidth) + 2 + lsExtraWidth;
		const height = getSafeTextHeight(metrics, fontSize) + Math.ceil(strokeWidth) + 2;
		ctx.restore();
		const rawDpr = ctx.getTransform().a;
		const dpr = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
		const pixelWidth = Math.ceil(width * dpr);
		const pixelHeight = Math.ceil(height * dpr);
		if (!canCacheTextBitmap(pixelWidth, pixelHeight, textBitmapCache.maxBytes)) return;
		const offscreen = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(pixelWidth, pixelHeight) : (() => {
			const canvas = document.createElement("canvas");
			canvas.width = pixelWidth;
			canvas.height = pixelHeight;
			return canvas;
		})();
		const offCtx = offscreen.getContext("2d");
		if (!offCtx) return;
		offCtx.scale(dpr, dpr);
		offCtx.font = font;
		offCtx.textBaseline = "top";
		offCtx.letterSpacing = letterSpacing;
		offCtx.textRendering = "optimizeLegibility";
		offCtx.fontKerning = "auto";
		offCtx.strokeStyle = strokeColor;
		offCtx.lineWidth = strokeWidth;
		offCtx.lineJoin = "round";
		offCtx.lineCap = "round";
		offCtx.miterLimit = 2;
		offCtx.strokeText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);
		offCtx.fillStyle = fillColor;
		offCtx.fillText(text, strokeWidth / 2 + 1, strokeWidth / 2 + 1);
		textBitmapCache.set(key, offscreen);
	}
	function drawBitmapAtCssSize(ctx, bitmap, x, y) {
		let bw = 0;
		let bh = 0;
		if (typeof HTMLCanvasElement !== "undefined" && bitmap instanceof HTMLCanvasElement || bitmap instanceof OffscreenCanvas) {
			bw = bitmap.width;
			bh = bitmap.height;
		}
		if (bw <= 0 || bh <= 0) {
			ctx.drawImage(bitmap, x, y);
			return;
		}
		const dpr = ctx.getTransform().a || 1;
		ctx.drawImage(bitmap, x, y, bw / dpr, bh / dpr);
	}
	function renderSegment(ctx, text, x, y, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn, letterSpacing = "0px") {
		const displayText = reverseRtlText(text);
		const font = getFontFn(fontSize);
		const strokeWidth = Math.max(.5, outlineWidthPx * OUTLINE_STROKE_SCALE);
		const strokeColor = computeOutlineColor(color, Math.min(1, outlineOpacity));
		const outlineClass = strokeColor.startsWith("rgba(0, 0, 0") ? "dark" : "light";
		if (outlineWidthPx > 0 && outlineOpacity > 0 && displayText.length >= 3) {
			const key = `${font}|${displayText}|${color}|${Math.round(strokeWidth)}|${outlineClass}|${letterSpacing}`;
			const bitmap = textBitmapCache.get(key);
			if (bitmap) {
				drawBitmapAtCssSize(ctx, bitmap, x, y);
				return;
			}
			cacheTextBitmap(key, displayText, font, fontSize, color, strokeWidth, strokeColor, ctx, textBitmapCache, letterSpacing);
			const freshBitmap = textBitmapCache.get(key);
			if (freshBitmap) {
				drawBitmapAtCssSize(ctx, freshBitmap, x, y);
				return;
			}
		}
		ctx.save();
		ctx.font = font;
		ctx.textBaseline = "top";
		ctx.textRendering = "optimizeSpeed";
		ctx.fontKerning = "none";
		ctx.letterSpacing = letterSpacing;
		strokeTextOutline(ctx, displayText, x, y, color, outlineWidthPx, outlineOpacity);
		ctx.fillStyle = color;
		ctx.fillText(displayText, x, y);
		ctx.restore();
	}
	function warmTextBitmapCache(segments, fontSize, fontWeight, fontFamily, color, outlineWidthPx, outlineOpacity, textBitmapCache, ctx, letterSpacing) {
		if (outlineWidthPx <= 0 || outlineOpacity <= 0) return;
		const strokeWidth = Math.max(.5, outlineWidthPx * OUTLINE_STROKE_SCALE);
		const strokeColor = computeOutlineColor(color, Math.min(1, outlineOpacity));
		const keyLetterSpacing = letterSpacing ?? "0px";
		const warmSingle = (text, ls) => {
			const displayText = reverseRtlText(text);
			if (displayText.length < 3) return;
			const font = getFontString(fontSize, fontWeight, fontFamily);
			const outlineClass = strokeColor.startsWith("rgba(0, 0, 0") ? "dark" : "light";
			const key = `${font}|${displayText}|${color}|${Math.round(strokeWidth)}|${outlineClass}|${ls}`;
			if (textBitmapCache.get(key)) return;
			cacheTextBitmap(key, displayText, font, fontSize, color, strokeWidth, strokeColor, ctx, textBitmapCache, ls);
		};
		if (typeof segments === "string") warmSingle(segments, keyLetterSpacing);
		else for (const seg of segments) if (seg.type === "text" && seg.content) warmSingle(seg.content, keyLetterSpacing);
	}
	function renderContentSegments(ctx, segments, startX, y, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn, measureTextFn, emojiCache, isValidEmoji, letterSpacing = "0px") {
		let cursorX = startX;
		const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
		const textHeight = measureTextHeight(getFontFn(fontSize), fontSize);
		const emojiY = y + Math.round((textHeight - emojiSize) / 2);
		for (const seg of segments) if (seg.type === "text" && seg.content) {
			renderSegment(ctx, seg.content, cursorX, y, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn, letterSpacing);
			cursorX += measureTextAdvanceWidth(seg.content, measureTextFn, letterSpacing);
		} else {
			const { emojiUrl } = resolveEmojiFields(seg);
			const fallbackText = getRenderableEmojiFallbackText(seg);
			const img = emojiUrl ? emojiCache.get(emojiUrl) : null;
			let advanceWidth = emojiSize + spacing.xs;
			if (img != null && isValidEmoji(img)) ctx.drawImage(img, cursorX, emojiY, emojiSize, emojiSize);
			else if (fallbackText) {
				renderSegment(ctx, fallbackText, cursorX, y, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn, letterSpacing);
				advanceWidth = measureEmojiAdvanceWidth(seg, emojiSize, measureTextFn, letterSpacing);
			}
			cursorX += advanceWidth;
		}
	}
	var _photoShadowCache = new WeakMap();
	var AUTHOR_PHOTO_SHADOW_PAD = 5;
	var AUTHOR_PHOTO_CANVAS_SIZE = rendererLayout.authorPhotoSize + 10;
	function drawAuthorPhoto(ctx, photo, x, y) {
		const dpr = ctx.getTransform().a || 1;
		const photoSize = rendererLayout.authorPhotoSize;
		const totalSize = AUTHOR_PHOTO_CANVAS_SIZE;
		const cached = _photoShadowCache.get(photo);
		if (cached) {
			ctx.drawImage(cached, x - AUTHOR_PHOTO_SHADOW_PAD, y - AUTHOR_PHOTO_SHADOW_PAD, totalSize, totalSize);
			return;
		}
		const offscreen = new OffscreenCanvas(Math.ceil(totalSize * dpr), Math.ceil(totalSize * dpr));
		const octx = offscreen.getContext("2d");
		if (!octx) {
			ctx.save();
			ctx.shadowColor = AUTHOR_PHOTO_SHADOW;
			ctx.shadowBlur = 4;
			ctx.shadowOffsetX = 1;
			ctx.shadowOffsetY = 1;
			ctx.drawImage(photo, x, y, photoSize, photoSize);
			ctx.restore();
			return;
		}
		octx.scale(dpr, dpr);
		octx.shadowColor = AUTHOR_PHOTO_SHADOW;
		octx.shadowBlur = 4;
		octx.shadowOffsetX = 1;
		octx.shadowOffsetY = 1;
		octx.drawImage(photo, AUTHOR_PHOTO_SHADOW_PAD, AUTHOR_PHOTO_SHADOW_PAD, photoSize, photoSize);
		_photoShadowCache.set(photo, offscreen);
		ctx.drawImage(offscreen, x - AUTHOR_PHOTO_SHADOW_PAD, y - AUTHOR_PHOTO_SHADOW_PAD, totalSize, totalSize);
	}
	function isCanvasImageSource(value) {
		if (typeof value !== "object" || value === null) return false;
		const obj = value;
		return (typeof obj.width === "number" || typeof obj.naturalWidth === "number") && (typeof obj.height === "number" || typeof obj.naturalHeight === "number");
	}
	function drawAuthorSection(ctx, message, textX, startY, color, maxNameWidth, authorFontSize, fontWeight, fontFamily, outlineWidthPx, outlineOpacity, photoCache, isValidPhoto, textBitmapCache, getFontFn) {
		if (!message.author) return startY;
		const prevFont = ctx.font;
		const prevTextBaseline = ctx.textBaseline;
		const nameFont = getFontString(authorFontSize, fontWeight, fontFamily);
		ctx.font = nameFont;
		const nameHeight = getSafeTextHeight(ctx.measureText("Mg"), authorFontSize);
		const sectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);
		const authorPhotoUrl = message.authorPhotoUrl;
		let hasPhoto = false;
		if (authorPhotoUrl) {
			const photo = photoCache.get(authorPhotoUrl);
			if (photo != null && isValidPhoto(photo) && isCanvasImageSource(photo)) {
				drawAuthorPhoto(ctx, photo, textX, startY);
				hasPhoto = true;
			}
		}
		const nameX = textX + (hasPhoto ? rendererLayout.authorPhotoSize + spacing.xs : 0);
		const nameY = startY + Math.max(0, Math.floor((sectionHeight - nameHeight) / 2));
		let displayName = message.author;
		if (maxNameWidth !== void 0 && maxNameWidth > 0) {
			ctx.font = nameFont;
			ctx.textBaseline = "top";
			if (ctx.measureText(displayName).width > maxNameWidth) {
				const ellipsis = "…";
				if (ctx.measureText(ellipsis).width >= maxNameWidth) {
					ctx.font = prevFont;
					ctx.textBaseline = prevTextBaseline;
					return startY + sectionHeight;
				}
				const graphemes = splitGraphemeClusters(displayName);
				let lo = 0;
				let hi = graphemes.length;
				while (lo < hi) {
					const mid = Math.floor((lo + hi) / 2);
					const testText = graphemes.slice(0, mid).join("") + ellipsis;
					if (ctx.measureText(testText).width <= maxNameWidth) lo = mid + 1;
					else hi = mid;
				}
				displayName = graphemes.slice(0, Math.max(0, lo - 1)).join("") + ellipsis;
			}
		}
		renderSegment(ctx, displayName, nameX, nameY, color, authorFontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn);
		ctx.font = prevFont;
		ctx.textBaseline = prevTextBaseline;
		return startY + sectionHeight;
	}
	function renderRegularMessage(ctx, message, x, y, config, textBitmapCache, emojiCache, isValidEmoji, authorPhotoCache, isValidAuthorPhoto, getFontFn, measureTextFn, overrideText, letterSpacing = "0px") {
		const { showAuthor, fontSize, fontWeight, fontFamily, color, outlineWidthPx, outlineOpacity, backgroundColor, messageWidth, messageHeight } = config;
		renderRegularMessageBackground(ctx, x, y, messageWidth, messageHeight, backgroundColor);
		const textX = x + rendererLayout.paddingH;
		let textY = y;
		if (showAuthor && message.author) {
			const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
			textY = drawAuthorSection(ctx, message, textX, textY, color, void 0, authorFontSize, fontWeight, fontFamily, outlineWidthPx, outlineOpacity, authorPhotoCache, isValidAuthorPhoto, textBitmapCache, getFontFn);
		}
		if (overrideText) renderSegment(ctx, overrideText, textX, textY, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn, letterSpacing);
		else if (message.content.length > 0) renderContentSegments(ctx, message.content, textX, textY, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn, measureTextFn, emojiCache, isValidEmoji, letterSpacing);
		else if (message.text.length > 0) renderSegment(ctx, message.text, textX, textY, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn, letterSpacing);
	}
	function renderWrappedContentSegments(ctx, segments, x, y, maxWidth, maxLines, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, emojiCache, getFontFn) {
		if (segments.length === 0) return y;
		const font = getFontFn(fontSize);
		const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
		const lineHeight = Math.ceil(measureTextHeight(font, fontSize));
		const spaceWidth = measureTextWidth(" ", font);
		const ellipsis = "…";
		const { lines } = buildWrappedLines(segments, maxWidth, emojiSize, (t) => measureTextWidth(t, font));
		const renderLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
		const isTruncated = lines.length > maxLines;
		let cursorY = y;
		for (let li = 0; li < renderLines.length; li++) {
			const line = renderLines[li];
			if (!line) continue;
			const needsEllipsis = li === renderLines.length - 1 && isTruncated;
			let cursorX = x;
			let prevText = false;
			const emojiLineY = cursorY + Math.round((lineHeight - emojiSize) / 2);
			for (const piece of line) {
				if (prevText) cursorX += spaceWidth;
				prevText = piece.type === "text";
				if (piece.type === "text") {
					renderSegment(ctx, piece.text, cursorX, cursorY, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn);
					cursorX += piece.width;
				} else {
					const cached = piece.emojiUrl ? emojiCache.get(piece.emojiUrl) : void 0;
					const img = cached != null && ("naturalWidth" in cached && cached.naturalWidth > 0 || "width" in cached && cached.width > 0) ? cached : null;
					let advanceWidth = emojiSize + spacing.xs;
					if (img) ctx.drawImage(img, cursorX, emojiLineY, emojiSize, emojiSize);
					else if (piece.emojiFallbackText) {
						renderSegment(ctx, piece.emojiFallbackText, cursorX, cursorY, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn);
						advanceWidth = piece.width;
					} else if (piece.emojiAlt && !EMOJI_ALIAS_PATTERN.test(piece.emojiAlt)) {
						renderSegment(ctx, piece.emojiAlt, cursorX, cursorY, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn);
						advanceWidth = piece.width;
					}
					cursorX += advanceWidth;
				}
			}
			if (needsEllipsis) renderSegment(ctx, ellipsis, cursorX, cursorY, color, fontSize, outlineWidthPx, outlineOpacity, textBitmapCache, getFontFn);
			cursorY += lineHeight;
		}
		return cursorY;
	}
	function drawLeftRoundedRect(ctx, x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + w, y);
		ctx.lineTo(x + w, y + h);
		ctx.lineTo(x + r, y + h);
		ctx.arcTo(x, y + h, x, y + h - r, r);
		ctx.lineTo(x, y + r);
		ctx.arcTo(x, y, x + r, y, r);
		ctx.closePath();
	}
	function renderCardBackground(ctx, x, y, w, h, config, gradientCache, baseColor, topAlpha, scAlpha, bottomAlpha) {
		if (config.background === "gradient" && gradientCache) {
			const grad = getCachedGradient(ctx, gradientCache, baseColor, h, topAlpha, scAlpha, bottomAlpha);
			ctx.save();
			ctx.translate(x, y);
			ctx.fillStyle = grad;
			drawRoundRect(ctx, 0, 0, w, h, config.cardRadius);
			ctx.fill();
			ctx.restore();
		} else if (config.backgroundColor) {
			ctx.save();
			const bg = config.backgroundColor;
			ctx.fillStyle = `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${config.backgroundAlpha ?? 1})`;
			drawRoundRect(ctx, x, y, w, h, config.cardRadius);
			ctx.fill();
			ctx.restore();
		}
	}
	function renderCardDecoration(ctx, x, y, w, h, elapsed, config, message, _baseColor) {
		if (config.decoration === "accentBar" && config.accentBar) {
			const barColorRaw = config.accentBar.color;
			const barRgb = typeof barColorRaw === "function" ? barColorRaw(message) : barColorRaw;
			const barWidth = config.accentBar.width;
			ctx.fillStyle = `rgb(${barRgb.r}, ${barRgb.g}, ${barRgb.b})`;
			drawLeftRoundedRect(ctx, x, y, barWidth, h, config.cardRadius);
			ctx.fill();
		} else if (config.decoration === "pulsingBorder" && config.pulsingBorder) {
			const pb = config.pulsingBorder;
			const pulse = computePulseAlpha(elapsed, pb.baseAlpha, pb.amplitude);
			ctx.save();
			drawRoundRect(ctx, x, y, w, h, config.cardRadius);
			ctx.strokeStyle = `rgba(${pb.borderRgb.r}, ${pb.borderRgb.g}, ${pb.borderRgb.b}, ${pulse})`;
			ctx.lineWidth = pb.borderWidth;
			ctx.stroke();
			ctx.restore();
		}
	}
	function renderCardHeaderTag(ctx, x, y, text, maxWidth, config, settings, _textBitmapCache, getFontFn) {
		if (!config.headerTag) return y;
		const headerFontSize = Math.round(settings.fontSize * config.headerTag.fontSizeScale);
		const headerFont = getFontFn(headerFontSize);
		ctx.font = headerFont;
		ctx.textBaseline = "top";
		let displayText = text;
		if (ctx.measureText(displayText).width > maxWidth) {
			const clusters = splitGraphemeClusters(displayText);
			let lo = 0, hi = clusters.length;
			while (lo < hi) {
				const mid = Math.floor((lo + hi) / 2);
				if (ctx.measureText(`${clusters.slice(0, mid).join("")}…`).width > maxWidth) hi = mid;
				else lo = mid + 1;
			}
			displayText = lo > 0 ? `${clusters.slice(0, lo - 1).join("")}…` : "…";
		}
		const tagY = y + (config.headerTag.marginTop ?? 0);
		renderSegment(ctx, displayText, x, tagY, config.headerTag.color, headerFontSize, settings.outline.enabled ? settings.outline.widthPx : 0, settings.outline.enabled ? settings.outline.opacity : 0, _textBitmapCache, getFontFn);
		return tagY + measureTextHeight(headerFont, headerFontSize) + (config.headerTag.marginBottom ?? 0);
	}
	function renderCardBadge(ctx, x, y, text, fontSize, config, settings, _textBitmapCache2, getFontFn) {
		if (!config.badge) return y;
		const badge = config.badge;
		const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
		ctx.font = getFontFn(badgeFontSize);
		const badgeWidth = Math.ceil(ctx.measureText(text).width) + badge.paddingH * 2;
		const badgeHeight = badgeFontSize + badge.paddingV * 2;
		drawRoundRect(ctx, x, y, badgeWidth, badgeHeight, badge.radius);
		ctx.save();
		ctx.fillStyle = badge.fillColor;
		ctx.fill();
		ctx.strokeStyle = badge.strokeColor;
		ctx.lineWidth = badge.strokeWidth;
		ctx.stroke();
		const textY = y + (badgeHeight - measureTextHeight(getFontFn(badgeFontSize), badgeFontSize)) / 2;
		renderSegment(ctx, text, x + badge.paddingH, textY, DEFAULT_TEXT_COLOR, badgeFontSize, settings.outline.enabled ? settings.outline.widthPx : 0, settings.outline.enabled ? settings.outline.opacity : 0, _textBitmapCache2, getFontFn);
		ctx.restore();
		return y + badgeHeight;
	}
	function renderPaidCard(ctx, message, msgWidth, msgHeight, x, y, elapsed, config, settings, textBitmapCache, authorPhotoCache, stickerCache, emojiCache, getFontFn, gradientCache) {
		const fontSize = settings.fontSize;
		const w = msgWidth;
		const h = msgHeight;
		const rgb = config.resolveColor(message);
		const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
		const textColor = config.textColor === "auto" ? computeReadableTextColor(baseColor) : config.textColor;
		let topAlpha = 1;
		let scAlpha = 1;
		let bottomAlpha = 1;
		if (config.background === "gradient" && config.backgroundGradient) {
			const bg = config.backgroundGradient;
			scAlpha = Math.min(1, Math.max(bg.minOpacity, settings.superChatOpacity));
			topAlpha = Math.min(1, scAlpha + bg.topBoost);
			bottomAlpha = Math.max(bg.minOpacity, scAlpha - bg.bottomReduction);
		}
		renderCardBackground(ctx, x, y, w, h, config, gradientCache, baseColor, topAlpha, scAlpha, bottomAlpha);
		renderCardDecoration(ctx, x, y, w, h, elapsed, config, message, baseColor);
		const padH = config.padding.horizontal;
		const padV = config.padding.vertical;
		const textX = x + padH;
		let cursorY = y + padV;
		if ((typeof config.authorSection.show === "function" ? config.authorSection.show(message, settings) : config.authorSection.show) && message.author) cursorY = drawAuthorSection(ctx, message, textX, cursorY, textColor, config.authorSection.nameMaxWidth, Math.round(settings.fontSize * rendererLayout.authorFontScale), settings.fontWeight, settings.fontFamily, settings.outline.enabled ? settings.outline.widthPx : 0, settings.outline.enabled ? settings.outline.opacity : 0, authorPhotoCache, isReadyHtmlImage, textBitmapCache, getFontFn);
		if (config.headerTag?.getText) {
			const headerText = config.headerTag.getText(message);
			if (headerText) {
				const headerMaxWidth = w - padH * 2;
				cursorY = renderCardHeaderTag(ctx, textX, cursorY, headerText, headerMaxWidth, config, settings, textBitmapCache, getFontFn);
			}
		}
		if (config.badge?.getText && settings.showSuperChatAmount) {
			const badgeText = config.badge.getText(message);
			if (badgeText) cursorY = renderCardBadge(ctx, textX, cursorY + spacing.xs, badgeText, fontSize, config, settings, textBitmapCache, getFontFn);
		}
		let textBottomY = cursorY;
		if (message.content.length > 0) {
			const bodyMaxWidth = w - padH * 2;
			const bodyMaxLines = config.body.maxLines === "fromSettings" ? message.kind === "superchat" ? settings.superChatMaxBodyLines : settings.membershipMaxBodyLines : config.body.maxLines;
			textBottomY = renderWrappedContentSegments(ctx, message.content, textX, cursorY + config.body.marginTop, bodyMaxWidth, bodyMaxLines, textColor, fontSize, settings.outline.enabled ? settings.outline.widthPx : 0, settings.outline.enabled ? settings.outline.opacity : 0, textBitmapCache, emojiCache, getFontFn);
		}
		if (config.sticker?.getUrl) {
			const stickerUrl = config.sticker.getUrl(message);
			if (stickerUrl) {
				const cached = stickerCache.get(stickerUrl);
				const stickerImg = cached?.complete && cached.naturalWidth > 0 ? cached : null;
				if (stickerImg) {
					const maxStickerSize = Math.round(fontSize * config.sticker.sizeScale);
					const stickerY = textBottomY + (config.sticker.marginTop ?? 0);
					const availableHeight = y + h - padV - stickerY;
					const stickerSize = Math.max(0, Math.min(maxStickerSize, availableHeight));
					if (stickerSize > 0) ctx.drawImage(stickerImg, textX, stickerY, stickerSize, stickerSize);
				}
			}
		}
	}
	function isReadyHtmlImage(photo) {
		return photo.complete && photo.naturalWidth > 0;
	}
	function toWorkerConfig(config, message, settings) {
		const resolveColorRgb = config.resolveColor(message);
		const baseColor = `rgb(${resolveColorRgb.r}, ${resolveColorRgb.g}, ${resolveColorRgb.b})`;
		const textColor = config.textColor === "auto" ? computeReadableTextColor(baseColor) : config.textColor;
		const accentBar = config.accentBar;
		let accentBarWorker;
		if (accentBar) {
			const rawColor = accentBar.color;
			const resolvedColor = typeof rawColor === "function" ? rawColor(message) : rawColor;
			accentBarWorker = {
				width: accentBar.width,
				color: resolvedColor
			};
		}
		const authorShow = typeof config.authorSection.show === "function" ? config.authorSection.show(message, settings) : config.authorSection.show;
		const bodyMaxLines = config.body.maxLines === "fromSettings" ? message.kind === "superchat" ? settings.superChatMaxBodyLines : settings.membershipMaxBodyLines : config.body.maxLines;
		return {
			background: config.background,
			backgroundGradient: config.backgroundGradient ?? void 0,
			backgroundColor: config.backgroundColor ? { ...config.backgroundColor } : void 0,
			backgroundAlpha: config.backgroundAlpha,
			decoration: config.decoration,
			accentBar: accentBarWorker,
			pulsingBorder: config.pulsingBorder ? {
				borderRgb: config.pulsingBorder.borderRgb,
				borderWidth: config.pulsingBorder.borderWidth,
				baseAlpha: config.pulsingBorder.baseAlpha,
				amplitude: config.pulsingBorder.amplitude
			} : void 0,
			badgeEnabled: config.badge !== void 0,
			badgeFillColor: config.badge?.fillColor ?? "",
			badgeStrokeColor: config.badge?.strokeColor ?? "",
			badgeRadius: config.badge?.radius ?? 0,
			badgePaddingH: config.badge?.paddingH ?? 0,
			badgePaddingV: config.badge?.paddingV ?? 0,
			badgeStrokeWidth: config.badge?.strokeWidth ?? 0,
			headerTagEnabled: config.headerTag !== void 0,
			headerTagFontSizeScale: config.headerTag?.fontSizeScale ?? .8,
			headerTagColor: config.headerTag?.color ?? "#ffffff",
			headerTagMarginTop: config.headerTag?.marginTop ?? 0,
			headerTagMarginBottom: config.headerTag?.marginBottom ?? 0,
			authorShow,
			authorNameMaxWidth: config.authorSection.nameMaxWidth,
			bodyMaxLines,
			bodyMarginTop: config.body.marginTop,
			stickerEnabled: config.sticker !== void 0,
			stickerSizeScale: config.sticker?.sizeScale ?? 0,
			stickerMarginTop: config.sticker?.marginTop ?? 0,
			showBadgeAmount: settings.showSuperChatAmount,
			padding: { ...config.padding },
			cardRadius: config.cardRadius,
			textColor,
			resolveColorRgb,
			needsGradientCache: config.needsGradientCache,
			needsElapsed: config.needsElapsed
		};
	}
	var SUPERCHAT_CARD_CONFIG = {
		background: "gradient",
		backgroundGradient: {
			topBoost: .12,
			bottomReduction: .15,
			minOpacity: .35
		},
		decoration: "accentBar",
		accentBar: {
			width: rendererLayout.superchatAccentBarWidth,
			color: (message) => {
				const superChat = message.superChat;
				return resolveSuperChatRgb(superChat ?? { tier: "blue" }, colors.superChat);
			}
		},
		badge: {
			getText: (message) => message.superChat?.amount,
			fillColor: SUPERCHAT_AMOUNT_BADGE_FILL,
			strokeColor: SUPERCHAT_AMOUNT_BADGE_STROKE,
			radius: rendererLayout.superchatBadge.radius,
			paddingH: rendererLayout.superchatBadge.paddingH,
			paddingV: rendererLayout.superchatBadge.paddingV,
			strokeWidth: rendererLayout.superchatBadgeStrokeWidth
		},
		authorSection: {
			show: (message, settings) => settings.showAuthor.superChat && !!message.author,
			nameMaxWidth: rendererLayout.authorNameMaxWidth
		},
		body: {
			maxLines: "fromSettings",
			marginTop: spacing.xs
		},
		sticker: {
			getUrl: (message) => message.superChat?.sticker?.url,
			sizeScale: rendererLayout.superchatStickerSize,
			marginTop: spacing.xs
		},
		padding: {
			horizontal: rendererLayout.superchat.paddingH,
			vertical: rendererLayout.superchat.paddingV
		},
		cardRadius: rendererLayout.superchatCardRadius,
		textColor: "auto",
		resolveColor: (message) => {
			const superChat = message.superChat;
			return resolveSuperChatRgb(superChat ?? { tier: "blue" }, colors.superChat);
		},
		needsGradientCache: true,
		needsElapsed: false
	};
	var MEMBERSHIP_CARD_CONFIG = (() => {
		const mem = colors.membership;
		return {
			background: "solid",
			backgroundColor: mem.background,
			backgroundAlpha: mem.backgroundAlpha,
			decoration: "pulsingBorder",
			pulsingBorder: {
				borderRgb: mem.borderRgb,
				borderWidth: rendererLayout.membershipBorderWidth,
				baseAlpha: mem.borderAlpha,
				amplitude: mem.borderAlphaAmplitude
			},
			headerTag: {
				getText: (message) => message.membershipHeader,
				fontSizeScale: .8,
				color: mem.headerText,
				marginTop: 0,
				marginBottom: spacing.xs
			},
			authorSection: {
				show: (message) => !!message.author,
				nameMaxWidth: rendererLayout.authorNameMaxWidth
			},
			body: {
				maxLines: "fromSettings",
				marginTop: spacing.xs
			},
			padding: {
				horizontal: rendererLayout.membership.paddingH,
				vertical: rendererLayout.membership.paddingV
			},
			cardRadius: rendererLayout.membershipCardRadius,
			textColor: DEFAULT_TEXT_COLOR,
			resolveColor: () => mem.background,
			needsGradientCache: false,
			needsElapsed: true
		};
	})();
	var log$15 = createLogger("AuthorRateLimiter");
	var DEFAULT_WINDOW_MS = 5e3;
	var DEFAULT_MAX_PER_WINDOW = 5;
	var PRIORITY_EXEMPT_THRESHOLD = 100;
	var PRUNE_INTERVAL_MS = 1e4;
	var BURST_LIMITS = {
		normal: null,
		elevated: null,
		high: 3,
		extreme: 2
	};
	function findFirstTimestampAfterCutoff(timestamps, cutoff) {
		let lo = 0;
		let hi = timestamps.length;
		while (lo < hi) {
			const mid = lo + hi >>> 1;
			if ((timestamps[mid] ?? 0) <= cutoff) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
	var PerAuthorRateLimiter = class {
		authorTimestamps = new Map();
		windowMs = DEFAULT_WINDOW_MS;
		maxPerWindow = DEFAULT_MAX_PER_WINDOW;
		enabled = true;
		lastPruneTime;
		getBurstLevel;
		now;
		constructor(getBurstLevel, now) {
			this.getBurstLevel = getBurstLevel;
			this.now = now ?? (() => Date.now());
			this.lastPruneTime = this.now();
		}
		allow(authorId, priority, authorType) {
			if (!this.enabled) return true;
			if (authorType === "moderator" || authorType === "owner") return true;
			if (priority >= PRIORITY_EXEMPT_THRESHOLD) return true;
			const limit = this.getEffectiveLimit();
			if (limit === null) return true;
			const now = this.now();
			const cutoff = now - this.windowMs;
			let timestamps = this.authorTimestamps.get(authorId);
			if (timestamps) {
				const lo = findFirstTimestampAfterCutoff(timestamps, cutoff);
				if (lo > 0) timestamps.splice(0, lo);
				if (timestamps.length >= limit) {
					this.authorTimestamps.set(authorId, timestamps);
					log$15.debug("media.rate-limiter.limited", { authorId });
					return false;
				}
			} else timestamps = [];
			timestamps.push(now);
			this.authorTimestamps.set(authorId, timestamps);
			this.pruneStaleEntries(now);
			return true;
		}
		getEffectiveLimit() {
			const burstLimit = BURST_LIMITS[this.getBurstLevel()];
			if (burstLimit === null) return this.maxPerWindow;
			return Math.min(this.maxPerWindow, burstLimit);
		}
		pruneStaleEntries(now) {
			if (now - this.lastPruneTime < PRUNE_INTERVAL_MS) return;
			this.lastPruneTime = now;
			const cutoff = now - this.windowMs;
			for (const [authorId, timestamps] of this.authorTimestamps) {
				const lo = findFirstTimestampAfterCutoff(timestamps, cutoff);
				if (lo > 0) timestamps.splice(0, lo);
				if (timestamps.length === 0) this.authorTimestamps.delete(authorId);
			}
			const maxEntries = 500;
			const PRUNE_TRIGGER_RATIO = 1.25;
			const PRUNE_TARGET_RATIO = .75;
			if (this.authorTimestamps.size > maxEntries * PRUNE_TRIGGER_RATIO) {
				const target = Math.floor(maxEntries * PRUNE_TARGET_RATIO);
				const entries = [...this.authorTimestamps.entries()];
				entries.sort((a, b) => (a[1][0] ?? 0) - (b[1][0] ?? 0));
				const toRemove = entries.slice(0, Math.max(0, entries.length - target));
				for (const [authorId] of toRemove) this.authorTimestamps.delete(authorId);
			}
		}
		updateConfig(config) {
			if (config.preset === "off") {
				this.enabled = false;
				this.authorTimestamps.clear();
			} else if (config.preset === "normal") {
				this.enabled = true;
				this.windowMs = DEFAULT_WINDOW_MS;
				this.maxPerWindow = DEFAULT_MAX_PER_WINDOW;
			} else if (config.preset === "strict") {
				this.enabled = true;
				this.windowMs = DEFAULT_WINDOW_MS;
				this.maxPerWindow = 2;
			}
		}
		size() {
			return this.authorTimestamps.size;
		}
		destroy() {
			this.authorTimestamps.clear();
		}
	};
	var log$14 = createLogger("BurstDetector");
	var BURST_COOLDOWN_BASE_MS = 2e3;
	var BURST_COOLDOWN_MAX_MS = 8e3;
	var BURST_COOLDOWN_RATIO = .3;
	var EMA_ALPHA = .3;
	var BurstDetector = class BurstDetector {
		static SAMPLE_INTERVAL_MS = 500;
		static IDLE_STOP_THRESHOLD_MS = 15e3;
		samples = [];
		runningSum = 0;
		currentLevel = "normal";
		lastBurstTime = 0;
		burstStartTime = 0;
		sampleInterval = null;
		samplesSinceLastCheck = 0;
		emaRate = 0;
		lastMessageTime = 0;
		postResumeSkipCount = 0;
		static POST_RESUME_EMA_SKIP = 3;
		observability;
		rateSampleWindow = 10;
		elevatedThreshold = 5;
		highThreshold = 15;
		extremeThreshold = 30;
		lastMessageTimestamp = 0;
		constructor(observability) {
			this.observability = observability;
		}
		updateThresholds(settings) {
			this.rateSampleWindow = settings.burstSampleWindow;
			this.elevatedThreshold = settings.burstElevatedThreshold;
			this.highThreshold = settings.burstHighThreshold;
			this.extremeThreshold = settings.burstExtremeThreshold;
		}
		onMessageReceived() {
			this.lastMessageTimestamp = performance.now();
			if (!this.sampleInterval) this.start();
			this.samplesSinceLastCheck++;
			const now = performance.now();
			if (this.lastMessageTime > 0) if (this.postResumeSkipCount < BurstDetector.POST_RESUME_EMA_SKIP) this.postResumeSkipCount++;
			else {
				const intervalMs = now - this.lastMessageTime;
				const instantRate = 1e3 / Math.max(1, intervalMs);
				this.emaRate = EMA_ALPHA * instantRate + .7 * this.emaRate;
			}
			this.lastMessageTime = now;
		}
		start() {
			if (this.sampleInterval) return;
			this.lastMessageTimestamp = performance.now();
			this.sampleInterval = setInterval(() => {
				if (performance.now() - this.lastMessageTimestamp > BurstDetector.IDLE_STOP_THRESHOLD_MS) {
					this.stop();
					return;
				}
				const count = this.samplesSinceLastCheck;
				this.samples.push(count);
				this.runningSum += count;
				if (this.samples.length > this.rateSampleWindow) {
					const removed = this.samples.shift() ?? 0;
					this.runningSum -= removed;
				}
				this.samplesSinceLastCheck = 0;
				this.evaluate();
			}, BurstDetector.SAMPLE_INTERVAL_MS);
		}
		getEmaRate() {
			return this.emaRate;
		}
		stop() {
			this.sampleInterval = clearSafeInterval(this.sampleInterval);
			this.samplesSinceLastCheck = 0;
		}
		pause() {
			this.stop();
			this.lastMessageTime = 0;
			this.postResumeSkipCount = 0;
			this.samples = [];
			this.runningSum = 0;
			this.currentLevel = "normal";
			this.lastBurstTime = 0;
			this.burstStartTime = 0;
		}
		resume() {
			this.samples = [];
			this.runningSum = 0;
			this.postResumeSkipCount = 0;
			this.lastBurstTime = 0;
			this.burstStartTime = 0;
			this.start();
		}
		resumeWithSamples(sampleIntervalsMs) {
			this.start();
			for (const intervalMs of sampleIntervalsMs) {
				if (intervalMs <= 0) continue;
				const instantRate = 1e3 / Math.max(1, intervalMs);
				if (this.emaRate === 0) this.emaRate = instantRate;
				else this.emaRate = EMA_ALPHA * instantRate + .7 * this.emaRate;
			}
			if (sampleIntervalsMs.length > 0) {
				const medianInterval = sampleIntervalsMs.slice().sort((a, b) => a - b)[sampleIntervalsMs.length / 2 | 0];
				const avgMsgPerTick = medianInterval > 0 ? BurstDetector.SAMPLE_INTERVAL_MS / medianInterval : 0;
				this.samplesSinceLastCheck = Math.max(this.samplesSinceLastCheck, Math.ceil(avgMsgPerTick));
			}
			this.postResumeSkipCount = BurstDetector.POST_RESUME_EMA_SKIP;
		}
		getLevel() {
			return this.currentLevel;
		}
		evaluate() {
			if (this.samples.length === 0) return;
			const now = performance.now();
			const avgRate = this.samples.length > 0 ? this.runningSum / this.samples.length : 0;
			const newLevel = avgRate > this.extremeThreshold ? "extreme" : avgRate > this.highThreshold ? "high" : avgRate > this.elevatedThreshold ? "elevated" : "normal";
			if (newLevel === this.currentLevel) {
				if (newLevel !== "normal") {
					this.lastBurstTime = now;
					if (this.burstStartTime === 0) this.burstStartTime = now;
				}
				return;
			}
			if (newLevel === "normal" && this.currentLevel !== "normal") {
				const burstDuration = now - this.burstStartTime;
				const cooldown = Math.min(BURST_COOLDOWN_MAX_MS, BURST_COOLDOWN_BASE_MS + burstDuration * BURST_COOLDOWN_RATIO);
				if (now - this.lastBurstTime < cooldown) return;
			}
			if (newLevel !== "normal") {
				this.lastBurstTime = now;
				if (this.burstStartTime === 0) this.burstStartTime = now;
			} else this.burstStartTime = 0;
			this.currentLevel = newLevel;
			log$14.debug("renderer.burst.level-change", {
				level: newLevel,
				avgRate: Math.round(avgRate * 10) / 10
			});
			this.observability?.updateBurstLevel(newLevel);
		}
		destroy() {
			this.stop();
			this.lastMessageTimestamp = 0;
			this.samples = [];
			this.emaRate = 0;
			this.lastMessageTime = 0;
			this.lastBurstTime = 0;
			this.burstStartTime = 0;
			this.observability = void 0;
		}
	};
	var HEADWAY_GAP_MIN_PX = 16;
	function computeBaseHeadwayPx(msgWidth, headwayGapRatio) {
		if (!Number.isFinite(msgWidth) || !Number.isFinite(headwayGapRatio)) return HEADWAY_GAP_MIN_PX;
		return Math.max(HEADWAY_GAP_MIN_PX, Math.min(60, Math.round(msgWidth * headwayGapRatio)));
	}
	function areSpeedTiersCompatible(a, b) {
		return Math.abs(a - b) <= 1;
	}
	function computeLaneY(laneIndex, viewportHeight, safeTop, laneHeight) {
		return viewportHeight * safeTop + laneIndex * laneHeight;
	}
	function computeOccupancyMs(durationMs, exitPaddingPx, headwayGapRatio, msgWidthPx, screenWidth) {
		const safeDuration = Math.max(0, durationMs);
		if (msgWidthPx === void 0 || screenWidth === void 0) {
			const safetyMargin = Math.round(safeDuration * SAFETY_MARGIN_RATIO);
			return safeDuration + Math.max(500, safetyMargin);
		}
		const totalDistance = screenWidth + msgWidthPx + exitPaddingPx;
		if (totalDistance <= 0) return safeDuration;
		const rightEdgePassFraction = (msgWidthPx + computeBaseHeadwayPx(msgWidthPx, headwayGapRatio)) / totalDistance;
		return Math.round(rightEdgePassFraction * safeDuration);
	}
	function heapSiftDown(heap, indexMap, startIdx) {
		const size = heap.length;
		let idx = startIdx;
		while (true) {
			let smallest = idx;
			const firstChild = 4 * idx + 1;
			for (let c = 0; c < 4; c++) {
				const childIdx = firstChild + c;
				if (childIdx >= size) break;
				const childEntry = heap[childIdx];
				const smallestEntry = heap[smallest];
				if (childEntry && smallestEntry && childEntry[1] < smallestEntry[1]) smallest = childIdx;
			}
			if (smallest === idx) break;
			const current = heap[idx];
			const smallestEntrySwap = heap[smallest];
			if (!current || !smallestEntrySwap) break;
			heap[idx] = smallestEntrySwap;
			heap[smallest] = current;
			indexMap.set(current[0], smallest);
			indexMap.set(smallestEntrySwap[0], idx);
			idx = smallest;
		}
	}
	function heapSiftUp(heap, indexMap, startIdx) {
		let idx = startIdx;
		while (idx > 0) {
			const parent = Math.floor((idx - 1) / 4);
			const parentEntry = heap[parent];
			const currentEntry = heap[idx];
			if (!parentEntry || !currentEntry) break;
			if (parentEntry[1] <= currentEntry[1]) break;
			heap[parent] = currentEntry;
			heap[idx] = parentEntry;
			indexMap.set(parentEntry[0], idx);
			indexMap.set(currentEntry[0], parent);
			idx = parent;
		}
	}
	function heapGetSlotAvailableAt(heap, indexMap, laneIndex, numLanes) {
		if (numLanes !== void 0 && (laneIndex < 0 || laneIndex >= numLanes)) return;
		const heapIdx = indexMap.get(laneIndex);
		if (heapIdx === void 0 || heapIdx >= heap.length) return void 0;
		return heap[heapIdx]?.[1];
	}
	function heapUpdateLane(heap, indexMap, laneIndex, newAvailableAt) {
		const idx = indexMap.get(laneIndex);
		if (idx === void 0) return;
		const entry = heap[idx];
		if (!entry) return;
		const old = entry[1];
		heap[idx] = [laneIndex, newAvailableAt];
		if (newAvailableAt > old) heapSiftDown(heap, indexMap, idx);
		else if (newAvailableAt < old) heapSiftUp(heap, indexMap, idx);
	}
	function buildLaneHeap(numLanes, now, indexMap) {
		const heap = [];
		indexMap.clear();
		for (let i = 0; i < numLanes; i++) {
			heap.push([i, now]);
			indexMap.set(i, i);
		}
		for (let i = Math.floor((heap.length - 2) / 4); i >= 0; i--) heapSiftDown(heap, indexMap, i);
		return heap;
	}
	function resetBatchShared(state, now) {
		for (const [k, v] of state.speedTierLanes) if (v.until <= now) state.speedTierLanes.delete(k);
		state.collidedLanes.clear();
	}
	function findPlacementShared(state, now, msgHeight, laneHeight, maxWaitMs, speedTier, random = Math.random) {
		if (state.heap.length === 0) return null;
		const slotCount = Math.max(1, Math.ceil(msgHeight / laneHeight));
		const numLanes = state.numLanes;
		if (numLanes <= 0) return null;
		if (slotCount <= 1) return allocateSingleLaneShared(state, now, 0, numLanes, maxWaitMs, speedTier, random);
		const maxStartLane = numLanes - slotCount;
		if (maxStartLane < 0) return null;
		const isTierCompatible = (slotIdx) => {
			const active = state.speedTierLanes.get(slotIdx);
			if (!active || active.until <= now) return true;
			return areSpeedTiersCompatible(speedTier, active.tier);
		};
		for (let startIdx = 0; startIdx <= maxStartLane; startIdx++) {
			let allZeroWait = true;
			for (let s = 0; s < slotCount; s++) {
				const slotIdx = startIdx + s;
				if (state.collidedLanes.has(slotIdx)) {
					allZeroWait = false;
					break;
				}
				if (!isTierCompatible(slotIdx)) {
					allZeroWait = false;
					break;
				}
				const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, slotIdx, numLanes);
				if (avail === void 0) {
					allZeroWait = false;
					break;
				}
				const wait = Math.max(0, Math.ceil(avail - now));
				if (wait > 0) allZeroWait = false;
				if (wait > maxWaitMs) {
					allZeroWait = false;
					break;
				}
			}
			if (allZeroWait) return {
				laneIndex: startIdx,
				waitMs: 0
			};
		}
		let bestBlock = null;
		for (let startIdx = 0; startIdx <= maxStartLane; startIdx++) {
			let allCompatible = true;
			let blockMaxWait = 0;
			for (let s = 0; s < slotCount; s++) {
				const slotIdx = startIdx + s;
				if (state.collidedLanes.has(slotIdx)) {
					allCompatible = false;
					break;
				}
				if (!isTierCompatible(slotIdx)) {
					allCompatible = false;
					break;
				}
				const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, slotIdx, numLanes);
				if (avail === void 0) {
					allCompatible = false;
					break;
				}
				const wait = Math.max(0, Math.ceil(avail - now));
				if (wait > maxWaitMs) {
					allCompatible = false;
					break;
				}
				blockMaxWait = Math.max(blockMaxWait, wait);
			}
			if (allCompatible && blockMaxWait <= maxWaitMs) {
				if (!bestBlock || blockMaxWait < bestBlock.waitMs) bestBlock = {
					laneIndex: startIdx,
					waitMs: blockMaxWait
				};
			}
		}
		if (bestBlock) return bestBlock;
		if (slotCount > 1) {
			let bestBlock = null;
			for (let startIdx = 0; startIdx <= maxStartLane; startIdx++) {
				let blockMaxWait = 0;
				let allAvailable = true;
				for (let s = 0; s < slotCount; s++) {
					const slotIdx = startIdx + s;
					if (state.collidedLanes.has(slotIdx)) {
						allAvailable = false;
						break;
					}
					const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, slotIdx, numLanes);
					if (avail === void 0) {
						allAvailable = false;
						break;
					}
					const wait = Math.max(0, Math.ceil(avail - now));
					if (wait > maxWaitMs) {
						allAvailable = false;
						break;
					}
					blockMaxWait = Math.max(blockMaxWait, wait);
				}
				if (allAvailable) {
					if (!bestBlock || blockMaxWait < bestBlock.waitMs) bestBlock = {
						laneIndex: startIdx,
						waitMs: blockMaxWait
					};
				}
			}
			if (bestBlock) return bestBlock;
			return null;
		}
		return allocateSingleLaneShared(state, now, 0, numLanes, maxWaitMs, speedTier, random);
	}
	function allocateSingleLaneShared(state, now, laneStart, laneEnd, maxWaitMs, speedTier, random = Math.random) {
		if (state.heap.length === 0) return null;
		let firstBusy = null;
		let speedMatched = null;
		let zeroWaitCandidates = null;
		for (let i = laneStart; i < laneEnd; i++) {
			if (state.collidedLanes.has(i)) continue;
			const active = state.speedTierLanes.get(i);
			if (active && active.until > now) {
				if (!areSpeedTiersCompatible(speedTier, active.tier)) continue;
			}
			const avail = heapGetSlotAvailableAt(state.heap, state.indexMap, i, state.numLanes);
			if (avail === void 0) continue;
			const wait = Math.max(0, Math.ceil(avail - now));
			if (wait > 0) {
				if (!firstBusy) firstBusy = {
					laneIndex: i,
					waitMs: wait
				};
				if (!speedMatched || wait < speedMatched.waitMs) {
					if (active !== void 0 && active.until > now && active.tier === speedTier) speedMatched = {
						laneIndex: i,
						waitMs: wait
					};
				}
				continue;
			}
			if (!zeroWaitCandidates) zeroWaitCandidates = [];
			zeroWaitCandidates.push(i);
			if (zeroWaitCandidates.length < 4) continue;
			break;
		}
		if (zeroWaitCandidates && zeroWaitCandidates.length > 0) {
			const idx = Math.floor(random() * zeroWaitCandidates.length) % zeroWaitCandidates.length;
			return {
				laneIndex: zeroWaitCandidates[idx],
				waitMs: 0
			};
		}
		if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;
		if (firstBusy && firstBusy.waitMs <= maxWaitMs && speedTier !== SPEED_TIER.BACKLOG) return firstBusy;
		return null;
	}
	var log$13 = createLogger("LaneAllocator");
	var LaneAllocator = class LaneAllocator {
		options;
		heap = [];
		indexMap = new Map();
		laneHeight = 0;
		numLanes = 0;
		cachedUtilization = 0;
		occupiedCount = 0;
		collidedLanes = new Set();
		speedTierLanes = new Map();
		constructor(options) {
			this.options = options;
		}
		updateSafeZone(safeTop, safeBottom) {
			this.options.safeTop = safeTop;
			this.options.safeBottom = safeBottom;
		}
		updateFontMetrics(fontSize, fontWeight, fontFamily, laneSpacing) {
			this.options.fontSize = fontSize;
			this.options.fontWeight = fontWeight;
			this.options.fontFamily = fontFamily;
			this.options.laneSpacing = laneSpacing;
		}
		updateLaneDensityFactor(factor) {
			this.options.laneDensityFactor = factor;
		}
		reset(dimensions) {
			this.heap = [];
			this.indexMap = new Map();
			this.collidedLanes.clear();
			this.speedTierLanes.clear();
			this.cachedUtilization = 0;
			this.occupiedCount = 0;
			this.utilizationRecountCounter = 0;
			if (!dimensions) {
				this.laneHeight = 0;
				this.numLanes = 0;
				return;
			}
			const textHeight = measureTextHeight(getFontString(this.options.fontSize, this.options.fontWeight, this.options.fontFamily), this.options.fontSize);
			const rawLaneHeight = Math.max(1, textHeight + this.options.laneSpacing);
			this.laneHeight = Math.max(1, Math.round(rawLaneHeight * this.options.laneDensityFactor));
			const usableHeight = dimensions.height * (1 - this.options.safeTop - this.options.safeBottom);
			this.numLanes = Math.max(1, Math.floor(usableHeight / this.laneHeight));
			log$13.debug("Reset", {
				lanes: this.numLanes,
				height: Math.round(this.laneHeight),
				density: this.options.laneDensityFactor
			});
			const now = performance.now();
			this.heap = buildLaneHeap(this.numLanes, now, this.indexMap);
		}
		isEmpty() {
			return this.heap.length === 0;
		}
		snapshot() {
			const indexMap = {};
			this.indexMap.forEach((v, k) => {
				indexMap[k] = v;
			});
			const speedTierMap = {};
			this.speedTierLanes.forEach((v, k) => {
				speedTierMap[k] = {
					tier: v.tier,
					until: v.until
				};
			});
			return {
				heap: structuredClone(this.heap),
				indexMap,
				laneHeight: this.laneHeight,
				laneCount: this.numLanes,
				speedTierLanes: speedTierMap
			};
		}
		restore(snapshot) {
			this.heap = structuredClone(snapshot.heap);
			this.indexMap = new Map(Object.entries(snapshot.indexMap).map(([k, v]) => [Number(k), v]));
			this.laneHeight = snapshot.laneHeight;
			this.numLanes = snapshot.laneCount;
			this.speedTierLanes = new Map(Object.entries(snapshot.speedTierLanes).map(([k, v]) => [Number(k), {
				tier: v.tier,
				until: v.until
			}]));
			this.collidedLanes.clear();
			this.cachedUtilization = 0;
			this.occupiedCount = 0;
			this.utilizationRecountCounter = 0;
		}
		getLaneCount() {
			return this.numLanes;
		}
		getUtilization() {
			if (this.heap.length === 0) return 0;
			return this.cachedUtilization;
		}
		getLaneHeight() {
			return this.laneHeight;
		}
		getLaneY(laneIndex, viewportHeight) {
			return computeLaneY(laneIndex, viewportHeight, this.options.safeTop, this.laneHeight);
		}
		findPlacement(messageHeight, dimensions, speedTier = SPEED_TIER.MID, now = performance.now(), random = Math.random) {
			if (this.numLanes <= 0) return null;
			const slotCount = Math.max(1, Math.ceil(messageHeight / this.laneHeight));
			const result = findPlacementShared(this, now, messageHeight, this.laneHeight, this.options.scrollDurationMaxMs, speedTier, random);
			if (!result) return null;
			return {
				laneIndex: result.laneIndex,
				waitMs: result.waitMs,
				laneY: this.getLaneY(result.laneIndex, dimensions.height),
				slotCount,
				verticalOffset: Math.floor((slotCount * this.laneHeight - messageHeight) / 2)
			};
		}
		commitPlacement(placement, startTime, durationMs, msgWidth, screenWidth, speedTier = SPEED_TIER.MID) {
			const nextAvailable = startTime + this.computeOccupancyMs(durationMs, msgWidth, screenWidth);
			const startIdx = placement.laneIndex;
			const until = startTime + durationMs;
			for (let offset = 0; offset < placement.slotCount; offset++) {
				const slotIdx = startIdx + offset;
				this.speedTierLanes.set(slotIdx, {
					tier: speedTier,
					until
				});
			}
			for (let offset = 0; offset < placement.slotCount; offset++) {
				const slotIdx = startIdx + offset;
				this.updateLane(slotIdx, nextAvailable);
			}
		}
		utilizationRecountCounter = 0;
		static UTILIZATION_RECOUNT_INTERVAL = 3;
		resetBatch(now = performance.now()) {
			if (this.heap.length !== this.indexMap.size) {
				log$13.warn("renderer.lane-allocator.heap-integrity", {
					heapLength: this.heap.length,
					indexMapSize: this.indexMap.size
				});
				this.indexMap.clear();
				for (let i = 0; i < this.heap.length; i++) {
					const entry = this.heap[i];
					if (entry) this.indexMap.set(entry[0], i);
				}
				for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) this.siftDown(i);
			}
			resetBatchShared(this, now);
			this.utilizationRecountCounter++;
			if (this.utilizationRecountCounter >= LaneAllocator.UTILIZATION_RECOUNT_INTERVAL) {
				this.utilizationRecountCounter = 0;
				let occupied = 0;
				for (const [, availableAt] of this.heap) if (availableAt > now) occupied++;
				this.occupiedCount = occupied;
			}
			this.cachedUtilization = this.heap.length > 0 ? this.occupiedCount / this.heap.length : 0;
		}
		markCollision(laneIndex) {
			this.collidedLanes.add(laneIndex);
		}
		computeOccupancyMs(durationMs, msgWidthPx, screenWidth) {
			return computeOccupancyMs(durationMs, this.options.exitPaddingPx, this.options.headwayGapRatio, msgWidthPx, screenWidth);
		}
		updateLane(laneIndex, newAvailableAt) {
			heapUpdateLane(this.heap, this.indexMap, laneIndex, newAvailableAt);
		}
		shiftAll(offsetMs) {
			if (offsetMs <= 0) return;
			if (this.heap.length > 0) {
				for (let i = 0; i < this.heap.length; i++) {
					const entry = this.heap[i];
					if (entry) entry[1] += offsetMs;
				}
				for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) this.siftDown(i);
			}
			for (const [idx, entry] of this.speedTierLanes) this.speedTierLanes.set(idx, {
				tier: entry.tier,
				until: entry.until + offsetMs
			});
		}
		siftDown(startIdx) {
			heapSiftDown(this.heap, this.indexMap, startIdx);
		}
	};
	var log$12 = createLogger("Observability");
	var DEBUG_OVERLAY_STYLES = {
		color: "#0f0",
		font: "12px/1.4 monospace",
		padding: "8px 12px",
		borderRadius: "4px",
		minWidth: "220px"
	};
	var ObservabilityReporter = class ObservabilityReporter {
		metrics;
		totalDroppedInWindow = 0;
		totalReceivedInWindow = 0;
		windowStartTime = Date.now();
		debugOverlayEl = null;
		lastWarnTime = 0;
		showDebug = false;
		static WARN_COOLDOWN_MS = 3e4;
		static METRIC_WINDOW_MS = 6e4;
		static DEBUG_OVERLAY_LINE_COUNT = 7;
		static DROP_RATE_WARN_THRESHOLD = .2;
		frameTimings = {
			renderFrameMs: 0,
			drainQueueMs: 0,
			collisionCheckMs: 0,
			textMeasureMs: 0,
			frameCount: 0,
			lastFrameTimestamp: 0
		};
		collisionAccumMs = 0;
		textMeasureAccumMs = 0;
		lastDebugUpdate = 0;
		static DEBUG_UPDATE_INTERVAL_MS = 250;
		constructor(initialShowDebug = false) {
			this.metrics = {
				totalReceived: 0,
				totalRendered: 0,
				totalDropped: 0,
				dropRate: 0,
				queueDepth: 0,
				burstLevel: "normal",
				activeMessages: 0,
				laneUtilization: 0,
				backlogProgress: 1,
				frameTimings: this.frameTimings
			};
			this.showDebug = initialShowDebug;
			if (initialShowDebug) this.createDebugOverlay();
		}
		onMessageReceived() {
			this.metrics.totalReceived++;
			this.totalReceivedInWindow++;
		}
		onMessageRendered() {
			this.metrics.totalRendered++;
		}
		onMessageDropped(reason) {
			this.metrics.totalDropped++;
			this.totalDroppedInWindow++;
			this.refreshDerivedMetrics();
			if (reason === "video_paused") return;
			if (this.metrics.dropRate > ObservabilityReporter.DROP_RATE_WARN_THRESHOLD) {
				const now = Date.now();
				if (now - this.lastWarnTime > ObservabilityReporter.WARN_COOLDOWN_MS) {
					this.lastWarnTime = now;
					log$12.warn(`High drop rate: ${(this.metrics.dropRate * 100).toFixed(1)}% (queue=${this.metrics.queueDepth}, lanes=${(this.metrics.laneUtilization * 100).toFixed(0)}%, reason=${reason ?? "unknown"})`);
				}
			} else this.lastWarnTime = 0;
		}
		updateQueueDepth(depth) {
			this.metrics.queueDepth = depth;
		}
		updateBurstLevel(level) {
			this.metrics.burstLevel = level;
		}
		updateActiveMessages(count) {
			this.metrics.activeMessages = count;
		}
		updateLaneUtilization(ratio) {
			this.metrics.laneUtilization = Math.max(0, Math.min(1, ratio));
		}
		updateBacklogProgress(progress) {
			this.metrics.backlogProgress = Math.max(0, Math.min(1, progress));
		}
		framesSinceLastTick = 0;
		recordRenderFrame(ms) {
			this.frameTimings.renderFrameMs = this.frameTimings.renderFrameMs * .95 + ms * .05;
			this.frameTimings.frameCount++;
			this.framesSinceLastTick++;
			this.frameTimings.lastFrameTimestamp = performance.now();
		}
		recordDrainQueue(ms) {
			this.frameTimings.drainQueueMs = this.frameTimings.drainQueueMs * .95 + ms * .05;
		}
		recordCollisionCheck(ms) {
			this.collisionAccumMs += ms;
		}
		recordTextMeasure(ms) {
			this.textMeasureAccumMs += ms;
		}
		getMetrics() {
			this.refreshDerivedMetrics();
			return structuredClone(this.metrics);
		}
		refreshDerivedMetrics() {
			const now = Date.now();
			if (now - this.windowStartTime >= ObservabilityReporter.METRIC_WINDOW_MS) {
				this.totalDroppedInWindow = 0;
				this.totalReceivedInWindow = 0;
				this.windowStartTime = now;
			}
			this.metrics.dropRate = this.totalReceivedInWindow > 0 ? this.totalDroppedInWindow / this.totalReceivedInWindow : 0;
		}
		setShowDebug(show) {
			if (this.showDebug === show) return;
			this.showDebug = show;
			if (show) this.createDebugOverlay();
			else this.destroyDebugOverlay();
		}
		tick() {
			if (!this.showDebug || !this.debugOverlayEl) return;
			if (this.framesSinceLastTick > 0) {
				const fc = this.framesSinceLastTick;
				this.frameTimings.collisionCheckMs = this.collisionAccumMs / fc;
				this.frameTimings.textMeasureMs = this.textMeasureAccumMs / fc;
				this.collisionAccumMs = 0;
				this.textMeasureAccumMs = 0;
				this.framesSinceLastTick = 0;
			}
			const now = performance.now();
			if (now - this.lastDebugUpdate >= ObservabilityReporter.DEBUG_UPDATE_INTERVAL_MS) {
				this.lastDebugUpdate = now;
				this.updateDebugOverlay();
			}
		}
		createDebugOverlay() {
			if (this.debugOverlayEl) return;
			const el = document.createElement("div");
			el.id = "yt-chat-overlay-debug";
			el.style.cssText = `position:fixed;top:8px;right:8px;z-index:${INDICATOR_Z_INDEX};background:${DEBUG_OVERLAY_BG};color:${DEBUG_OVERLAY_STYLES.color};font:${DEBUG_OVERLAY_STYLES.font};padding:${DEBUG_OVERLAY_STYLES.padding};border-radius:${DEBUG_OVERLAY_STYLES.borderRadius};min-width:${DEBUG_OVERLAY_STYLES.minWidth};pointer-events:none;user-select:none`;
			for (let i = 0; i < ObservabilityReporter.DEBUG_OVERLAY_LINE_COUNT; i++) el.appendChild(document.createElement("div"));
			document.body.appendChild(el);
			this.debugOverlayEl = el;
		}
		updateDebugOverlay() {
			if (!this.debugOverlayEl) return;
			const m = this.getMetrics();
			const lines = [
				`Rcvd: ${m.totalReceived} | Rndr: ${m.totalRendered}`,
				`Drop: ${m.totalDropped} (${(m.dropRate * 100).toFixed(1)}%)`,
				`Queue: ${m.queueDepth} | Burst: ${m.burstLevel}`,
				`Active: ${m.activeMessages} | Lane: ${(m.laneUtilization * 100).toFixed(0)}%`,
				`Backlog: ${(m.backlogProgress * 100).toFixed(0)}%`,
				`Render: ${m.frameTimings.renderFrameMs.toFixed(2)}ms | Drain: ${m.frameTimings.drainQueueMs.toFixed(2)}ms`,
				`Coll: ${m.frameTimings.collisionCheckMs.toFixed(2)}ms | Text: ${m.frameTimings.textMeasureMs.toFixed(2)}ms`
			];
			const children = this.debugOverlayEl.children;
			for (let i = 0; i < lines.length; i++) {
				const child = children.item(i);
				if (child) child.textContent = lines[i];
			}
		}
		destroyDebugOverlay() {
			if (this.debugOverlayEl) {
				this.debugOverlayEl.remove();
				this.debugOverlayEl = null;
			}
		}
		destroy() {
			this.destroyDebugOverlay();
		}
	};
	var log$11 = createLogger("RendererBase");
	var RendererBase = class RendererBase {
		observability;
		onBacklogPauseChange = null;
		onStatusBarClick = null;
		setChatPanelOpen(_open) {}
		overlay;
		settings;
		laneAllocator;
		burstDetector;
		authorRateLimiter;
		isPaused = false;
		videoPaused = false;
		isUserPaused = false;
		currentLaneDensityFactor = 1;
		replayMode = false;
		pausedAt = null;
		backlogPaused = false;
		drainLocked = false;
		lastRenderActivity = performance.now();
		pauseBuffer = [];
		static PAUSE_BUFFER_MAX = 200;
		static BACKLOG_PRIORITY_OFFSET = 50;
		static LANE_DENSITY_BY_BURST = {
			normal: 1,
			elevated: 1,
			high: .75,
			extreme: .5
		};
		lastBacklogToggleTime = 0;
		constructor(overlay, settings) {
			this.overlay = overlay;
			this.settings = settings;
			this.observability = new ObservabilityReporter(settings.showDebugOverlay);
			setTextMeasureCallback((ms) => this.observability.recordTextMeasure(ms));
			this.laneAllocator = new LaneAllocator({
				safeTop: this.settings.safeTop,
				safeBottom: this.settings.safeBottom,
				fontSize: this.getEffectiveFontSize(),
				fontWeight: this.settings.fontWeight,
				fontFamily: this.settings.fontFamily,
				laneSpacing: this.settings.laneSpacing,
				headwayGapRatio: this.settings.headwayGapRatio,
				exitPaddingPx: this.settings.exitPaddingPx,
				scrollDurationMaxMs: this.settings.scrollDurationMaxMs,
				maxMessageAgeMs: this.settings.maxMessageAgeMs,
				laneDensityFactor: 1
			});
			this.laneAllocator.reset(this.overlay.getDimensions());
			this.burstDetector = new BurstDetector(this.observability);
			this.burstDetector.updateThresholds({
				burstSampleWindow: this.settings.burstSampleWindow,
				burstElevatedThreshold: this.settings.burstElevatedThreshold,
				burstHighThreshold: this.settings.burstHighThreshold,
				burstExtremeThreshold: this.settings.burstExtremeThreshold
			});
			this.burstDetector.start();
			this.authorRateLimiter = new PerAuthorRateLimiter(() => this.burstDetector.getLevel());
			this.authorRateLimiter.updateConfig({ preset: settings.authorRateLimit });
		}
		getBurstEmaRate() {
			return this.burstDetector.getEmaRate();
		}
		get isVideoPaused() {
			return this.videoPaused;
		}
		get isReplayMode() {
			return this.replayMode;
		}
		setReplayMode(enabled) {
			this.replayMode = enabled;
		}
		getEffectiveFontSize() {
			const dims = this.overlay.getDimensions();
			if (!dims || dims.height <= 0) return this.settings.fontSize;
			const { fontSize, fontBaseViewportHeight, fontMinSize, fontMaxSize } = this.settings;
			const scaled = Math.round(fontSize * (dims.height / fontBaseViewportHeight));
			return Math.max(fontMinSize, Math.min(fontMaxSize, scaled));
		}
		setUserPaused(paused) {
			this.isUserPaused = paused;
		}
		pause() {
			if (this.isPaused) return;
			this.isPaused = true;
			this.pausedAt = performance.now();
			this.burstDetector.pause();
			this.onPause();
			log$11.debug("renderer.paused", { reason: "user" });
		}
		resume() {
			if (!this.isPaused) return;
			const now = performance.now();
			let pausedDuration = 0;
			if (this.pausedAt !== null) {
				const raw = Math.max(0, now - this.pausedAt);
				pausedDuration = Math.min(raw, this.settings.maxMessageAgeMs * 2);
				this.applyPausedDuration(pausedDuration);
			}
			this.pausedAt = null;
			const intervals = this.computePendingQueueIntervals();
			if (intervals.length > 0) this.burstDetector.resumeWithSamples(intervals);
			else this.burstDetector.resume();
			this.isPaused = false;
			if (!this.isVideoPaused) this.laneAllocator.shiftAll(pausedDuration);
			if (this.isVideoPaused) return;
			this.onResume();
			log$11.debug("renderer.resumed");
		}
		pauseForVideo() {
			if (this.isVideoPaused) return;
			this.videoPaused = true;
			if (!this.isPaused) this.pause();
		}
		resumeForVideo() {
			if (!this.videoPaused) return;
			this.videoPaused = false;
			if (document.visibilityState === "visible") if (this.isPaused) this.resume();
			else {
				this.onResume();
				log$11.debug("renderer.resumed");
			}
			this.flushPauseBuffer();
		}
		flushPauseBuffer() {
			if (this.pauseBuffer.length === 0) return;
			const buffered = this.pauseBuffer;
			this.pauseBuffer = [];
			this.onResumeFromVideoPause(buffered);
		}
		onResumeFromVideoPause(_messages) {}
		updateSettings(settings, options = {}) {
			const prev = {
				safeTop: this.settings.safeTop,
				safeBottom: this.settings.safeBottom,
				fontSize: this.settings.fontSize,
				fontWeight: this.settings.fontWeight,
				fontFamily: this.settings.fontFamily,
				laneSpacing: this.settings.laneSpacing
			};
			this.settings = settings;
			this.observability.setShowDebug(settings.showDebugOverlay);
			this.burstDetector.updateThresholds({
				burstSampleWindow: settings.burstSampleWindow,
				burstElevatedThreshold: settings.burstElevatedThreshold,
				burstHighThreshold: settings.burstHighThreshold,
				burstExtremeThreshold: settings.burstExtremeThreshold
			});
			this.authorRateLimiter.updateConfig({ preset: settings.authorRateLimit });
			const fontChanged = settings.fontSize !== prev.fontSize || settings.fontWeight !== prev.fontWeight || settings.fontFamily !== prev.fontFamily;
			const laneSpacingChanged = settings.laneSpacing !== prev.laneSpacing;
			if (fontChanged || laneSpacingChanged) this.laneAllocator.updateFontMetrics(this.getEffectiveFontSize(), settings.fontWeight, settings.fontFamily, settings.laneSpacing);
			if (fontChanged) clearTextMeasurementCaches();
			const safeZoneChanged = settings.safeTop !== prev.safeTop || settings.safeBottom !== prev.safeBottom;
			this.laneAllocator.updateSafeZone(settings.safeTop, settings.safeBottom);
			if (options.resetState) {
				this.resetState();
				this.laneAllocator.reset(this.overlay.getDimensions());
				return;
			}
			if (safeZoneChanged || this.laneAllocator.isEmpty()) this.laneAllocator.reset(this.overlay.getDimensions());
		}
		getEffectiveSpeedPxPerSec() {
			const baseSpeed = this.settings.speedPxPerSec;
			if (this.replayMode) return Math.max(1, baseSpeed);
			let speed = baseSpeed;
			const emaRate = this.burstDetector.getEmaRate();
			if (emaRate > this.settings.speedBoostThreshold) {
				const emaMultiplier = 1 + Math.min((emaRate - this.settings.speedBoostThreshold) / this.settings.speedBoostDenom, this.settings.speedBoostMax);
				speed *= emaMultiplier;
			}
			const burstLevel = this.burstDetector.getLevel();
			return Math.max(1, speed * rendererLayout.burstSpeedMultiplier[burstLevel]);
		}
		getLaneDensityFactor() {
			const burstLevel = this.burstDetector.getLevel();
			return RendererBase.LANE_DENSITY_BY_BURST[burstLevel];
		}
		applyLaneDensityIfChanged() {
			const newFactor = this.getLaneDensityFactor();
			if (newFactor === this.currentLaneDensityFactor) return false;
			this.currentLaneDensityFactor = newFactor;
			this.laneAllocator.updateLaneDensityFactor(newFactor);
			this.laneAllocator.reset(this.overlay.getDimensions());
			return true;
		}
		isMessageAllowed(message) {
			this.observability.onMessageReceived();
			if (this.isVideoPaused) {
				this.observability.onMessageDropped("video_paused");
				if (this.pauseBuffer.length < RendererBase.PAUSE_BUFFER_MAX) this.pauseBuffer.push(message);
				return false;
			}
			if (!this.replayMode) {
				this.burstDetector.onMessageReceived();
				const priority = RendererBase.getMessagePriority(message);
				if (!this.authorRateLimiter.allow(message.author ?? "anonymous", priority, message.authorType)) {
					log$11.debug("renderer.message.drop", {
						reason: "rate_limited",
						author: message.author,
						kind: message.kind
					});
					this.observability.onMessageDropped("rate_limited");
					return false;
				}
			}
			return true;
		}
		isAntiBlockActive() {
			const utilization = this.laneAllocator.getUtilization();
			if (utilization < .95) return false;
			const acceptProb = (1 - utilization) / ANTI_BLOCK_FREE_RATIO;
			return Math.random() >= acceptProb;
		}
		static getMessagePriority(message) {
			let priority = rendererLayout.kindPriority[message.kind];
			if (message.isBacklog) priority -= RendererBase.BACKLOG_PRIORITY_OFFSET;
			return priority;
		}
		destroy() {
			this.isPaused = false;
			this.videoPaused = false;
			this.pauseBuffer.length = 0;
			this.burstDetector.destroy();
			this.authorRateLimiter.destroy();
			this.observability.destroy();
			this.onDestroy();
			log$11.debug("renderer.destroyed");
		}
		getLaneCount() {
			return this.laneAllocator.getLaneCount();
		}
		getLaneUtilization() {
			return this.laneAllocator.getUtilization();
		}
		trimBackgroundQueue() {}
		replayMessage(_message) {}
		setStandbyStatus(_standby) {}
		setConnectionStatus(_status) {}
		getMsSinceLastRenderActivity(now = performance.now()) {
			return Math.max(0, now - this.lastRenderActivity);
		}
		isWorkerAlive() {
			return true;
		}
		fallbackToMainThread(_reason) {}
		resetAllocator(dims) {
			this.laneAllocator.reset(dims);
		}
		resetBurstDetector() {
			this.burstDetector.resume();
		}
		resumeRenderLoop() {}
		clearPausedDuration() {
			this.pausedAt = null;
		}
		drainPendingQueue() {
			return [];
		}
		clearActiveMessages() {}
		clearPendingQueue() {}
		prepareForRefresh() {
			this.clearActiveMessages();
			this.clearPendingQueue();
		}
		getPendingQueueMessages() {
			return [];
		}
		computePendingQueueIntervals() {
			const msgs = this.getPendingQueueMessages();
			if (msgs.length < 2) return [];
			const intervals = [];
			for (let i = 1; i < msgs.length; i++) {
				const delta = msgs[i].timestamp - msgs[i - 1].timestamp;
				if (delta >= 0) intervals.push(delta);
			}
			return intervals;
		}
		updateBacklogPause() {
			const now = Date.now();
			if (now - this.lastBacklogToggleTime < this.settings.backlogToggleCooldownMs) return;
			const queueRatio = this.settings.queueMaxSize > 0 ? this.getQueueLength() / this.settings.queueMaxSize : 0;
			if (queueRatio > this.settings.backlogPauseThreshold && !this.backlogPaused) {
				this.backlogPaused = true;
				this.lastBacklogToggleTime = now;
				this.onBacklogPauseChange?.(true);
			} else if (queueRatio < this.settings.backlogResumeThreshold && this.backlogPaused) {
				this.backlogPaused = false;
				this.lastBacklogToggleTime = now;
				this.onBacklogPauseChange?.(false);
			}
		}
	};
	var DEFAULT_SETTINGS = {
		enabled: true,
		danmakuMode: "scroll",
		speedPxPerSec: 250,
		fontSize: 32,
		fontBaseViewportHeight: 540,
		fontMinSize: 18,
		fontMaxSize: 48,
		opacity: 1,
		superChatOpacity: .75,
		safeTop: 0,
		safeBottom: .12,
		maxConcurrentMessages: 300,
		allowShortTextMessages: false,
		minTextLength: 1,
		logLevel: "warn",
		showAuthor: {
			normal: false,
			member: false,
			moderator: true,
			owner: true,
			verified: false,
			superChat: true
		},
		colors: {
			normal: colors.authorNormal,
			member: colors.authorMember,
			moderator: colors.authorModerator,
			owner: colors.authorOwner,
			verified: colors.authorVerified
		},
		backgroundColors: { ...colors.authorBackground },
		outline: {
			enabled: true,
			widthPx: 2,
			opacity: .7
		},
		laneSpacing: 0,
		showDebugOverlay: false,
		ignoreReducedMotion: false,
		authorRateLimit: "normal",
		backlogMaxRate: 20,
		backlogSpeedMultiplier: 2,
		backlogMode: "playback",
		backlogRecentMinutes: 1,
		backlogOpacityMultiplier: .75,
		depthLayersEnabled: true,
		depthNearSpeedMul: 1.4,
		depthFarSpeedMul: .8,
		depthFarOpacityMul: .75,
		motionBlurEnabled: false,
		motionBlurAlpha: .03,
		modOwnerDurationMultiplier: 1.5,
		showSuperChatAmount: true,
		fontWeight: "bold",
		fontFamily: DEFAULT_FONT_FAMILY,
		preserveUserColor: true,
		superChatMaxBodyLines: 5,
		membershipMaxBodyLines: 3,
		fadeDurationMs: 500,
		minPollIntervalMs: 50,
		maxPollIntervalMs: 2e3,
		language: "auto",
		translationEnabled: false,
		translationService: "auto",
		translationSource: "auto",
		translationTarget: "auto",
		translationMode: "dual",
		exitPaddingPx: 100,
		scrollDurationMinMs: 5e3,
		scrollDurationMaxMs: 3e4,
		topBottomDurationMs: 4e3,
		queueMaxSize: 200,
		backgroundQueueMax: 50,
		maxMessageAgeMs: 6e4,
		headwayGapRatio: rendererLayout.headwayGapRatio,
		emojiCacheMb: 3,
		photoCacheMb: 2,
		stickerCacheMb: 1,
		textCacheMb: 4,
		translationBatchSize: 5,
		emojiFetchLimit: 6,
		failedEmojiRetryMins: 5,
		burstSampleWindow: 10,
		burstElevatedThreshold: 5,
		burstHighThreshold: 15,
		burstExtremeThreshold: 30,
		backlogInjectionMax: 20,
		backlogDensityRampMs: 2500,
		livePollFallbackMs: 1500,
		livePollFailureLimit: 10,
		speedBoostThreshold: 5,
		backlogPauseThreshold: .8,
		backlogResumeThreshold: .4,
		activityTimeoutMs: 3e4,
		staggerMaxDelayMs: 200,
		staggerMediumDelayMs: 80,
		emojiFetchTimeoutMs: 3e4,
		backlogDensityRampMaxMs: 4e3,
		backlogInjectionRateMin: 4,
		speedBoostMax: .05,
		speedBoostDenom: 15,
		backlogToggleCooldownMs: 2e3,
		replayPrefetchPages: 200,
		replayBatchLimit: 12
	};
	var STORAGE_KEY = "yt-live-chat-overlay-settings";
	var MIGRATIONS = {
		0: (s) => ({
			...s,
			_version: 1
		}),
		1: (s) => ({
			...s,
			backgroundColors: s.backgroundColors ?? { ...DEFAULT_SETTINGS.backgroundColors },
			_version: 2
		})
	};
	function migrateSettings(raw) {
		if (!isRecord(raw)) return { _version: 2 };
		const rawVersion = raw._version;
		let version = Number.isFinite(rawVersion) && rawVersion >= 0 ? Math.min(rawVersion, 2) : 0;
		let migrated = { ...raw };
		while (version < 2) {
			const fn = MIGRATIONS[version];
			if (!fn) {
				migrated = {
					...migrated,
					_version: 2
				};
				break;
			}
			migrated = fn(migrated);
			version = migrated._version;
		}
		return migrated;
	}
	var SETTINGS_LIMITS = {
		speedPxPerSec: {
			min: 50,
			max: 500,
			step: 10
		},
		fontSize: {
			min: 14,
			max: 50,
			step: 2
		},
		fontBaseViewportHeight: {
			min: 360,
			max: 2160,
			step: 1
		},
		fontMinSize: {
			min: 10,
			max: 32,
			step: 1
		},
		fontMaxSize: {
			min: 24,
			max: 72,
			step: 1
		},
		opacity: {
			min: .5,
			max: 1,
			step: .05
		},
		superChatOpacity: {
			min: .35,
			max: 1,
			step: .05
		},
		safeTop: {
			min: 0,
			max: .25,
			step: .01
		},
		safeBottom: {
			min: 0,
			max: .5,
			step: .01
		},
		maxConcurrentMessages: {
			min: 30,
			max: 300,
			step: 10
		},
		minTextLength: {
			min: 1,
			max: 10,
			step: 1
		},
		outlineWidthPx: {
			min: 0,
			max: 8,
			step: .5
		},
		outlineOpacity: {
			min: 0,
			max: 1,
			step: .1
		},
		laneSpacing: {
			min: 0,
			max: 20,
			step: 1
		},
		backlogMaxRate: {
			min: 0,
			max: 50,
			step: 5
		},
		backlogSpeedMultiplier: {
			min: 1,
			max: 5,
			step: .5
		},
		backlogRecentMinutes: {
			min: 1,
			max: 30,
			step: 1
		},
		backlogOpacityMultiplier: {
			min: .1,
			max: 1,
			step: .05
		},
		depthNearSpeedMul: {
			min: 1,
			max: 2,
			step: .1
		},
		depthFarSpeedMul: {
			min: .3,
			max: 1,
			step: .1
		},
		depthFarOpacityMul: {
			min: .4,
			max: 1,
			step: .05
		},
		motionBlurAlpha: {
			min: .01,
			max: .05,
			step: .01
		},
		superChatMaxBodyLines: {
			min: 2,
			max: 10,
			step: 1
		},
		membershipMaxBodyLines: {
			min: 1,
			max: 5,
			step: 1
		},
		fadeDurationMs: {
			min: 0,
			max: 1e3,
			step: 50
		},
		minPollIntervalMs: {
			min: 50,
			max: 5e3,
			step: 50
		},
		maxPollIntervalMs: {
			min: 1e3,
			max: 3e4,
			step: 1e3
		},
		modOwnerDurationMultiplier: {
			min: 1,
			max: 3,
			step: .1
		},
		exitPaddingPx: {
			min: 20,
			max: 400,
			step: 10
		},
		scrollDurationMinMs: {
			min: 1e3,
			max: 15e3,
			step: 500
		},
		scrollDurationMaxMs: {
			min: 5e3,
			max: 12e4,
			step: 5e3
		},
		topBottomDurationMs: {
			min: 1e3,
			max: 3e4,
			step: 500
		},
		queueMaxSize: {
			min: 50,
			max: 1e3,
			step: 10
		},
		backgroundQueueMax: {
			min: 10,
			max: 500,
			step: 10
		},
		maxMessageAgeMs: {
			min: 1e4,
			max: 3e5,
			step: 1e4
		},
		headwayGapRatio: {
			min: .02,
			max: .3,
			step: .01
		},
		emojiCacheMb: {
			min: 1,
			max: 20,
			step: 1
		},
		photoCacheMb: {
			min: 1,
			max: 20,
			step: 1
		},
		stickerCacheMb: {
			min: 1,
			max: 20,
			step: 1
		},
		textCacheMb: {
			min: 1,
			max: 20,
			step: 1
		},
		translationBatchSize: {
			min: 1,
			max: 20,
			step: 1
		},
		emojiFetchLimit: {
			min: 1,
			max: 20,
			step: 1
		},
		failedEmojiRetryMins: {
			min: 1,
			max: 60,
			step: 1
		},
		burstSampleWindow: {
			min: 3,
			max: 60,
			step: 1
		},
		burstElevatedThreshold: {
			min: 2,
			max: 50,
			step: 1
		},
		burstHighThreshold: {
			min: 5,
			max: 100,
			step: 5
		},
		burstExtremeThreshold: {
			min: 10,
			max: 200,
			step: 5
		},
		backlogInjectionMax: {
			min: 5,
			max: 100,
			step: 5
		},
		backlogDensityRampMs: {
			min: 500,
			max: 1e4,
			step: 500
		},
		livePollFallbackMs: {
			min: 500,
			max: 3e4,
			step: 500
		},
		livePollFailureLimit: {
			min: 3,
			max: 50,
			step: 1
		},
		speedBoostThreshold: {
			min: 2,
			max: 50,
			step: 1
		},
		backlogPauseThreshold: {
			min: .3,
			max: 1,
			step: .05
		},
		backlogResumeThreshold: {
			min: .1,
			max: 1,
			step: .05
		},
		activityTimeoutMs: {
			min: 5e3,
			max: 12e4,
			step: 5e3
		},
		staggerMaxDelayMs: {
			min: 20,
			max: 1e3,
			step: 20
		},
		staggerMediumDelayMs: {
			min: 10,
			max: 500,
			step: 10
		},
		emojiFetchTimeoutMs: {
			min: 5e3,
			max: 12e4,
			step: 5e3
		},
		backlogDensityRampMaxMs: {
			min: 500,
			max: 15e3,
			step: 500
		},
		backlogInjectionRateMin: {
			min: 1,
			max: 50,
			step: 1
		},
		speedBoostMax: {
			min: .05,
			max: 1,
			step: .05
		},
		speedBoostDenom: {
			min: 2,
			max: 100,
			step: 1
		},
		backlogToggleCooldownMs: {
			min: 500,
			max: 3e4,
			step: 500
		},
		replayPrefetchPages: {
			min: 50,
			max: 1e3,
			step: 50
		},
		replayBatchLimit: {
			min: 3,
			max: 100,
			step: 1
		}
	};
	var OUTLINE_NUMERIC_KEYS = ["widthPx", "opacity"];
	var OUTLINE_LIMIT_KEYS = {
		widthPx: "outlineWidthPx",
		opacity: "outlineOpacity"
	};
	var OUTLINE_DISPLAY_SCALE = {
		widthPx: 1,
		opacity: 100
	};
	var getOutlineDisplayScale = (key) => OUTLINE_DISPLAY_SCALE[key] ?? 1;
	function resolveLimits(key) {
		const direct = SETTINGS_LIMITS[key];
		if (direct) return direct;
		const outlineKey = OUTLINE_LIMIT_KEYS[key];
		if (outlineKey) return SETTINGS_LIMITS[outlineKey];
		throw new Error(`Unknown setting key: ${key}`);
	}
	function resolveOutlineLimits(key) {
		const outlineKey = OUTLINE_LIMIT_KEYS[key];
		if (outlineKey) return SETTINGS_LIMITS[outlineKey];
		throw new Error(`Unknown outline setting key: ${key}`);
	}
	var AUTHOR_COLOR_KEYS = [
		"normal",
		"member",
		"moderator",
		"owner",
		"verified"
	];
	var SHOW_AUTHOR_KEYS = [...AUTHOR_COLOR_KEYS, "superChat"];
	var ROOT_SETTING_META = {
		enabled: {
			type: "boolean",
			visual: false
		},
		danmakuMode: {
			type: "string",
			visual: false
		},
		speedPxPerSec: {
			type: "number",
			visual: true
		},
		fontSize: {
			type: "number",
			visual: true
		},
		fontBaseViewportHeight: {
			type: "number",
			visual: false
		},
		fontMinSize: {
			type: "number",
			visual: false
		},
		fontMaxSize: {
			type: "number",
			visual: false
		},
		opacity: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 0
		},
		superChatOpacity: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 0
		},
		safeTop: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 1
		},
		safeBottom: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 1
		},
		maxConcurrentMessages: {
			type: "number",
			visual: true
		},
		allowShortTextMessages: {
			type: "boolean",
			visual: true
		},
		minTextLength: {
			type: "number",
			visual: true
		},
		logLevel: {
			type: "string",
			visual: false
		},
		laneSpacing: {
			type: "number",
			visual: true
		},
		showDebugOverlay: {
			type: "boolean",
			visual: false
		},
		ignoreReducedMotion: {
			type: "boolean",
			visual: false
		},
		authorRateLimit: {
			type: "string",
			visual: false
		},
		backlogMaxRate: {
			type: "number",
			visual: false
		},
		backlogSpeedMultiplier: {
			type: "number",
			visual: false,
			displayScale: 1,
			displayPrecision: 1
		},
		backlogMode: {
			type: "string",
			visual: false
		},
		backlogRecentMinutes: {
			type: "number",
			visual: false
		},
		backlogOpacityMultiplier: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 0
		},
		depthLayersEnabled: {
			type: "boolean",
			visual: true
		},
		depthNearSpeedMul: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 0
		},
		depthFarSpeedMul: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 0
		},
		depthFarOpacityMul: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 0
		},
		motionBlurEnabled: {
			type: "boolean",
			visual: true
		},
		motionBlurAlpha: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 0
		},
		fontWeight: {
			type: "string",
			visual: true
		},
		fontFamily: {
			type: "string",
			visual: true
		},
		preserveUserColor: {
			type: "boolean",
			visual: true
		},
		superChatMaxBodyLines: {
			type: "number",
			visual: true
		},
		membershipMaxBodyLines: {
			type: "number",
			visual: true
		},
		fadeDurationMs: {
			type: "number",
			visual: false
		},
		minPollIntervalMs: {
			type: "number",
			visual: false
		},
		maxPollIntervalMs: {
			type: "number",
			visual: false
		},
		language: {
			type: "string",
			visual: false
		},
		modOwnerDurationMultiplier: {
			type: "number",
			visual: false,
			displayScale: 1,
			displayPrecision: 1
		},
		showSuperChatAmount: {
			type: "boolean",
			visual: true
		},
		translationEnabled: {
			type: "boolean",
			visual: false
		},
		translationService: {
			type: "string",
			visual: false
		},
		translationSource: {
			type: "string",
			visual: false
		},
		translationTarget: {
			type: "string",
			visual: false
		},
		translationMode: {
			type: "string",
			visual: true
		},
		exitPaddingPx: {
			type: "number",
			visual: true
		},
		scrollDurationMinMs: {
			type: "number",
			visual: false
		},
		scrollDurationMaxMs: {
			type: "number",
			visual: false
		},
		topBottomDurationMs: {
			type: "number",
			visual: true
		},
		queueMaxSize: {
			type: "number",
			visual: false
		},
		backgroundQueueMax: {
			type: "number",
			visual: false
		},
		maxMessageAgeMs: {
			type: "number",
			visual: true
		},
		headwayGapRatio: {
			type: "number",
			visual: true,
			displayScale: 100,
			displayPrecision: 1
		},
		emojiCacheMb: {
			type: "number",
			visual: false
		},
		photoCacheMb: {
			type: "number",
			visual: false
		},
		stickerCacheMb: {
			type: "number",
			visual: false
		},
		textCacheMb: {
			type: "number",
			visual: false
		},
		translationBatchSize: {
			type: "number",
			visual: false
		},
		emojiFetchLimit: {
			type: "number",
			visual: false
		},
		failedEmojiRetryMins: {
			type: "number",
			visual: false
		},
		burstSampleWindow: {
			type: "number",
			visual: false
		},
		burstElevatedThreshold: {
			type: "number",
			visual: false
		},
		burstHighThreshold: {
			type: "number",
			visual: false
		},
		burstExtremeThreshold: {
			type: "number",
			visual: false
		},
		backlogInjectionMax: {
			type: "number",
			visual: false
		},
		backlogDensityRampMs: {
			type: "number",
			visual: false
		},
		livePollFallbackMs: {
			type: "number",
			visual: false
		},
		livePollFailureLimit: {
			type: "number",
			visual: false
		},
		speedBoostThreshold: {
			type: "number",
			visual: false
		},
		backlogPauseThreshold: {
			type: "number",
			visual: false,
			displayScale: 100,
			displayPrecision: 0
		},
		backlogResumeThreshold: {
			type: "number",
			visual: false,
			displayScale: 100,
			displayPrecision: 0
		},
		activityTimeoutMs: {
			type: "number",
			visual: false
		},
		staggerMaxDelayMs: {
			type: "number",
			visual: false
		},
		staggerMediumDelayMs: {
			type: "number",
			visual: false
		},
		emojiFetchTimeoutMs: {
			type: "number",
			visual: false
		},
		backlogDensityRampMaxMs: {
			type: "number",
			visual: false
		},
		backlogInjectionRateMin: {
			type: "number",
			visual: false
		},
		speedBoostMax: {
			type: "number",
			visual: false,
			displayPrecision: 2
		},
		speedBoostDenom: {
			type: "number",
			visual: false
		},
		backlogToggleCooldownMs: {
			type: "number",
			visual: false
		},
		replayPrefetchPages: {
			type: "number",
			visual: false
		},
		replayBatchLimit: {
			type: "number",
			visual: false
		}
	};
	var VISUAL_ROOT_KEYS = Object.entries(ROOT_SETTING_META).filter(([, meta]) => meta.visual).map(([key]) => key);
	function getRootDisplayMeta(key) {
		const meta = ROOT_SETTING_META[key];
		return {
			scale: meta.displayScale ?? 1,
			precision: meta.displayPrecision ?? 0
		};
	}
	var isLogLevel = (value) => LOG_LEVEL_VALUES.includes(value);
	var VALID_BACKLOG_MODES = [
		"playback",
		"recent",
		"full",
		"none"
	];
	var VALID_DANMAKU_MODES = [
		"scroll",
		"reverse",
		"top",
		"bottom"
	];
	var AUTHOR_RATE_LIMIT_VALUES = [
		"off",
		"normal",
		"strict"
	];
	var LANGUAGE_VALUES = [
		"auto",
		"en",
		"ko",
		"ja",
		"es",
		"zh-CN",
		"ar"
	];
	var TRANSLATION_SERVICE_VALUES = ["auto", "off"];
	var TRANSLATION_TARGET_VALUES = [
		"auto",
		"en",
		"ko",
		"ja",
		"es",
		"zh-CN",
		"ar"
	];
	var TRANSLATION_SOURCE_VALUES = [
		"auto",
		"en",
		"ko",
		"ja",
		"es",
		"zh-CN",
		"ar"
	];
	var TRANSLATION_MODE_VALUES = ["dual", "replace"];
	var FONT_WEIGHT_VALUES = ["normal", "bold"];
	var LOG_LEVEL_VALUES = [
		"warn",
		"info",
		"debug"
	];
	var isColorValue = (value) => typeof value === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6,8})$/i.test(value);
	function clampNumber(value, fallback, limits) {
		const numericValue = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(numericValue)) return fallback;
		return Math.min(limits.max, Math.max(limits.min, numericValue));
	}
	var cloneSettings = (settings) => ({
		...settings,
		showAuthor: { ...settings.showAuthor },
		colors: { ...settings.colors },
		backgroundColors: { ...settings.backgroundColors },
		outline: { ...settings.outline }
	});
	function normalizeBackgroundColor(value, fallback) {
		if (!isColorValue(value)) return fallback;
		const hex = value.slice(1);
		let rgba;
		if (hex.length === 3) rgba = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}59`;
		else if (hex.length === 4) {
			const alpha = `${hex[3]}${hex[3]}`.toUpperCase() === "00" ? "00" : "59";
			rgba = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${alpha}`;
		} else if (hex.length === 6) rgba = `${hex}59`;
		else {
			const alpha = hex.slice(6).toUpperCase() === "00" ? "00" : "59";
			rgba = `${hex.slice(0, 6)}${alpha}`;
		}
		return `#${rgba.toUpperCase()}`;
	}
	var STRING_VALIDATORS = {
		backlogMode: (v) => VALID_BACKLOG_MODES.includes(v),
		danmakuMode: (v) => VALID_DANMAKU_MODES.includes(v),
		logLevel: (v) => isLogLevel(v),
		fontWeight: (v) => FONT_WEIGHT_VALUES.includes(v),
		fontFamily: (_v) => true,
		authorRateLimit: (v) => AUTHOR_RATE_LIMIT_VALUES.includes(v),
		language: (v) => LANGUAGE_VALUES.includes(v),
		translationService: (v) => TRANSLATION_SERVICE_VALUES.includes(v),
		translationTarget: (v) => TRANSLATION_TARGET_VALUES.includes(v),
		translationMode: (v) => TRANSLATION_MODE_VALUES.includes(v),
		translationSource: (v) => TRANSLATION_SOURCE_VALUES.includes(v)
	};
	function mutateScalarSettings(out, settings, defaults) {
		const mutableOut = out;
		const mutableDefaults = defaults;
		for (const key of Object.keys(ROOT_SETTING_META)) {
			const meta = ROOT_SETTING_META[key];
			const raw = settings[key];
			if (meta?.type === "boolean") {
				if (typeof raw === "boolean") mutableOut[key] = raw;
			} else if (meta?.type === "number") {
				const defaultVal = mutableDefaults[key];
				if (typeof defaultVal === "number") mutableOut[key] = clampNumber(raw, defaultVal, resolveLimits(key));
			} else {
				const validator = STRING_VALIDATORS[key];
				if (typeof raw === "string" && validator?.(raw)) mutableOut[key] = raw;
			}
		}
	}
	var normalizeSettings = (settings) => {
		const d = DEFAULT_SETTINGS;
		const out = cloneSettings(DEFAULT_SETTINGS);
		const pickBool = (v, fallback) => typeof v === "boolean" ? v : fallback;
		mutateScalarSettings(out, settings, d);
		for (const key of SHOW_AUTHOR_KEYS) out.showAuthor[key] = pickBool(settings.showAuthor[key], d.showAuthor[key]);
		for (const key of AUTHOR_COLOR_KEYS) {
			out.colors[key] = isColorValue(settings.colors[key]) ? settings.colors[key] : d.colors[key];
			out.backgroundColors[key] = normalizeBackgroundColor(settings.backgroundColors[key], d.backgroundColors[key]);
		}
		out.outline.enabled = pickBool(settings.outline.enabled, d.outline.enabled);
		for (const key of ["widthPx", "opacity"]) out.outline[key] = clampNumber(settings.outline[key], d.outline[key], resolveLimits(key));
		for (const [minKey, maxKey] of [
			["fontMinSize", "fontMaxSize"],
			["minPollIntervalMs", "maxPollIntervalMs"],
			["scrollDurationMinMs", "scrollDurationMaxMs"]
		]) {
			const minVal = out[minKey];
			const maxVal = out[maxKey];
			if (typeof minVal === "number" && typeof maxVal === "number" && minVal > maxVal) {
				out[minKey] = maxVal;
				out[maxKey] = minVal;
			}
		}
		return out;
	};
	function applySettingsPatch(base, partial) {
		return normalizeSettings({
			...base,
			...partial,
			showAuthor: {
				...base.showAuthor,
				...partial.showAuthor
			},
			colors: {
				...base.colors,
				...partial.colors
			},
			backgroundColors: {
				...base.backgroundColors,
				...partial.backgroundColors
			},
			outline: {
				...base.outline,
				...partial.outline
			}
		});
	}
	function normalizeStoredSettings(stored) {
		if (!stored || Array.isArray(stored)) return cloneSettings(DEFAULT_SETTINGS);
		const migrated = migrateSettings(stored);
		return applySettingsPatch(cloneSettings(DEFAULT_SETTINGS), migrated);
	}
	function shouldResetRendererForSettingsChange(previous, next) {
		if (VISUAL_ROOT_KEYS.some((key) => previous[key] !== next[key])) return true;
		if (SHOW_AUTHOR_KEYS.some((key) => previous.showAuthor[key] !== next.showAuthor[key])) return true;
		if (AUTHOR_COLOR_KEYS.some((key) => previous.colors[key] !== next.colors[key])) return true;
		return [
			"enabled",
			"widthPx",
			"opacity"
		].some((key) => previous.outline[key] !== next.outline[key]);
	}
	function measureContentWidth(message, font, fontSize, letterSpacing) {
		let width = 0;
		const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
		const measureText = (text) => measureTextWidth(text, font);
		if (message.content.length > 0) for (const seg of message.content) if (seg.type === "text") width += measureTextAdvanceWidth(seg.content, measureText, letterSpacing);
		else width += measureEmojiAdvanceWidth(seg, emojiSize, measureText, letterSpacing);
		else if (message.text) width += measureTextAdvanceWidth(message.text, measureText, letterSpacing);
		return Math.ceil(width);
	}
	function estimateMessageDimensions(message, fontSize, showAuthor, fontWeight = "bold", fontFamily = DEFAULT_FONT_FAMILY, maxBodyLines, showSuperChatAmount, letterSpacing = "0px") {
		const font = getFontString(fontSize, fontWeight, fontFamily);
		if (message.kind === "superchat") return estimateSuperChatDimensions(message, font, fontSize, showAuthor, fontFamily, maxBodyLines?.superchat ?? DEFAULT_SETTINGS.superChatMaxBodyLines, fontWeight, showSuperChatAmount);
		if (message.kind === "membership") return estimateMembershipDimensions(message, font, fontSize, maxBodyLines?.membership ?? DEFAULT_SETTINGS.membershipMaxBodyLines);
		return estimateRegularMessageDimensions(message, font, fontSize, showAuthor, fontFamily, letterSpacing);
	}
	function estimateRegularMessageDimensions(message, font, fontSize, showAuthor, fontFamily, letterSpacing) {
		const textWidth = measureContentWidth(message, font, fontSize, letterSpacing);
		const textHeight = measureTextHeight(font, fontSize);
		const { paddingH } = rendererLayout;
		if (!showAuthor || !message.author) return {
			width: textWidth + paddingH * 2,
			height: textHeight
		};
		const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
		const authorFont = getFontString(authorFontSize, "bold", fontFamily);
		const authorNameWidth = measureTextWidth(message.author, authorFont);
		const authorSectionWidth = rendererLayout.authorPhotoSize + spacing.sm + authorNameWidth;
		const totalWidth = Math.max(authorSectionWidth + paddingH * 2, textWidth + paddingH * 2);
		const photoHeight = rendererLayout.authorPhotoSize;
		const nameHeight = measureTextHeight(authorFont, authorFontSize);
		return {
			width: totalWidth,
			height: Math.max(photoHeight, nameHeight) + spacing.xs + textHeight
		};
	}
	function estimateSuperChatDimensions(message, font, fontSize, showAuthor, fontFamily, maxBodyLines, fontWeight = "bold", showSuperChatAmount = true) {
		const { paddingH, paddingV } = rendererLayout.superchat;
		const bodyLineHeight = measureTextHeight(font, fontSize);
		let authorSectionWidth = 0;
		let authorSectionHeight = 0;
		if (showAuthor && message.author) {
			const authorFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
			const authorFont = getFontString(authorFontSize, fontWeight, fontFamily);
			const rawNameWidth = measureTextWidth(message.author, authorFont);
			const authorNameWidth = Math.min(rawNameWidth, rendererLayout.authorNameMaxWidth);
			authorSectionWidth = rendererLayout.authorPhotoSize + spacing.sm + authorNameWidth;
			const nameHeight = measureTextHeight(authorFont, authorFontSize);
			authorSectionHeight = Math.max(rendererLayout.authorPhotoSize, nameHeight);
		}
		let badgeWidth = 0;
		let badgeHeight = 0;
		if (showSuperChatAmount) {
			const badgeFontSize = Math.round(fontSize * rendererLayout.authorFontScale);
			const badgeFont = getFontString(badgeFontSize, "bold", fontFamily);
			badgeWidth = measureTextWidth(message.superChat?.amount ?? "", badgeFont) + rendererLayout.superchatBadge.paddingH * 2;
			badgeHeight = badgeFontSize + rendererLayout.superchatBadge.paddingV * 2;
		}
		const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
		const maxInnerWidth = rendererLayout.superchatMaxWidth - paddingH * 2;
		const pass1Result = buildWrappedLines(toSharedContentSegments(message.content), Math.max(1, maxInnerWidth), emojiSize, (t) => measureTextWidth(t, font));
		const maxLineWidth = pass1Result.maxLineWidth;
		const contentWidth = Math.max(authorSectionWidth, badgeWidth, maxLineWidth);
		const width = Math.max(rendererLayout.superchatMinWidth, Math.min(rendererLayout.superchatMaxWidth, contentWidth + paddingH * 2));
		const pass1LineCount = pass1Result.lines.length;
		const actualInnerWidth = Math.max(1, width - paddingH * 2);
		let lineCount;
		if (actualInnerWidth === maxInnerWidth || pass1LineCount <= 1) lineCount = Math.min(pass1LineCount, maxBodyLines);
		else {
			const pass2Result = buildWrappedLines(toSharedContentSegments(message.content), actualInnerWidth, emojiSize, (t) => measureTextWidth(t, font));
			lineCount = Math.min(pass2Result.lines.length, maxBodyLines);
		}
		const textHeight = Math.ceil(bodyLineHeight) * lineCount;
		let stickerHeight = 0;
		if (message.superChat?.sticker) stickerHeight = Math.round(fontSize * rendererLayout.superchatStickerSize) + spacing.xs;
		const badgeSectionHeight = showSuperChatAmount ? spacing.xs + badgeHeight + spacing.xs : lineCount > 0 ? spacing.xs : 0;
		return {
			width,
			height: authorSectionHeight + badgeSectionHeight + textHeight + stickerHeight + paddingV * 2
		};
	}
	function estimateMembershipDimensions(message, font, fontSize, maxBodyLines) {
		const textWidth = measureContentWidth(message, font, fontSize, "0px");
		const { paddingH, paddingV } = rendererLayout.membership;
		const nameHeight = measureTextHeight(font, fontSize);
		const bodyLineHeight = measureTextHeight(font, fontSize);
		const infoHeight = nameHeight;
		const width = Math.max(rendererLayout.superchatMinWidth, Math.min(rendererLayout.superchatMaxWidth, textWidth + paddingH * 2));
		let headerHeight = 0;
		if (message.membershipHeader) headerHeight = measureTextHeight(font, Math.round(fontSize * .8)) + spacing.xs;
		const actualInnerWidth = Math.max(1, width - paddingH * 2);
		const emojiSize = Math.round(fontSize * rendererLayout.emojiSize);
		const passResult = buildWrappedLines(toSharedContentSegments(message.content), actualInnerWidth, emojiSize, (t) => measureTextWidth(t, font));
		const bodyLineCount = Math.min(passResult.lines.length, maxBodyLines);
		const textHeight = Math.ceil(bodyLineHeight) * bodyLineCount;
		const authorBodyGap = message.author !== void 0 ? spacing.xs : 0;
		return {
			width,
			height: headerHeight + infoHeight + authorBodyGap + textHeight + paddingV * 2
		};
	}
	function computeAgeFadeRate(maxMessageAgeMs) {
		return 1 / Math.max(1, maxMessageAgeMs);
	}
	function computeInvFadeDuration(fadeDurationMs) {
		return fadeDurationMs > 0 ? 1 / Math.max(1, fadeDurationMs) : 0;
	}
	function computeMessageOpacity(isBacklog, elapsed, duration, isScrolling, speedTier, config) {
		let opacity = config.baseOpacity;
		if (config.fadeDurationMs > 0) if (isScrolling) {
			const remaining = duration - elapsed;
			if (remaining < config.fadeDurationMs) opacity *= Math.max(0, remaining * config.invFadeDuration);
		} else {
			if (elapsed < config.fadeDurationMs) opacity *= elapsed * config.invFadeDuration;
			if (elapsed > duration - config.fadeDurationMs) opacity *= Math.max(0, (duration - elapsed) * config.invFadeDuration);
		}
		if (isBacklog) opacity *= config.backlogOpacityMultiplier;
		if (config.depthLayersEnabled && speedTier === SPEED_TIER.FAR) opacity *= config.depthFarOpacityMul;
		const ageRatio = isScrolling ? Math.min(1, elapsed * config.ageFadeRate) : 0;
		opacity *= Math.max(0, 1 - ageRatio);
		return opacity;
	}
	function enqueueWithOverflow(queue, message, priority, onDrop, maxSize) {
		if (queue.size >= maxSize) {
			const lowest = queue.peekLowest();
			if (lowest && priority <= RendererBase.getMessagePriority(lowest)) {
				onDrop("queue_priority");
				return "dropped";
			}
			queue.dropLowest();
			onDrop("queue_replaced");
			queue.enqueue(message, priority);
			return "replaced";
		}
		queue.enqueue(message, priority);
		return "enqueued";
	}
	var LIVE_REGION_MAX_MESSAGES = 10;
	var LIVE_REGION_THROTTLE_MS = 500;
	function drainStage(ctx, now, _dims) {
		if (!ctx.isReplayMode && ctx.isAntiBlockActive()) {
			const currentNow = now;
			if (ctx.antiBlockSince.value === null) ctx.antiBlockSince.value = currentNow;
			const peeked = ctx.pendingQueue.peek();
			const forceDrain = peeked !== void 0 && currentNow - ctx.antiBlockSince.value >= 2e3;
			if (peeked !== void 0 && getMessagePriority(peeked) >= 80 || forceDrain) {
				if (forceDrain) ctx.antiBlockSince.value = currentNow;
				ctx.laneAllocator.resetBatch(now);
				ctx.drainQueue(now);
			}
		} else {
			ctx.antiBlockSince.value = null;
			ctx.laneAllocator.resetBatch(now);
			ctx.drainQueue(now);
		}
	}
	function cleanupAndBucketStage(ctx, now, dims, mode) {
		const isScrolling = mode === "scroll" || mode === "reverse";
		const farBuckets = ctx.farOpacityBuckets;
		const midBuckets = ctx.midOpacityBuckets;
		const nearBuckets = ctx.nearOpacityBuckets;
		for (const bucket of farBuckets) bucket.length = 0;
		for (const bucket of midBuckets) bucket.length = 0;
		for (const bucket of nearBuckets) bucket.length = 0;
		ctx.expiredMessagesScratch.length = 0;
		const oldLength = ctx.activeMessages.length;
		let writeIdx = 0;
		let anyRemoved = false;
		for (let i = 0; i < oldLength; i++) {
			const msg = ctx.activeMessages[i];
			if (!msg) continue;
			const elapsed = now - msg.startTime - msg.pausedDuration;
			if (elapsed >= msg.duration) {
				ctx.expiredMessagesScratch.push(msg);
				ctx.messageActivator.releaseMessage(msg);
				anyRemoved = true;
				continue;
			}
			ctx.activeMessages[writeIdx] = msg;
			writeIdx++;
			if (elapsed < 0) continue;
			if (msg.speedTier === SPEED_TIER.FAR) {
				msg._prevX = msg.x;
				msg._prevY = msg.y;
			}
			const progress = Math.min(1, Math.max(0, elapsed * msg.invDuration));
			if (mode === "scroll") if (!ctx.isReducedMotionActive) {
				const travelDistance = msg.startX + msg.width + ctx.settings.exitPaddingPx;
				msg.x = msg.startX - progress * travelDistance;
			} else msg.x = Math.max(0, (dims.width - msg.width) / 2);
			else if (mode === "reverse") if (!ctx.isReducedMotionActive) {
				const travelDistance = dims.width - msg.startX + ctx.settings.exitPaddingPx;
				msg.x = msg.startX + progress * travelDistance;
			} else msg.x = Math.max(0, (dims.width - msg.width) / 2);
			const fadeElapsed = now - msg.fadeStartTime - msg.pausedDuration;
			const opacity = computeMessageOpacity(msg.message.isBacklog === true, fadeElapsed, msg.duration, isScrolling, msg.speedTier, ctx.cachedOpacityConfig);
			const bucketIndex = Math.min(20, Math.round(opacity * 20));
			msg._frameElapsed = elapsed;
			if (msg.speedTier === SPEED_TIER.FAR) farBuckets[bucketIndex].push(msg);
			else if (msg.speedTier === SPEED_TIER.NEAR) nearBuckets[bucketIndex].push(msg);
			else midBuckets[bucketIndex].push(msg);
		}
		return {
			farBuckets,
			midBuckets,
			nearBuckets,
			anyRemoved,
			writeIdx,
			oldLength
		};
	}
	function compactRemovedMessages(ctx, writeIdx, oldLength) {
		for (const msg of ctx.expiredMessagesScratch) removeMessageFromLaneIndex(ctx.activeMessagesByLane, msg, msg.slotCount ?? 1);
		if (writeIdx < oldLength * .5) {
			const newMessages = ctx.activeMessages.slice(0, writeIdx);
			ctx.activeMessages.length = 0;
			Array.prototype.push.apply(ctx.activeMessages, newMessages);
		} else ctx.activeMessages.length = writeIdx;
		for (const [lane, msgs] of ctx.activeMessagesByLane) if (msgs.length === 0) ctx.activeMessagesByLane.delete(lane);
		ctx.observability.updateActiveMessages(ctx.activeMessages.length);
		ctx.observability.updateQueueDepth(ctx.pendingQueue.size);
	}
	function drawStage(ctx, renderCtx, buckets) {
		for (let bucketIndex = 0; bucketIndex < 21; bucketIndex++) {
			const entries = buckets[bucketIndex];
			if (!entries || entries.length === 0) continue;
			const bucketOpacity = bucketIndex / 20;
			renderCtx.globalAlpha = bucketOpacity;
			try {
				for (const msg of entries) {
					const elapsed = msg._frameElapsed;
					const snappedX = Math.floor(msg.x);
					const snappedY = Math.floor(msg.y);
					if (ctx.settings.motionBlurEnabled && !ctx.isReducedMotionActive && msg.speedTier === SPEED_TIER.FAR && msg._prevX !== void 0 && msg._prevY !== void 0) {
						const ghostAlpha = renderCtx.globalAlpha * ctx.settings.motionBlurAlpha;
						if (ghostAlpha > .001) {
							renderCtx.save();
							renderCtx.globalAlpha = ghostAlpha;
							if (msg.renderMessage) {
								renderCtx.font = ctx.boundGetFont(ctx.settings.fontSize);
								renderCtx.textBaseline = "top";
								renderCtx.textRendering = "optimizeSpeed";
								renderCtx.fontKerning = "none";
								renderCtx.fillStyle = msg.renderMessage.userColor && ctx.settings.preserveUserColor ? msg.renderMessage.userColor : msg.renderMessage.authorType && ctx.settings.colors[msg.renderMessage.authorType] || ctx.settings.colors.normal;
								if (msg.ghostText) renderCtx.fillText(msg.ghostText, Math.floor(msg._prevX) + rendererLayout.paddingH, Math.floor(msg._prevY));
							}
							renderCtx.restore();
						}
					}
					const renderMessage = msg.renderMessage;
					if (msg.message.kind === "text") {
						const isReplace = ctx.settings.translationEnabled && ctx.settings.translationMode === "replace";
						const regularConfig = ctx.regularRenderConfig;
						regularConfig.fontSize = ctx.settings.fontSize;
						regularConfig.fontWeight = ctx.settings.fontWeight;
						regularConfig.fontFamily = ctx.settings.fontFamily;
						regularConfig.outlineWidthPx = ctx.settings.outline.enabled ? ctx.settings.outline.widthPx : 0;
						regularConfig.outlineOpacity = ctx.settings.outline.enabled ? ctx.settings.outline.opacity : 0;
						regularConfig.showAuthor = ctx.settings.showAuthor[renderMessage.authorType];
						regularConfig.color = ctx.settings.preserveUserColor && renderMessage.userColor ? renderMessage.userColor : ctx.settings.colors[renderMessage.authorType];
						regularConfig.backgroundColor = ctx.settings.backgroundColors[renderMessage.authorType];
						regularConfig.messageWidth = msg.width;
						regularConfig.messageHeight = msg.height;
						renderRegularMessage(renderCtx, renderMessage, snappedX, snappedY, regularConfig, ctx.textBitmapCache, ctx.imageFetchManager.emojiCache, isImageReady, ctx.imageFetchManager.authorPhotoCache, isImageReady, ctx.boundGetFont, ctx.boundMeasureTextWidth, isReplace ? msg.translatedText : void 0, msg.speedTier === SPEED_TIER.FAR ? "1px" : void 0);
					} else {
						const cardConfig = msg.message.kind === "superchat" ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG;
						const paidRenderMessage = (ctx.settings.translationEnabled && ctx.settings.translationMode === "replace" ? msg.translatedText : void 0) ? msg.translatedRenderMessage ?? renderMessage : renderMessage;
						renderCtx.save();
						try {
							renderPaidCard(renderCtx, paidRenderMessage, msg.width, msg.height, snappedX, snappedY, elapsed, cardConfig, ctx.settings, ctx.textBitmapCache, ctx.imageFetchManager.authorPhotoCache, ctx.imageFetchManager.stickerCache, ctx.imageFetchManager.emojiCache, ctx.boundGetFont, ctx.superChatGradientCache);
						} finally {
							renderCtx.restore();
						}
					}
					if (ctx.settings.translationEnabled && msg.translatedText && ctx.settings.translationMode !== "replace") {
						const fontSize = Math.max(1, Math.round(ctx.settings.fontSize * TRANSLATION_FONT_SCALE));
						const transY = snappedY + msg.height - fontSize - 2;
						const transColor = ctx.settings.preserveUserColor && renderMessage.userColor ? renderMessage.userColor : msg.message.authorType && ctx.settings.colors[msg.message.authorType] || ctx.settings.colors.normal;
						renderCtx.save();
						try {
							renderCtx.globalAlpha = bucketOpacity * TRANSLATION_OPACITY_SCALE;
							const transFont = getFontString(fontSize, "normal", ctx.settings.fontFamily);
							renderSegment(renderCtx, msg.translatedText, snappedX + (msg.message.kind === "text" ? rendererLayout.paddingH : 0), transY, transColor, fontSize, ctx.settings.outline.enabled ? ctx.settings.outline.widthPx : 0, ctx.settings.outline.enabled ? ctx.settings.outline.opacity : 0, ctx.textBitmapCache, (_fs) => transFont);
						} finally {
							renderCtx.restore();
						}
					}
				}
			} finally {
				renderCtx.globalAlpha = 1;
			}
		}
	}
	function drawGlowStage(_ctx, renderCtx, buckets) {
		for (let bucketIndex = 0; bucketIndex < 21; bucketIndex++) {
			const entries = buckets[bucketIndex];
			if (!entries || entries.length === 0) continue;
			for (const msg of entries) {
				if (!msg.message || msg.message.kind === "text") continue;
				const renderMessage = msg.renderMessage;
				if (!renderMessage) continue;
				const cardConfig = renderMessage.kind === "superchat" ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG;
				if (cardConfig.decoration !== "pulsingBorder") continue;
				const pb = cardConfig.pulsingBorder;
				if (!pb) continue;
				const pulse = computePulseAlpha(msg._frameElapsed ?? 0, pb.baseAlpha, pb.amplitude);
				if (pulse <= .01) continue;
				const alpha = Math.min(1, pulse * .3);
				renderCtx.save();
				renderCtx.globalAlpha = alpha;
				renderCtx.filter = "blur(8px)";
				renderCtx.fillStyle = `rgb(${pb.borderRgb.r},${pb.borderRgb.g},${pb.borderRgb.b})`;
				renderCtx.fillRect(Math.floor(msg.x) - 4, Math.floor(msg.y) - 4, msg.width + 8, msg.height + 8);
				renderCtx.restore();
			}
		}
	}
	function mirrorVisibleMessages(ctx) {
		const now = performance.now();
		if (now - ctx.lastLiveRegionUpdate.value < LIVE_REGION_THROTTLE_MS) return;
		ctx.lastLiveRegionUpdate.value = now;
		const count = Math.min(ctx.activeMessages.length, LIVE_REGION_MAX_MESSAGES);
		if (count === 0) return;
		const messages = [];
		const start = ctx.activeMessages.length - count;
		for (let i = start; i < ctx.activeMessages.length; i++) {
			const msg = ctx.activeMessages[i];
			if (!msg) continue;
			const message = msg.message;
			if (!message.text && !message.author) continue;
			messages.push({
				id: message.id ?? `${message.timestamp}:${message.author ?? ""}:${message.kind}:${message.text}`,
				text: message.text,
				kind: message.kind,
				...message.author !== void 0 ? { author: message.author } : {},
				...message.superChat?.amount !== void 0 ? { superChatAmount: message.superChat.amount } : {},
				...message.membershipHeader !== void 0 ? { membershipHeader: message.membershipHeader } : {}
			});
		}
		if (messages.length > 0) ctx.updateLiveRegion(messages);
	}
	function isImageReady(img) {
		return img?.complete === true && img.naturalWidth > 0;
	}
	function getMessagePriority(message) {
		let priority = {
			superchat: 100,
			membership: 90,
			text: 0
		}[message.kind] ?? 0;
		if (message.isBacklog) priority -= 50;
		return priority;
	}
	function getSpeedTier(message, config) {
		if (message.isBacklog) return SPEED_TIER.BACKLOG;
		if (!config.depthLayersEnabled) return SPEED_TIER.MID;
		const mode = config.danmakuMode;
		if (mode !== "scroll" && mode !== "reverse") return SPEED_TIER.MID;
		if (message.kind === "superchat" || message.kind === "membership") return SPEED_TIER.NEAR;
		return hashStringForTier(message.id ?? String(message.timestamp)) < .3 ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
	}
	function workerSupported() {
		if (window.__ytExtensionBridge?.workerSupported) return true;
		if (((typeof chrome !== "undefined" ? chrome : void 0) ?? (typeof browser !== "undefined" ? browser : void 0))?.runtime?.getURL) return true;
		const metaUrl = {}.url;
		try {
			new URL(".", metaUrl);
		} catch {
			return false;
		}
		return true;
	}
	function createWorkerUrl() {
		if (window.__ytExtensionBridge?.workerUrl) return window.__ytExtensionBridge.workerUrl;
		const chromeApi = (typeof chrome !== "undefined" ? chrome : void 0) ?? (typeof browser !== "undefined" ? browser : void 0);
		if (chromeApi?.runtime?.getURL) return chromeApi.runtime.getURL("workers/renderer.js");
		return new URL("data:video/mp2t;base64,Ly8gU1BEWC1MaWNlbnNlLUlkZW50aWZpZXI6IE1JVAovLyBDb3B5cmlnaHQgKGMpIDIwMjYgUGllc1AKCi8qKgogKiBSZW5kZXJlcldvcmtlciDigJQgT2Zmc2NyZWVuQ2FudmFzLWJhc2VkIHJlbmRlciBsb29wIHJ1bm5pbmcgaW4gYSBXZWIgV29ya2VyLgogKgogKiBPZmZsb2FkcyBDYW52YXMgMkQgcmVuZGVyaW5nIGZyb20gdGhlIG1haW4gdGhyZWFkLiBUaGUgbWFpbiB0aHJlYWQgaGFuZGxlcwogKiBET00gb2JzZXJ2YXRpb24sIEFQSSBwb2xsaW5nLCBhbmQgdHJhbnNsYXRpb247IHRoZSB3b3JrZXIgcnVucyBpdHMgb3duIHJBRgogKiBsb29wIGZvciByZW5kZXJpbmcsIGxhbmUgYWxsb2NhdGlvbiwgYW5kIG1lc3NhZ2UgbGlmZWN5Y2xlLgogKgogKiAjIyBQcm90b2NvbAogKgogKiBNYWluIOKGkiBXb3JrZXI6CiAqICAgeyB0eXBlOiAnaW5pdCcsIGNhbnZhczogT2Zmc2NyZWVuQ2FudmFzLCBjb25maWc6IFdvcmtlckNvbmZpZyB9CiAqICAgeyB0eXBlOiAncmVzaXplJywgd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIsIGRwcjogbnVtYmVyIH0KICogICB7IHR5cGU6ICdhZGRNZXNzYWdlcycsIG1lc3NhZ2VzOiBXb3JrZXJNZXNzYWdlW10gfQogKiAgIHsgdHlwZTogJ3VwZGF0ZUNvbmZpZycsIGNvbmZpZzogUGFydGlhbDxXb3JrZXJDb25maWc+IH0KICogICB7IHR5cGU6ICdzZXRQYXVzZWQnLCBwYXVzZWQ6IGJvb2xlYW4gfQogKiAgIHsgdHlwZTogJ3NuYXBzaG90TWVzc2FnZXMnLCByZXF1ZXN0SWQ6IG51bWJlciB9CiAqICAgeyB0eXBlOiAnZGVzdHJveScgfQogKgogKiBXb3JrZXIg4oaSIE1haW46CiAqICAgeyB0eXBlOiAnc3RhdHMnLCBhY3RpdmVNZXNzYWdlczogbnVtYmVyLCBkcm9wczogbnVtYmVyIH0KICoKICogIyMgV29ya2VyQ29uZmlnCiAqCiAqIEEgbWluaW1hbCBzdWJzZXQgb2YgT3ZlcmxheVNldHRpbmdzIG5lZWRlZCBieSB0aGUgcmVuZGVyIGxvb3AuCiAqIFRoZSBtYWluIHRocmVhZCBzZXJpYWxpemVzIHJlbGV2YW50IHNldHRpbmdzIGludG8gdGhpcyBmbGF0IGNvbmZpZyBzaGFwZS4KICovCgovLy8gPHJlZmVyZW5jZSBsaWI9IndlYndvcmtlciIgLz4KCmltcG9ydCB0eXBlIHsgRm9udFdlaWdodCB9IGZyb20gJ0BhcHAtdHlwZXMnOwppbXBvcnQgeyBFTU9KSV9DQUNIRV9NQVhfRU5UUklFUywgZ2V0U3RpY2tlckNhY2hlQnl0ZXMgfSBmcm9tICdAbWVkaWEvY2FjaGUtbGltaXRzJzsKaW1wb3J0IHsgaXNBbGxvd2VkSW1hZ2VVcmwgfSBmcm9tICdAbWVkaWEvaW1hZ2UtdXJsLXZhbGlkYXRpb24nOwppbXBvcnQgeyBnZXRDYWNoZWRHcmFkaWVudCB9IGZyb20gJ0ByZW5kZXJlci9jYW52YXMvZ3JhZGllbnQtdXRpbHMnOwppbXBvcnQgeyBjb21wdXRlUHVsc2VBbHBoYSB9IGZyb20gJ0ByZW5kZXJlci9jYW52YXMvbHV0LWhlbHBlcnMnOwppbXBvcnQgewogIGFkZE1lc3NhZ2VUb0xhbmVJbmRleCwKICBmYXN0UmFuZG9tLAogIHJlbW92ZU1lc3NhZ2VGcm9tTGFuZUluZGV4LAp9IGZyb20gJ0ByZW5kZXJlci9jYW52YXMvcGlwZWxpbmUtdXRpbHMnOwppbXBvcnQgewogIGRyYXdBdXRob3JTZWN0aW9uLAogIGRyYXdSb3VuZFJlY3QsCiAgZ2V0RGlzcGxheVRleHQsCiAgZ2V0U2FmZVRleHRIZWlnaHQsCiAgdHlwZSBSZWd1bGFyTWVzc2FnZVJlbmRlckNvbmZpZywKICByZW5kZXJSZWd1bGFyTWVzc2FnZSwKICByZW5kZXJTZWdtZW50LAogIHJlbmRlcldyYXBwZWRDb250ZW50U2VnbWVudHMsCiAgc3BsaXRHcmFwaGVtZUNsdXN0ZXJzLAogIHN0cm9rZVRleHRPdXRsaW5lLAogIHR5cGUgVGV4dEJpdG1hcENhY2hlLAogIHdhcm1UZXh0Qml0bWFwQ2FjaGUsCn0gZnJvbSAnQHJlbmRlcmVyL2NhbnZhcy9zaGFyZWQnOwppbXBvcnQgeyBnZXRTcGVlZFRpZXIgfSBmcm9tICdAcmVuZGVyZXIvY2FudmFzL3NwZWVkLXRpZXInOwppbXBvcnQgdHlwZSB7IENhcmRDb25maWdXb3JrZXIgfSBmcm9tICdAcmVuZGVyZXIvY2FyZC1jb25maWcnOwppbXBvcnQgeyBkZXNhdHVyYXRlQ29sb3IgfSBmcm9tICdAcmVuZGVyZXIvY29sb3ItdXRpbHMnOwppbXBvcnQgewogIEFOVElfQkxPQ0tfRlJFRV9SQVRJTywKICBBTlRJX0JMT0NLX01BWF9EVVJBVElPTl9NUywKICBBTlRJX0JMT0NLX1BSSU9SSVRZX1RIUkVTSE9MRCwKICBFTU9KSV9GRVRDSF9USU1FT1VUX0RFRkFVTFRfTVMsCiAgRkFSX0xBWUVSX0RFU0FUVVJBVElPTl9GQUNUT1IsCiAgR1JBRElFTlRfQ0FDSEVfTUFYLAogIEhPUklaT05UQUxfU1RBR0dFUl9NQVgsCiAgSE9SSVpPTlRBTF9TVEFHR0VSX1BFUl9TVEVQLAogIElETEVfR1JBQ0VfUEVSSU9EX01TLAogIE9QQUNJVFlfQlVDS0VUX0NPVU5UIGFzIE9QQUNJVFlfQlVDS0VUUywKICBTUEVFRF9USUVSLAogIFNUQUdHRVJfQkFUQ0hfTUFYLAogIFNUQUdHRVJfRVhQX1NDQUxFLAogIFNUQUdHRVJfUVVFVUVfSElHSCwKICBTVEFHR0VSX1FVRVVFX01FRCwKICBUUkFOU0xBVElPTl9GT05UX1NDQUxFLAogIFRSQU5TTEFUSU9OX0dBUF9QWCwKICBUUkFOU0xBVElPTl9PUEFDSVRZX1NDQUxFLAp9IGZyb20gJ0ByZW5kZXJlci9jb25zdGFudHMnOwppbXBvcnQgewogIGJ1aWxkTGFuZUhlYXAsCiAgY29tbWl0UGxhY2VtZW50U2hhcmVkLAogIGNvbXB1dGVCYXNlSGVhZHdheVB4LAogIGNvbXB1dGVMYW5lWSwKICBjb21wdXRlT2NjdXBhbmN5TXMgYXMgY29tcHV0ZU9jY3VwYW5jeU1zU2hhcmVkLAogIGZpbmRQbGFjZW1lbnRTaGFyZWQsCiAgdHlwZSBMYW5lQWxsb2NhdGlvblN0YXRlLAogIHJlc2V0QmF0Y2hTaGFyZWQsCiAgc2hpZnRMYW5lVGltZXJzU2hhcmVkLAp9IGZyb20gJ0ByZW5kZXJlci9sYXlvdXQvbGFuZS1zaGFyZWQnOwppbXBvcnQgewogIGNvbXB1dGVBZ2VGYWRlUmF0ZSwKICBjb21wdXRlSW52RmFkZUR1cmF0aW9uLAogIGNvbXB1dGVNZXNzYWdlT3BhY2l0eSwKICB0eXBlIE9wYWNpdHlDb25maWcsCn0gZnJvbSAnQHJlbmRlcmVyL3NoYXJlZCc7CmltcG9ydCB7IGdldEZvbnRTdHJpbmcsIG1lYXN1cmVCb3VuZGluZ0JveFdpZHRoIH0gZnJvbSAnQHJlbmRlcmVyL3RleHQtbWVhc3VyZSc7CmltcG9ydCB7IERFRkFVTFRfU0VUVElOR1MgfSBmcm9tICdAc2V0dGluZ3MvZGVmYXVsdHMnOwppbXBvcnQgeyBSZXNpemFibGVCeXRlTGltaXRlZENhY2hlIH0gZnJvbSAnQHV0aWwvYnl0ZS1saW1pdGVkLWNhY2hlJzsKaW1wb3J0IHsKICBjb21wdXRlU2Nyb2xsRHVyYXRpb24sCiAgREVGQVVMVF9GT05UX0ZBTUlMWSwKICBERUZBVUxUX1RFWFRfQ09MT1IsCiAgcmVuZGVyZXJMYXlvdXQsCiAgc3BhY2luZywKfSBmcm9tICdAdXRpbC9kZXNpZ24tdG9rZW5zJzsKaW1wb3J0IHsgTWFwQ29tcGF0aWJsZUxydU1hcCB9IGZyb20gJ0B1dGlsL2xydS1tYXAnOwppbXBvcnQgeyBpc1ZhbGlkQ29udHJvbE1lc3NhZ2UgfSBmcm9tICcuL3Byb3RvY29sLWd1YXJkcyc7CgppbXBvcnQgdHlwZSB7IEFjdGl2ZU1lc3NhZ2UsIFdvcmtlckNvbmZpZywgV29ya2VyQ29udGVudFNlZ21lbnQsIFdvcmtlck1lc3NhZ2UgfSBmcm9tICcuL3R5cGVzJzsKCi8vIOKUgOKUgCBXb3JrZXItc3BlY2lmaWMgY29uc3RhbnRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKLyoqIFN0aWNrZXIgaW1hZ2UgY2FjaGUg4oCUIGxhemlseSBpbml0aWFsaXplZCBkdXJpbmcgd29ya2VyIGluaXQuICovCmxldCBzdGlja2VyQ2FjaGU6IFJlc2l6YWJsZUJ5dGVMaW1pdGVkQ2FjaGU8SW1hZ2VCaXRtYXA+IHwgbnVsbCA9IG51bGw7CgpmdW5jdGlvbiBpc0F2YWlsYWJsZUltYWdlKGltYWdlOiB1bmtub3duKTogYm9vbGVhbiB7CiAgcmV0dXJuIGltYWdlICE9IG51bGw7Cn0KCmZ1bmN0aW9uIG1lYXN1cmVUZXh0SGVpZ2h0KAogIGZvbnRTaXplOiBudW1iZXIsCiAgZm9udDogc3RyaW5nLAogIGN0eD86IE9mZnNjcmVlbkNhbnZhc1JlbmRlcmluZ0NvbnRleHQyRAopOiBudW1iZXIgewogIGlmIChjdHgpIHsKICAgIGN0eC5mb250ID0gZm9udDsKICAgIGNvbnN0IG0gPSBjdHgubWVhc3VyZVRleHQoJ01nJyk7CiAgICBjb25zdCBhc2NlbnQgPSBNYXRoLm1heCgwLCBtLmFjdHVhbEJvdW5kaW5nQm94QXNjZW50KTsKICAgIGNvbnN0IGRlc2NlbnQgPSBNYXRoLm1heCgwLCBtLmFjdHVhbEJvdW5kaW5nQm94RGVzY2VudCk7CiAgICBpZiAoYXNjZW50ID4gMCAmJiBkZXNjZW50ID4gMCkgcmV0dXJuIE1hdGguY2VpbChhc2NlbnQgKyBkZXNjZW50KTsKICB9CiAgcmV0dXJuIE1hdGguY2VpbChmb250U2l6ZSAqIDEuMSk7Cn0KCi8vIOKUgOKUgCBDb25maWctZHJpdmVuIHBhaWQgY2FyZCByZW5kZXJlciAod29ya2VyIHZhcmlhbnQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAoKLyoqCiAqIFJlbmRlciBhIHBhaWQgY2FyZCAoU3VwZXJDaGF0IG9yIE1lbWJlcnNoaXApIGRyaXZlbiBlbnRpcmVseSBieSBhCiAqIENhcmRDb25maWdXb3JrZXIuIE1pcnJvcnMgdGhlIG1haW4tdGhyZWFkIHJlbmRlclBhaWRDYXJkIGJ1dCB1c2VzIHdvcmtlci1zYWZlCiAqIHR5cGVzIChPZmZzY3JlZW5DYW52YXNSZW5kZXJpbmdDb250ZXh0MkQsIFJlc2l6YWJsZUJ5dGVMaW1pdGVkQ2FjaGU8SW1hZ2VCaXRtYXA+KS4KICoKICogQWxsIGNvbG91cnMsIGRpbWVuc2lvbnMsIGFuZCBmbGFncyBhcmUgcHJlLXJlc29sdmVkIGluIHRoZSBDYXJkQ29uZmlnV29ya2VyCiAqIOKAlCBubyBjYWxsYmFja3Mgb3Igc2V0dGluZ3MgbG9va3VwcyBuZWVkZWQuCiAqLwpmdW5jdGlvbiByZW5kZXJQYWlkQ2FyZFdvcmtlcigKICBjdHg6IE9mZnNjcmVlbkNhbnZhc1JlbmRlcmluZ0NvbnRleHQyRCwKICBtZXNzYWdlOiBBY3RpdmVNZXNzYWdlLAogIGNvbnRlbnQ6IHJlYWRvbmx5IFdvcmtlckNvbnRlbnRTZWdtZW50W10sCiAgbXNnV2lkdGg6IG51bWJlciwKICBtc2dIZWlnaHQ6IG51bWJlciwKICB4OiBudW1iZXIsCiAgeTogbnVtYmVyLAogIGVsYXBzZWQ6IG51bWJlciwKICBjYXJkOiBDYXJkQ29uZmlnV29ya2VyLAogIGZvbnRTaXplOiBudW1iZXIsCiAgZm9udFdlaWdodDogc3RyaW5nLAogIGZvbnRGYW1pbHk6IHN0cmluZywKICBvdXRsaW5lV2lkdGhQeDogbnVtYmVyLAogIG91dGxpbmVPcGFjaXR5OiBudW1iZXIsCiAgdGV4dEJpdG1hcENhY2hlOiBUZXh0Qml0bWFwQ2FjaGUsCiAgYXV0aG9yUGhvdG9DYWNoZTogUmVzaXphYmxlQnl0ZUxpbWl0ZWRDYWNoZTxJbWFnZUJpdG1hcD4sCiAgZW1vamlDYWNoZTogUmVzaXphYmxlQnl0ZUxpbWl0ZWRDYWNoZTxJbWFnZUJpdG1hcD4sCiAgZ2V0Rm9udEZuOiAoZm9udFNpemU6IG51bWJlcikgPT4gc3RyaW5nLAogIGdyYWRpZW50Q2FjaGU6IE1hcDxzdHJpbmcsIENhbnZhc0dyYWRpZW50PiwKICAvKiogQ29uZmlndXJhYmxlIFN1cGVyQ2hhdCBvcGFjaXR5IGZyb20gc2V0dGluZ3MsIGNsYW1wZWQgdG8gWzAuMzUsIDFdLiAqLwogIHN1cGVyQ2hhdE9wYWNpdHk6IG51bWJlcgopOiB2b2lkIHsKICBjb25zdCB3ID0gbXNnV2lkdGg7CiAgY29uc3QgaCA9IG1zZ0hlaWdodDsKCiAgLy8g4pSA4pSAIDEuIFJlc29sdmUgYmFzZSBjb2xvdXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgY29uc3QgcmdiID0gY2FyZC5yZXNvbHZlQ29sb3JSZ2I7CiAgY29uc3QgYmFzZUNvbG9yID0gYHJnYigke3JnYi5yfSwgJHtyZ2IuZ30sICR7cmdiLmJ9KWA7CiAgY29uc3QgdGV4dENvbG9yID0gY2FyZC50ZXh0Q29sb3I7CgogIC8vIENvbXB1dGUgZ3JhZGllbnQgb3BhY2l0aWVzIGlmIGJhY2tncm91bmQgaXMgZ3JhZGllbnQKICAvLyBzY0FscGhhIGlzIGRlY2xhcmVkIGhlcmUgKHdpdGggZGVmYXVsdCAxKSBhbmQgcmVhc3NpZ25lZCBpbnNpZGUgdGhlCiAgLy8gZ3JhZGllbnQgYmxvY2sgYmVsb3cuIEEgc2VwYXJhdGUgYGlmYCB3aXRoIHRoZSBzYW1lIGNvbmRpdGlvbiByZWFkcyBpdCwKICAvLyBzbyBUUyBuZWVkcyBkZWZpbml0ZSBhc3NpZ25tZW50IG91dHNpZGUgdGhlIGZpcnN0IGBpZmAuCiAgbGV0IHRvcEFscGhhID0gMTsKICBsZXQgc2NBbHBoYSA9IDE7CiAgbGV0IGJvdHRvbUFscGhhID0gMTsKICBpZiAoY2FyZC5iYWNrZ3JvdW5kID09PSAnZ3JhZGllbnQnICYmIGNhcmQuYmFja2dyb3VuZEdyYWRpZW50KSB7CiAgICBjb25zdCBiZyA9IGNhcmQuYmFja2dyb3VuZEdyYWRpZW50OwogICAgc2NBbHBoYSA9IE1hdGgubWluKDEsIE1hdGgubWF4KGJnLm1pbk9wYWNpdHksIHN1cGVyQ2hhdE9wYWNpdHkpKTsKICAgIHRvcEFscGhhID0gTWF0aC5taW4oMSwgc2NBbHBoYSArIGJnLnRvcEJvb3N0KTsKICAgIGJvdHRvbUFscGhhID0gTWF0aC5tYXgoYmcubWluT3BhY2l0eSwgc2NBbHBoYSAtIGJnLmJvdHRvbVJlZHVjdGlvbik7CiAgfQoKICAvLyDilIDilIAgMi4gQmFja2dyb3VuZCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKICBpZiAoY2FyZC5iYWNrZ3JvdW5kID09PSAnZ3JhZGllbnQnICYmIGNhcmQuYmFja2dyb3VuZEdyYWRpZW50KSB7CiAgICBjb25zdCBncmFkID0gZ2V0Q2FjaGVkR3JhZGllbnQoCiAgICAgIGN0eCwKICAgICAgZ3JhZGllbnRDYWNoZSwKICAgICAgYmFzZUNvbG9yLAogICAgICBoLAogICAgICB0b3BBbHBoYSwKICAgICAgc2NBbHBoYSwKICAgICAgYm90dG9tQWxwaGEKICAgICk7CiAgICBjdHguc2F2ZSgpOwogICAgY3R4LnRyYW5zbGF0ZSh4LCB5KTsKICAgIGN0eC5maWxsU3R5bGUgPSBncmFkOwogICAgZHJhd1JvdW5kUmVjdChjdHgsIDAsIDAsIHcsIGgsIGNhcmQuY2FyZFJhZGl1cyk7CiAgICBjdHguZmlsbCgpOwogICAgY3R4LnJlc3RvcmUoKTsKICB9IGVsc2UgaWYgKGNhcmQuYmFja2dyb3VuZENvbG9yKSB7CiAgICBjb25zdCBiZyA9IGNhcmQuYmFja2dyb3VuZENvbG9yOwogICAgY3R4LnNhdmUoKTsKICAgIGN0eC5maWxsU3R5bGUgPSBgcmdiYSgke2JnLnJ9LCAke2JnLmd9LCAke2JnLmJ9LCAke2NhcmQuYmFja2dyb3VuZEFscGhhID8/IDF9KWA7CiAgICBkcmF3Um91bmRSZWN0KGN0eCwgeCwgeSwgdywgaCwgY2FyZC5jYXJkUmFkaXVzKTsKICAgIGN0eC5maWxsKCk7CiAgICBjdHgucmVzdG9yZSgpOwogIH0KCiAgLy8g4pSA4pSAIDMuIERlY29yYXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgaWYgKGNhcmQuZGVjb3JhdGlvbiA9PT0gJ2FjY2VudEJhcicgJiYgY2FyZC5hY2NlbnRCYXIpIHsKICAgIGNvbnN0IGJhclJnYiA9IGNhcmQuYWNjZW50QmFyLmNvbG9yOwogICAgY3R4LnNhdmUoKTsKICAgIGN0eC5maWxsU3R5bGUgPSBgcmdiKCR7YmFyUmdiLnJ9LCAke2JhclJnYi5nfSwgJHtiYXJSZ2IuYn0pYDsKICAgIC8vIERlZGljYXRlZCBsZWZ0LXJvdW5kZWQgcmVjdCDigJQgYXZvaWRzIGN0eC5jbGlwKCkgd2hpY2ggZm9yY2VzIHNhdmUvcmVzdG9yZQogICAgLy8gYW5kIHJlY29tcHV0ZXMgdGhlIHJhc3Rlcml6ZXIgY2xpcCBtYXNrLgogICAgY3R4LmJlZ2luUGF0aCgpOwogICAgY3R4Lm1vdmVUbyh4ICsgY2FyZC5jYXJkUmFkaXVzLCB5KTsKICAgIGN0eC5saW5lVG8oeCArIGNhcmQuYWNjZW50QmFyLndpZHRoLCB5KTsKICAgIGN0eC5saW5lVG8oeCArIGNhcmQuYWNjZW50QmFyLndpZHRoLCB5ICsgaCk7CiAgICBjdHgubGluZVRvKHggKyBjYXJkLmNhcmRSYWRpdXMsIHkgKyBoKTsKICAgIGN0eC5hcmNUbyh4LCB5ICsgaCwgeCwgeSArIGggLSBjYXJkLmNhcmRSYWRpdXMsIGNhcmQuY2FyZFJhZGl1cyk7CiAgICBjdHgubGluZVRvKHgsIHkgKyBjYXJkLmNhcmRSYWRpdXMpOwogICAgY3R4LmFyY1RvKHgsIHksIHggKyBjYXJkLmNhcmRSYWRpdXMsIHksIGNhcmQuY2FyZFJhZGl1cyk7CiAgICBjdHguY2xvc2VQYXRoKCk7CiAgICBjdHguZmlsbCgpOwogICAgY3R4LnJlc3RvcmUoKTsKICB9IGVsc2UgaWYgKGNhcmQuZGVjb3JhdGlvbiA9PT0gJ3B1bHNpbmdCb3JkZXInICYmIGNhcmQucHVsc2luZ0JvcmRlcikgewogICAgY29uc3QgcGIgPSBjYXJkLnB1bHNpbmdCb3JkZXI7CiAgICBjb25zdCBwdWxzZSA9IGNvbXB1dGVQdWxzZUFscGhhKGVsYXBzZWQsIHBiLmJhc2VBbHBoYSwgcGIuYW1wbGl0dWRlKTsKICAgIGN0eC5zYXZlKCk7CiAgICBkcmF3Um91bmRSZWN0KGN0eCwgeCwgeSwgdywgaCwgY2FyZC5jYXJkUmFkaXVzKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9IGByZ2JhKCR7cGIuYm9yZGVyUmdiLnJ9LCAke3BiLmJvcmRlclJnYi5nfSwgJHtwYi5ib3JkZXJSZ2IuYn0sICR7cHVsc2V9KWA7CiAgICBjdHgubGluZVdpZHRoID0gcGIuYm9yZGVyV2lkdGg7CiAgICBjdHguc3Ryb2tlKCk7CiAgICBjdHgucmVzdG9yZSgpOwogIH0KCiAgLy8g4pSA4pSAIDQuIENvbnRlbnQgbGF5b3V0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIGNvbnN0IHBhZEggPSBjYXJkLnBhZGRpbmcuaG9yaXpvbnRhbDsKICBjb25zdCBwYWRWID0gY2FyZC5wYWRkaW5nLnZlcnRpY2FsOwogIGNvbnN0IHRleHRYID0geCArIHBhZEg7CiAgbGV0IGN1cnNvclkgPSB5ICsgcGFkVjsKCiAgLy8g4pSA4pSAIDUuIEF1dGhvciBzZWN0aW9uIChuYW1lICsgcGhvdG8pIOKAlCByZW5kZXJlZCBmaXJzdCBzbyBuYW1lIGFwcGVhcnMgYWJvdmUgYW1vdW50L2R1cmF0aW9uCiAgaWYgKGNhcmQuYXV0aG9yU2hvdyAmJiBtZXNzYWdlLmF1dGhvcikgewogICAgY3Vyc29yWSA9IGRyYXdBdXRob3JTZWN0aW9uKAogICAgICBjdHgsCiAgICAgIG1lc3NhZ2UsCiAgICAgIHRleHRYLAogICAgICBjdXJzb3JZLAogICAgICB0ZXh0Q29sb3IsCiAgICAgIGNhcmQuYXV0aG9yTmFtZU1heFdpZHRoLAogICAgICBNYXRoLnJvdW5kKGZvbnRTaXplICogcmVuZGVyZXJMYXlvdXQuYXV0aG9yRm9udFNjYWxlKSwKICAgICAgZm9udFdlaWdodCwKICAgICAgZm9udEZhbWlseSwKICAgICAgb3V0bGluZVdpZHRoUHgsCiAgICAgIG91dGxpbmVPcGFjaXR5LAogICAgICBhdXRob3JQaG90b0NhY2hlLAogICAgICBpc0F2YWlsYWJsZUltYWdlLAogICAgICB0ZXh0Qml0bWFwQ2FjaGUsCiAgICAgIGdldEZvbnRGbgogICAgKTsKICB9CgogIC8vIOKUgOKUgCA2LiBIZWFkZXIgdGFnICh0aWVyIG5hbWUgLyBtZW1iZXJzaGlwIGR1cmF0aW9uKQogIGlmIChjYXJkLmhlYWRlclRhZ0VuYWJsZWQgJiYgbWVzc2FnZS5tZW1iZXJzaGlwSGVhZGVyKSB7CiAgICBjb25zdCBoZWFkZXJGb250U2l6ZSA9IE1hdGgucm91bmQoZm9udFNpemUgKiBjYXJkLmhlYWRlclRhZ0ZvbnRTaXplU2NhbGUpOwogICAgY29uc3QgaGVhZGVyRm9udCA9IGdldEZvbnRTdHJpbmcoaGVhZGVyRm9udFNpemUsIGZvbnRXZWlnaHQgYXMgRm9udFdlaWdodCwgZm9udEZhbWlseSk7CiAgICBjdHguc2F2ZSgpOwogICAgY3R4LmZvbnQgPSBoZWFkZXJGb250OwogICAgY3R4LnRleHRCYXNlbGluZSA9ICd0b3AnOwogICAgY29uc3QgaGVhZGVyTWF4V2lkdGggPSB3IC0gcGFkSCAqIDI7CiAgICBsZXQgZGlzcGxheVRleHQgPSBtZXNzYWdlLm1lbWJlcnNoaXBIZWFkZXI7CiAgICBpZiAoY3R4Lm1lYXN1cmVUZXh0KGRpc3BsYXlUZXh0KS53aWR0aCA+IGhlYWRlck1heFdpZHRoKSB7CiAgICAgIGNvbnN0IGdyYXBoZW1lcyA9IHNwbGl0R3JhcGhlbWVDbHVzdGVycyhkaXNwbGF5VGV4dCk7CiAgICAgIGxldCBsbyA9IDAsCiAgICAgICAgaGkgPSBncmFwaGVtZXMubGVuZ3RoOwogICAgICB3aGlsZSAobG8gPCBoaSkgewogICAgICAgIGNvbnN0IG1pZCA9IE1hdGguZmxvb3IoKGxvICsgaGkpIC8gMik7CiAgICAgICAgaWYgKGN0eC5tZWFzdXJlVGV4dChgJHtncmFwaGVtZXMuc2xpY2UoMCwgbWlkKS5qb2luKCcnKX3igKZgKS53aWR0aCA+IGhlYWRlck1heFdpZHRoKSB7CiAgICAgICAgICBoaSA9IG1pZDsKICAgICAgICB9IGVsc2UgewogICAgICAgICAgbG8gPSBtaWQgKyAxOwogICAgICAgIH0KICAgICAgfQogICAgICBkaXNwbGF5VGV4dCA9IGxvID4gMCA/IGAke2dyYXBoZW1lcy5zbGljZSgwLCBsbyAtIDEpLmpvaW4oJycpfeKApmAgOiAn4oCmJzsKICAgIH0KICAgIHN0cm9rZVRleHRPdXRsaW5lKAogICAgICBjdHgsCiAgICAgIGRpc3BsYXlUZXh0LAogICAgICB0ZXh0WCwKICAgICAgY3Vyc29yWSArIGNhcmQuaGVhZGVyVGFnTWFyZ2luVG9wLAogICAgICBjYXJkLmhlYWRlclRhZ0NvbG9yLAogICAgICBvdXRsaW5lV2lkdGhQeCwKICAgICAgb3V0bGluZU9wYWNpdHkKICAgICk7CiAgICBjdHguZmlsbFN0eWxlID0gY2FyZC5oZWFkZXJUYWdDb2xvcjsKICAgIGN0eC5maWxsVGV4dChkaXNwbGF5VGV4dCwgdGV4dFgsIGN1cnNvclkgKyBjYXJkLmhlYWRlclRhZ01hcmdpblRvcCk7CiAgICBjdHgucmVzdG9yZSgpOwogICAgY29uc3QgaGVhZGVySGVpZ2h0ID0gbWVhc3VyZVRleHRIZWlnaHQoaGVhZGVyRm9udFNpemUsIGhlYWRlckZvbnQsIGN0eCk7CiAgICBjdXJzb3JZICs9IGhlYWRlckhlaWdodCArIGNhcmQuaGVhZGVyVGFnTWFyZ2luVG9wICsgY2FyZC5oZWFkZXJUYWdNYXJnaW5Cb3R0b207CiAgfQoKICAvLyDilIDilIAgNy4gQmFkZ2UgKGFtb3VudCBwaWxsKSDigJQgcmVzcGVjdHMgc2hvd1N1cGVyQ2hhdEFtb3VudCBzZXR0aW5nCiAgaWYgKGNhcmQuYmFkZ2VFbmFibGVkICYmIGNhcmQuc2hvd0JhZGdlQW1vdW50ICYmIG1lc3NhZ2Uuc3VwZXJDaGF0QW1vdW50KSB7CiAgICBjdXJzb3JZICs9IHNwYWNpbmcueHM7CiAgICBjb25zdCBiYWRnZUZvbnRTaXplID0gTWF0aC5yb3VuZChmb250U2l6ZSAqIHJlbmRlcmVyTGF5b3V0LmF1dGhvckZvbnRTY2FsZSk7CiAgICBjb25zdCBiYWRnZUZvbnQgPSBnZXRGb250U3RyaW5nKGJhZGdlRm9udFNpemUsICdib2xkJyBhcyBGb250V2VpZ2h0LCBmb250RmFtaWx5KTsKICAgIGN0eC5mb250ID0gYmFkZ2VGb250OwogICAgY29uc3QgYmFkZ2VUZXh0V2lkdGggPSBNYXRoLmNlaWwoY3R4Lm1lYXN1cmVUZXh0KG1lc3NhZ2Uuc3VwZXJDaGF0QW1vdW50KS53aWR0aCk7CiAgICBjb25zdCBiYWRnZVdpZHRoID0gYmFkZ2VUZXh0V2lkdGggKyBjYXJkLmJhZGdlUGFkZGluZ0ggKiAyOwogICAgY29uc3QgYmFkZ2VIZWlnaHQgPSBiYWRnZUZvbnRTaXplICsgY2FyZC5iYWRnZVBhZGRpbmdWICogMjsKCiAgICBkcmF3Um91bmRSZWN0KGN0eCwgdGV4dFgsIGN1cnNvclksIGJhZGdlV2lkdGgsIGJhZGdlSGVpZ2h0LCBjYXJkLmJhZGdlUmFkaXVzKTsKICAgIGNvbnN0IHByZXZGaWxsU3R5bGUgPSBjdHguZmlsbFN0eWxlOwogICAgY29uc3QgcHJldlN0cm9rZVN0eWxlID0gY3R4LnN0cm9rZVN0eWxlOwogICAgY29uc3QgcHJldkxpbmVXaWR0aCA9IGN0eC5saW5lV2lkdGg7CiAgICBjdHguZmlsbFN0eWxlID0gY2FyZC5iYWRnZUZpbGxDb2xvcjsKICAgIGN0eC5maWxsKCk7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSBjYXJkLmJhZGdlU3Ryb2tlQ29sb3I7CiAgICBjdHgubGluZVdpZHRoID0gY2FyZC5iYWRnZVN0cm9rZVdpZHRoOwogICAgY3R4LnN0cm9rZSgpOwoKICAgIGN0eC50ZXh0QmFzZWxpbmUgPSAnbWlkZGxlJzsKICAgIHN0cm9rZVRleHRPdXRsaW5lKAogICAgICBjdHgsCiAgICAgIG1lc3NhZ2Uuc3VwZXJDaGF0QW1vdW50LAogICAgICB0ZXh0WCArIGNhcmQuYmFkZ2VQYWRkaW5nSCwKICAgICAgY3Vyc29yWSArIGJhZGdlSGVpZ2h0IC8gMiwKICAgICAgREVGQVVMVF9URVhUX0NPTE9SLAogICAgICBvdXRsaW5lV2lkdGhQeCwKICAgICAgb3V0bGluZU9wYWNpdHkKICAgICk7CiAgICBjdHguZmlsbFN0eWxlID0gREVGQVVMVF9URVhUX0NPTE9SOwogICAgY3R4LmZpbGxUZXh0KG1lc3NhZ2Uuc3VwZXJDaGF0QW1vdW50LCB0ZXh0WCArIGNhcmQuYmFkZ2VQYWRkaW5nSCwgY3Vyc29yWSArIGJhZGdlSGVpZ2h0IC8gMik7CiAgICBjdHgudGV4dEJhc2VsaW5lID0gJ3RvcCc7CiAgICBjdHguZmlsbFN0eWxlID0gcHJldkZpbGxTdHlsZTsKICAgIGN0eC5zdHJva2VTdHlsZSA9IHByZXZTdHJva2VTdHlsZTsKICAgIGN0eC5saW5lV2lkdGggPSBwcmV2TGluZVdpZHRoOwoKICAgIGN1cnNvclkgKz0gYmFkZ2VIZWlnaHQ7CiAgfQoKICAvLyDilIDilIAgOC4gQm9keSB0ZXh0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogIGxldCB0ZXh0Qm90dG9tWSA9IGN1cnNvclk7CiAgaWYgKGNvbnRlbnQubGVuZ3RoID4gMCkgewogICAgY29uc3QgYm9keU1heFdpZHRoID0gdyAtIHBhZEggKiAyOwogICAgdGV4dEJvdHRvbVkgPSByZW5kZXJXcmFwcGVkQ29udGVudFNlZ21lbnRzKAogICAgICBjdHgsCiAgICAgIGNvbnRlbnQsCiAgICAgIHRleHRYLAogICAgICBjdXJzb3JZICsgY2FyZC5ib2R5TWFyZ2luVG9wLAogICAgICBib2R5TWF4V2lkdGgsCiAgICAgIGNhcmQuYm9keU1heExpbmVzLAogICAgICB0ZXh0Q29sb3IsCiAgICAgIGZvbnRTaXplLAogICAgICBvdXRsaW5lV2lkdGhQeCwKICAgICAgb3V0bGluZU9wYWNpdHksCiAgICAgIHRleHRCaXRtYXBDYWNoZSwKICAgICAgZW1vamlDYWNoZSBhcyBSZXNpemFibGVCeXRlTGltaXRlZENhY2hlPENhbnZhc0ltYWdlU291cmNlPiwKICAgICAgZ2V0Rm9udEZuCiAgICApOwogIH0KCiAgLy8g4pSA4pSAIDkuIFN0aWNrZXIgKHNraXAgaWYgbm8gVVJMIOKAlCB3b3JrZXIgZG9lc24ndCBoYXZlIHN0aWNrZXIgY2FjaGUpIOKUgOKUgOKUgOKUgAogIGlmIChjYXJkLnN0aWNrZXJFbmFibGVkICYmIG1lc3NhZ2Uuc3VwZXJDaGF0U3RpY2tlclVybCkgewogICAgLy8gU3RpY2tlciBpbWFnZXMgYXJlIGhhbmRsZWQgdmlhIHRoZSBtYWluIHRocmVhZCdzIGltYWdlRGF0YSB0cmFuc2Zlci4KICAgIC8vIFJlbmRlciBpZiBhdmFpbGFibGUgaW4gc3RpY2tlckNhY2hlLgogICAgY29uc3Qgc3RpY2tlckltZyA9IHN0aWNrZXJDYWNoZT8uZ2V0KG1lc3NhZ2Uuc3VwZXJDaGF0U3RpY2tlclVybCk7CiAgICBpZiAoc3RpY2tlckltZykgewogICAgICBjb25zdCBtYXhTdGlja2VyU2l6ZSA9IE1hdGgucm91bmQoZm9udFNpemUgKiBjYXJkLnN0aWNrZXJTaXplU2NhbGUpOwogICAgICBjb25zdCBzdGlja2VyWSA9IHRleHRCb3R0b21ZICsgKGNhcmQuc3RpY2tlck1hcmdpblRvcCA/PyAwKTsKICAgICAgY29uc3QgYXZhaWxhYmxlSGVpZ2h0ID0geSArIGggLSBwYWRWIC0gc3RpY2tlclk7CiAgICAgIGNvbnN0IHN0aWNrZXJTaXplID0gTWF0aC5tYXgoMCwgTWF0aC5taW4obWF4U3RpY2tlclNpemUsIGF2YWlsYWJsZUhlaWdodCkpOwogICAgICBpZiAoc3RpY2tlclNpemUgPiAwKSB7CiAgICAgICAgY3R4LmRyYXdJbWFnZShzdGlja2VySW1nLCB0ZXh0WCwgc3RpY2tlclksIHN0aWNrZXJTaXplLCBzdGlja2VyU2l6ZSk7CiAgICAgIH0KICAgIH0KICB9Cn0KCmV4cG9ydCBjbGFzcyBXb3JrZXJSZW5kZXJlciB7CiAgcHJpdmF0ZSBjdHg6IE9mZnNjcmVlbkNhbnZhc1JlbmRlcmluZ0NvbnRleHQyRCB8IG51bGwgPSBudWxsOwogIHByaXZhdGUgY2FudmFzOiBPZmZzY3JlZW5DYW52YXMgfCBudWxsID0gbnVsbDsKICBwcml2YXRlIGNvbmZpZzogV29ya2VyQ29uZmlnIHwgbnVsbCA9IG51bGw7CiAgcHJpdmF0ZSBhbmltRnJhbWVJZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7CiAgcHJpdmF0ZSBpc0Rlc3Ryb3llZCA9IGZhbHNlOwogIHByaXZhdGUgaXNQYXVzZWQgPSBmYWxzZTsKICBwcml2YXRlIGlzVXNlclBhdXNlZCA9IGZhbHNlOwogIHByaXZhdGUgcGF1c2VTdGFydFRpbWUgPSAwOwogIHByaXZhdGUgYW50aUJsb2NrU3RhcnRUaW1lID0gMDsKICBwcml2YXRlIGludkZhZGVNcyA9IDA7CiAgcHJpdmF0ZSBhZ2VGYWRlUmF0ZSA9IDA7CiAgcHJpdmF0ZSBvcGFjaXR5Q29uZmlnOiBPcGFjaXR5Q29uZmlnIHwgbnVsbCA9IG51bGw7CiAgcHJpdmF0ZSBib3VuZEdldEZvbnQ6IChmb250U2l6ZTogbnVtYmVyKSA9PiBzdHJpbmcgPSAoZnM6IG51bWJlcikgPT4KICAgIGdldEZvbnRTdHJpbmcoZnMsICdib2xkJyBhcyBGb250V2VpZ2h0LCBERUZBVUxUX0ZPTlRfRkFNSUxZKTsKICBwcml2YXRlIHJlYWRvbmx5IGJvdW5kTWVhc3VyZVRleHRDYWNoZWQgPSAodGV4dDogc3RyaW5nKTogbnVtYmVyID0+IHRoaXMubWVhc3VyZVRleHRDYWNoZWQodGV4dCk7CiAgcHJpdmF0ZSB0cmFuc2xhdGlvbkZvbnRTaXplID0gMTsKICBwcml2YXRlIHJlYWRvbmx5IGJvdW5kR2V0VHJhbnNsYXRpb25Gb250ID0gKCk6IHN0cmluZyA9PgogICAgZ2V0Rm9udFN0cmluZygKICAgICAgdGhpcy50cmFuc2xhdGlvbkZvbnRTaXplLAogICAgICAnbm9ybWFsJywKICAgICAgdGhpcy5jb25maWc/LmZvbnRGYW1pbHkgPz8gREVGQVVMVF9GT05UX0ZBTUlMWQogICAgKTsKCiAgLyoqIENvbXB1dGUgZWZmZWN0aXZlIGZvbnQgc2l6ZSBzY2FsZWQgdG8gY3VycmVudCB2aWV3cG9ydCBoZWlnaHQuICovCiAgcHJpdmF0ZSBnZXRFZmZlY3RpdmVGb250U2l6ZSgpOiBudW1iZXIgewogICAgaWYgKCF0aGlzLmNvbmZpZyB8fCB0aGlzLmxvZ2ljYWxIZWlnaHQgPD0gMCkgcmV0dXJuIHRoaXMuY29uZmlnPy5mb250U2l6ZSA/PyAzMjsKICAgIGNvbnN0IHsgZm9udFNpemUsIGZvbnRCYXNlVmlld3BvcnRIZWlnaHQsIGZvbnRNaW5TaXplLCBmb250TWF4U2l6ZSB9ID0gdGhpcy5jb25maWc7CiAgICBjb25zdCBzY2FsZWQgPSBNYXRoLnJvdW5kKGZvbnRTaXplICogKHRoaXMubG9naWNhbEhlaWdodCAvIGZvbnRCYXNlVmlld3BvcnRIZWlnaHQpKTsKICAgIHJldHVybiBNYXRoLm1heChmb250TWluU2l6ZSwgTWF0aC5taW4oZm9udE1heFNpemUsIHNjYWxlZCkpOwogIH0KCiAgcHJpdmF0ZSBzdGF0aWMgVEVYVF9NRUFTVVJFX0NBQ0hFX01BWCA9IDUwMDsKICAvKiogUHJlLWNvbXB1dGVkIGV4cG9uZW50aWFsIGRpc3RyaWJ1dGlvbiB0YWJsZSBmb3Igc3RhZ2dlciBkZWxheSAoMjU2IGVudHJpZXMpLgogICAqICBFYWNoIGVudHJ5ID0gLWxuKDEgLSAoaSswLjUpLzI1NiksIHlpZWxkaW5nIGEgcG9zaXRpdmUgZXhwb25lbnRpYWwgc2FtcGxlLgogICAqICBJbmRleGVkIGJ5IGZsb29yKE1hdGgucmFuZG9tKCkgKiAyNTYpIOKAlCBhdm9pZHMgcGVyLW1lc3NhZ2UgTWF0aC5sb2cgY2FsbHMuICovCiAgcHJpdmF0ZSBzdGF0aWMgcmVhZG9ubHkgU1RBR0dFUl9FWFBfVEFCTEU6IEZsb2F0NjRBcnJheSA9ICgoKSA9PiB7CiAgICBjb25zdCB0ID0gbmV3IEZsb2F0NjRBcnJheSgyNTYpOwogICAgZm9yIChsZXQgaSA9IDA7IGkgPCAyNTY7IGkrKykgewogICAgICB0W2ldID0gLU1hdGgubG9nKDEgLSAoaSArIDAuNSkgLyAyNTYpOwogICAgfQogICAgcmV0dXJuIHQ7CiAgfSkoKTsKICBwcml2YXRlIHRleHRNZWFzdXJlQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpOwogIHByaXZhdGUgZm9udE1ldHJpY3NDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCB7IGhlaWdodDogbnVtYmVyIH0+KCk7CiAgcHJpdmF0ZSBhY3RpdmVNZXNzYWdlczogQWN0aXZlTWVzc2FnZVtdID0gW107CiAgcHJpdmF0ZSBhY3RpdmVNZXNzYWdlc0J5TGFuZSA9IG5ldyBNYXA8bnVtYmVyLCBBY3RpdmVNZXNzYWdlW10+KCk7CiAgcHJpdmF0ZSBwZW5kaW5nUXVldWU6IFdvcmtlck1lc3NhZ2VbXSA9IFtdOwogIHByaXZhdGUgcGVuZGluZ1F1ZXVlU29ydE5lZWRlZCA9IGZhbHNlOwogIHByaXZhdGUgbGFuZUhlYXA6IFtudW1iZXIsIG51bWJlcl1bXSA9IFtdOwogIHByaXZhdGUgbGFuZUluZGV4VG9IZWFwSW5kZXggPSBuZXcgTWFwPG51bWJlciwgbnVtYmVyPigpOwogIHByaXZhdGUgbGFuZUhlaWdodCA9IDA7CiAgcHJpdmF0ZSBudW1MYW5lcyA9IDA7CiAgLyoqIEN1cnJlbnQgbGFuZSBkZW5zaXR5IGZhY3RvciDigJQgdXBkYXRlZCB2aWEgJ2xhbmVEZW5zaXR5JyBwcm90b2NvbCBtZXNzYWdlLiAqLwogIHByaXZhdGUgbGFuZURlbnNpdHlGYWN0b3IgPSAxLjA7CiAgcHJpdmF0ZSBzcGVlZFRpZXJMYW5lcyA9IG5ldyBNYXA8bnVtYmVyLCB7IHRpZXI6IG51bWJlcjsgdW50aWw6IG51bWJlciB9PigpOwogIHByaXZhdGUgY29sbGlkZWRMYW5lcyA9IG5ldyBTZXQ8bnVtYmVyPigpOwogIHByaXZhdGUgdG90YWxEcm9wcyA9IDA7CiAgcHJpdmF0ZSB0ZXh0Qml0bWFwQ2FjaGUhOiBSZXNpemFibGVCeXRlTGltaXRlZENhY2hlPE9mZnNjcmVlbkNhbnZhcz47CiAgcHJpdmF0ZSBlbW9qaUNhY2hlITogUmVzaXphYmxlQnl0ZUxpbWl0ZWRDYWNoZTxJbWFnZUJpdG1hcD47CiAgcHJpdmF0ZSBhdXRob3JQaG90b0NhY2hlITogUmVzaXphYmxlQnl0ZUxpbWl0ZWRDYWNoZTxJbWFnZUJpdG1hcD47CiAgcHJpdmF0ZSBzdGlja2VyQ2FjaGUhOiBSZXNpemFibGVCeXRlTGltaXRlZENhY2hlPEltYWdlQml0bWFwPjsKICBwcml2YXRlIHN1cGVyQ2hhdEdyYWRpZW50Q2FjaGUgPSBuZXcgTWFwQ29tcGF0aWJsZUxydU1hcDxzdHJpbmcsIENhbnZhc0dyYWRpZW50PigKICAgIEdSQURJRU5UX0NBQ0hFX01BWAogICk7CiAgcHJpdmF0ZSByZWFkb25seSBtZXNzYWdlQnlJZCA9IG5ldyBNYXA8c3RyaW5nLCBXb3JrZXJNZXNzYWdlIHwgQWN0aXZlTWVzc2FnZT4oKTsKICBwcml2YXRlIGZldGNoaW5nID0gbmV3IFNldDxzdHJpbmc+KCk7CiAgcHJpdmF0ZSByZWFkb25seSBmZXRjaENvbnRyb2xsZXJzID0gbmV3IFNldDxBYm9ydENvbnRyb2xsZXI+KCk7CiAgcHJpdmF0ZSBmZXRjaEdlbmVyYXRpb24gPSAwOwogIHByaXZhdGUgZmFyT3BhY2l0eUJ1Y2tldHM6IEFjdGl2ZU1lc3NhZ2VbXVtdID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogT1BBQ0lUWV9CVUNLRVRTIH0sICgpID0+IFtdKTsKICBwcml2YXRlIG1pZE9wYWNpdHlCdWNrZXRzOiBBY3RpdmVNZXNzYWdlW11bXSA9IEFycmF5LmZyb20oeyBsZW5ndGg6IE9QQUNJVFlfQlVDS0VUUyB9LCAoKSA9PiBbXSk7CiAgcHJpdmF0ZSBuZWFyT3BhY2l0eUJ1Y2tldHM6IEFjdGl2ZU1lc3NhZ2VbXVtdID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogT1BBQ0lUWV9CVUNLRVRTIH0sICgpID0+IFtdKTsKICBwcml2YXRlIHJlYWRvbmx5IHRpZXJPcGFjaXR5QnVja2V0cyA9IFsKICAgIHRoaXMuZmFyT3BhY2l0eUJ1Y2tldHMsCiAgICB0aGlzLm1pZE9wYWNpdHlCdWNrZXRzLAogICAgdGhpcy5uZWFyT3BhY2l0eUJ1Y2tldHMsCiAgXTsKICBwcml2YXRlIHJlYWRvbmx5IGV4cGlyZWRNZXNzYWdlc1NjcmF0Y2g6IEFjdGl2ZU1lc3NhZ2VbXSA9IFtdOwogIHByaXZhdGUgcmVhZG9ubHkgcmVndWxhclJlbmRlckNvbmZpZzogUmVndWxhck1lc3NhZ2VSZW5kZXJDb25maWcgPSB7CiAgICBzaG93QXV0aG9yOiB0cnVlLAogICAgZm9udFNpemU6IDEsCiAgICBmb250V2VpZ2h0OiAnYm9sZCcsCiAgICBmb250RmFtaWx5OiBERUZBVUxUX0ZPTlRfRkFNSUxZLAogICAgY29sb3I6IERFRkFVTFRfVEVYVF9DT0xPUiwKICAgIG91dGxpbmVXaWR0aFB4OiAwLAogICAgb3V0bGluZU9wYWNpdHk6IDAsCiAgICBiYWNrZ3JvdW5kQ29sb3I6ICcjMDAwMDAwMDAnLAogICAgbWVzc2FnZVdpZHRoOiAwLAogICAgbWVzc2FnZUhlaWdodDogMCwKICB9OwogIHByaXZhdGUgc3RhdHNGcmFtZUNvdW50ZXIgPSAwOwogIHByaXZhdGUgaWRsZVNpbmNlOiBudW1iZXIgfCBudWxsID0gbnVsbDsKCiAgLyoqIENTUy1waXhlbCBkaW1lbnNpb25zIChub3QgRFBSLW11bHRpcGxpZWQpLiBTZXQgYnkgaW5pdC9yZXNpemUgaGFuZGxlcnMuICovCiAgcHJpdmF0ZSBsb2dpY2FsV2lkdGggPSAwOwogIHByaXZhdGUgbG9naWNhbEhlaWdodCA9IDA7CgogIGhhbmRsZU1lc3NhZ2UoZTogTWVzc2FnZUV2ZW50KTogdm9pZCB7CiAgICB0cnkgewogICAgICAvLyBSdW50aW1lIGd1YXJkOiB2YWxpZGF0ZSBjb250cm9sIG1lc3NhZ2UgYmVmb3JlIGFueSBzdGF0ZSBtdXRhdGlvbi4KICAgICAgLy8gTWFsZm9ybWVkIG1lc3NhZ2VzIChudWxsLCBhcnJheXMsIHByaW1pdGl2ZXMsIHVua25vd24gZGlzY3JpbWluYW50cywKICAgICAgLy8gbWlzc2luZyByZXF1aXJlZCBmaWVsZHMpIGFyZSBzaWxlbnRseSBpZ25vcmVkLgogICAgICBpZiAoIWlzVmFsaWRDb250cm9sTWVzc2FnZShlLmRhdGEpKSByZXR1cm47CgogICAgICB0cnkgewogICAgICAgIGNvbnN0IGRhdGEgPSBlLmRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47CiAgICAgICAgY29uc3QgdHlwZSA9IGRhdGEudHlwZSBhcyBzdHJpbmc7CiAgICAgICAgc3dpdGNoICh0eXBlKSB7CiAgICAgICAgICBjYXNlICdpbml0JzogewogICAgICAgICAgICB0aGlzLmNvbmZpZyA9IGRhdGEuY29uZmlnIGFzIFdvcmtlckNvbmZpZzsKICAgICAgICAgICAgdGhpcy5jYW52YXMgPSBkYXRhLmNhbnZhcyBhcyBPZmZzY3JlZW5DYW52YXM7CiAgICAgICAgICAgIHRoaXMuY3R4ID0gdGhpcy5jYW52YXMuZ2V0Q29udGV4dCgnMmQnLCB7IGFscGhhOiB0cnVlLCBkZXN5bmNocm9uaXplZDogdHJ1ZSB9KTsKICAgICAgICAgICAgaWYgKCF0aGlzLmN0eCkgewogICAgICAgICAgICAgIHNlbGYucG9zdE1lc3NhZ2UoeyB0eXBlOiAnZXJyb3InLCBlcnJvcjogJ0ZhaWxlZCB0byBnZXQgMkQgY29udGV4dCcgfSk7CiAgICAgICAgICAgICAgcmV0dXJuOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGNvbnN0IGRwciA9IGRhdGEuZHByIGFzIG51bWJlcjsKICAgICAgICAgICAgdGhpcy5jdHguc2V0VHJhbnNmb3JtKGRwciwgMCwgMCwgZHByLCAwLCAwKTsKICAgICAgICAgICAgdGhpcy5lbW9qaUNhY2hlID0gbmV3IFJlc2l6YWJsZUJ5dGVMaW1pdGVkQ2FjaGU8SW1hZ2VCaXRtYXA+KAogICAgICAgICAgICAgICh0aGlzLmNvbmZpZy5lbW9qaUNhY2hlTWIgPz8gNCkgKiAxXzAwMF8wMDAsCiAgICAgICAgICAgICAgV29ya2VyUmVuZGVyZXIuZXN0aW1hdGVCaXRtYXBCeXRlcywKICAgICAgICAgICAgICAoYikgPT4gYi5jbG9zZSgpLAogICAgICAgICAgICAgIEVNT0pJX0NBQ0hFX01BWF9FTlRSSUVTCiAgICAgICAgICAgICk7CiAgICAgICAgICAgIHRoaXMuYXV0aG9yUGhvdG9DYWNoZSA9IG5ldyBSZXNpemFibGVCeXRlTGltaXRlZENhY2hlPEltYWdlQml0bWFwPigKICAgICAgICAgICAgICAodGhpcy5jb25maWcucGhvdG9DYWNoZU1iID8/IDQpICogMV8wMDBfMDAwLAogICAgICAgICAgICAgIFdvcmtlclJlbmRlcmVyLmVzdGltYXRlQml0bWFwQnl0ZXMsCiAgICAgICAgICAgICAgKGIpID0+IGIuY2xvc2UoKQogICAgICAgICAgICApOwogICAgICAgICAgICBzdGlja2VyQ2FjaGUgPSB0aGlzLnN0aWNrZXJDYWNoZSA9IG5ldyBSZXNpemFibGVCeXRlTGltaXRlZENhY2hlPEltYWdlQml0bWFwPigKICAgICAgICAgICAgICBnZXRTdGlja2VyQ2FjaGVCeXRlcyh0aGlzLmNvbmZpZy5zdGlja2VyQ2FjaGVNYiA/PyA0KSwKICAgICAgICAgICAgICBXb3JrZXJSZW5kZXJlci5lc3RpbWF0ZUJpdG1hcEJ5dGVzLAogICAgICAgICAgICAgIChiKSA9PiBiLmNsb3NlKCkKICAgICAgICAgICAgKTsKICAgICAgICAgICAgdGhpcy50ZXh0Qml0bWFwQ2FjaGUgPSBuZXcgUmVzaXphYmxlQnl0ZUxpbWl0ZWRDYWNoZTxPZmZzY3JlZW5DYW52YXM+KAogICAgICAgICAgICAgICh0aGlzLmNvbmZpZy50ZXh0Q2FjaGVNYiA/PyA0KSAqIDFfMDAwXzAwMCwKICAgICAgICAgICAgICAoY2FudmFzKSA9PiBjYW52YXMud2lkdGggKiBjYW52YXMuaGVpZ2h0ICogNAogICAgICAgICAgICApOwogICAgICAgICAgICB0aGlzLnJlY29tcHV0ZUNvbmZpZ0Rlcml2ZWQoKTsKICAgICAgICAgICAgLy8gU2V0IGxvZ2ljYWwgZGltZW5zaW9ucyBCRUZPUkUgaW5pdExhbmVzIHNvIHRoYXQKICAgICAgICAgICAgLy8gZ2V0RWZmZWN0aXZlRm9udFNpemUoKSBjYW4gc2NhbGUgdGhlIGZvbnQgdG8gdGhlIHZpZXdwb3J0LgogICAgICAgICAgICB0aGlzLmxvZ2ljYWxXaWR0aCA9IGRhdGEud2lkdGggYXMgbnVtYmVyOwogICAgICAgICAgICB0aGlzLmxvZ2ljYWxIZWlnaHQgPSBkYXRhLmhlaWdodCBhcyBudW1iZXI7CiAgICAgICAgICAgIHRoaXMuaW5pdExhbmVzKGRhdGEud2lkdGggYXMgbnVtYmVyLCBkYXRhLmhlaWdodCBhcyBudW1iZXIpOwogICAgICAgICAgICB0aGlzLnN0YXJ0UmVuZGVyTG9vcCgpOwogICAgICAgICAgICBzZWxmLnBvc3RNZXNzYWdlKHsgdHlwZTogJ3JlYWR5JyB9KTsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgICBjYXNlICdyZXNpemUnOiB7CiAgICAgICAgICAgIGlmICghdGhpcy5jYW52YXMgfHwgIXRoaXMuY3R4KSBicmVhazsKICAgICAgICAgICAgY29uc3QgbmV3RHByID0gZGF0YS5kcHIgYXMgbnVtYmVyOwogICAgICAgICAgICBjb25zdCBjc3NXID0gZGF0YS53aWR0aCBhcyBudW1iZXI7CiAgICAgICAgICAgIGNvbnN0IGNzc0ggPSBkYXRhLmhlaWdodCBhcyBudW1iZXI7CiAgICAgICAgICAgIHRoaXMuY2FudmFzLndpZHRoID0gY3NzVyAqIG5ld0RwcjsKICAgICAgICAgICAgdGhpcy5jYW52YXMuaGVpZ2h0ID0gY3NzSCAqIG5ld0RwcjsKICAgICAgICAgICAgdGhpcy5jdHguc2V0VHJhbnNmb3JtKG5ld0RwciwgMCwgMCwgbmV3RHByLCAwLCAwKTsKICAgICAgICAgICAgdGhpcy5sb2dpY2FsV2lkdGggPSBjc3NXOwogICAgICAgICAgICB0aGlzLmxvZ2ljYWxIZWlnaHQgPSBjc3NIOwogICAgICAgICAgICB0aGlzLmluaXRMYW5lcyhjc3NXLCBjc3NIKTsKICAgICAgICAgICAgdGhpcy5yZWZsb3dBY3RpdmVNZXNzYWdlcygpOwogICAgICAgICAgICBicmVhazsKICAgICAgICAgIH0KICAgICAgICAgIGNhc2UgJ2FkZE1lc3NhZ2VzJzogewogICAgICAgICAgICBjb25zdCBtc2dzID0gZGF0YS5tZXNzYWdlcyBhcyBXb3JrZXJNZXNzYWdlW107CiAgICAgICAgICAgIGNvbnN0IGltYWdlRGF0YSA9IGRhdGEuaW1hZ2VEYXRhIGFzCiAgICAgICAgICAgICAgfCBBcnJheTx7IHVybDogc3RyaW5nOyBiaXRtYXA6IEltYWdlQml0bWFwOyB0YXJnZXQ6IHN0cmluZyB9PgogICAgICAgICAgICAgIHwgdW5kZWZpbmVkOwogICAgICAgICAgICBpZiAoaW1hZ2VEYXRhKSB7CiAgICAgICAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGltYWdlRGF0YSkgewogICAgICAgICAgICAgICAgY29uc3QgeyB1cmwsIGJpdG1hcCwgdGFyZ2V0IH0gPSBpdGVtOwogICAgICAgICAgICAgICAgaWYgKCF1cmwgfHwgIWJpdG1hcCkgY29udGludWU7CiAgICAgICAgICAgICAgICBjb25zdCBjYWNoZSA9CiAgICAgICAgICAgICAgICAgIHRhcmdldCA9PT0gJ2F1dGhvcicKICAgICAgICAgICAgICAgICAgICA/IHRoaXMuYXV0aG9yUGhvdG9DYWNoZQogICAgICAgICAgICAgICAgICAgIDogdGFyZ2V0ID09PSAnc3RpY2tlcicKICAgICAgICAgICAgICAgICAgICAgID8gdGhpcy5zdGlja2VyQ2FjaGUKICAgICAgICAgICAgICAgICAgICAgIDogdGhpcy5lbW9qaUNhY2hlOwogICAgICAgICAgICAgICAgY2FjaGUuc2V0KHVybCwgYml0bWFwKTsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgIH0KICAgICAgICAgICAgZm9yIChjb25zdCBtIG9mIG1zZ3MpIHRoaXMuZW5xdWV1ZU1lc3NhZ2UobSk7CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgfQogICAgICAgICAgY2FzZSAndXBkYXRlQ29uZmlnJzoKICAgICAgICAgICAgaWYgKHRoaXMuY29uZmlnKSB7CiAgICAgICAgICAgICAgY29uc3QgcHJldk1vZGUgPSB0aGlzLmNvbmZpZy5kYW5tYWt1TW9kZTsKICAgICAgICAgICAgICBjb25zdCBuZXh0Q29uZmlnID0gZGF0YS5jb25maWcgYXMgUGFydGlhbDxXb3JrZXJDb25maWc+OwogICAgICAgICAgICAgIGNvbnN0IGdlb21ldHJ5Q2hhbmdlZCA9CiAgICAgICAgICAgICAgICAobmV4dENvbmZpZy5mb250U2l6ZSAhPT0gdW5kZWZpbmVkICYmCiAgICAgICAgICAgICAgICAgIG5leHRDb25maWcuZm9udFNpemUgIT09IHRoaXMuY29uZmlnLmZvbnRTaXplKSB8fAogICAgICAgICAgICAgICAgKG5leHRDb25maWcuZm9udFdlaWdodCAhPT0gdW5kZWZpbmVkICYmCiAgICAgICAgICAgICAgICAgIG5leHRDb25maWcuZm9udFdlaWdodCAhPT0gdGhpcy5jb25maWcuZm9udFdlaWdodCkgfHwKICAgICAgICAgICAgICAgIChuZXh0Q29uZmlnLmZvbnRGYW1pbHkgIT09IHVuZGVmaW5lZCAmJgogICAgICAgICAgICAgICAgICBuZXh0Q29uZmlnLmZvbnRGYW1pbHkgIT09IHRoaXMuY29uZmlnLmZvbnRGYW1pbHkpIHx8CiAgICAgICAgICAgICAgICAobmV4dENvbmZpZy5sYW5lU3BhY2luZyAhPT0gdW5kZWZpbmVkICYmCiAgICAgICAgICAgICAgICAgIG5leHRDb25maWcubGFuZVNwYWNpbmcgIT09IHRoaXMuY29uZmlnLmxhbmVTcGFjaW5nKSB8fAogICAgICAgICAgICAgICAgKG5leHRDb25maWcuc2FmZVRvcCAhPT0gdW5kZWZpbmVkICYmIG5leHRDb25maWcuc2FmZVRvcCAhPT0gdGhpcy5jb25maWcuc2FmZVRvcCkgfHwKICAgICAgICAgICAgICAgIChuZXh0Q29uZmlnLnNhZmVCb3R0b20gIT09IHVuZGVmaW5lZCAmJgogICAgICAgICAgICAgICAgICBuZXh0Q29uZmlnLnNhZmVCb3R0b20gIT09IHRoaXMuY29uZmlnLnNhZmVCb3R0b20pOwogICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcy5jb25maWcsIG5leHRDb25maWcpOwogICAgICAgICAgICAgIHRoaXMucmVjb21wdXRlQ29uZmlnRGVyaXZlZCgpOwogICAgICAgICAgICAgIHRoaXMudGV4dE1lYXN1cmVDYWNoZS5jbGVhcigpOwogICAgICAgICAgICAgIHRoaXMuZm9udE1ldHJpY3NDYWNoZS5jbGVhcigpOwogICAgICAgICAgICAgIHRoaXMudGV4dEJpdG1hcENhY2hlLmNsZWFyKCk7CiAgICAgICAgICAgICAgLy8gUHJlc2VydmUgZGVjb2RlZCBpbWFnZSBjYWNoZXMgYWNyb3NzIG9yZGluYXJ5IHNldHRpbmdzCiAgICAgICAgICAgICAgLy8gdXBkYXRlcy4gQ2xlYXJpbmcgdGhlbSBmb3Igb3BhY2l0eS90cmFuc2xhdGlvbi90aW1pbmcgY2hhbmdlcwogICAgICAgICAgICAgIC8vIG1ha2VzIHZpc2libGUgZW1vamksIGF2YXRhcnMsIGFuZCBzdGlja2VycyBkaXNhcHBlYXIgdW50aWwgYQogICAgICAgICAgICAgIC8vIG5ldyBmZXRjaCBjb21wbGV0ZXMuIHJlc2l6ZSgpIHN0aWxsIGV2aWN0cyB3aGVuIGEgY2FjaGUgbGltaXQKICAgICAgICAgICAgICAvLyBpcyBhY3R1YWxseSByZWR1Y2VkLgogICAgICAgICAgICAgIGlmIChuZXh0Q29uZmlnICYmICdlbW9qaUNhY2hlTWInIGluIG5leHRDb25maWcpIHsKICAgICAgICAgICAgICAgIHRoaXMuZW1vamlDYWNoZS5yZXNpemUoKHRoaXMuY29uZmlnLmVtb2ppQ2FjaGVNYiA/PyA0KSAqIDFfMDAwXzAwMCk7CiAgICAgICAgICAgICAgfQogICAgICAgICAgICAgIGlmIChuZXh0Q29uZmlnICYmICdwaG90b0NhY2hlTWInIGluIG5leHRDb25maWcpIHsKICAgICAgICAgICAgICAgIHRoaXMuYXV0aG9yUGhvdG9DYWNoZS5yZXNpemUoKHRoaXMuY29uZmlnLnBob3RvQ2FjaGVNYiA/PyA0KSAqIDFfMDAwXzAwMCk7CiAgICAgICAgICAgICAgfQogICAgICAgICAgICAgIGlmIChuZXh0Q29uZmlnICYmICdzdGlja2VyQ2FjaGVNYicgaW4gbmV4dENvbmZpZykgewogICAgICAgICAgICAgICAgdGhpcy5zdGlja2VyQ2FjaGUucmVzaXplKGdldFN0aWNrZXJDYWNoZUJ5dGVzKHRoaXMuY29uZmlnLnN0aWNrZXJDYWNoZU1iID8/IDQpKTsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgaWYgKG5leHRDb25maWcgJiYgJ3RleHRDYWNoZU1iJyBpbiBuZXh0Q29uZmlnKSB7CiAgICAgICAgICAgICAgICB0aGlzLnRleHRCaXRtYXBDYWNoZS5yZXNpemUoKHRoaXMuY29uZmlnLnRleHRDYWNoZU1iID8/IDQpICogMV8wMDBfMDAwKTsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgdGhpcy5zdXBlckNoYXRHcmFkaWVudENhY2hlLmNsZWFyKCk7CiAgICAgICAgICAgICAgaWYgKGdlb21ldHJ5Q2hhbmdlZCAmJiB0aGlzLmNhbnZhcykgewogICAgICAgICAgICAgICAgdGhpcy5pbml0TGFuZXModGhpcy5sb2dpY2FsV2lkdGgsIHRoaXMubG9naWNhbEhlaWdodCk7CiAgICAgICAgICAgICAgICB0aGlzLnJlZmxvd0FjdGl2ZU1lc3NhZ2VzKCk7CiAgICAgICAgICAgICAgfQogICAgICAgICAgICAgIC8vIElzc3VlIDQ6IFdoZW4gZGFubWFrdU1vZGUgY2hhbmdlcywgYWN0aXZlIG1lc3NhZ2VzIGhhdmUgcG9zaXRpb25zCiAgICAgICAgICAgICAgLy8gY29tcHV0ZWQgZm9yIHRoZSBvbGQgbW9kZSDigJQgcmVmbG93IHRoZW0gaW50byB0aGUgbmV3IG1vZGUgbGF5b3V0CiAgICAgICAgICAgICAgLy8gaW5zdGVhZCBvZiBjbGVhcmluZyBzdGF0ZSAod2hpY2ggbG9zZXMgYWxsIGFjdGl2ZSBtZXNzYWdlcykuCiAgICAgICAgICAgICAgLy8gVGhlIHdvcmtlcidzIHJlZmxvd0FjdGl2ZU1lc3NhZ2VzKCkgcmVjb21wdXRlcyBzdGFydFgsIHgsIGFuZAogICAgICAgICAgICAgIC8vIGR1cmF0aW9uIGJhc2VkIG9uIHRoaXMuY29uZmlnLmRhbm1ha3VNb2RlLCBtYXRjaGluZyB0aGUgbWFpbgogICAgICAgICAgICAgIC8vIHRocmVhZCBDYW52YXMyRCBiZWhhdmlvci4KICAgICAgICAgICAgICBpZiAoCiAgICAgICAgICAgICAgICBkYXRhLmNvbmZpZyAmJgogICAgICAgICAgICAgICAgKGRhdGEuY29uZmlnIGFzIFdvcmtlckNvbmZpZykuZGFubWFrdU1vZGUgIT09IHVuZGVmaW5lZCAmJgogICAgICAgICAgICAgICAgKGRhdGEuY29uZmlnIGFzIFdvcmtlckNvbmZpZykuZGFubWFrdU1vZGUgIT09IHByZXZNb2RlCiAgICAgICAgICAgICAgKSB7CiAgICAgICAgICAgICAgICB0aGlzLnJlZmxvd0FjdGl2ZU1lc3NhZ2VzKCk7CiAgICAgICAgICAgICAgfQogICAgICAgICAgICB9CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgY2FzZSAnc2V0UGF1c2VkJzogewogICAgICAgICAgICBjb25zdCBzaG91bGRQYXVzZSA9IGRhdGEucGF1c2VkIGFzIGJvb2xlYW47CiAgICAgICAgICAgIGlmIChzaG91bGRQYXVzZSAmJiAhdGhpcy5pc1BhdXNlZCkgewogICAgICAgICAgICAgIGlmICh0aGlzLmFuaW1GcmFtZUlkICE9PSBudWxsKSB7CiAgICAgICAgICAgICAgICBjYW5jZWxBbmltYXRpb25GcmFtZSh0aGlzLmFuaW1GcmFtZUlkKTsKICAgICAgICAgICAgICAgIHRoaXMuYW5pbUZyYW1lSWQgPSBudWxsOwogICAgICAgICAgICAgIH0KICAgICAgICAgICAgICB0aGlzLnBhdXNlU3RhcnRUaW1lID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgICAgICAgICAgICAgdGhpcy5pc1BhdXNlZCA9IHRydWU7CiAgICAgICAgICAgIH0gZWxzZSBpZiAoIXNob3VsZFBhdXNlICYmIHRoaXMuaXNQYXVzZWQpIHsKICAgICAgICAgICAgICBjb25zdCBub3cgPSBwZXJmb3JtYW5jZS5ub3coKTsKICAgICAgICAgICAgICBsZXQgcGF1c2VkTXMgPSBNYXRoLm1heCgwLCBub3cgLSB0aGlzLnBhdXNlU3RhcnRUaW1lKTsKICAgICAgICAgICAgICBmb3IgKGNvbnN0IG1zZyBvZiB0aGlzLmFjdGl2ZU1lc3NhZ2VzKSB7CiAgICAgICAgICAgICAgICBjb25zdCBlbGFwc2VkQmVmb3JlUGF1c2UgPSBub3cgLSBwYXVzZWRNcyAtIG1zZy5zdGFydFRpbWU7CiAgICAgICAgICAgICAgICBjb25zdCByZW1haW5pbmdEaXNwbGF5ID0gbXNnLmR1cmF0aW9uIC0gZWxhcHNlZEJlZm9yZVBhdXNlOwogICAgICAgICAgICAgICAgY29uc3QgY2FwcGVkID0gTWF0aC5tYXgoCiAgICAgICAgICAgICAgICAgIDAsCiAgICAgICAgICAgICAgICAgIE1hdGgubWluKHBhdXNlZE1zLCBNYXRoLm1heCgwLCByZW1haW5pbmdEaXNwbGF5KSArIDEwMDApCiAgICAgICAgICAgICAgICApOwogICAgICAgICAgICAgICAgbXNnLnBhdXNlZER1cmF0aW9uICs9IGNhcHBlZDsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgcGF1c2VkTXMgPSBNYXRoLm1pbigKICAgICAgICAgICAgICAgIHBhdXNlZE1zLAogICAgICAgICAgICAgICAgKHRoaXMuY29uZmlnPy5tYXhNZXNzYWdlQWdlTXMgPz8gREVGQVVMVF9TRVRUSU5HUy5tYXhNZXNzYWdlQWdlTXMpICogMgogICAgICAgICAgICAgICk7CiAgICAgICAgICAgICAgV29ya2VyUmVuZGVyZXIuc2hpZnRMYW5lVGltZXJzKHRoaXMubGFuZVN0YXRlLCBwYXVzZWRNcyk7CiAgICAgICAgICAgICAgdGhpcy5pc1BhdXNlZCA9IGZhbHNlOwogICAgICAgICAgICAgIHRoaXMucGF1c2VTdGFydFRpbWUgPSAwOwogICAgICAgICAgICAgIGlmICh0aGlzLmFuaW1GcmFtZUlkID09PSBudWxsICYmICF0aGlzLmlzRGVzdHJveWVkKSB7CiAgICAgICAgICAgICAgICB0aGlzLnN0YXJ0UmVuZGVyTG9vcCgpOwogICAgICAgICAgICAgIH0KICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICB0aGlzLmlzUGF1c2VkID0gc2hvdWxkUGF1c2U7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICB9CiAgICAgICAgICBjYXNlICd1cGRhdGVUcmFuc2xhdGlvbic6IHsKICAgICAgICAgICAgY29uc3QgbXNnSWQgPSBkYXRhLmlkIGFzIHN0cmluZzsKICAgICAgICAgICAgY29uc3QgdHJhbnNsYXRlZFRleHQgPSBkYXRhLnRyYW5zbGF0ZWRUZXh0IGFzIHN0cmluZyB8IG51bGw7CiAgICAgICAgICAgIGNvbnN0IG1zZyA9IHRoaXMubWVzc2FnZUJ5SWQuZ2V0KG1zZ0lkKTsKICAgICAgICAgICAgaWYgKG1zZykgewogICAgICAgICAgICAgIG1zZy50cmFuc2xhdGVkVGV4dCA9IHRyYW5zbGF0ZWRUZXh0OwogICAgICAgICAgICAgIGlmICgnbGFuZUFycmF5SW5kaWNlcycgaW4gbXNnKSB7CiAgICAgICAgICAgICAgICBpZiAodHJhbnNsYXRlZFRleHQpIHsKICAgICAgICAgICAgICAgICAgbXNnLnRyYW5zbGF0ZWRDb250ZW50ID0gW3sgdHlwZTogJ3RleHQnLCBjb250ZW50OiB0cmFuc2xhdGVkVGV4dCB9XTsKICAgICAgICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgICAgICAgIGRlbGV0ZSBtc2cudHJhbnNsYXRlZENvbnRlbnQ7CiAgICAgICAgICAgICAgICB9CiAgICAgICAgICAgICAgfQogICAgICAgICAgICB9CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgfQogICAgICAgICAgY2FzZSAnc2V0VXNlclBhdXNlZCc6CiAgICAgICAgICAgIHRoaXMuaXNVc2VyUGF1c2VkID0gKGRhdGEucGF1c2VkIGFzIGJvb2xlYW4pID8/IGZhbHNlOwogICAgICAgICAgICAvLyBSZXN0YXJ0IHJlbmRlciBsb29wIGlmIHVucGF1c2luZyB3aGlsZSBub3Qgb3RoZXJ3aXNlIHBhdXNlZAogICAgICAgICAgICBpZiAoIXRoaXMuaXNVc2VyUGF1c2VkICYmICF0aGlzLmlzUGF1c2VkICYmICF0aGlzLmlzRGVzdHJveWVkKSB7CiAgICAgICAgICAgICAgaWYgKHRoaXMuYW5pbUZyYW1lSWQgPT09IG51bGwpIHsKICAgICAgICAgICAgICAgIHRoaXMuc3RhcnRSZW5kZXJMb29wKCk7CiAgICAgICAgICAgICAgfQogICAgICAgICAgICB9CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgY2FzZSAnc25hcHNob3RNZXNzYWdlcyc6CiAgICAgICAgICAgIHNlbGYucG9zdE1lc3NhZ2UoewogICAgICAgICAgICAgIHR5cGU6ICdtZXNzYWdlU25hcHNob3QnLAogICAgICAgICAgICAgIHJlcXVlc3RJZDogZGF0YS5yZXF1ZXN0SWQsCiAgICAgICAgICAgICAgbWVzc2FnZUlkczogWy4uLnRoaXMubWVzc2FnZUJ5SWQua2V5cygpXSwKICAgICAgICAgICAgfSk7CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgY2FzZSAnZGVzdHJveSc6CiAgICAgICAgICAgIHRoaXMuaGFuZGxlRGVzdHJveSgpOwogICAgICAgICAgICBicmVhazsKICAgICAgICAgIGNhc2UgJ2NsZWFyU3RhdGUnOgogICAgICAgICAgICB0aGlzLmhhbmRsZUNsZWFyU3RhdGUoKTsKICAgICAgICAgICAgYnJlYWs7CiAgICAgICAgICBjYXNlICdsYW5lRGVuc2l0eSc6CiAgICAgICAgICAgIHRoaXMubGFuZURlbnNpdHlGYWN0b3IgPSAoZGF0YSBhcyB7IGZhY3RvcjogbnVtYmVyIH0pLmZhY3RvcjsKICAgICAgICAgICAgaWYgKHRoaXMuY2FudmFzICYmIHRoaXMuY29uZmlnKSB7CiAgICAgICAgICAgICAgdGhpcy5pbml0TGFuZXModGhpcy5sb2dpY2FsV2lkdGgsIHRoaXMubG9naWNhbEhlaWdodCk7CiAgICAgICAgICAgICAgdGhpcy5yZWZsb3dBY3RpdmVNZXNzYWdlcygpOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgICAgY2FzZSAncGluZyc6CiAgICAgICAgICAgIHNlbGYucG9zdE1lc3NhZ2UoeyB0eXBlOiAncG9uZycgfSk7CiAgICAgICAgICAgIGJyZWFrOwogICAgICAgIH0KICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgc2VsZi5wb3N0TWVzc2FnZSh7CiAgICAgICAgICB0eXBlOiAnZXJyb3InLAogICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSwKICAgICAgICB9KTsKICAgICAgfQogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIHNlbGYucG9zdE1lc3NhZ2UoeyB0eXBlOiAnZXJyb3InLCBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpIH0pOwogICAgfQogIH0KCiAgcHJpdmF0ZSByZWNvbXB1dGVDb25maWdEZXJpdmVkKCk6IHZvaWQgewogICAgaWYgKCF0aGlzLmNvbmZpZykgcmV0dXJuOwogICAgY29uc3QgYyA9IHRoaXMuY29uZmlnOwogICAgdGhpcy5pbnZGYWRlTXMgPSBjb21wdXRlSW52RmFkZUR1cmF0aW9uKGMuZmFkZUR1cmF0aW9uTXMpOwogICAgdGhpcy5hZ2VGYWRlUmF0ZSA9IGNvbXB1dGVBZ2VGYWRlUmF0ZShjLm1heE1lc3NhZ2VBZ2VNcyk7CiAgICB0aGlzLmJvdW5kR2V0Rm9udCA9IChmb250U2l6ZTogbnVtYmVyKTogc3RyaW5nID0+CiAgICAgIGdldEZvbnRTdHJpbmcoZm9udFNpemUsIGMuZm9udFdlaWdodCwgYy5mb250RmFtaWx5KTsKICAgIHRoaXMub3BhY2l0eUNvbmZpZyA9IHsKICAgICAgYmFzZU9wYWNpdHk6IGMub3BhY2l0eSwKICAgICAgZmFkZUR1cmF0aW9uTXM6IGMuZmFkZUR1cmF0aW9uTXMsCiAgICAgIGludkZhZGVEdXJhdGlvbjogdGhpcy5pbnZGYWRlTXMsCiAgICAgIGJhY2tsb2dPcGFjaXR5TXVsdGlwbGllcjogYy5iYWNrbG9nT3BhY2l0eU11bHRpcGxpZXIsCiAgICAgIGRlcHRoTGF5ZXJzRW5hYmxlZDogYy5kZXB0aExheWVyc0VuYWJsZWQsCiAgICAgIGRlcHRoRmFyT3BhY2l0eU11bDogYy5kZXB0aEZhck9wYWNpdHlNdWwsCiAgICAgIGFnZUZhZGVSYXRlOiB0aGlzLmFnZUZhZGVSYXRlLAogICAgfTsKICB9CgogIHByaXZhdGUgbWVhc3VyZVRleHRDYWNoZWQodGV4dDogc3RyaW5nKTogbnVtYmVyIHsKICAgIGlmICghdGhpcy5jdHgpIHJldHVybiAwOwogICAgbGV0IHcgPSB0aGlzLnRleHRNZWFzdXJlQ2FjaGUuZ2V0KHRleHQpOwogICAgaWYgKHcgPT09IHVuZGVmaW5lZCkgewogICAgICBjb25zdCBtID0gdGhpcy5jdHgubWVhc3VyZVRleHQodGV4dCk7CiAgICAgIHcgPSBtZWFzdXJlQm91bmRpbmdCb3hXaWR0aChtKTsKICAgICAgaWYgKHRoaXMudGV4dE1lYXN1cmVDYWNoZS5zaXplID49IFdvcmtlclJlbmRlcmVyLlRFWFRfTUVBU1VSRV9DQUNIRV9NQVgpIHsKICAgICAgICBjb25zdCBvbGRlc3RLZXkgPSB0aGlzLnRleHRNZWFzdXJlQ2FjaGUua2V5cygpLm5leHQoKS52YWx1ZTsKICAgICAgICBpZiAob2xkZXN0S2V5ICE9PSB1bmRlZmluZWQpIHRoaXMudGV4dE1lYXN1cmVDYWNoZS5kZWxldGUob2xkZXN0S2V5KTsKICAgICAgfQogICAgICB0aGlzLnRleHRNZWFzdXJlQ2FjaGUuc2V0KHRleHQsIHcpOwogICAgfQogICAgcmV0dXJuIHc7CiAgfQoKICBwcml2YXRlIGdldEZvbnRGcm9tQ29uZmlnKGZvbnRTaXplOiBudW1iZXIpOiBzdHJpbmcgewogICAgaWYgKCF0aGlzLmNvbmZpZykgcmV0dXJuIGAke2ZvbnRTaXplfXB4IHNhbnMtc2VyaWZgOwogICAgcmV0dXJuIGdldEZvbnRTdHJpbmcoZm9udFNpemUsIHRoaXMuY29uZmlnLmZvbnRXZWlnaHQsIHRoaXMuY29uZmlnLmZvbnRGYW1pbHkpOwogIH0KCiAgcHJpdmF0ZSBtZWFzdXJlVGV4dEhlaWdodChmb250U2l6ZTogbnVtYmVyKTogbnVtYmVyIHsKICAgIGlmICghdGhpcy5jdHgpIHJldHVybiBNYXRoLmNlaWwoZm9udFNpemUgKiAxLjEpOwogICAgY29uc3QgZm9udCA9IHRoaXMuZ2V0Rm9udEZyb21Db25maWcoZm9udFNpemUpOwogICAgbGV0IG1ldHJpY3MgPSB0aGlzLmZvbnRNZXRyaWNzQ2FjaGUuZ2V0KGZvbnQpOwogICAgaWYgKCFtZXRyaWNzKSB7CiAgICAgIHRoaXMuY3R4LmZvbnQgPSBmb250OwogICAgICBjb25zdCBtID0gdGhpcy5jdHgubWVhc3VyZVRleHQoJ01nJyk7CiAgICAgIG1ldHJpY3MgPSB7IGhlaWdodDogZ2V0U2FmZVRleHRIZWlnaHQobSwgZm9udFNpemUpIH07CiAgICAgIHRoaXMuZm9udE1ldHJpY3NDYWNoZS5zZXQoZm9udCwgbWV0cmljcyk7CiAgICB9CiAgICByZXR1cm4gbWV0cmljcy5oZWlnaHQ7CiAgfQoKICBwcml2YXRlIHN0YXRpYyBlc3RpbWF0ZUJpdG1hcEJ5dGVzKGJpdG1hcDogSW1hZ2VCaXRtYXApOiBudW1iZXIgewogICAgcmV0dXJuIGJpdG1hcC53aWR0aCAqIGJpdG1hcC5oZWlnaHQgKiA0OwogIH0KCiAgcHJpdmF0ZSBlbnF1ZXVlTWVzc2FnZShtc2c6IFdvcmtlck1lc3NhZ2UpOiB2b2lkIHsKICAgIGNvbnN0IG1heFNpemUgPSB0aGlzLmNvbmZpZz8ucXVldWVNYXhTaXplID8/IDIwMDsKICAgIGlmICh0aGlzLnBlbmRpbmdRdWV1ZS5sZW5ndGggPj0gbWF4U2l6ZSkgewogICAgICBsZXQgbWluSWR4ID0gMDsKICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPCB0aGlzLnBlbmRpbmdRdWV1ZS5sZW5ndGg7IGkrKykgewogICAgICAgIGlmICgodGhpcy5wZW5kaW5nUXVldWVbaV0/LnByaW9yaXR5ID8/IDApIDwgKHRoaXMucGVuZGluZ1F1ZXVlW21pbklkeF0/LnByaW9yaXR5ID8/IDApKSB7CiAgICAgICAgICBtaW5JZHggPSBpOwogICAgICAgIH0KICAgICAgfQogICAgICBpZiAobXNnLnByaW9yaXR5ID4gKHRoaXMucGVuZGluZ1F1ZXVlW21pbklkeF0/LnByaW9yaXR5ID8/IDApKSB7CiAgICAgICAgLy8gUmVwbGFjZSB0aGUgbG93ZXN0LXByaW9yaXR5IGVudHJ5LiAgQ2xlYW4gdXAgdGhlIGV2aWN0ZWQKICAgICAgICAvLyBlbnRyeSBmcm9tIG1lc3NhZ2VCeUlkIGFuZCByZWdpc3RlciB0aGUgbmV3IG9uZSBzbwogICAgICAgIC8vIHRyYW5zbGF0aW9uIHJlc3VsdHMgY2FuIGJlIG1hdGNoZWQuCiAgICAgICAgY29uc3QgZXZpY3RlZCA9IHRoaXMucGVuZGluZ1F1ZXVlW21pbklkeF07CiAgICAgICAgaWYgKGV2aWN0ZWQpIHRoaXMubWVzc2FnZUJ5SWQuZGVsZXRlKGV2aWN0ZWQuaWQpOwogICAgICAgIHRoaXMucGVuZGluZ1F1ZXVlW21pbklkeF0gPSBtc2c7CiAgICAgICAgdGhpcy5tZXNzYWdlQnlJZC5zZXQobXNnLmlkLCBtc2cpOwogICAgICB9CiAgICAgIHJldHVybjsKICAgIH0KICAgIHRoaXMucGVuZGluZ1F1ZXVlLnB1c2gobXNnKTsKICAgIHRoaXMubWVzc2FnZUJ5SWQuc2V0KG1zZy5pZCwgbXNnKTsKICAgIHRoaXMucGVuZGluZ1F1ZXVlU29ydE5lZWRlZCA9IHRydWU7CiAgICBpZiAodGhpcy5hbmltRnJhbWVJZCA9PT0gbnVsbCAmJiAhdGhpcy5pc0Rlc3Ryb3llZCkgewogICAgICB0aGlzLnN0YXJ0UmVuZGVyTG9vcCgpOwogICAgfQogIH0KCiAgcHJpdmF0ZSBzdGFydFJlbmRlckxvb3AoKTogdm9pZCB7CiAgICBpZiAodGhpcy5hbmltRnJhbWVJZCAhPT0gbnVsbCkgcmV0dXJuOwogICAgY29uc3QgZnJhbWUgPSAoX3Q6IG51bWJlcik6IHZvaWQgPT4gewogICAgICBpZiAodGhpcy5pc0Rlc3Ryb3llZCkgcmV0dXJuOwogICAgICB0aGlzLnJlbmRlckZyYW1lKCk7CiAgICAgIGlmICh0aGlzLmFjdGl2ZU1lc3NhZ2VzLmxlbmd0aCA9PT0gMCAmJiB0aGlzLnBlbmRpbmdRdWV1ZS5sZW5ndGggPT09IDApIHsKICAgICAgICBjb25zdCBub3cgPSBwZXJmb3JtYW5jZS5ub3coKTsKICAgICAgICBpZiAodGhpcy5pZGxlU2luY2UgPT09IG51bGwpIHsKICAgICAgICAgIHRoaXMuaWRsZVNpbmNlID0gbm93OwogICAgICAgIH0gZWxzZSBpZiAobm93IC0gdGhpcy5pZGxlU2luY2UgPj0gSURMRV9HUkFDRV9QRVJJT0RfTVMpIHsKICAgICAgICAgIHRoaXMuYW5pbUZyYW1lSWQgPSBudWxsOwogICAgICAgICAgdGhpcy5pZGxlU2luY2UgPSBudWxsOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgfSBlbHNlIHsKICAgICAgICB0aGlzLmlkbGVTaW5jZSA9IG51bGw7CiAgICAgIH0KICAgICAgdGhpcy5hbmltRnJhbWVJZCA9IHJlcXVlc3RBbmltYXRpb25GcmFtZShmcmFtZSk7CiAgICB9OwogICAgdGhpcy5hbmltRnJhbWVJZCA9IHJlcXVlc3RBbmltYXRpb25GcmFtZShmcmFtZSk7CiAgfQoKICBwcml2YXRlIGhhbmRsZURlc3Ryb3koKTogdm9pZCB7CiAgICB0aGlzLmlzRGVzdHJveWVkID0gdHJ1ZTsKICAgIHRoaXMuZmV0Y2hHZW5lcmF0aW9uKys7CiAgICBmb3IgKGNvbnN0IGNvbnRyb2xsZXIgb2YgdGhpcy5mZXRjaENvbnRyb2xsZXJzKSBjb250cm9sbGVyLmFib3J0KCk7CiAgICB0aGlzLmZldGNoQ29udHJvbGxlcnMuY2xlYXIoKTsKICAgIHRoaXMuZmV0Y2hpbmcuY2xlYXIoKTsKICAgIGlmICh0aGlzLmFuaW1GcmFtZUlkICE9PSBudWxsKSB7CiAgICAgIGNhbmNlbEFuaW1hdGlvbkZyYW1lKHRoaXMuYW5pbUZyYW1lSWQpOwogICAgICB0aGlzLmFuaW1GcmFtZUlkID0gbnVsbDsKICAgIH0KICAgIHRoaXMuY3R4ID0gbnVsbDsKICAgIHRoaXMuY2FudmFzID0gbnVsbDsKICAgIHRoaXMuYWN0aXZlTWVzc2FnZXMubGVuZ3RoID0gMDsKICAgIHRoaXMuYWN0aXZlTWVzc2FnZXNCeUxhbmUuY2xlYXIoKTsKICAgIHRoaXMucGVuZGluZ1F1ZXVlLmxlbmd0aCA9IDA7CiAgICB0aGlzLnRleHRCaXRtYXBDYWNoZS5jbGVhcigpOwogICAgdGhpcy5lbW9qaUNhY2hlLmNsZWFyKCk7CiAgICB0aGlzLmF1dGhvclBob3RvQ2FjaGUuY2xlYXIoKTsKICAgIHRoaXMuc3RpY2tlckNhY2hlLmNsZWFyKCk7CiAgICB0aGlzLnN1cGVyQ2hhdEdyYWRpZW50Q2FjaGUuY2xlYXIoKTsKICAgIHRoaXMubWVzc2FnZUJ5SWQuY2xlYXIoKTsKICAgIC8vIEFja25vd2xlZGdlIHRoZSBkZXN0cm95IHJlcXVlc3Qgc28gdGhlIG1haW4gdGhyZWFkIGNhbiB0ZXJtaW5hdGUKICAgIC8vIHdpdGhvdXQgd2FpdGluZyBmb3IgdGhlIDUwMG1zIHNhZmV0eSB0aW1lb3V0LgogICAgc2VsZi5wb3N0TWVzc2FnZSh7IHR5cGU6ICdhY2snIH0pOwogIH0KCiAgLyoqCiAgICogQ2xlYXIgcmVuZGVyZXIgc3RhdGUgZm9yIGEgZnJlc2ggcmVzdGFydCAodXNlZCBieSBwZXJmb3JtT3ZlcmxheVJlZnJlc2gpLgogICAqIFJlc2V0cyBhY3RpdmUgbWVzc2FnZXMsIHBlbmRpbmcgcXVldWUsIGFuZCBsYW5lIGFsbG9jYXRvciB3aGlsZQogICAqIHByZXNlcnZpbmcgY2FjaGVzICh0ZXh0IGJpdG1hcHMsIGVtb2ppLCBhdXRob3IgcGhvdG9zLCBldGMuKS4KICAgKi8KICBwcml2YXRlIGhhbmRsZUNsZWFyU3RhdGUoKTogdm9pZCB7CiAgICB0aGlzLmFjdGl2ZU1lc3NhZ2VzLmxlbmd0aCA9IDA7CiAgICB0aGlzLmFjdGl2ZU1lc3NhZ2VzQnlMYW5lLmNsZWFyKCk7CiAgICB0aGlzLnBlbmRpbmdRdWV1ZS5sZW5ndGggPSAwOwogICAgdGhpcy5tZXNzYWdlQnlJZC5jbGVhcigpOwogICAgLy8gUmVidWlsZCBsYW5lIGFsbG9jYXRvciBmcm9tIGV4aXN0aW5nIGRpbWVuc2lvbnMgKG51bUxhbmVzL2xhbmVIZWlnaHQKICAgIC8vIGFyZSBwcmVzZXJ2ZWQgZnJvbSB0aGUgbGFzdCBpbml0TGFuZXMvcmVzaXplIGNhbGwpLgogICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgICB0aGlzLmxhbmVIZWFwID0gYnVpbGRMYW5lSGVhcCh0aGlzLm51bUxhbmVzLCBub3csIHRoaXMubGFuZUluZGV4VG9IZWFwSW5kZXgpOwogICAgdGhpcy5zcGVlZFRpZXJMYW5lcy5jbGVhcigpOwogICAgdGhpcy5jb2xsaWRlZExhbmVzLmNsZWFyKCk7CiAgfQoKICBwcml2YXRlIGdldCBsYW5lU3RhdGUoKTogTGFuZUFsbG9jYXRpb25TdGF0ZSB7CiAgICByZXR1cm4gewogICAgICBoZWFwOiB0aGlzLmxhbmVIZWFwLAogICAgICBpbmRleE1hcDogdGhpcy5sYW5lSW5kZXhUb0hlYXBJbmRleCwKICAgICAgbnVtTGFuZXM6IHRoaXMubnVtTGFuZXMsCiAgICAgIHNwZWVkVGllckxhbmVzOiB0aGlzLnNwZWVkVGllckxhbmVzLAogICAgICBjb2xsaWRlZExhbmVzOiB0aGlzLmNvbGxpZGVkTGFuZXMsCiAgICB9OwogIH0KCiAgLyoqIFJlcG9zaXRpb24gYWN0aXZlIG1lc3NhZ2VzIGFuZCByZXN0b3JlIHRoZWlyIGxhbmUgcmVzZXJ2YXRpb25zIGFmdGVyIHJlc2l6ZS4gKi8KICBwcml2YXRlIHJlZmxvd0FjdGl2ZU1lc3NhZ2VzKCk6IHZvaWQgewogICAgaWYgKCF0aGlzLmNvbmZpZyB8fCB0aGlzLm51bUxhbmVzIDw9IDApIHJldHVybjsKICAgIGNvbnN0IG5vdyA9IHBlcmZvcm1hbmNlLm5vdygpOwogICAgdGhpcy5hY3RpdmVNZXNzYWdlc0J5TGFuZS5jbGVhcigpOwoKICAgIGZvciAoY29uc3QgbXNnIG9mIHRoaXMuYWN0aXZlTWVzc2FnZXMpIHsKICAgICAgY29uc3QgcmVxdWVzdGVkU2xvdHMgPSBNYXRoLm1heCgxLCBtc2cubGFuZVNsb3RDb3VudCA/PyAxKTsKICAgICAgY29uc3Qgc2xvdENvdW50ID0gTWF0aC5taW4ocmVxdWVzdGVkU2xvdHMsIHRoaXMubnVtTGFuZXMpOwogICAgICBjb25zdCBsYW5lSW5kZXggPSBNYXRoLm1pbihtc2cubGFuZUluZGV4LCBNYXRoLm1heCgwLCB0aGlzLm51bUxhbmVzIC0gc2xvdENvdW50KSk7CiAgICAgIG1zZy5sYW5lSW5kZXggPSBsYW5lSW5kZXg7CiAgICAgIG1zZy5sYW5lU2xvdENvdW50ID0gc2xvdENvdW50OwogICAgICBtc2cubGFuZUFycmF5SW5kaWNlcy5sZW5ndGggPSAwOwogICAgICBtc2cueSA9CiAgICAgICAgY29tcHV0ZUxhbmVZKGxhbmVJbmRleCwgdGhpcy5sb2dpY2FsSGVpZ2h0LCB0aGlzLmNvbmZpZy5zYWZlVG9wID8/IDAsIHRoaXMubGFuZUhlaWdodCkgKwogICAgICAgIE1hdGguZmxvb3IoKHNsb3RDb3VudCAqIHRoaXMubGFuZUhlaWdodCAtIG1zZy5oZWlnaHQpIC8gMik7CgogICAgICBjb25zdCBlbGFwc2VkID0gTWF0aC5tYXgoMCwgbm93IC0gbXNnLnN0YXJ0VGltZSAtIG1zZy5wYXVzZWREdXJhdGlvbik7CiAgICAgIGNvbnN0IHByb2dyZXNzID0gTWF0aC5taW4oMSwgZWxhcHNlZCAqIG1zZy5pbnZEdXJhdGlvbik7CiAgICAgIGNvbnN0IGlzU2Nyb2xsaW5nID0KICAgICAgICB0aGlzLmNvbmZpZy5kYW5tYWt1TW9kZSA9PT0gJ3Njcm9sbCcgfHwgdGhpcy5jb25maWcuZGFubWFrdU1vZGUgPT09ICdyZXZlcnNlJzsKICAgICAgbGV0IGR1cmF0aW9uID0gdGhpcy5jb25maWcudG9wQm90dG9tRHVyYXRpb25NczsKICAgICAgaWYgKGlzU2Nyb2xsaW5nKSB7CiAgICAgICAgbGV0IHNwZWVkID0gdGhpcy5jb25maWcuc3BlZWRQeFBlclNlYzsKICAgICAgICBpZiAobXNnLnNwZWVkVGllciA9PT0gU1BFRURfVElFUi5GQVIpIHsKICAgICAgICAgIHNwZWVkID0gTWF0aC5tYXgoMzAsIHNwZWVkICogdGhpcy5jb25maWcuZGVwdGhGYXJTcGVlZE11bCk7CiAgICAgICAgfSBlbHNlIGlmIChtc2cuc3BlZWRUaWVyID09PSBTUEVFRF9USUVSLk5FQVIpIHsKICAgICAgICAgIHNwZWVkICo9IHRoaXMuY29uZmlnLmRlcHRoTmVhclNwZWVkTXVsOwogICAgICAgIH0gZWxzZSBpZiAobXNnLnNwZWVkVGllciA9PT0gU1BFRURfVElFUi5CQUNLTE9HKSB7CiAgICAgICAgICBzcGVlZCAqPSB0aGlzLmNvbmZpZy5iYWNrbG9nU3BlZWRNdWx0aXBsaWVyOwogICAgICAgIH0KICAgICAgICBjb25zdCB0b3RhbERpc3RhbmNlID0gdGhpcy5sb2dpY2FsV2lkdGggKyBtc2cud2lkdGggKyB0aGlzLmNvbmZpZy5leGl0UGFkZGluZ1B4OwogICAgICAgIGR1cmF0aW9uID0gY29tcHV0ZVNjcm9sbER1cmF0aW9uKAogICAgICAgICAgdG90YWxEaXN0YW5jZSwKICAgICAgICAgIHNwZWVkLAogICAgICAgICAgdGhpcy5jb25maWcuc2Nyb2xsRHVyYXRpb25NaW5NcywKICAgICAgICAgIHRoaXMuY29uZmlnLnNjcm9sbER1cmF0aW9uTWF4TXMsCiAgICAgICAgICB0aGlzLmNvbmZpZy5leGl0UGFkZGluZ1B4CiAgICAgICAgKTsKICAgICAgfQogICAgICBpZiAobXNnLmF1dGhvclR5cGUgPT09ICdtb2RlcmF0b3InIHx8IG1zZy5hdXRob3JUeXBlID09PSAnb3duZXInKSB7CiAgICAgICAgZHVyYXRpb24gKj0gdGhpcy5jb25maWcubW9kT3duZXJEdXJhdGlvbk11bHRpcGxpZXI7CiAgICAgIH0KICAgICAgbXNnLmR1cmF0aW9uID0gZHVyYXRpb247CiAgICAgIG1zZy5pbnZEdXJhdGlvbiA9IDEgLyBNYXRoLm1heCgxLCBkdXJhdGlvbik7CiAgICAgIG1zZy5zdGFydFRpbWUgPSBub3cgLSBtc2cucGF1c2VkRHVyYXRpb24gLSBwcm9ncmVzcyAqIGR1cmF0aW9uOwogICAgICBpZiAoaXNTY3JvbGxpbmcpIHsKICAgICAgICBpZiAodGhpcy5jb25maWcuZGFubWFrdU1vZGUgPT09ICdzY3JvbGwnKSB7CiAgICAgICAgICBtc2cuc3RhcnRYID0gdGhpcy5sb2dpY2FsV2lkdGg7CiAgICAgICAgICBtc2cueCA9IG1zZy5zdGFydFggLSBwcm9ncmVzcyAqIChtc2cuc3RhcnRYICsgbXNnLndpZHRoICsgdGhpcy5jb25maWcuZXhpdFBhZGRpbmdQeCk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIG1zZy5zdGFydFggPSAtbXNnLndpZHRoOwogICAgICAgICAgbXNnLnggPQogICAgICAgICAgICBtc2cuc3RhcnRYICsgcHJvZ3Jlc3MgKiAodGhpcy5sb2dpY2FsV2lkdGggLSBtc2cuc3RhcnRYICsgdGhpcy5jb25maWcuZXhpdFBhZGRpbmdQeCk7CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIG1zZy54ID0gKHRoaXMubG9naWNhbFdpZHRoIC0gbXNnLndpZHRoKSAvIDI7CiAgICAgIH0KCiAgICAgIGFkZE1lc3NhZ2VUb0xhbmVJbmRleCh0aGlzLmFjdGl2ZU1lc3NhZ2VzQnlMYW5lLCBtc2csIHNsb3RDb3VudCk7CgogICAgICBjb25zdCByZW1haW5pbmdEdXJhdGlvbiA9IE1hdGgubWF4KDEsIGR1cmF0aW9uICogKDEgLSBwcm9ncmVzcykpOwogICAgICB0aGlzLmNvbW1pdFBsYWNlbWVudCgKICAgICAgICBsYW5lSW5kZXgsCiAgICAgICAgc2xvdENvdW50LAogICAgICAgIG5vdywKICAgICAgICByZW1haW5pbmdEdXJhdGlvbiwKICAgICAgICBtc2cuc3BlZWRUaWVyLAogICAgICAgIGlzU2Nyb2xsaW5nID8gbXNnLndpZHRoIDogdW5kZWZpbmVkCiAgICAgICk7CiAgICB9CiAgfQoKICBwcml2YXRlIGluaXRMYW5lcyhfd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIpOiB2b2lkIHsKICAgIGlmICghdGhpcy5jb25maWcgfHwgIXRoaXMuY3R4KSByZXR1cm47CiAgICBjb25zdCB0ZXh0SGVpZ2h0ID0gdGhpcy5tZWFzdXJlVGV4dEhlaWdodCh0aGlzLmdldEVmZmVjdGl2ZUZvbnRTaXplKCkpOwogICAgY29uc3QgcmF3TGFuZUhlaWdodCA9IE1hdGgubWF4KDEsIHRleHRIZWlnaHQgKyB0aGlzLmNvbmZpZy5sYW5lU3BhY2luZyk7CiAgICB0aGlzLmxhbmVIZWlnaHQgPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKHJhd0xhbmVIZWlnaHQgKiB0aGlzLmxhbmVEZW5zaXR5RmFjdG9yKSk7CiAgICBjb25zdCB1c2FibGVIZWlnaHQgPSBoZWlnaHQgKiAoMSAtIHRoaXMuY29uZmlnLnNhZmVUb3AgLSB0aGlzLmNvbmZpZy5zYWZlQm90dG9tKTsKICAgIHRoaXMubnVtTGFuZXMgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHVzYWJsZUhlaWdodCAvIHRoaXMubGFuZUhlaWdodCkpOwogICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgICB0aGlzLmxhbmVIZWFwID0gYnVpbGRMYW5lSGVhcCh0aGlzLm51bUxhbmVzLCBub3csIHRoaXMubGFuZUluZGV4VG9IZWFwSW5kZXgpOwogICAgdGhpcy5zcGVlZFRpZXJMYW5lcy5jbGVhcigpOwogIH0KCiAgcHJpdmF0ZSBzdGF0aWMgcmVzZXRCYXRjaChzdGF0ZTogTGFuZUFsbG9jYXRpb25TdGF0ZSwgbm93OiBudW1iZXIpOiB2b2lkIHsKICAgIHJlc2V0QmF0Y2hTaGFyZWQoc3RhdGUsIG5vdyk7CiAgfQoKICBwcml2YXRlIGZpbmRQbGFjZW1lbnQoCiAgICBtc2dIZWlnaHQ6IG51bWJlciwKICAgIHNwZWVkVGllcjogbnVtYmVyLAogICAgbm93OiBudW1iZXIKICApOiB7CiAgICBsYW5lSW5kZXg6IG51bWJlcjsKICAgIHdhaXRNczogbnVtYmVyOwogICAgbGFuZVk6IG51bWJlcjsKICAgIHNsb3RDb3VudDogbnVtYmVyOwogICAgdmVydGljYWxPZmZzZXQ6IG51bWJlcjsKICB9IHwgbnVsbCB7CiAgICBpZiAodGhpcy5sYW5lSGVhcC5sZW5ndGggPT09IDApIHJldHVybiBudWxsOwogICAgY29uc3QgbWF4V2FpdE1zID0gdGhpcy5jb25maWc/LnNjcm9sbER1cmF0aW9uTWF4TXMgPz8gREVGQVVMVF9TRVRUSU5HUy5zY3JvbGxEdXJhdGlvbk1heE1zOwogICAgY29uc3QgcmVzdWx0ID0gZmluZFBsYWNlbWVudFNoYXJlZCgKICAgICAgdGhpcy5sYW5lU3RhdGUsCiAgICAgIG5vdywKICAgICAgbXNnSGVpZ2h0LAogICAgICB0aGlzLmxhbmVIZWlnaHQsCiAgICAgIG1heFdhaXRNcywKICAgICAgc3BlZWRUaWVyCiAgICApOwogICAgaWYgKCFyZXN1bHQpIHJldHVybiBudWxsOwogICAgY29uc3Qgc2xvdENvdW50ID0gTWF0aC5tYXgoMSwgTWF0aC5jZWlsKG1zZ0hlaWdodCAvIHRoaXMubGFuZUhlaWdodCkpOwogICAgY29uc3QgbGFuZVkgPSBjb21wdXRlTGFuZVkoCiAgICAgIHJlc3VsdC5sYW5lSW5kZXgsCiAgICAgIHRoaXMubG9naWNhbEhlaWdodCwKICAgICAgdGhpcy5jb25maWc/LnNhZmVUb3AgPz8gMCwKICAgICAgdGhpcy5sYW5lSGVpZ2h0CiAgICApOwogICAgY29uc3QgdmVydGljYWxPZmZzZXQgPSBNYXRoLmZsb29yKChzbG90Q291bnQgKiB0aGlzLmxhbmVIZWlnaHQgLSBtc2dIZWlnaHQpIC8gMik7CiAgICByZXR1cm4geyAuLi5yZXN1bHQsIGxhbmVZLCBzbG90Q291bnQsIHZlcnRpY2FsT2Zmc2V0IH07CiAgfQoKICBwcml2YXRlIGNvbW1pdFBsYWNlbWVudCgKICAgIGxhbmVJbmRleDogbnVtYmVyLAogICAgc2xvdENvdW50OiBudW1iZXIsCiAgICBzdGFydFRpbWU6IG51bWJlciwKICAgIGR1cmF0aW9uTXM6IG51bWJlciwKICAgIHNwZWVkVGllcjogbnVtYmVyLAogICAgbXNnV2lkdGg/OiBudW1iZXIKICApOiB2b2lkIHsKICAgIGlmICghdGhpcy5jb25maWcpIHJldHVybjsKICAgIGNvbnN0IHNjcmVlbldpZHRoID0gdGhpcy5sb2dpY2FsV2lkdGggfHwgMTkyMDsKICAgIGNvbnN0IG9jY3VwYW5jeU1zID0gY29tcHV0ZU9jY3VwYW5jeU1zU2hhcmVkKAogICAgICBkdXJhdGlvbk1zLAogICAgICB0aGlzLmNvbmZpZy5leGl0UGFkZGluZ1B4LAogICAgICB0aGlzLmNvbmZpZy5oZWFkd2F5R2FwUmF0aW8sCiAgICAgIG1zZ1dpZHRoLAogICAgICBzY3JlZW5XaWR0aAogICAgKTsKICAgIGNvbW1pdFBsYWNlbWVudFNoYXJlZCgKICAgICAgdGhpcy5sYW5lU3RhdGUsCiAgICAgIGxhbmVJbmRleCwKICAgICAgc2xvdENvdW50LAogICAgICBzdGFydFRpbWUsCiAgICAgIG9jY3VwYW5jeU1zLAogICAgICBkdXJhdGlvbk1zLAogICAgICBzcGVlZFRpZXIKICAgICk7CiAgfQoKICBwcml2YXRlIHN0YXRpYyBzaGlmdExhbmVUaW1lcnMoc3RhdGU6IExhbmVBbGxvY2F0aW9uU3RhdGUsIG1zOiBudW1iZXIpOiB2b2lkIHsKICAgIHNoaWZ0TGFuZVRpbWVyc1NoYXJlZChzdGF0ZSwgbXMpOwogIH0KCiAgcHJpdmF0ZSBhY3RpdmF0ZU1lc3NhZ2UoCiAgICBtc2c6IFdvcmtlck1lc3NhZ2UsCiAgICBub3c6IG51bWJlciwKICAgIHBsYWNlbWVudDogewogICAgICBsYW5lSW5kZXg6IG51bWJlcjsKICAgICAgd2FpdE1zOiBudW1iZXI7CiAgICAgIGxhbmVZOiBudW1iZXI7CiAgICAgIHNsb3RDb3VudDogbnVtYmVyOwogICAgICB2ZXJ0aWNhbE9mZnNldDogbnVtYmVyOwogICAgfSwKICAgIGJhdGNoSW5kZXg6IG51bWJlciwKICAgIHNwZWVkVGllcjogbnVtYmVyLAogICAgc2NyZWVuV2lkdGg6IG51bWJlciwKICAgIF9zY3JlZW5IZWlnaHQ6IG51bWJlcgogICk6IHZvaWQgewogICAgaWYgKCF0aGlzLmNvbmZpZykgcmV0dXJuOwogICAgY29uc3QgbW9kZSA9IHRoaXMuY29uZmlnLmRhbm1ha3VNb2RlOwogICAgY29uc3QgaXNTY3JvbGxpbmcgPSBtb2RlID09PSAnc2Nyb2xsJyB8fCBtb2RlID09PSAncmV2ZXJzZSc7CiAgICBsZXQgc3BlZWQgPSB0aGlzLmNvbmZpZy5zcGVlZFB4UGVyU2VjOwogICAgaWYgKG1zZy5idXJzdFNwZWVkTXVsdGlwbGllciAmJiBtc2cuYnVyc3RTcGVlZE11bHRpcGxpZXIgPiAxKSBzcGVlZCAqPSBtc2cuYnVyc3RTcGVlZE11bHRpcGxpZXI7CiAgICBzd2l0Y2ggKHNwZWVkVGllcikgewogICAgICBjYXNlIFNQRUVEX1RJRVIuRkFSOgogICAgICAgIHNwZWVkID0gTWF0aC5tYXgoMzAsIHNwZWVkICogdGhpcy5jb25maWcuZGVwdGhGYXJTcGVlZE11bCk7CiAgICAgICAgYnJlYWs7CiAgICAgIGNhc2UgU1BFRURfVElFUi5ORUFSOgogICAgICAgIHNwZWVkICo9IHRoaXMuY29uZmlnLmRlcHRoTmVhclNwZWVkTXVsOwogICAgICAgIGJyZWFrOwogICAgICBjYXNlIFNQRUVEX1RJRVIuQkFDS0xPRzoKICAgICAgICBzcGVlZCAqPSB0aGlzLmNvbmZpZy5iYWNrbG9nU3BlZWRNdWx0aXBsaWVyOwogICAgICAgIGJyZWFrOwogICAgfQogICAgY29uc3QgcGVuZGluZ0NvdW50ID0gdGhpcy5wZW5kaW5nUXVldWUubGVuZ3RoOwogICAgbGV0IGVmZmVjdGl2ZU1heFN0YWdnZXIgPSB0aGlzLmNvbmZpZy5zdGFnZ2VyTWF4RGVsYXlNczsKICAgIGlmIChwZW5kaW5nQ291bnQgPiBTVEFHR0VSX1FVRVVFX0hJR0gpIGVmZmVjdGl2ZU1heFN0YWdnZXIgPSAwOwogICAgZWxzZSBpZiAocGVuZGluZ0NvdW50ID4gU1RBR0dFUl9RVUVVRV9NRUQpCiAgICAgIGVmZmVjdGl2ZU1heFN0YWdnZXIgPSB0aGlzLmNvbmZpZy5zdGFnZ2VyTWVkaXVtRGVsYXlNczsKICAgIGxldCBzdGFnZ2VyRGVsYXkgPSAwOwogICAgaWYgKGJhdGNoSW5kZXggPiAwICYmIGlzU2Nyb2xsaW5nKSB7CiAgICAgIGNvbnN0IHN0YWdnZXJlZElkeCA9IE1hdGgubWluKGJhdGNoSW5kZXgsIFNUQUdHRVJfQkFUQ0hfTUFYKTsKICAgICAgc3RhZ2dlckRlbGF5ID0gTWF0aC5yb3VuZCgKICAgICAgICBNYXRoLm1pbigKICAgICAgICAgIGVmZmVjdGl2ZU1heFN0YWdnZXIsCiAgICAgICAgICBzdGFnZ2VyZWRJZHggKgogICAgICAgICAgICBTVEFHR0VSX0VYUF9TQ0FMRSAqCiAgICAgICAgICAgIFdvcmtlclJlbmRlcmVyLlNUQUdHRVJfRVhQX1RBQkxFWyhmYXN0UmFuZG9tKCkgKiAyNTYpID4+PiAwXSEKICAgICAgICApCiAgICAgICk7CiAgICB9CiAgICBjb25zdCBob3Jpem9udGFsU3RhZ2dlciA9CiAgICAgIGlzU2Nyb2xsaW5nICYmIGJhdGNoSW5kZXggPiAwCiAgICAgICAgPyBNYXRoLm1pbihIT1JJWk9OVEFMX1NUQUdHRVJfTUFYLCBiYXRjaEluZGV4ICogSE9SSVpPTlRBTF9TVEFHR0VSX1BFUl9TVEVQKQogICAgICAgIDogMDsKICAgIGxldCBzdGFydFg6IG51bWJlcjsKICAgIGlmIChtb2RlID09PSAnc2Nyb2xsJykgc3RhcnRYID0gc2NyZWVuV2lkdGggKyBob3Jpem9udGFsU3RhZ2dlcjsKICAgIGVsc2UgaWYgKG1vZGUgPT09ICdyZXZlcnNlJykgc3RhcnRYID0gLShtc2cud2lkdGggKyBob3Jpem9udGFsU3RhZ2dlcik7CiAgICBlbHNlIHN0YXJ0WCA9IChzY3JlZW5XaWR0aCAtIG1zZy53aWR0aCkgLyAyOwogICAgbGV0IGR1cmF0aW9uOiBudW1iZXI7CiAgICBpZiAoaXNTY3JvbGxpbmcpIHsKICAgICAgY29uc3QgdG90YWxEaXN0YW5jZSA9CiAgICAgICAgbW9kZSA9PT0gJ3Njcm9sbCcKICAgICAgICAgID8gc3RhcnRYICsgbXNnLndpZHRoICsgdGhpcy5jb25maWcuZXhpdFBhZGRpbmdQeAogICAgICAgICAgOiBzY3JlZW5XaWR0aCAtIHN0YXJ0WCArIHRoaXMuY29uZmlnLmV4aXRQYWRkaW5nUHg7CiAgICAgIGR1cmF0aW9uID0KICAgICAgICBzcGVlZCA+IDAKICAgICAgICAgID8gY29tcHV0ZVNjcm9sbER1cmF0aW9uKAogICAgICAgICAgICAgIHRvdGFsRGlzdGFuY2UsCiAgICAgICAgICAgICAgc3BlZWQsCiAgICAgICAgICAgICAgdGhpcy5jb25maWcuc2Nyb2xsRHVyYXRpb25NaW5NcywKICAgICAgICAgICAgICB0aGlzLmNvbmZpZy5zY3JvbGxEdXJhdGlvbk1heE1zLAogICAgICAgICAgICAgIHRoaXMuY29uZmlnLmV4aXRQYWRkaW5nUHgKICAgICAgICAgICAgKQogICAgICAgICAgOiB0aGlzLmNvbmZpZy5zY3JvbGxEdXJhdGlvbk1pbk1zOwogICAgfSBlbHNlIHsKICAgICAgZHVyYXRpb24gPSB0aGlzLmNvbmZpZy50b3BCb3R0b21EdXJhdGlvbk1zOwogICAgfQogICAgaWYgKG1zZy5hdXRob3JUeXBlID09PSAnbW9kZXJhdG9yJyB8fCBtc2cuYXV0aG9yVHlwZSA9PT0gJ293bmVyJykKICAgICAgZHVyYXRpb24gKj0gdGhpcy5jb25maWcubW9kT3duZXJEdXJhdGlvbk11bHRpcGxpZXI7CiAgICBjb25zdCBzbG90Q291bnQgPSBwbGFjZW1lbnQuc2xvdENvdW50OwogICAgY29uc3QgbGFuZVkgPSBwbGFjZW1lbnQubGFuZVkgKyBwbGFjZW1lbnQudmVydGljYWxPZmZzZXQ7CiAgICBjb25zdCBlZmZlY3RpdmVTdGFydFRpbWUgPSBub3cgKyBzdGFnZ2VyRGVsYXkgKyBwbGFjZW1lbnQud2FpdE1zOwogICAgY29uc3QgYXV0aG9yQ29sb3IgPQogICAgICB0aGlzLmNvbmZpZy5wcmVzZXJ2ZVVzZXJDb2xvciAmJiBtc2cudXNlckNvbG9yCiAgICAgICAgPyBtc2cudXNlckNvbG9yCiAgICAgICAgOiAobXNnLmF1dGhvclR5cGUgJiYgdGhpcy5jb25maWcuYXV0aG9yQ29sb3JzW21zZy5hdXRob3JUeXBlXSkgfHwKICAgICAgICAgIHRoaXMuY29uZmlnLmNvbG9yIHx8CiAgICAgICAgICBERUZBVUxUX1RFWFRfQ09MT1I7CiAgICBjb25zdCBhbTogQWN0aXZlTWVzc2FnZSA9IHsKICAgICAgaWQ6IG1zZy5pZCwKICAgICAgeDogc3RhcnRYLAogICAgICB5OiBsYW5lWSwKICAgICAgc3RhcnRYLAogICAgICB3aWR0aDogbXNnLndpZHRoLAogICAgICBoZWlnaHQ6IG1zZy5oZWlnaHQsCiAgICAgIGZhZGVTdGFydFRpbWU6IGVmZmVjdGl2ZVN0YXJ0VGltZSwKICAgICAgc3RhcnRUaW1lOiBlZmZlY3RpdmVTdGFydFRpbWUsCiAgICAgIGR1cmF0aW9uLAogICAgICBpbnZEdXJhdGlvbjogMSAvIE1hdGgubWF4KDEsIGR1cmF0aW9uKSwKICAgICAgcGF1c2VkRHVyYXRpb246IDAsCiAgICAgIGxhbmVJbmRleDogcGxhY2VtZW50LmxhbmVJbmRleCwKICAgICAgbGFuZVNsb3RDb3VudDogc2xvdENvdW50LAogICAgICBsYW5lQXJyYXlJbmRpY2VzOiBbXSwKICAgICAgc3BlZWRUaWVyLAogICAgICB0ZXh0OiBtc2cudGV4dCwKICAgICAgY29sb3I6IGF1dGhvckNvbG9yLAogICAgICBnaG9zdFRleHQ6IGdldERpc3BsYXlUZXh0KG1zZy5jb250ZW50ID8/IFtdKSwKICAgICAgY29udGVudDogbXNnLmNvbnRlbnQgPz8gW10sCiAgICB9OwogICAgaWYgKG1zZy5hdXRob3JUeXBlICE9PSB1bmRlZmluZWQpIGFtLmF1dGhvclR5cGUgPSBtc2cuYXV0aG9yVHlwZTsKICAgIGlmIChtc2cua2luZCAhPT0gdW5kZWZpbmVkKSBhbS5raW5kID0gbXNnLmtpbmQ7CiAgICBpZiAobXNnLnRyYW5zbGF0ZWRUZXh0ICE9PSB1bmRlZmluZWQpIHsKICAgICAgYW0udHJhbnNsYXRlZFRleHQgPSBtc2cudHJhbnNsYXRlZFRleHQ7CiAgICAgIGlmIChtc2cudHJhbnNsYXRlZFRleHQpIHsKICAgICAgICBhbS50cmFuc2xhdGVkQ29udGVudCA9IFt7IHR5cGU6ICd0ZXh0JywgY29udGVudDogbXNnLnRyYW5zbGF0ZWRUZXh0IH1dOwogICAgICB9CiAgICB9CiAgICBpZiAobXNnLmF1dGhvciAhPT0gdW5kZWZpbmVkKSBhbS5hdXRob3IgPSBtc2cuYXV0aG9yOwogICAgaWYgKG1zZy5hdXRob3JQaG90b1VybCAhPT0gdW5kZWZpbmVkKSBhbS5hdXRob3JQaG90b1VybCA9IG1zZy5hdXRob3JQaG90b1VybDsKICAgIGlmIChtc2cuc3VwZXJDaGF0QW1vdW50ICE9PSB1bmRlZmluZWQpIGFtLnN1cGVyQ2hhdEFtb3VudCA9IG1zZy5zdXBlckNoYXRBbW91bnQ7CiAgICBpZiAobXNnLnN1cGVyQ2hhdFN0aWNrZXJVcmwgIT09IHVuZGVmaW5lZCkgYW0uc3VwZXJDaGF0U3RpY2tlclVybCA9IG1zZy5zdXBlckNoYXRTdGlja2VyVXJsOwogICAgaWYgKG1zZy5tZW1iZXJzaGlwSGVhZGVyICE9PSB1bmRlZmluZWQpIGFtLm1lbWJlcnNoaXBIZWFkZXIgPSBtc2cubWVtYmVyc2hpcEhlYWRlcjsKICAgIGlmIChtc2cuY2FyZENvbmZpZ1dvcmtlciAhPT0gdW5kZWZpbmVkKSBhbS5jYXJkQ29uZmlnV29ya2VyID0gbXNnLmNhcmRDb25maWdXb3JrZXI7CiAgICB0aGlzLmNvbW1pdFBsYWNlbWVudCgKICAgICAgcGxhY2VtZW50LmxhbmVJbmRleCwKICAgICAgc2xvdENvdW50LAogICAgICBlZmZlY3RpdmVTdGFydFRpbWUsCiAgICAgIGR1cmF0aW9uLAogICAgICBzcGVlZFRpZXIsCiAgICAgIGlzU2Nyb2xsaW5nID8gbXNnLndpZHRoIDogdW5kZWZpbmVkCiAgICApOwogICAgdGhpcy5hY3RpdmVNZXNzYWdlcy5wdXNoKGFtKTsKICAgIC8vIFJlZ2lzdGVyIGluIHBlci1sYW5lIGluZGV4IGZvciBPKGxhbmVzKSBjb2xsaXNpb24gY2hlY2tzIChJc3N1ZSA3KS4KICAgIGFkZE1lc3NhZ2VUb0xhbmVJbmRleCh0aGlzLmFjdGl2ZU1lc3NhZ2VzQnlMYW5lLCBhbSwgc2xvdENvdW50KTsKICAgIHRoaXMubWVzc2FnZUJ5SWQuc2V0KG1zZy5pZCwgYW0pOwogICAgaWYgKG1zZy5jb250ZW50KSB7CiAgICAgIGNvbnN0IGVtb2ppVXJsczogc3RyaW5nW10gPSBbXTsKICAgICAgZm9yIChjb25zdCBzZWcgb2YgbXNnLmNvbnRlbnQpIHsKICAgICAgICBpZiAoc2VnLnR5cGUgPT09ICdlbW9qaScgJiYgc2VnLmVtb2ppVXJsKSBlbW9qaVVybHMucHVzaChzZWcuZW1vamlVcmwpOwogICAgICB9CiAgICAgIGlmIChlbW9qaVVybHMubGVuZ3RoID4gMCkgdm9pZCB0aGlzLnByZWZldGNoSW1hZ2VzKGVtb2ppVXJscywgdGhpcy5lbW9qaUNhY2hlKTsKICAgIH0KICAgIGlmIChtc2cuYXV0aG9yUGhvdG9VcmwpIHZvaWQgdGhpcy5wcmVmZXRjaEltYWdlcyhbbXNnLmF1dGhvclBob3RvVXJsXSwgdGhpcy5hdXRob3JQaG90b0NhY2hlKTsKICAgIGlmIChtc2cuc3VwZXJDaGF0U3RpY2tlclVybCkKICAgICAgdm9pZCB0aGlzLnByZWZldGNoSW1hZ2VzKFttc2cuc3VwZXJDaGF0U3RpY2tlclVybF0sIHRoaXMuc3RpY2tlckNhY2hlKTsKICB9CgogIHByaXZhdGUgcmVuZGVyRnJhbWUoKTogdm9pZCB7CiAgICBpZiAoIXRoaXMuY3R4IHx8ICF0aGlzLmNhbnZhcyB8fCAhdGhpcy5jb25maWcgfHwgdGhpcy5pc1BhdXNlZCB8fCB0aGlzLmlzVXNlclBhdXNlZCkgcmV0dXJuOwoKICAgIC8vIERldGVjdCBPZmZzY3JlZW5DYW52YXMgY29udGV4dCBsb3NzIChHUFUgZHJpdmVyIHJlc2V0LCBldGMuKS4KICAgIC8vIFNpZ25hbCB0aGUgbWFpbiB0aHJlYWQgc28gaXQgY2FuIGZhbGwgYmFjayB0byBtYWluLXRocmVhZCByZW5kZXJpbmcuCiAgICAvLyBPZmZzY3JlZW5DYW52YXNSZW5kZXJpbmdDb250ZXh0MkQuaXNDb250ZXh0TG9zdCgpIGlzIGF2YWlsYWJsZSBpbgogICAgLy8gQ2hyb21lIDEzMCsgYW5kIEZpcmVmb3ggMTM1Ky4KICAgIHRyeSB7CiAgICAgIGlmICh0eXBlb2YgdGhpcy5jdHguaXNDb250ZXh0TG9zdCA9PT0gJ2Z1bmN0aW9uJyAmJiB0aGlzLmN0eC5pc0NvbnRleHRMb3N0KCkpIHsKICAgICAgICBzZWxmLnBvc3RNZXNzYWdlKHsgdHlwZTogJ2NvbnRleHRMb3N0JyB9KTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgIH0gY2F0Y2ggewogICAgICBzZWxmLnBvc3RNZXNzYWdlKHsgdHlwZTogJ2NvbnRleHRMb3N0JyB9KTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IGNmZyA9IHRoaXMuY29uZmlnOwogICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgICBjb25zdCB3aWR0aCA9IHRoaXMubG9naWNhbFdpZHRoOwogICAgY29uc3QgaGVpZ2h0ID0gdGhpcy5sb2dpY2FsSGVpZ2h0OwogICAgLy8gQW50aS1ibG9jayBnYXRlOiBjaGVjayBpZiBkcmFpblF1ZXVlIHNob3VsZCBydW4KICAgIGxldCBzaG91bGREcmFpbiA9IHRydWU7CiAgICBpZiAodGhpcy5wZW5kaW5nUXVldWUubGVuZ3RoID4gMCkgewogICAgICBsZXQgb2NjdXBpZWRDb3VudCA9IDA7CiAgICAgIGZvciAobGV0IGggPSAwOyBoIDwgdGhpcy5sYW5lSGVhcC5sZW5ndGg7IGgrKykgewogICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5sYW5lSGVhcFtoXTsKICAgICAgICBpZiAoZW50cnkgJiYgZW50cnlbMV0gPiBub3cpIG9jY3VwaWVkQ291bnQrKzsKICAgICAgfQogICAgICBjb25zdCBsYW5lVXRpbGl6YXRpb24gPSBvY2N1cGllZENvdW50IC8gTWF0aC5tYXgoMSwgdGhpcy5udW1MYW5lcyk7CiAgICAgIGlmIChsYW5lVXRpbGl6YXRpb24gPj0gMSAtIEFOVElfQkxPQ0tfRlJFRV9SQVRJTykgewogICAgICAgIGlmICghY2ZnLmlzUmVwbGF5TW9kZSkgewogICAgICAgICAgaWYgKHRoaXMuYW50aUJsb2NrU3RhcnRUaW1lID09PSAwKSB7CiAgICAgICAgICAgIHRoaXMuYW50aUJsb2NrU3RhcnRUaW1lID0gbm93OwogICAgICAgICAgfQogICAgICAgICAgY29uc3QgZnJvbnQgPSB0aGlzLnBlbmRpbmdRdWV1ZVswXTsKICAgICAgICAgIGNvbnN0IGZvcmNlRHJhaW4gPSBub3cgLSB0aGlzLmFudGlCbG9ja1N0YXJ0VGltZSA+PSBBTlRJX0JMT0NLX01BWF9EVVJBVElPTl9NUzsKICAgICAgICAgIGlmIChmb3JjZURyYWluKSB7CiAgICAgICAgICAgIHRoaXMuYW50aUJsb2NrU3RhcnRUaW1lID0gbm93OwogICAgICAgICAgfQogICAgICAgICAgY29uc3QgaGlnaFByaW9yaXR5RnJvbnQgPSBmcm9udCA/IGZyb250LnByaW9yaXR5ID49IEFOVElfQkxPQ0tfUFJJT1JJVFlfVEhSRVNIT0xEIDogZmFsc2U7CiAgICAgICAgICBzaG91bGREcmFpbiA9IGZvcmNlRHJhaW4gfHwgaGlnaFByaW9yaXR5RnJvbnQ7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIHRoaXMuYW50aUJsb2NrU3RhcnRUaW1lID0gMDsKICAgICAgICB9CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdGhpcy5hbnRpQmxvY2tTdGFydFRpbWUgPSAwOwogICAgICB9CiAgICB9CiAgICBpZiAoc2hvdWxkRHJhaW4pIHsKICAgICAgV29ya2VyUmVuZGVyZXIucmVzZXRCYXRjaCh0aGlzLmxhbmVTdGF0ZSwgbm93KTsKICAgICAgdGhpcy5kcmFpblF1ZXVlKG5vdywgd2lkdGgsIGhlaWdodCk7CiAgICB9CiAgICAvLyDilIDilIAgTWVyZ2VkIGNsZWFudXAgKyBwcmUtc2NhbiAoc2luZ2xlIHBhc3MpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAogICAgZm9yIChjb25zdCBidWNrZXQgb2YgdGhpcy5mYXJPcGFjaXR5QnVja2V0cykgYnVja2V0Lmxlbmd0aCA9IDA7CiAgICBmb3IgKGNvbnN0IGJ1Y2tldCBvZiB0aGlzLm1pZE9wYWNpdHlCdWNrZXRzKSBidWNrZXQubGVuZ3RoID0gMDsKICAgIGZvciAoY29uc3QgYnVja2V0IG9mIHRoaXMubmVhck9wYWNpdHlCdWNrZXRzKSBidWNrZXQubGVuZ3RoID0gMDsKICAgIGNvbnN0IG1vZGUgPSB0aGlzLmNvbmZpZy5kYW5tYWt1TW9kZTsKICAgIGNvbnN0IGlzU2Nyb2xsaW5nID0gbW9kZSA9PT0gJ3Njcm9sbCcgfHwgbW9kZSA9PT0gJ3JldmVyc2UnOwogICAgY29uc3Qgc3Ryb2tlV2lkdGggPQogICAgICB0aGlzLmNvbmZpZy5vdXRsaW5lV2lkdGhQeCA+IDAgJiYgdGhpcy5jb25maWcub3V0bGluZU9wYWNpdHkgPiAwCiAgICAgICAgPyB0aGlzLmNvbmZpZy5vdXRsaW5lV2lkdGhQeAogICAgICAgIDogMDsKICAgIGxldCB3cml0ZUlkeCA9IDA7CiAgICB0aGlzLmV4cGlyZWRNZXNzYWdlc1NjcmF0Y2gubGVuZ3RoID0gMDsKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5hY3RpdmVNZXNzYWdlcy5sZW5ndGg7IGkrKykgewogICAgICBjb25zdCBtc2cgPSB0aGlzLmFjdGl2ZU1lc3NhZ2VzW2ldOwogICAgICBpZiAoIW1zZykgY29udGludWU7CiAgICAgIGNvbnN0IGVsYXBzZWQgPSBub3cgLSBtc2cuc3RhcnRUaW1lIC0gbXNnLnBhdXNlZER1cmF0aW9uOwogICAgICAvLyBFeHBpcmVkOiByZW1vdmUgdmlhIHNraXAgKGRvbid0IHdyaXRlIHRvIHdyaXRlSWR4IHBvc2l0aW9uKQogICAgICBpZiAoZWxhcHNlZCA+PSBtc2cuZHVyYXRpb24pIHsKICAgICAgICB0aGlzLm1lc3NhZ2VCeUlkLmRlbGV0ZShtc2cuaWQpOwogICAgICAgIHRoaXMuZXhwaXJlZE1lc3NhZ2VzU2NyYXRjaC5wdXNoKG1zZyk7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgLy8gS2VlcCBtZXNzYWdlIChpbi1wbGFjZSBjb21wYWN0aW9uKQogICAgICB0aGlzLmFjdGl2ZU1lc3NhZ2VzW3dyaXRlSWR4KytdID0gbXNnOwogICAgICAvLyBTdGlsbCBpbiBzdGFnZ2VyIGRlbGF5IOKAlCBrZWVwIGJ1dCBza2lwIHJlbmRlcmluZwogICAgICBpZiAoZWxhcHNlZCA8IDApIGNvbnRpbnVlOwogICAgICAvLyDilIDilIAgUmVuZGVyIHByZS1jb21wdXRlIOKUgOKUgAogICAgICAvLyBTYXZlIHByZXZpb3VzIHBvc2l0aW9uIGZvciB0ZW1wb3JhbCBmcmFtZSBibGVuZGluZyAoRkFSLXRpZXIgbW90aW9uIGJsdXIpCiAgICAgIGlmIChtc2cuc3BlZWRUaWVyID09PSBTUEVFRF9USUVSLkZBUikgewogICAgICAgIG1zZy5fcHJldlggPSBtc2cueDsKICAgICAgICBtc2cuX3ByZXZZID0gbXNnLnk7CiAgICAgIH0KICAgICAgY29uc3QgcHJvZ3Jlc3MgPSBNYXRoLm1pbigxLCBNYXRoLm1heCgwLCBlbGFwc2VkICogbXNnLmludkR1cmF0aW9uKSk7CiAgICAgIGNvbnN0IGlzUmVkdWNlZE1vdGlvbkFjdGl2ZSA9IHRoaXMuY29uZmlnLnJlZHVjZWRNb3Rpb24gJiYgIXRoaXMuY29uZmlnLmlnbm9yZVJlZHVjZWRNb3Rpb247CiAgICAgIGlmIChtb2RlID09PSAnc2Nyb2xsJykgewogICAgICAgIGlmICghaXNSZWR1Y2VkTW90aW9uQWN0aXZlKSB7CiAgICAgICAgICBtc2cueCA9IG1zZy5zdGFydFggLSBwcm9ncmVzcyAqIChtc2cuc3RhcnRYICsgbXNnLndpZHRoICsgdGhpcy5jb25maWcuZXhpdFBhZGRpbmdQeCk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIG1zZy54ID0gTWF0aC5tYXgoMCwgKHRoaXMubG9naWNhbFdpZHRoIC0gbXNnLndpZHRoKSAvIDIpOwogICAgICAgIH0KICAgICAgfSBlbHNlIGlmIChtb2RlID09PSAncmV2ZXJzZScpIHsKICAgICAgICBpZiAoIWlzUmVkdWNlZE1vdGlvbkFjdGl2ZSkgewogICAgICAgICAgbXNnLnggPQogICAgICAgICAgICBtc2cuc3RhcnRYICsgcHJvZ3Jlc3MgKiAodGhpcy5sb2dpY2FsV2lkdGggLSBtc2cuc3RhcnRYICsgdGhpcy5jb25maWcuZXhpdFBhZGRpbmdQeCk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIG1zZy54ID0gTWF0aC5tYXgoMCwgKHRoaXMubG9naWNhbFdpZHRoIC0gbXNnLndpZHRoKSAvIDIpOwogICAgICAgIH0KICAgICAgfQogICAgICBjb25zdCBmYWRlRWxhcHNlZCA9IG5vdyAtIG1zZy5mYWRlU3RhcnRUaW1lIC0gbXNnLnBhdXNlZER1cmF0aW9uOwogICAgICBjb25zdCBvcGFjaXR5ID0gdGhpcy5vcGFjaXR5Q29uZmlnCiAgICAgICAgPyBjb21wdXRlTWVzc2FnZU9wYWNpdHkoCiAgICAgICAgICAgIG1zZy5zcGVlZFRpZXIgPT09IFNQRUVEX1RJRVIuQkFDS0xPRywKICAgICAgICAgICAgZmFkZUVsYXBzZWQsCiAgICAgICAgICAgIG1zZy5kdXJhdGlvbiwKICAgICAgICAgICAgaXNTY3JvbGxpbmcsCiAgICAgICAgICAgIG1zZy5zcGVlZFRpZXIsCiAgICAgICAgICAgIHRoaXMub3BhY2l0eUNvbmZpZwogICAgICAgICAgKQogICAgICAgIDogMDsKICAgICAgaWYgKG9wYWNpdHkgPD0gMCkgY29udGludWU7CiAgICAgIGNvbnN0IGJ1Y2tldEluZGV4ID0gTWF0aC5taW4oCiAgICAgICAgT1BBQ0lUWV9CVUNLRVRTIC0gMSwKICAgICAgICBNYXRoLnJvdW5kKG9wYWNpdHkgKiAoT1BBQ0lUWV9CVUNLRVRTIC0gMSkpCiAgICAgICk7CiAgICAgIG1zZy5fZnJhbWVFbGFwc2VkID0gZWxhcHNlZDsKICAgICAgLy8gUm91dGUgdG8gdGhlIGNvcnJlY3Qgc3BlZWQtdGllciBidWNrZXQgZm9yIHotb3JkZXIgcmVuZGVyaW5nCiAgICAgIGlmIChtc2cuc3BlZWRUaWVyID09PSBTUEVFRF9USUVSLkZBUikgewogICAgICAgIHRoaXMuZmFyT3BhY2l0eUJ1Y2tldHNbYnVja2V0SW5kZXhdPy5wdXNoKG1zZyk7CiAgICAgIH0gZWxzZSBpZiAobXNnLnNwZWVkVGllciA9PT0gU1BFRURfVElFUi5ORUFSKSB7CiAgICAgICAgdGhpcy5uZWFyT3BhY2l0eUJ1Y2tldHNbYnVja2V0SW5kZXhdPy5wdXNoKG1zZyk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdGhpcy5taWRPcGFjaXR5QnVja2V0c1tidWNrZXRJbmRleF0/LnB1c2gobXNnKTsKICAgICAgfQogICAgfQogICAgdGhpcy5hY3RpdmVNZXNzYWdlcy5sZW5ndGggPSB3cml0ZUlkeDsKICAgIGZvciAoY29uc3QgZXhwaXJlZCBvZiB0aGlzLmV4cGlyZWRNZXNzYWdlc1NjcmF0Y2gpIHsKICAgICAgcmVtb3ZlTWVzc2FnZUZyb21MYW5lSW5kZXgodGhpcy5hY3RpdmVNZXNzYWdlc0J5TGFuZSwgZXhwaXJlZCwgZXhwaXJlZC5sYW5lU2xvdENvdW50KTsKICAgIH0KICAgIC8vIOKUgOKUgCBDbGVhciBjYW52YXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACiAgICB0aGlzLmN0eC5jbGVhclJlY3QoMCwgMCwgdGhpcy5sb2dpY2FsV2lkdGgsIHRoaXMubG9naWNhbEhlaWdodCk7CiAgICBpZiAod3JpdGVJZHggPT09IDApIHsKICAgICAgdGhpcy5zdGF0c0ZyYW1lQ291bnRlcisrOwogICAgICBpZiAodGhpcy5zdGF0c0ZyYW1lQ291bnRlciA+PSA2MCkgewogICAgICAgIHRoaXMuc3RhdHNGcmFtZUNvdW50ZXIgPSAwOwogICAgICAgIHNlbGYucG9zdE1lc3NhZ2UoewogICAgICAgICAgdHlwZTogJ3N0YXRzJywKICAgICAgICAgIGFjdGl2ZU1lc3NhZ2VzOiAwLAogICAgICAgICAgZHJvcHM6IHRoaXMudG90YWxEcm9wcywKICAgICAgICAgIHBlbmRpbmdRdWV1ZURlcHRoOiB0aGlzLnBlbmRpbmdRdWV1ZS5sZW5ndGgsCiAgICAgICAgICBhY3RpdmVNZXNzYWdlSWRzOiBbXSwKICAgICAgICAgIHBlbmRpbmdNZXNzYWdlSWRzOiBbXSwKICAgICAgICB9KTsKICAgICAgfQogICAgICByZXR1cm47CiAgICB9CiAgICB0aGlzLmN0eC50ZXh0QmFzZWxpbmUgPSAndG9wJzsKICAgIGNvbnN0IGdldEZvbnQgPSB0aGlzLmJvdW5kR2V0Rm9udDsKICAgIC8vIFJlbmRlciBGQVIg4oaSIE1JRCDihpIgTkVBUiBmb3IgY29ycmVjdCB6LW9yZGVyCiAgICBmb3IgKGNvbnN0IHRpZXJCdWNrZXQgb2YgdGhpcy50aWVyT3BhY2l0eUJ1Y2tldHMpIHsKICAgICAgZm9yIChsZXQgYnVja2V0SW5kZXggPSAwOyBidWNrZXRJbmRleCA8IE9QQUNJVFlfQlVDS0VUUzsgYnVja2V0SW5kZXgrKykgewogICAgICAgIGNvbnN0IGVudHJpZXMgPSB0aWVyQnVja2V0W2J1Y2tldEluZGV4XTsKICAgICAgICBpZiAoIWVudHJpZXMgfHwgZW50cmllcy5sZW5ndGggPT09IDApIGNvbnRpbnVlOwogICAgICAgIHRoaXMuY3R4Lmdsb2JhbEFscGhhID0gYnVja2V0SW5kZXggLyAoT1BBQ0lUWV9CVUNLRVRTIC0gMSk7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGZvciAoY29uc3QgbXNnIG9mIGVudHJpZXMpIHsKICAgICAgICAgICAgbGV0IHJlbmRlckNvbG9yID0gbXNnLmNvbG9yT3ZlcnJpZGUgfHwgbXNnLmNvbG9yOwogICAgICAgICAgICBpZiAobXNnLnNwZWVkVGllciA9PT0gU1BFRURfVElFUi5GQVIgJiYgIW1zZy5jb2xvck92ZXJyaWRlKSB7CiAgICAgICAgICAgICAgcmVuZGVyQ29sb3IgPSBkZXNhdHVyYXRlQ29sb3IocmVuZGVyQ29sb3IsIEZBUl9MQVlFUl9ERVNBVFVSQVRJT05fRkFDVE9SKTsKICAgICAgICAgICAgICBtc2cuY29sb3JPdmVycmlkZSA9IHJlbmRlckNvbG9yOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGNvbnN0IHN4ID0gTWF0aC5mbG9vcihtc2cueCk7CiAgICAgICAgICAgIGlmIChzeCArIG1zZy53aWR0aCA8PSAwKSBjb250aW51ZTsKICAgICAgICAgICAgY29uc3Qgc3kgPSBNYXRoLmZsb29yKG1zZy55KTsKCiAgICAgICAgICAgIC8vIFRlbXBvcmFsIGZyYW1lIGJsZW5kaW5nOiByZW5kZXIgZ2hvc3QgYXQgcHJldmlvdXMgcG9zaXRpb24gZm9yIEZBUi10aWVyCiAgICAgICAgICAgIGlmICgKICAgICAgICAgICAgICB0aGlzLmNvbmZpZy5tb3Rpb25CbHVyRW5hYmxlZCAmJgogICAgICAgICAgICAgICEodGhpcy5jb25maWcucmVkdWNlZE1vdGlvbiAmJiAhdGhpcy5jb25maWcuaWdub3JlUmVkdWNlZE1vdGlvbikgJiYKICAgICAgICAgICAgICBtc2cuc3BlZWRUaWVyID09PSBTUEVFRF9USUVSLkZBUiAmJgogICAgICAgICAgICAgICFtc2cuY2FyZENvbmZpZ1dvcmtlciAmJgogICAgICAgICAgICAgIG1zZy5fcHJldlggIT09IHVuZGVmaW5lZCAmJgogICAgICAgICAgICAgIG1zZy5fcHJldlkgIT09IHVuZGVmaW5lZAogICAgICAgICAgICApIHsKICAgICAgICAgICAgICBjb25zdCBnaG9zdEFscGhhID0gdGhpcy5jdHguZ2xvYmFsQWxwaGEgKiB0aGlzLmNvbmZpZy5tb3Rpb25CbHVyQWxwaGE7CiAgICAgICAgICAgICAgaWYgKGdob3N0QWxwaGEgPiAwLjAwMSkgewogICAgICAgICAgICAgICAgdGhpcy5jdHguc2F2ZSgpOwogICAgICAgICAgICAgICAgdGhpcy5jdHguZ2xvYmFsQWxwaGEgPSBnaG9zdEFscGhhOwogICAgICAgICAgICAgICAgY29uc3QgZ2hvc3RGb250ID0gZ2V0Rm9udCh0aGlzLmdldEVmZmVjdGl2ZUZvbnRTaXplKCkpOwogICAgICAgICAgICAgICAgdGhpcy5jdHguZm9udCA9IGdob3N0Rm9udDsKICAgICAgICAgICAgICAgIHRoaXMuY3R4LnRleHRSZW5kZXJpbmcgPSAnb3B0aW1pemVTcGVlZCc7CiAgICAgICAgICAgICAgICB0aGlzLmN0eC5mb250S2VybmluZyA9ICdub25lJzsKICAgICAgICAgICAgICAgIHRoaXMuY3R4LmZpbGxTdHlsZSA9IHJlbmRlckNvbG9yOwogICAgICAgICAgICAgICAgLy8gQnVpbGQgZ2hvc3QgdGV4dCBmcm9tIHRleHQgc2VnbWVudHMgb25seSDigJQgc2tpcCBlbW9qaSBmYWxsYmFja1RleHQKICAgICAgICAgICAgICAgIGlmIChtc2cuZ2hvc3RUZXh0KSB7CiAgICAgICAgICAgICAgICAgIHRoaXMuY3R4LmZpbGxUZXh0KAogICAgICAgICAgICAgICAgICAgIG1zZy5naG9zdFRleHQsCiAgICAgICAgICAgICAgICAgICAgTWF0aC5mbG9vcihtc2cuX3ByZXZYKSArIHJlbmRlcmVyTGF5b3V0LnBhZGRpbmdILAogICAgICAgICAgICAgICAgICAgIE1hdGguZmxvb3IobXNnLl9wcmV2WSkKICAgICAgICAgICAgICAgICAgKTsKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgICAgIHRoaXMuY3R4LnJlc3RvcmUoKTsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgIH0KICAgICAgICAgICAgaWYgKG1zZy5jYXJkQ29uZmlnV29ya2VyKSB7CiAgICAgICAgICAgICAgY29uc3QgcGFpZENvbnRlbnQgPQogICAgICAgICAgICAgICAgY2ZnLnRyYW5zbGF0aW9uRW5hYmxlZCAmJiBjZmcudHJhbnNsYXRpb25Nb2RlID09PSAncmVwbGFjZScgJiYgbXNnLnRyYW5zbGF0ZWRUZXh0CiAgICAgICAgICAgICAgICAgID8gKG1zZy50cmFuc2xhdGVkQ29udGVudCA/PyBtc2cuY29udGVudCkKICAgICAgICAgICAgICAgICAgOiBtc2cuY29udGVudDsKICAgICAgICAgICAgICB0aGlzLmN0eC5zYXZlKCk7CiAgICAgICAgICAgICAgdHJ5IHsKICAgICAgICAgICAgICAgIHJlbmRlclBhaWRDYXJkV29ya2VyKAogICAgICAgICAgICAgICAgICB0aGlzLmN0eCwKICAgICAgICAgICAgICAgICAgbXNnLAogICAgICAgICAgICAgICAgICBwYWlkQ29udGVudCwKICAgICAgICAgICAgICAgICAgbXNnLndpZHRoLAogICAgICAgICAgICAgICAgICBtc2cuaGVpZ2h0LAogICAgICAgICAgICAgICAgICBzeCwKICAgICAgICAgICAgICAgICAgc3ksCiAgICAgICAgICAgICAgICAgIG1zZy5fZnJhbWVFbGFwc2VkISwKICAgICAgICAgICAgICAgICAgbXNnLmNhcmRDb25maWdXb3JrZXIsCiAgICAgICAgICAgICAgICAgIGNmZy5mb250U2l6ZSwKICAgICAgICAgICAgICAgICAgY2ZnLmZvbnRXZWlnaHQsCiAgICAgICAgICAgICAgICAgIGNmZy5mb250RmFtaWx5LAogICAgICAgICAgICAgICAgICBzdHJva2VXaWR0aCwKICAgICAgICAgICAgICAgICAgY2ZnLm91dGxpbmVPcGFjaXR5LAogICAgICAgICAgICAgICAgICB0aGlzLnRleHRCaXRtYXBDYWNoZSwKICAgICAgICAgICAgICAgICAgdGhpcy5hdXRob3JQaG90b0NhY2hlLAogICAgICAgICAgICAgICAgICB0aGlzLmVtb2ppQ2FjaGUsCiAgICAgICAgICAgICAgICAgIGdldEZvbnQsCiAgICAgICAgICAgICAgICAgIHRoaXMuc3VwZXJDaGF0R3JhZGllbnRDYWNoZSwKICAgICAgICAgICAgICAgICAgY2ZnLnN1cGVyQ2hhdE9wYWNpdHkKICAgICAgICAgICAgICAgICk7CiAgICAgICAgICAgICAgfSBmaW5hbGx5IHsKICAgICAgICAgICAgICAgIHRoaXMuY3R4LnJlc3RvcmUoKTsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgICAgY29uc3Qgb3ZlcnJpZGVUZXh0ID0KICAgICAgICAgICAgICAgIGNmZy50cmFuc2xhdGlvbkVuYWJsZWQgJiYgY2ZnLnRyYW5zbGF0aW9uTW9kZSA9PT0gJ3JlcGxhY2UnICYmIG1zZy50cmFuc2xhdGVkVGV4dAogICAgICAgICAgICAgICAgICA/IG1zZy50cmFuc2xhdGVkVGV4dAogICAgICAgICAgICAgICAgICA6IG51bGw7CiAgICAgICAgICAgICAgY29uc3QgcmVndWxhckNvbmZpZyA9IHRoaXMucmVndWxhclJlbmRlckNvbmZpZzsKICAgICAgICAgICAgICByZWd1bGFyQ29uZmlnLnNob3dBdXRob3IgPSBjZmcuc2hvd0F1dGhvclttc2cuYXV0aG9yVHlwZSA/PyAnbm9ybWFsJ10gPz8gdHJ1ZTsKICAgICAgICAgICAgICByZWd1bGFyQ29uZmlnLmZvbnRTaXplID0gY2ZnLmZvbnRTaXplOwogICAgICAgICAgICAgIHJlZ3VsYXJDb25maWcuZm9udFdlaWdodCA9IGNmZy5mb250V2VpZ2h0OwogICAgICAgICAgICAgIHJlZ3VsYXJDb25maWcuZm9udEZhbWlseSA9IGNmZy5mb250RmFtaWx5OwogICAgICAgICAgICAgIHJlZ3VsYXJDb25maWcuY29sb3IgPSByZW5kZXJDb2xvcjsKICAgICAgICAgICAgICByZWd1bGFyQ29uZmlnLm91dGxpbmVXaWR0aFB4ID0gc3Ryb2tlV2lkdGg7CiAgICAgICAgICAgICAgcmVndWxhckNvbmZpZy5vdXRsaW5lT3BhY2l0eSA9IGNmZy5vdXRsaW5lT3BhY2l0eTsKICAgICAgICAgICAgICByZWd1bGFyQ29uZmlnLmJhY2tncm91bmRDb2xvciA9CiAgICAgICAgICAgICAgICBjZmcuYmFja2dyb3VuZENvbG9yc1ttc2cuYXV0aG9yVHlwZSA/PyAnbm9ybWFsJ10gPz8gJyMwMDAwMDAwMCc7CiAgICAgICAgICAgICAgcmVndWxhckNvbmZpZy5tZXNzYWdlV2lkdGggPSBtc2cud2lkdGg7CiAgICAgICAgICAgICAgcmVndWxhckNvbmZpZy5tZXNzYWdlSGVpZ2h0ID0gbXNnLmhlaWdodDsKICAgICAgICAgICAgICByZW5kZXJSZWd1bGFyTWVzc2FnZSgKICAgICAgICAgICAgICAgIHRoaXMuY3R4LAogICAgICAgICAgICAgICAgbXNnLAogICAgICAgICAgICAgICAgc3gsCiAgICAgICAgICAgICAgICBzeSwKICAgICAgICAgICAgICAgIHJlZ3VsYXJDb25maWcsCiAgICAgICAgICAgICAgICB0aGlzLnRleHRCaXRtYXBDYWNoZSwKICAgICAgICAgICAgICAgIHRoaXMuZW1vamlDYWNoZSwKICAgICAgICAgICAgICAgIGlzQXZhaWxhYmxlSW1hZ2UsCiAgICAgICAgICAgICAgICB0aGlzLmF1dGhvclBob3RvQ2FjaGUsCiAgICAgICAgICAgICAgICBpc0F2YWlsYWJsZUltYWdlLAogICAgICAgICAgICAgICAgZ2V0Rm9udCwKICAgICAgICAgICAgICAgIHRoaXMuYm91bmRNZWFzdXJlVGV4dENhY2hlZCwKICAgICAgICAgICAgICAgIG92ZXJyaWRlVGV4dCwKICAgICAgICAgICAgICAgIG1zZy5zcGVlZFRpZXIgPT09IFNQRUVEX1RJRVIuRkFSID8gJzFweCcgOiB1bmRlZmluZWQKICAgICAgICAgICAgICApOwogICAgICAgICAgICB9CiAgICAgICAgICAgIGlmICgKICAgICAgICAgICAgICBjZmcudHJhbnNsYXRpb25FbmFibGVkICYmCiAgICAgICAgICAgICAgY2ZnLnRyYW5zbGF0aW9uTW9kZSA9PT0gJ2R1YWwnICYmCiAgICAgICAgICAgICAgbXNnLnRyYW5zbGF0ZWRUZXh0ICYmCiAgICAgICAgICAgICAgbXNnLnRyYW5zbGF0ZWRUZXh0ICE9PSBtc2cudGV4dAogICAgICAgICAgICApIHsKICAgICAgICAgICAgICBjb25zdCB0cmFuc2xhdGlvbkZvbnRTaXplID0gTWF0aC5yb3VuZChjZmcuZm9udFNpemUgKiBUUkFOU0xBVElPTl9GT05UX1NDQUxFKTsKICAgICAgICAgICAgICB0aGlzLnRyYW5zbGF0aW9uRm9udFNpemUgPSB0cmFuc2xhdGlvbkZvbnRTaXplOwogICAgICAgICAgICAgIGNvbnN0IHRyYW5zbGF0aW9uQ29sb3IgPSBtc2cuYXV0aG9yVHlwZQogICAgICAgICAgICAgICAgPyBjZmcuYXV0aG9yQ29sb3JzW21zZy5hdXRob3JUeXBlXSB8fCByZW5kZXJDb2xvcgogICAgICAgICAgICAgICAgOiByZW5kZXJDb2xvcjsKICAgICAgICAgICAgICBjb25zdCB0cmFuc2xhdGlvblkgPSBzeSArIG1zZy5oZWlnaHQgLSB0cmFuc2xhdGlvbkZvbnRTaXplIC0gVFJBTlNMQVRJT05fR0FQX1BYOwogICAgICAgICAgICAgIHRoaXMuY3R4LnNhdmUoKTsKICAgICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgICAgdGhpcy5jdHguZ2xvYmFsQWxwaGEgPQogICAgICAgICAgICAgICAgICAoYnVja2V0SW5kZXggLyAoT1BBQ0lUWV9CVUNLRVRTIC0gMSkpICogVFJBTlNMQVRJT05fT1BBQ0lUWV9TQ0FMRTsKICAgICAgICAgICAgICAgIHJlbmRlclNlZ21lbnQoCiAgICAgICAgICAgICAgICAgIHRoaXMuY3R4LAogICAgICAgICAgICAgICAgICBtc2cudHJhbnNsYXRlZFRleHQsCiAgICAgICAgICAgICAgICAgIHN4ICsgKG1zZy5jYXJkQ29uZmlnV29ya2VyID8gMCA6IHJlbmRlcmVyTGF5b3V0LnBhZGRpbmdIKSwKICAgICAgICAgICAgICAgICAgTWF0aC5mbG9vcih0cmFuc2xhdGlvblkpLAogICAgICAgICAgICAgICAgICB0cmFuc2xhdGlvbkNvbG9yLAogICAgICAgICAgICAgICAgICB0cmFuc2xhdGlvbkZvbnRTaXplLAogICAgICAgICAgICAgICAgICBzdHJva2VXaWR0aCwKICAgICAgICAgICAgICAgICAgY2ZnLm91dGxpbmVPcGFjaXR5LAogICAgICAgICAgICAgICAgICB0aGlzLnRleHRCaXRtYXBDYWNoZSwKICAgICAgICAgICAgICAgICAgdGhpcy5ib3VuZEdldFRyYW5zbGF0aW9uRm9udAogICAgICAgICAgICAgICAgKTsKICAgICAgICAgICAgICB9IGZpbmFsbHkgewogICAgICAgICAgICAgICAgdGhpcy5jdHgucmVzdG9yZSgpOwogICAgICAgICAgICAgIH0KICAgICAgICAgICAgfQogICAgICAgICAgfQogICAgICAgIH0gZmluYWxseSB7CiAgICAgICAgICB0aGlzLmN0eC5nbG9iYWxBbHBoYSA9IDE7CiAgICAgICAgfQogICAgICB9CiAgICB9CiAgICB0aGlzLnN0YXRzRnJhbWVDb3VudGVyKys7CiAgICBpZiAodGhpcy5zdGF0c0ZyYW1lQ291bnRlciA+PSA2MCkgewogICAgICB0aGlzLnN0YXRzRnJhbWVDb3VudGVyID0gMDsKICAgICAgc2VsZi5wb3N0TWVzc2FnZSh7CiAgICAgICAgdHlwZTogJ3N0YXRzJywKICAgICAgICBhY3RpdmVNZXNzYWdlczogdGhpcy5hY3RpdmVNZXNzYWdlcy5sZW5ndGgsCiAgICAgICAgZHJvcHM6IHRoaXMudG90YWxEcm9wcywKICAgICAgICBwZW5kaW5nUXVldWVEZXB0aDogdGhpcy5wZW5kaW5nUXVldWUubGVuZ3RoLAogICAgICAgIGFjdGl2ZU1lc3NhZ2VJZHM6IHRoaXMuYWN0aXZlTWVzc2FnZXMubWFwKChtc2cpID0+IG1zZy5pZCksCiAgICAgICAgcGVuZGluZ01lc3NhZ2VJZHM6IHRoaXMucGVuZGluZ1F1ZXVlLm1hcCgobXNnKSA9PiBtc2cuaWQpLAogICAgICB9KTsKICAgIH0KCiAgICAvLyDilIDilIAgTGl2ZSByZWdpb24gbWlycm9yOiBzZW5kIHN0cnVjdHVyZWQgdGV4dCBhbHRlcm5hdGl2ZXMgdG8gbWFpbiB0aHJlYWQg4pSA4pSACiAgICAvLyBSdW5zIGV2ZXJ5IDMwIGZyYW1lcyAofjUwMG1zIGF0IDYwZnBzKSB0byBrZWVwIHRoZSBhcmlhLWxpdmUgcmVnaW9uCiAgICAvLyB1cGRhdGVkIHdpdGggY3VycmVudCB2aXNpYmxlIG1lc3NhZ2VzIGZvciBzY3JlZW4gcmVhZGVyIGFjY2Vzcy4KICAgIC8vIE1pcnJvcnMgdGhlIG1haW4tdGhyZWFkIHJlbmRlcmVyJ3MgbWlycm9yVmlzaWJsZU1lc3NhZ2VzKCkgYmVoYXZpb3VyLgogICAgaWYgKHRoaXMuc3RhdHNGcmFtZUNvdW50ZXIgJSAzMCA9PT0gMCkgewogICAgICBjb25zdCBtYXhTbmlwcGV0cyA9IDEwOwogICAgICBjb25zdCBjb3VudCA9IE1hdGgubWluKHRoaXMuYWN0aXZlTWVzc2FnZXMubGVuZ3RoLCBtYXhTbmlwcGV0cyk7CiAgICAgIGlmIChjb3VudCA+IDApIHsKICAgICAgICBjb25zdCBtZXNzYWdlczogQXJyYXk8ewogICAgICAgICAgaWQ6IHN0cmluZzsKICAgICAgICAgIHRleHQ6IHN0cmluZzsKICAgICAgICAgIGtpbmQ6ICd0ZXh0JyB8ICdzdXBlcmNoYXQnIHwgJ21lbWJlcnNoaXAnOwogICAgICAgICAgYXV0aG9yPzogc3RyaW5nOwogICAgICAgICAgc3VwZXJDaGF0QW1vdW50Pzogc3RyaW5nOwogICAgICAgICAgbWVtYmVyc2hpcEhlYWRlcj86IHN0cmluZzsKICAgICAgICB9PiA9IFtdOwogICAgICAgIGNvbnN0IHN0YXJ0ID0gdGhpcy5hY3RpdmVNZXNzYWdlcy5sZW5ndGggLSBjb3VudDsKICAgICAgICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPCB0aGlzLmFjdGl2ZU1lc3NhZ2VzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgICBjb25zdCBtc2cgPSB0aGlzLmFjdGl2ZU1lc3NhZ2VzW2ldOwogICAgICAgICAgaWYgKCFtc2cgfHwgKCFtc2cudGV4dCAmJiAhbXNnLmF1dGhvcikpIGNvbnRpbnVlOwogICAgICAgICAgY29uc3Qga2luZCA9IG1zZy5raW5kID09PSAnc3VwZXJjaGF0JyB8fCBtc2cua2luZCA9PT0gJ21lbWJlcnNoaXAnID8gbXNnLmtpbmQgOiAndGV4dCc7CiAgICAgICAgICBtZXNzYWdlcy5wdXNoKHsKICAgICAgICAgICAgaWQ6IG1zZy5pZCwKICAgICAgICAgICAgdGV4dDogbXNnLnRleHQsCiAgICAgICAgICAgIGtpbmQsCiAgICAgICAgICAgIC4uLihtc2cuYXV0aG9yICE9PSB1bmRlZmluZWQgPyB7IGF1dGhvcjogbXNnLmF1dGhvciB9IDoge30pLAogICAgICAgICAgICAuLi4obXNnLnN1cGVyQ2hhdEFtb3VudCAhPT0gdW5kZWZpbmVkID8geyBzdXBlckNoYXRBbW91bnQ6IG1zZy5zdXBlckNoYXRBbW91bnQgfSA6IHt9KSwKICAgICAgICAgICAgLi4uKG1zZy5tZW1iZXJzaGlwSGVhZGVyICE9PSB1bmRlZmluZWQKICAgICAgICAgICAgICA/IHsgbWVtYmVyc2hpcEhlYWRlcjogbXNnLm1lbWJlcnNoaXBIZWFkZXIgfQogICAgICAgICAgICAgIDoge30pLAogICAgICAgICAgfSk7CiAgICAgICAgfQogICAgICAgIGlmIChtZXNzYWdlcy5sZW5ndGggPiAwKSB7CiAgICAgICAgICBzZWxmLnBvc3RNZXNzYWdlKHsgdHlwZTogJ2xpdmVSZWdpb25TbmlwcGV0cycsIG1lc3NhZ2VzIH0pOwogICAgICAgIH0KICAgICAgfQogICAgfQogIH0KCiAgcHJpdmF0ZSBjaGVja0NvbGxpc2lvbigKICAgIHBsYWNlbWVudDogewogICAgICBsYW5lSW5kZXg6IG51bWJlcjsKICAgICAgd2FpdE1zOiBudW1iZXI7CiAgICAgIGxhbmVZOiBudW1iZXI7CiAgICAgIHNsb3RDb3VudDogbnVtYmVyOwogICAgICB2ZXJ0aWNhbE9mZnNldDogbnVtYmVyOwogICAgfSwKICAgIG5ld01zZ0hlaWdodDogbnVtYmVyLAogICAgX25ld1NwZWVkVGllcjogbnVtYmVyLAogICAgbm93OiBudW1iZXIsCiAgICBzY3JlZW5XaWR0aDogbnVtYmVyCiAgKTogYm9vbGVhbiB7CiAgICBpZiAoIXRoaXMuY29uZmlnKSByZXR1cm4gdHJ1ZTsKICAgIGNvbnN0IG1vZGUgPSB0aGlzLmNvbmZpZy5kYW5tYWt1TW9kZTsKICAgIGNvbnN0IGlzU2Nyb2xsaW5nID0gbW9kZSA9PT0gJ3Njcm9sbCcgfHwgbW9kZSA9PT0gJ3JldmVyc2UnOwogICAgY29uc3QgbmV3VG9wID0gcGxhY2VtZW50LmxhbmVZICsgcGxhY2VtZW50LnZlcnRpY2FsT2Zmc2V0OwogICAgY29uc3QgbmV3Qm90dG9tID0gbmV3VG9wICsgbmV3TXNnSGVpZ2h0OwoKICAgIC8vIElzc3VlIDc6IExhbmUtc2NvcGVkIGNvbGxpc2lvbiBzY2FuIHZpYSBhY3RpdmVNZXNzYWdlc0J5TGFuZS4KICAgIC8vIFNjYW4gdGhlIG5ldyBtZXNzYWdlJ3MgbGFuZXMgwrEgMSBmb3IgYWRqYWNlbnQgb3ZlcmxhcCwgaW5zdGVhZCBvZgogICAgLy8gaXRlcmF0aW5nIGFsbCBhY3RpdmUgbWVzc2FnZXMgKE8obikg4oaSIE8obGFuZXMgwrcgYXZnTXNnc1BlckxhbmUpKS4KICAgIGNvbnN0IGFkamFjZW50TWVzc2FnZXM6IEFjdGl2ZU1lc3NhZ2VbXSA9IFtdOwogICAgY29uc3Qgc2NhblN0YXJ0ID0gcGxhY2VtZW50LmxhbmVJbmRleCAtIDE7CiAgICBjb25zdCBzY2FuRW5kID0gcGxhY2VtZW50LmxhbmVJbmRleCArIHBsYWNlbWVudC5zbG90Q291bnQ7CiAgICBmb3IgKGxldCBsaSA9IHNjYW5TdGFydDsgbGkgPD0gc2NhbkVuZDsgbGkrKykgewogICAgICBjb25zdCBsYW5lTXNncyA9IHRoaXMuYWN0aXZlTWVzc2FnZXNCeUxhbmUuZ2V0KGxpKTsKICAgICAgaWYgKGxhbmVNc2dzKSB7CiAgICAgICAgZm9yIChjb25zdCBtIG9mIGxhbmVNc2dzKSBhZGphY2VudE1lc3NhZ2VzLnB1c2gobSk7CiAgICAgIH0KICAgIH0KCiAgICAvLyBTY2FuIG5ld2VzdC1maXJzdCBmb3IgZWFybHkgY29sbGlzaW9uIGV4aXQKICAgIGZvciAobGV0IGkgPSBhZGphY2VudE1lc3NhZ2VzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7CiAgICAgIGNvbnN0IGFjdGl2ZSA9IGFkamFjZW50TWVzc2FnZXNbaV07CiAgICAgIGlmICghYWN0aXZlKSBjb250aW51ZTsKICAgICAgY29uc3QgYWN0aXZlRWxhcHNlZCA9IG5vdyAtIGFjdGl2ZS5zdGFydFRpbWUgLSBhY3RpdmUucGF1c2VkRHVyYXRpb247CiAgICAgIGlmIChhY3RpdmVFbGFwc2VkIDwgMCkgY29udGludWU7CiAgICAgIGlmIChhY3RpdmUueSArIGFjdGl2ZS5oZWlnaHQgPD0gbmV3VG9wIHx8IGFjdGl2ZS55ID49IG5ld0JvdHRvbSkgY29udGludWU7CiAgICAgIGlmIChpc1Njcm9sbGluZykgewogICAgICAgIGNvbnN0IGhlYWR3YXlQeCA9IGNvbXB1dGVCYXNlSGVhZHdheVB4KGFjdGl2ZS53aWR0aCwgdGhpcy5jb25maWcuaGVhZHdheUdhcFJhdGlvKTsKICAgICAgICBjb25zdCBhY3RpdmVQcm9ncmVzcyA9IE1hdGgubWluKDEsIE1hdGgubWF4KDAsIGFjdGl2ZUVsYXBzZWQgKiBhY3RpdmUuaW52RHVyYXRpb24pKTsKICAgICAgICBpZiAobW9kZSA9PT0gJ3Njcm9sbCcpIHsKICAgICAgICAgIGlmICgKICAgICAgICAgICAgYWN0aXZlLnN0YXJ0WCAtCiAgICAgICAgICAgICAgYWN0aXZlUHJvZ3Jlc3MgKiAoYWN0aXZlLnN0YXJ0WCArIGFjdGl2ZS53aWR0aCArIHRoaXMuY29uZmlnLmV4aXRQYWRkaW5nUHgpICsKICAgICAgICAgICAgICBhY3RpdmUud2lkdGggPgogICAgICAgICAgICBzY3JlZW5XaWR0aCAtIGhlYWR3YXlQeAogICAgICAgICAgKSB7CiAgICAgICAgICAgIHRoaXMubWFya0NvbGxpZGVkTGFuZXMocGxhY2VtZW50LmxhbmVJbmRleCwgcGxhY2VtZW50LnNsb3RDb3VudCk7CiAgICAgICAgICAgIHJldHVybiBmYWxzZTsKICAgICAgICAgIH0KICAgICAgICB9IGVsc2UgewogICAgICAgICAgLy8gcmV2ZXJzZSBtb2RlOiBtZXNzYWdlcyBlbnRlciBmcm9tIGxlZnQsIHRyYXZlbCByaWdodC4KICAgICAgICAgIC8vIENvbGxpc2lvbjogdGhlIGFjdGl2ZSBtZXNzYWdlJ3MgTEVGVCBlZGdlIG11c3QgaGF2ZSBjbGVhcmVkCiAgICAgICAgICAvLyB0aGUgbGVmdC1zaWRlIGVudHJ5IHpvbmUgKCsgaGVhZHdheSBnYXApIGJlZm9yZSBhIG5ldyBtZXNzYWdlCiAgICAgICAgICAvLyBjYW4gZW50ZXIgdGhlIHNhbWUgbGFuZS4KICAgICAgICAgIGNvbnN0IGFjdGl2ZVggPQogICAgICAgICAgICBhY3RpdmUuc3RhcnRYICsKICAgICAgICAgICAgYWN0aXZlUHJvZ3Jlc3MgKiAoc2NyZWVuV2lkdGggLSBhY3RpdmUuc3RhcnRYICsgdGhpcy5jb25maWcuZXhpdFBhZGRpbmdQeCk7CiAgICAgICAgICBpZiAoYWN0aXZlWCA8IGhlYWR3YXlQeCkgewogICAgICAgICAgICB0aGlzLm1hcmtDb2xsaWRlZExhbmVzKHBsYWNlbWVudC5sYW5lSW5kZXgsIHBsYWNlbWVudC5zbG90Q291bnQpOwogICAgICAgICAgICByZXR1cm4gZmFsc2U7CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIGlmIChhY3RpdmVFbGFwc2VkIDwgYWN0aXZlLmR1cmF0aW9uKSB7CiAgICAgICAgICB0aGlzLm1hcmtDb2xsaWRlZExhbmVzKHBsYWNlbWVudC5sYW5lSW5kZXgsIHBsYWNlbWVudC5zbG90Q291bnQpOwogICAgICAgICAgcmV0dXJuIGZhbHNlOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgcmV0dXJuIHRydWU7CiAgfQoKICAvKiogSXNzdWUgNjogTWFyayBhbGwgbGFuZXMgb2NjdXBpZWQgYnkgYSBtdWx0aS1zbG90IG1lc3NhZ2UsIG5vdCBqdXN0IHRoZSBzdGFydCBsYW5lLiAqLwogIHByaXZhdGUgbWFya0NvbGxpZGVkTGFuZXMoc3RhcnRMYW5lOiBudW1iZXIsIHNsb3RDb3VudDogbnVtYmVyKTogdm9pZCB7CiAgICBmb3IgKGxldCBzbG90ID0gMDsgc2xvdCA8IHNsb3RDb3VudDsgc2xvdCsrKSB7CiAgICAgIHRoaXMuY29sbGlkZWRMYW5lcy5hZGQoc3RhcnRMYW5lICsgc2xvdCk7CiAgICB9CiAgfQoKICBwcml2YXRlIGRyYWluUXVldWUobm93OiBudW1iZXIsIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogdm9pZCB7CiAgICBpZiAoIXRoaXMuY29uZmlnKSByZXR1cm47CiAgICBpZiAodGhpcy5wZW5kaW5nUXVldWVTb3J0TmVlZGVkICYmIHRoaXMucGVuZGluZ1F1ZXVlLmxlbmd0aCA+IDApIHsKICAgICAgdGhpcy5wZW5kaW5nUXVldWUuc29ydCgoYSwgYikgPT4gYi5wcmlvcml0eSAtIGEucHJpb3JpdHkpOwogICAgICB0aGlzLnBlbmRpbmdRdWV1ZVNvcnROZWVkZWQgPSBmYWxzZTsKICAgIH0KICAgIGxldCBiYXRjaEluZGV4ID0gMDsKICAgIGNvbnN0IGNvbW1pdHRlZCA9IG5ldyBTZXQ8V29ya2VyTWVzc2FnZT4oKTsKICAgIGxldCBza2lwQ291bnQgPSAwOwogICAgY29uc3QgTUFYX0NPTlNFQ1VUSVZFX1NLSVBTID0gMTY7CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMucGVuZGluZ1F1ZXVlLmxlbmd0aDsgaSsrKSB7CiAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5wZW5kaW5nUXVldWVbaV07CiAgICAgIGlmICghZW50cnkpIGNvbnRpbnVlOwogICAgICBpZiAodGhpcy5hY3RpdmVNZXNzYWdlcy5sZW5ndGggPj0gdGhpcy5jb25maWcubWF4Q29uY3VycmVudE1lc3NhZ2VzKSBicmVhazsKICAgICAgY29uc3Qgc3BlZWRUaWVyID0gZ2V0U3BlZWRUaWVyKGVudHJ5LCB0aGlzLmNvbmZpZyk7CiAgICAgIGNvbnN0IHJlcXVpcmVkU2xvdHMgPSBNYXRoLm1heCgxLCBNYXRoLmNlaWwoZW50cnkuaGVpZ2h0IC8gdGhpcy5sYW5lSGVpZ2h0KSk7CiAgICAgIGlmIChyZXF1aXJlZFNsb3RzID4gdGhpcy5udW1MYW5lcykgewogICAgICAgIC8vIEEgbWVzc2FnZSB0YWxsZXIgdGhhbiB0aGUgdmlld3BvcnQgY2FuIG5ldmVyIG9idGFpbiBhIGNvbnRpZ3VvdXMKICAgICAgICAvLyBibG9jay4gVHJlYXQgaXQgYXMgYSBwZXJtYW5lbnQgZHJvcCBpbnN0ZWFkIG9mIHJldHJ5aW5nIGl0IGV2ZXJ5CiAgICAgICAgLy8gZnJhbWUgYW5kIGtlZXBpbmcgdGhlIFdvcmtlciByZW5kZXIgbG9vcCBhbGl2ZSBpbmRlZmluaXRlbHkuCiAgICAgICAgdGhpcy50b3RhbERyb3BzKys7CiAgICAgICAgdGhpcy5tZXNzYWdlQnlJZC5kZWxldGUoZW50cnkuaWQpOwogICAgICAgIGNvbW1pdHRlZC5hZGQoZW50cnkpOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIGNvbnN0IHBsYWNlbWVudCA9IHRoaXMuZmluZFBsYWNlbWVudChlbnRyeS5oZWlnaHQsIHNwZWVkVGllciwgbm93KTsKICAgICAgaWYgKCFwbGFjZW1lbnQpIHsKICAgICAgICB0aGlzLnRvdGFsRHJvcHMrKzsKICAgICAgICBza2lwQ291bnQrKzsKICAgICAgICBpZiAoc2tpcENvdW50ID49IE1BWF9DT05TRUNVVElWRV9TS0lQUykgYnJlYWs7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KICAgICAgaWYgKCF0aGlzLmNoZWNrQ29sbGlzaW9uKHBsYWNlbWVudCwgZW50cnkuaGVpZ2h0LCBzcGVlZFRpZXIsIG5vdywgd2lkdGgpKSB7CiAgICAgICAgc2tpcENvdW50Kys7CiAgICAgICAgaWYgKHNraXBDb3VudCA+PSBNQVhfQ09OU0VDVVRJVkVfU0tJUFMpIGJyZWFrOwogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIHNraXBDb3VudCA9IDA7CiAgICAgIHRoaXMuYWN0aXZhdGVNZXNzYWdlKGVudHJ5LCBub3csIHBsYWNlbWVudCwgYmF0Y2hJbmRleCwgc3BlZWRUaWVyLCB3aWR0aCwgaGVpZ2h0KTsKICAgICAgYmF0Y2hJbmRleCsrOwogICAgICBjb21taXR0ZWQuYWRkKGVudHJ5KTsKCiAgICAgIC8vIFByZS13YXJtIHRleHQgYml0bWFwIGNhY2hlIOKAlCBzZWUgY2FudmFzLXJlbmRlcmVyLnRzIGRyYWluUXVldWUgZm9yIHJhdGlvbmFsZS4KICAgICAgaWYgKGVudHJ5LmNvbnRlbnQgJiYgdGhpcy5jb25maWcub3V0bGluZVdpZHRoUHggPiAwICYmIHRoaXMuY29uZmlnLm91dGxpbmVPcGFjaXR5ID4gMCkgewogICAgICAgIGNvbnN0IHdhcm1Db2xvciA9CiAgICAgICAgICB0aGlzLmNvbmZpZy5wcmVzZXJ2ZVVzZXJDb2xvciAmJiBlbnRyeS51c2VyQ29sb3IKICAgICAgICAgICAgPyBlbnRyeS51c2VyQ29sb3IKICAgICAgICAgICAgOiAoZW50cnkuYXV0aG9yVHlwZSAmJiB0aGlzLmNvbmZpZy5hdXRob3JDb2xvcnNbZW50cnkuYXV0aG9yVHlwZV0pIHx8CiAgICAgICAgICAgICAgdGhpcy5jb25maWcuY29sb3IgfHwKICAgICAgICAgICAgICBERUZBVUxUX1RFWFRfQ09MT1I7CiAgICAgICAgY29uc3QgZmFyU3BhY2luZyA9IHNwZWVkVGllciA9PT0gU1BFRURfVElFUi5GQVIgPyAnMXB4JyA6IHVuZGVmaW5lZDsKICAgICAgICB3YXJtVGV4dEJpdG1hcENhY2hlKAogICAgICAgICAgZW50cnkuY29udGVudCwKICAgICAgICAgIHRoaXMuZ2V0RWZmZWN0aXZlRm9udFNpemUoKSwKICAgICAgICAgIHRoaXMuY29uZmlnLmZvbnRXZWlnaHQsCiAgICAgICAgICB0aGlzLmNvbmZpZy5mb250RmFtaWx5LAogICAgICAgICAgd2FybUNvbG9yLAogICAgICAgICAgdGhpcy5jb25maWcub3V0bGluZVdpZHRoUHgsCiAgICAgICAgICB0aGlzLmNvbmZpZy5vdXRsaW5lT3BhY2l0eSwKICAgICAgICAgIHRoaXMudGV4dEJpdG1hcENhY2hlLAogICAgICAgICAgdGhpcy5jdHghLAogICAgICAgICAgZmFyU3BhY2luZwogICAgICAgICk7CiAgICAgIH0KICAgIH0KICAgIGlmIChjb21taXR0ZWQuc2l6ZSA+IDApIHsKICAgICAgbGV0IHdyaXRlSWR4ID0gMDsKICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLnBlbmRpbmdRdWV1ZS5sZW5ndGg7IGkrKykgewogICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5wZW5kaW5nUXVldWVbaV07CiAgICAgICAgaWYgKGVudHJ5ICE9PSB1bmRlZmluZWQgJiYgIWNvbW1pdHRlZC5oYXMoZW50cnkpKSB7CiAgICAgICAgICB0aGlzLnBlbmRpbmdRdWV1ZVt3cml0ZUlkeCsrXSA9IGVudHJ5OwogICAgICAgIH0KICAgICAgfQogICAgICB0aGlzLnBlbmRpbmdRdWV1ZS5sZW5ndGggPSB3cml0ZUlkeDsKICAgIH0KICB9CgogIHByaXZhdGUgYXN5bmMgcHJlZmV0Y2hJbWFnZXMoCiAgICB1cmxzOiBzdHJpbmdbXSwKICAgIGNhY2hlOiBSZXNpemFibGVCeXRlTGltaXRlZENhY2hlPEltYWdlQml0bWFwPgogICk6IFByb21pc2U8dm9pZD4gewogICAgaWYgKHRoaXMuaXNEZXN0cm95ZWQpIHJldHVybjsKICAgIGNvbnN0IGdlbmVyYXRpb24gPSB0aGlzLmZldGNoR2VuZXJhdGlvbjsKICAgIGNvbnN0IHRvRmV0Y2ggPSBbLi4ubmV3IFNldCh1cmxzKV0uZmlsdGVyKCh1KSA9PiAhY2FjaGUuaGFzKHUpICYmICF0aGlzLmZldGNoaW5nLmhhcyh1KSk7CiAgICBpZiAodG9GZXRjaC5sZW5ndGggPT09IDApIHJldHVybjsKICAgIGxldCBpZHggPSAwOwogICAgY29uc3Qgd29ya2VyczogUHJvbWlzZTx2b2lkPltdID0gW107CiAgICBmb3IgKGxldCBpID0gMDsgaSA8IE1hdGgubWluKHRoaXMuY29uZmlnPy5lbW9qaUZldGNoTGltaXQgPz8gOCwgdG9GZXRjaC5sZW5ndGgpOyBpKyspIHsKICAgICAgd29ya2Vycy5wdXNoKAogICAgICAgIChhc3luYyAoKSA9PiB7CiAgICAgICAgICB3aGlsZSAoaWR4IDwgdG9GZXRjaC5sZW5ndGgpIHsKICAgICAgICAgICAgaWYgKHRoaXMuaXNEZXN0cm95ZWQgfHwgZ2VuZXJhdGlvbiAhPT0gdGhpcy5mZXRjaEdlbmVyYXRpb24pIGJyZWFrOwogICAgICAgICAgICBjb25zdCB1cmwgPSB0b0ZldGNoW2lkeCsrXTsKICAgICAgICAgICAgaWYgKHVybCA9PT0gdW5kZWZpbmVkKSBicmVhazsKICAgICAgICAgICAgaWYgKCFpc0FsbG93ZWRJbWFnZVVybCh1cmwpKSB7CiAgICAgICAgICAgICAgdGhpcy5mZXRjaGluZy5kZWxldGUodXJsKTsKICAgICAgICAgICAgICBjb250aW51ZTsKICAgICAgICAgICAgfQogICAgICAgICAgICB0aGlzLmZldGNoaW5nLmFkZCh1cmwpOwogICAgICAgICAgICBsZXQgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkOwogICAgICAgICAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgICAgICAgICB0aGlzLmZldGNoQ29udHJvbGxlcnMuYWRkKGNvbnRyb2xsZXIpOwogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgKICAgICAgICAgICAgICAgICgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwKICAgICAgICAgICAgICAgIHRoaXMuY29uZmlnPy5lbW9qaUZldGNoVGltZW91dE1zID8/IEVNT0pJX0ZFVENIX1RJTUVPVVRfREVGQVVMVF9NUwogICAgICAgICAgICAgICk7CiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTsKICAgICAgICAgICAgICBpZiAodGhpcy5pc1ByZWZldGNoU3RhbGUoZ2VuZXJhdGlvbiwgY29udHJvbGxlci5zaWduYWwpKSBjb250aW51ZTsKICAgICAgICAgICAgICBpZiAoIXJlc3BvbnNlLm9rKSBjb250aW51ZTsKICAgICAgICAgICAgICBjb25zdCBibG9iID0gYXdhaXQgcmVzcG9uc2UuYmxvYigpOwogICAgICAgICAgICAgIGlmICh0aGlzLmlzUHJlZmV0Y2hTdGFsZShnZW5lcmF0aW9uLCBjb250cm9sbGVyLnNpZ25hbCkpIGNvbnRpbnVlOwogICAgICAgICAgICAgIGNvbnN0IGJpdG1hcCA9IGF3YWl0IGNyZWF0ZUltYWdlQml0bWFwKGJsb2IpOwogICAgICAgICAgICAgIGlmICh0aGlzLmlzUHJlZmV0Y2hTdGFsZShnZW5lcmF0aW9uLCBjb250cm9sbGVyLnNpZ25hbCkpIHsKICAgICAgICAgICAgICAgIGJpdG1hcC5jbG9zZSgpOwogICAgICAgICAgICAgICAgY29udGludWU7CiAgICAgICAgICAgICAgfQogICAgICAgICAgICAgIGNhY2hlLnNldCh1cmwsIGJpdG1hcCk7CiAgICAgICAgICAgIH0gY2F0Y2ggewogICAgICAgICAgICAgIC8vIHNpbGVudGx5IHNraXAKICAgICAgICAgICAgfSBmaW5hbGx5IHsKICAgICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpOwogICAgICAgICAgICAgIHRoaXMuZmV0Y2hDb250cm9sbGVycy5kZWxldGUoY29udHJvbGxlcik7CiAgICAgICAgICAgICAgdGhpcy5mZXRjaGluZy5kZWxldGUodXJsKTsKICAgICAgICAgICAgfQogICAgICAgICAgfQogICAgICAgIH0pKCkKICAgICAgKTsKICAgIH0KICAgIGF3YWl0IFByb21pc2UuYWxsKHdvcmtlcnMpOwogIH0KCiAgcHJpdmF0ZSBpc1ByZWZldGNoU3RhbGUoZ2VuZXJhdGlvbjogbnVtYmVyLCBzaWduYWw6IEFib3J0U2lnbmFsKTogYm9vbGVhbiB7CiAgICByZXR1cm4gdGhpcy5pc0Rlc3Ryb3llZCB8fCBnZW5lcmF0aW9uICE9PSB0aGlzLmZldGNoR2VuZXJhdGlvbiB8fCBzaWduYWwuYWJvcnRlZDsKICB9Cn0KCi8vIOKUgOKUgCBXb3JrZXIgZW50cnkgcG9pbnQg4pSA4pSACgpsZXQgcmVuZGVyZXIgPSBuZXcgV29ya2VyUmVuZGVyZXIoKTsKc2VsZi5vbm1lc3NhZ2UgPSAoZTogTWVzc2FnZUV2ZW50KTogdm9pZCA9PiB7CiAgcmVuZGVyZXIuaGFuZGxlTWVzc2FnZShlKTsKfTsKCi8qKiBSZXNldCB3b3JrZXIgc3RhdGUgZm9yIHRlc3QgaXNvbGF0aW9uLiAqLwpleHBvcnQgZnVuY3Rpb24gcmVzZXRXb3JrZXJGb3JUZXN0cygpOiB2b2lkIHsKICByZW5kZXJlciA9IG5ldyBXb3JrZXJSZW5kZXJlcigpOwp9Cg==", "" + {}.url);
	}
	function sendUpdateConfigToWorker(manager, config) {
		manager.worker?.postMessage({
			type: "updateConfig",
			config
		});
	}
	function sendSetPausedToWorker(manager, paused, videoPaused) {
		manager.worker?.postMessage({
			type: "setPaused",
			paused,
			videoPaused
		});
	}
	function sendClearStateToWorker(manager) {
		manager.worker?.postMessage({ type: "clearState" });
	}
	function buildPartialWorkerConfig(settings, keys) {
		const config = {};
		for (const key of keys) config[key] = settings[key];
		return config;
	}
	function serializeWorkerMessage({ message, id, dimensions, priority, burstSpeedMultiplier, settings }) {
		const content = message.content.map((segment) => {
			if (segment.type === "text") return {
				type: "text",
				content: segment.content
			};
			return {
				type: "emoji",
				content: segment.emoji.alt,
				emojiUrl: segment.emoji.url,
				emojiAlt: segment.emoji.alt,
				...segment.emoji.fallbackText !== void 0 ? { emojiFallbackText: segment.emoji.fallbackText } : {}
			};
		});
		const translatedText = message.translatedText;
		return {
			id,
			text: message.text,
			width: dimensions.width,
			height: dimensions.height,
			priority,
			isBacklog: message.isBacklog ?? false,
			authorType: message.authorType,
			kind: message.kind,
			userColor: message.userColor,
			cardConfigWorker: message.kind === "superchat" || message.kind === "membership" ? toWorkerConfig(message.kind === "superchat" ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG, message, settings) : void 0,
			burstSpeedMultiplier,
			...translatedText !== void 0 ? { translatedText } : {},
			content,
			author: message.author,
			authorPhotoUrl: message.authorPhotoUrl,
			...message.kind === "superchat" && message.superChat ? {
				superChatAmount: message.superChat.amount,
				superChatStickerUrl: message.superChat.sticker?.url
			} : {},
			...message.kind === "membership" ? { membershipHeader: message.membershipHeader } : {}
		};
	}
	var log$10 = createLogger("RenderWorkerManager");
	var RenderWorkerManager = class RenderWorkerManager {
		static WORKER_CONFIG_KEYS = [
			"speedPxPerSec",
			"fontSize",
			"fontBaseViewportHeight",
			"fontMinSize",
			"fontMaxSize",
			"fontWeight",
			"fontFamily",
			"opacity",
			"laneSpacing",
			"safeTop",
			"safeBottom",
			"maxConcurrentMessages",
			"danmakuMode",
			"backlogSpeedMultiplier",
			"depthLayersEnabled",
			"depthFarSpeedMul",
			"depthNearSpeedMul",
			"depthFarOpacityMul",
			"motionBlurEnabled",
			"motionBlurAlpha",
			"backlogOpacityMultiplier",
			"fadeDurationMs",
			"modOwnerDurationMultiplier",
			"superChatOpacity",
			"superChatMaxBodyLines",
			"membershipMaxBodyLines",
			"showAuthor",
			"backgroundColors",
			"showSuperChatAmount",
			"translationEnabled",
			"translationMode",
			"exitPaddingPx",
			"scrollDurationMinMs",
			"scrollDurationMaxMs",
			"topBottomDurationMs",
			"queueMaxSize",
			"maxMessageAgeMs",
			"headwayGapRatio",
			"emojiCacheMb",
			"photoCacheMb",
			"stickerCacheMb",
			"textCacheMb",
			"emojiFetchLimit",
			"emojiFetchTimeoutMs",
			"failedEmojiRetryMins",
			"staggerMaxDelayMs",
			"staggerMediumDelayMs",
			"ignoreReducedMotion",
			"preserveUserColor",
			"backgroundQueueMax",
			"translationBatchSize"
		];
		static buildWorkerConfig(settings) {
			const config = {};
			for (const key of RenderWorkerManager.WORKER_CONFIG_KEYS) config[key] = settings[key];
			config.outlineWidthPx = settings.outline.enabled ? settings.outline.widthPx : 0;
			config.outlineOpacity = settings.outline.enabled ? settings.outline.opacity : 0;
			config.authorColors = { ...settings.colors };
			config.backgroundColors = { ...settings.backgroundColors };
			config.color = settings.colors.normal;
			config.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			config.isReplayMode = false;
			return config;
		}
		worker = null;
		active = false;
		_queueDepth = 0;
		_activeMessageCount = 0;
		deps;
		sentMessages = new Map();
		snapshotSequence = 0;
		messageSnapshotRequest = null;
		dimensionsUnsubscribe = null;
		_liveRegionCallback = null;
		_fatalErrorCallback = null;
		pendingBatch = [];
		batchFlushScheduled = false;
		pingTimer = null;
		lastPongTime = 0;
		_contextLost = false;
		initTime = 0;
		static PING_INTERVAL_MS = 1e3;
		static PONG_TIMEOUT_MS = 5e3;
		static INIT_TIMEOUT_MS = 1e4;
		constructor(deps) {
			this.deps = deps;
		}
		get isActive() {
			return this.active;
		}
		setActive(active) {
			this.active = active;
		}
		get workerRef() {
			return this.worker;
		}
		get queueDepth() {
			return this._queueDepth;
		}
		get activeMessageCount() {
			return this._activeMessageCount;
		}
		setLiveRegionCallback(callback) {
			this._liveRegionCallback = callback;
		}
		setFatalErrorCallback(callback) {
			this._fatalErrorCallback = callback;
		}
		isAlive() {
			if (!this.active) return true;
			if (!this.worker) return false;
			if (this._contextLost) return false;
			if (this.lastPongTime === 0) return performance.now() - this.initTime < RenderWorkerManager.INIT_TIMEOUT_MS;
			return performance.now() - this.lastPongTime < RenderWorkerManager.PONG_TIMEOUT_MS;
		}
		startPingPong() {
			this.stopPingPong();
			this.lastPongTime = 0;
			this.initTime = performance.now();
			this.pingTimer = setInterval(() => {
				if (this.worker) this.worker.postMessage({ type: "ping" });
			}, RenderWorkerManager.PING_INTERVAL_MS);
		}
		stopPingPong() {
			if (this.pingTimer !== null) {
				clearInterval(this.pingTimer);
				this.pingTimer = null;
			}
			this.lastPongTime = 0;
			this.initTime = 0;
		}
		init(canvas, settings, overlay, overrideWorkerUrl) {
			let worker = null;
			try {
				if (!workerSupported()) {
					log$10.debug("renderer.worker.unavailable", { reason: "worker-unsupported-platform" });
					return false;
				}
				if (typeof OffscreenCanvas === "undefined") {
					log$10.debug("renderer.worker.unavailable", { reason: "no-offscreen-canvas" });
					return false;
				}
				const dims = overlay.getDimensions();
				if (!dims || !Number.isFinite(dims.width) || dims.width <= 0 || !Number.isFinite(dims.height) || dims.height <= 0) {
					log$10.debug("renderer.worker.unavailable", { reason: "invalid-overlay-dimensions" });
					return false;
				}
				const dpr = window.devicePixelRatio || 1;
				const config = RenderWorkerManager.buildWorkerConfig(settings);
				const workerUrl = overrideWorkerUrl ?? createWorkerUrl();
				try {
					worker = new Worker(workerUrl, { type: "module" });
				} catch (workerError) {
					if (workerError instanceof DOMException && workerError.name === "SecurityError") log$10.info("Worker creation blocked by page CSP — falling back to main-thread renderer. This can happen if the page CSP has a restrictive worker-src directive.");
					else log$10.debug("renderer.worker.creation-failed", { error: String(workerError) });
					return false;
				}
				const w = worker;
				canvas.width = dims.width * dpr;
				canvas.height = dims.height * dpr;
				const offscreen = canvas.transferControlToOffscreen();
				w.onmessage = (e) => {
					const data = e.data;
					if (data === null || typeof data !== "object" || !("type" in data) || typeof data.type !== "string") {
						log$10.debug("renderer.worker.malformed-message", { data: String(data) });
						return;
					}
					const { type } = data;
					switch (type) {
						case "ready":
							log$10.info("renderer.worker.started");
							break;
						case "stats":
							this._activeMessageCount = data.activeMessages ?? 0;
							this.deps.observability.updateActiveMessages(this._activeMessageCount);
							this._queueDepth = data.pendingQueueDepth ?? 0;
							this.pruneSentMessages(data.activeMessageIds, data.pendingMessageIds);
							break;
						case "messageSnapshot": {
							const request = this.messageSnapshotRequest;
							const requestId = data.requestId;
							if (!request || request.requestId !== requestId) break;
							clearTimeout(request.timer);
							this.messageSnapshotRequest = null;
							const ids = Array.isArray(data.messageIds) ? data.messageIds : [];
							request.resolve(this.takeSentMessages(ids));
							break;
						}
						case "error":
							log$10.warn("renderer.worker.error", { error: String(data.error) });
							break;
						case "pong":
							this.lastPongTime = performance.now();
							break;
						case "contextLost":
							log$10.warn("renderer.worker.context-lost");
							this._contextLost = true;
							break;
						case "liveRegionSnippets": if (this._liveRegionCallback) this._liveRegionCallback(data.messages ?? []);
					}
				};
				w.onerror = (err) => {
					log$10.warn("renderer.worker.error", { error: err.message });
				};
				let messageErrorCount = 0;
				let fatalErrorHandled = false;
				const MAX_MESSAGE_ERRORS = 3;
				w.onmessageerror = () => {
					messageErrorCount++;
					log$10.warn("renderer.worker.message-deserialization-failed", {
						attempt: messageErrorCount,
						max: MAX_MESSAGE_ERRORS
					});
					if (messageErrorCount === MAX_MESSAGE_ERRORS && !fatalErrorHandled) {
						fatalErrorHandled = true;
						log$10.error("renderer.worker.max-message-errors", { limit: MAX_MESSAGE_ERRORS });
						if (this._fatalErrorCallback) this._fatalErrorCallback("worker-messageerror");
						else this.destroy();
					}
				};
				w.postMessage({
					type: "init",
					canvas: offscreen,
					config,
					width: dims.width,
					height: dims.height,
					dpr
				}, [offscreen]);
				this.dimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
					if (d) {
						const currentDpr = window.devicePixelRatio || 1;
						w.postMessage({
							type: "resize",
							width: d.width,
							height: d.height,
							dpr: currentDpr
						});
					}
				});
				this.worker = w;
				this.active = true;
				this.startPingPong();
				log$10.info("renderer.worker.initialized");
				return true;
			} catch (error) {
				worker?.terminate();
				log$10.debug("renderer.worker.unavailable", { error: String(error) });
				return false;
			}
		}
		sendToWorker(message, msgId) {
			if (!this.worker) return;
			const priority = this.deps.getMessagePriority(message);
			const maxWorkerQueue = this.deps.settings.queueMaxSize * 2;
			if (this._queueDepth > maxWorkerQueue) {
				if (priority < 40) {
					this.deps.observability.onMessageDropped("worker_backpressure");
					return;
				}
			}
			const dims = this.deps.estimateDimensions(message);
			const id = msgId ?? message.id ?? `${message.timestamp}-${Math.random()}`;
			const workerMessage = serializeWorkerMessage({
				message,
				id,
				dimensions: dims,
				priority,
				burstSpeedMultiplier: this.computeBurstSpeedMultiplier(),
				settings: this.deps.settings
			});
			const transferList = [];
			const transferredImages = [];
			const collectBitmap = (url, target) => {
				if (!url) return;
				const bitmap = this.deps.imageFetchManager.workerBitmapCache.take(url);
				if (!bitmap) return;
				transferList.push(bitmap);
				transferredImages.push({
					url,
					bitmap,
					target
				});
			};
			for (const seg of workerMessage.content ?? []) if (seg.type === "emoji") collectBitmap(seg.emojiUrl, "emoji");
			collectBitmap(message.authorPhotoUrl, "author");
			if (message.kind === "superchat" && message.superChat?.sticker?.url) collectBitmap(message.superChat.sticker.url, "sticker");
			this.sentMessages.set(id, message);
			this.pendingBatch.push({
				msg: workerMessage,
				transferredImages,
				transferList
			});
			this.scheduleBatchFlush();
		}
		scheduleBatchFlush() {
			if (this.batchFlushScheduled || !this.worker) return;
			this.batchFlushScheduled = true;
			queueMicrotask(() => this.flushBatch());
		}
		flushBatch() {
			this.batchFlushScheduled = false;
			const batch = this.pendingBatch.splice(0);
			if (batch.length === 0) return;
			const worker = this.worker;
			if (!worker) {
				this.discardPendingBatch(batch);
				return;
			}
			const messages = [];
			const seenUrls = new Set();
			const allTransferredImages = [];
			const allTransferList = [];
			for (const entry of batch) {
				messages.push(entry.msg);
				for (const img of entry.transferredImages) if (!seenUrls.has(img.url)) {
					seenUrls.add(img.url);
					allTransferredImages.push(img);
					allTransferList.push(img.bitmap);
				}
			}
			if (messages.length === 0) return;
			const workerMessage = {
				type: "addMessages",
				messages
			};
			if (allTransferredImages.length > 0) {
				workerMessage.imageData = allTransferredImages;
				try {
					worker.postMessage(workerMessage, allTransferList);
				} catch (error) {
					this.discardPendingBatch(batch);
					log$10.warn("renderer.worker.batch-send-failed", { error: String(error) });
				}
			} else try {
				worker.postMessage(workerMessage);
			} catch (error) {
				this.discardPendingBatch(batch);
				log$10.warn("renderer.worker.batch-send-failed", { error: String(error) });
			}
		}
		discardPendingBatch(batch) {
			const bitmaps = new Set();
			for (const entry of batch) {
				this.sentMessages.delete(entry.msg.id);
				for (const image of entry.transferredImages) bitmaps.add(image.bitmap);
			}
			for (const bitmap of bitmaps) bitmap.close();
		}
		sendTranslation(msgId, translatedText) {
			this.worker?.postMessage({
				type: "updateTranslation",
				id: msgId,
				translatedText
			});
		}
		updateSettings(settings) {
			this.deps.settings = settings;
			const config = buildPartialWorkerConfig(settings, RenderWorkerManager.WORKER_CONFIG_KEYS);
			config.outlineWidthPx = settings.outline.enabled ? settings.outline.widthPx : 0;
			config.outlineOpacity = settings.outline.enabled ? settings.outline.opacity : 0;
			config.authorColors = { ...settings.colors };
			config.backgroundColors = { ...settings.backgroundColors };
			config.color = settings.colors.normal;
			config.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			sendUpdateConfigToWorker({ worker: this.worker }, config);
		}
		setPaused(paused) {
			if (!this.worker) return;
			sendSetPausedToWorker({ worker: this.worker }, paused);
		}
		setUserPaused(paused) {
			this.worker?.postMessage({
				type: "setUserPaused",
				paused
			});
		}
		sendReplayModeToWorker(isReplayMode) {
			if (!this.worker) return;
			sendUpdateConfigToWorker({ worker: this.worker }, { isReplayMode });
		}
		sendReducedMotion(reducedMotion) {
			if (!this.worker) return;
			sendUpdateConfigToWorker({ worker: this.worker }, { reducedMotion });
		}
		clearState() {
			if (!this.worker) return;
			sendClearStateToWorker({ worker: this.worker });
		}
		sendLaneDensity(factor) {
			this.worker?.postMessage({
				type: "laneDensity",
				factor
			});
		}
		snapshotMessages(timeoutMs = 250) {
			const worker = this.worker;
			if (!worker) return Promise.resolve([]);
			if (this.messageSnapshotRequest) return Promise.resolve([]);
			const requestId = ++this.snapshotSequence;
			const knownMessages = new Map(this.sentMessages);
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					const request = this.messageSnapshotRequest;
					if (!request || request.requestId !== requestId) return;
					this.messageSnapshotRequest = null;
					resolve(this.takeKnownMessages(request.knownMessages));
				}, timeoutMs);
				this.messageSnapshotRequest = {
					requestId,
					knownMessages,
					resolve,
					timer
				};
				try {
					worker.postMessage({
						type: "snapshotMessages",
						requestId
					});
				} catch {
					clearTimeout(timer);
					this.messageSnapshotRequest = null;
					resolve(this.takeKnownMessages(knownMessages));
				}
			});
		}
		destroy() {
			if (this.messageSnapshotRequest) {
				const request = this.messageSnapshotRequest;
				clearTimeout(request.timer);
				this.messageSnapshotRequest = null;
				request.resolve(this.takeKnownMessages(request.knownMessages));
			}
			this.batchFlushScheduled = false;
			const pendingBatch = this.pendingBatch.splice(0);
			if (pendingBatch.length > 0) this.discardPendingBatch(pendingBatch);
			this.dimensionsUnsubscribe?.();
			this.dimensionsUnsubscribe = null;
			this.stopPingPong();
			if (!this.worker) {
				this.sentMessages.clear();
				return;
			}
			const workerToDestroy = this.worker;
			this.worker = null;
			workerToDestroy.postMessage({ type: "destroy" });
			let terminated = false;
			let terminationTimeout = null;
			const finalizeWorkerTermination = () => {
				if (terminated) return;
				terminated = true;
				if (terminationTimeout !== null) {
					clearTimeout(terminationTimeout);
					terminationTimeout = null;
				}
				workerToDestroy.removeEventListener("message", messageHandler);
				workerToDestroy.terminate();
				if (this.worker === workerToDestroy) this.worker = null;
				this.deps.imageFetchManager.workerBitmapCache.clear();
			};
			const messageHandler = (event) => {
				if (event.data?.type === "ack") finalizeWorkerTermination();
			};
			workerToDestroy.addEventListener("message", messageHandler);
			terminationTimeout = setTimeout(finalizeWorkerTermination, 500);
			this.active = false;
			this.sentMessages.clear();
		}
		pruneSentMessages(activeIds, pendingIds) {
			if (!Array.isArray(activeIds) && !Array.isArray(pendingIds)) return;
			const currentIds = new Set();
			for (const id of [...Array.isArray(activeIds) ? activeIds : [], ...Array.isArray(pendingIds) ? pendingIds : []]) if (typeof id === "string") currentIds.add(id);
			for (const id of this.sentMessages.keys()) if (!currentIds.has(id)) this.sentMessages.delete(id);
		}
		takeSentMessages(ids) {
			const messages = [];
			for (const id of ids) {
				if (typeof id !== "string") continue;
				const message = this.sentMessages.get(id);
				if (message) {
					messages.push(message);
					this.sentMessages.delete(id);
				}
			}
			return messages;
		}
		takeKnownMessages(knownMessages) {
			const messages = [...knownMessages.values()];
			for (const [id, message] of knownMessages) if (this.sentMessages.get(id) === message) this.sentMessages.delete(id);
			return messages;
		}
		computeBurstSpeedMultiplier() {
			const baseSpeed = this.deps.settings.speedPxPerSec;
			const safeSpeed = Math.max(1, baseSpeed);
			return Math.max(1, this.deps.getEffectiveSpeedPxPerSec() / safeSpeed);
		}
	};
	var MAX_ENTRIES = 20;
	var ChannelLanguageMemory = class ChannelLanguageMemory {
		map = new Map();
		static keyFromUrl(url) {
			try {
				const u = new URL(url);
				if (u.hostname !== "www.youtube.com") return null;
				if (isYouTubeWatch(url)) return u.searchParams.get("v");
				const segments = u.pathname.split("/").filter(Boolean);
				if (segments[0] === "live" && segments[1]) return segments[1];
				if (segments[0]?.startsWith("@")) return segments[0];
				if (segments[0] === "channel" && segments[1]) return segments[1];
				return null;
			} catch {
				return null;
			}
		}
		static keyFromDocument(doc) {
			const metaChannelId = doc.querySelector("meta[itemprop=\"channelId\"]");
			if (metaChannelId?.content) return metaChannelId.content;
			const ownerLink = doc.querySelector("#owner ytd-channel-name a");
			if (ownerLink) {
				const path = ownerLink.getAttribute("href");
				if (path) return ChannelLanguageMemory.keyFromUrl(`https://www.youtube.com${path}`);
			}
			return null;
		}
		static resolveKey(url, doc) {
			const urlKey = ChannelLanguageMemory.keyFromUrl(url);
			if (!urlKey) return null;
			if (doc && (isYouTubeWatch(url) || isYouTubeLive(url))) {
				const channelKey = ChannelLanguageMemory.keyFromDocument(doc);
				if (channelKey) return channelKey;
			}
			return urlKey;
		}
		get(key) {
			const language = this.map.get(key);
			if (language === void 0) return void 0;
			this.map.delete(key);
			this.map.set(key, language);
			return language;
		}
		set(key, lang) {
			this.map.delete(key);
			if (this.map.size >= MAX_ENTRIES) {
				const first = this.map.keys().next().value;
				if (first) this.map.delete(first);
			}
			this.map.set(key, lang);
		}
		clear() {
			this.map.clear();
		}
		get size() {
			return this.map.size;
		}
	};
	var log$9 = createLogger("LanguageDetector");
	var UNICODE_HINTS = [
		["ja", [12352, 12447]],
		["ja", [12448, 12543]],
		["ko", [44032, 55215]],
		["zh-CN", [19968, 40959]],
		["es", [192, 255]],
		["ar", [1536, 1791]]
	];
	function detectByUnicodeRange(text) {
		const scores = new Map();
		const sample = text.slice(0, 100);
		for (const ch of sample) {
			const cp = ch.codePointAt(0);
			if (cp === void 0) continue;
			for (const [lang, [lo, hi]] of UNICODE_HINTS) if (cp >= lo && cp <= hi) scores.set(lang, (scores.get(lang) ?? 0) + 1);
		}
		if (scores.size === 0) return "en";
		return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
	}
	var LanguageDetectorService = class LanguageDetectorService {
		detector = null;
		initPromise = null;
		lifecycleGeneration = 0;
		static isSupported() {
			return typeof LanguageDetector !== "undefined" && typeof LanguageDetector?.create === "function";
		}
		async initialize() {
			if (!LanguageDetectorService.isSupported()) {
				log$9.info("translation.detector.api-unavailable");
				return;
			}
			if (this.detector) return;
			if (this.initPromise) {
				await this.initPromise;
				return;
			}
			const generation = this.lifecycleGeneration;
			const initPromise = this.doInit(generation);
			this.initPromise = initPromise;
			try {
				await initPromise;
			} finally {
				if (this.initPromise === initPromise) this.initPromise = null;
			}
		}
		async doInit(generation) {
			if (typeof LanguageDetector?.capabilities !== "function") {
				log$9.info("translation.detector.api-mismatch");
				return;
			}
			try {
				const caps = await LanguageDetector.capabilities();
				if (!caps || caps.available === "no") {
					log$9.warn("translation.detector.device-unavailable");
					return;
				}
				if (typeof LanguageDetector.create === "function") {
					const detector = await LanguageDetector.create();
					if (generation !== this.lifecycleGeneration) {
						detector.destroy();
						return;
					}
					this.detector = detector;
				}
				log$9.info("translation.detector.ready");
			} catch (err) {
				log$9.warn("translation.detector.create-failed", { error: String(err) });
			}
		}
		async detect(text) {
			if (!text.trim()) return "en";
			if (this.detector) try {
				const top = (await this.detector.detect(text))[0];
				if (top && top.confidence >= .5) {
					const mapped = this.mapBcp47(top.detectedLanguage);
					if (mapped) return mapped;
				}
			} catch (err) {
				log$9.debug("translation.detector.detect-failed", { error: String(err) });
			}
			return detectByUnicodeRange(text) ?? "en";
		}
		async detectFromSamples(samples) {
			const votes = new Map();
			for (const sample of samples) {
				const lang = await this.detect(sample);
				votes.set(lang, (votes.get(lang) ?? 0) + 1);
			}
			if (votes.size === 0) return "en";
			return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
		}
		mapBcp47(bcp47) {
			switch (bcp47.split("-")[0]?.toLowerCase()) {
				case "en": return "en";
				case "ko": return "ko";
				case "ja": return "ja";
				case "es": return "es";
				case "zh": return "zh-CN";
				case "zh-CN": return "zh-CN";
				case "ar": return "ar";
				default: return null;
			}
		}
		destroy() {
			this.lifecycleGeneration++;
			if (this.detector) {
				try {
					this.detector.destroy();
				} catch {}
				this.detector = null;
			}
			this.initPromise = null;
		}
	};
	function getTranslator() {
		return typeof Translator !== "undefined" ? Translator : void 0;
	}
	function isTranslationSupported() {
		return typeof Translator !== "undefined";
	}
	var log$8 = createLogger("TranslationService");
	var TRANSLATION_CANCELLED = Symbol("translation-cancelled");
	var TranslationService = class TranslationService {
		translator = null;
		currentTarget = null;
		currentSource = null;
		enabled = false;
		lifecyclePromise = Promise.resolve();
		configurationGeneration = 0;
		translatorGeneration = null;
		configuringGeneration = null;
		configurationCancellation = null;
		translateQueue = [];
		activeEntry = null;
		activeCancellation = null;
		drainActive = false;
		drainRestartRequested = false;
		pendingSource = null;
		pendingTarget = null;
		consecutiveFailures = 0;
		static MAX_CONSECUTIVE_FAILURES = 6;
		recoveryCycleCount = 0;
		static MAX_RECOVERY_CYCLES = 3;
		lastSuccessTimestamp = 0;
		static RECOVERY_RESET_MS = 3e5;
		translationCache = new ResizableByteLimitedCache(5e4, (text) => text.length * 2);
		static MAX_TRANSLATE_QUEUE_SIZE = 1e3;
		async configure(settings) {
			const resolvedTarget = settings.target === "auto" ? resolveTranslationTarget("auto") : settings.target;
			const resolvedSource = settings.source === "auto" ? "en" : settings.source;
			this.enabled = settings.enabled && settings.service === "auto";
			if (!this.enabled) {
				this.disableTranslation();
				return;
			}
			if (!getTranslator()) {
				log$8.warn("translation.service.api-unavailable");
				this.disableTranslation();
				return;
			}
			const reservation = this.reserveConfiguration(resolvedSource, resolvedTarget);
			if (reservation === null) return;
			const { generation, cancellation } = reservation;
			await this.enqueueLifecycleOperation(async () => {
				if (!this.enabled || generation !== this.configurationGeneration) return;
				if (!getTranslator()) {
					log$8.warn("translation.service.api-unavailable");
					this.disableTranslation();
					return;
				}
				if (resolvedTarget === this.currentTarget && resolvedSource === this.currentSource && this.translatorGeneration === this.configurationGeneration) return;
				await this.doConfigure(resolvedSource, resolvedTarget, generation, cancellation);
			});
		}
		async onUserActivation() {
			if (!this.enabled) return;
			this.resetRecoveryCyclesIfExpired();
			if (this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES) return;
			const source = this.pendingSource;
			const target = this.pendingTarget;
			if (!source || !target) return;
			const reservation = this.reserveConfiguration(source, target);
			if (reservation === null) return;
			const { generation, cancellation } = reservation;
			await this.enqueueLifecycleOperation(async () => {
				if (!this.enabled || generation !== this.configurationGeneration || this.pendingSource !== source || this.pendingTarget !== target) return;
				log$8.info("translation.service.retry-user-activation");
				await this.doConfigure(source, target, generation, cancellation, true);
			});
		}
		async setDetectedSource(source) {
			if (!this.enabled) return;
			const target = this.pendingTarget ?? this.currentTarget;
			const configuredSource = this.pendingSource ?? this.currentSource;
			if (!target || source === configuredSource) return;
			const reservation = this.reserveConfiguration(source, target);
			if (reservation === null) return;
			const { generation, cancellation } = reservation;
			await this.enqueueLifecycleOperation(async () => {
				if (!this.enabled || generation !== this.configurationGeneration || this.pendingSource !== source || this.pendingTarget !== target) return;
				await this.doConfigure(source, target, generation, cancellation);
			});
		}
		enqueueLifecycleOperation(operation) {
			const operationPromise = this.lifecyclePromise.then(operation);
			this.lifecyclePromise = operationPromise.catch(() => void 0);
			return operationPromise;
		}
		reserveConfiguration(sourceLanguage, targetLanguage) {
			if (sourceLanguage === this.currentSource && targetLanguage === this.currentTarget && this.translator !== null && this.translatorGeneration === this.configurationGeneration) return null;
			if (sourceLanguage === this.pendingSource && targetLanguage === this.pendingTarget && this.configuringGeneration === this.configurationGeneration) {
				const cancellation = this.configurationCancellation;
				if (cancellation) return {
					generation: this.configurationGeneration,
					cancellation
				};
			}
			this.cancelConfiguration();
			const generation = this.configurationGeneration + 1;
			this.configurationGeneration = generation;
			this.translatorGeneration = null;
			this.configuringGeneration = generation;
			const cancellation = this.createConfigurationCancellation();
			this.configurationCancellation = cancellation;
			this.cancelActiveTranslation();
			this.resolveStaleQueueEntries(generation);
			this.pendingSource = sourceLanguage;
			this.pendingTarget = targetLanguage;
			return {
				generation,
				cancellation
			};
		}
		createConfigurationCancellation() {
			let resolveCancellation;
			const cancellation = {
				promise: new Promise((resolve) => {
					resolveCancellation = resolve;
				}),
				cancelled: false,
				cancel: () => {
					if (cancellation.cancelled) return;
					cancellation.cancelled = true;
					resolveCancellation?.();
				}
			};
			return cancellation;
		}
		cancelConfiguration() {
			this.configurationCancellation?.cancel();
			this.configurationCancellation = null;
		}
		async raceConfiguration(operation, cancellation, onCancelledValue) {
			const operationPromise = Promise.resolve(operation);
			const result = await Promise.race([operationPromise.then((value) => ({
				cancelled: false,
				value
			}), (error) => Promise.reject(error)), cancellation.promise.then(() => ({ cancelled: true }))]);
			if (result.cancelled || cancellation.cancelled) {
				if (onCancelledValue) operationPromise.then(onCancelledValue, () => void 0);
				return { cancelled: true };
			}
			return result;
		}
		resolveQueueEntry(entry, result) {
			if (entry.settled) return;
			entry.settled = true;
			entry.resolve(result);
		}
		cancelActiveTranslation() {
			const cancellation = this.activeCancellation;
			this.activeCancellation = null;
			cancellation?.();
			const activeEntry = this.activeEntry;
			if (activeEntry) this.resolveQueueEntry(activeEntry, null);
		}
		resolveStaleQueueEntries(generation) {
			const currentEntries = [];
			for (const entry of this.translateQueue) if (entry.generation === generation) currentEntries.push(entry);
			else this.resolveQueueEntry(entry, null);
			this.translateQueue = currentEntries;
		}
		disableTranslation() {
			this.cancelConfiguration();
			this.configurationGeneration++;
			this.configuringGeneration = null;
			this.translatorGeneration = null;
			this.cancelActiveTranslation();
			this.disposeTranslator(this.translator);
			this.translator = null;
			this.currentTarget = null;
			this.currentSource = null;
			this.pendingSource = null;
			this.pendingTarget = null;
			this.enabled = false;
			for (const entry of this.translateQueue) this.resolveQueueEntry(entry, null);
			this.translateQueue = [];
		}
		startDrainIfNeeded() {
			if (this.translateQueue.length === 0) return;
			if (this.drainActive) {
				this.drainRestartRequested = true;
				return;
			}
			this.drainActive = true;
			this.drainQueue();
		}
		resolveQueueEntriesForGeneration(generation) {
			const remainingEntries = [];
			for (const entry of this.translateQueue) if (entry.generation === generation) this.resolveQueueEntry(entry, null);
			else remainingEntries.push(entry);
			this.translateQueue = remainingEntries;
		}
		isGenerationReady(generation) {
			return this.enabled && this.translator !== null && this.configurationGeneration === generation && this.translatorGeneration === generation;
		}
		resolveQueueAfterRecovery() {
			this.resetRecoveryCyclesIfExpired();
			if (this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES) {
				log$8.warn(`Translator died ${this.recoveryCycleCount} times — disabling auto-recovery for this session. Open settings and click Save to retry.`);
				this.pendingSource = null;
				this.pendingTarget = null;
			}
			while (this.translateQueue.length > 0) {
				const next = this.translateQueue.shift();
				if (next) this.resolveQueueEntry(next, null);
			}
		}
		resetRecoveryCyclesIfExpired() {
			if (this.lastSuccessTimestamp > 0 && Date.now() - this.lastSuccessTimestamp > TranslationService.RECOVERY_RESET_MS) {
				log$8.debug("translation.service.recovery-reset");
				this.recoveryCycleCount = 0;
			}
		}
		disposeTranslator(translator, logMessage = "translation.service.destroy-failed") {
			if (!translator) return;
			try {
				translator.destroy();
			} catch {
				log$8.debug(logMessage);
			}
		}
		async doConfigure(sourceLanguage, targetLanguage, generation, cancellation, preserveRecoveryCount = false) {
			this.translatorGeneration = null;
			this.configuringGeneration = generation;
			this.cancelActiveTranslation();
			this.resolveStaleQueueEntries(generation);
			this.pendingSource = sourceLanguage;
			this.pendingTarget = targetLanguage;
			try {
				const availabilityResult = await this.raceConfiguration(getTranslator()?.availability({
					sourceLanguage,
					targetLanguage
				}), cancellation);
				if (availabilityResult.cancelled) return;
				const availability = availabilityResult.value;
				if (generation !== this.configurationGeneration || !this.enabled) return;
				if (availability === "unavailable") {
					log$8.warn(`Translator not available for ${sourceLanguage}→${targetLanguage} (unsupported language pair).`);
					this.disposeTranslator(this.translator);
					this.translator = null;
					this.currentTarget = null;
					this.currentSource = null;
					this.configuringGeneration = null;
					this.resolveQueueEntriesForGeneration(generation);
					return;
				}
				const createResult = await this.raceConfiguration(getTranslator()?.create({
					sourceLanguage,
					targetLanguage,
					monitor: (monitor) => {
						monitor.addEventListener("downloadprogress", (e) => {
							const evt = e;
							if (evt.total > 0) log$8.debug(`Translator model download: ${Math.round(evt.loaded / evt.total * 100)}%`);
						});
					}
				}), cancellation, (createdTranslator) => {
					if (createdTranslator) this.disposeTranslator(createdTranslator);
				});
				if (createResult.cancelled) return;
				const newTranslator = createResult.value ?? null;
				if (generation !== this.configurationGeneration || !this.enabled) {
					this.disposeTranslator(newTranslator);
					return;
				}
				if (!newTranslator) {
					this.configuringGeneration = null;
					this.translatorGeneration = null;
					this.disposeTranslator(this.translator);
					this.translator = null;
					this.currentTarget = null;
					this.currentSource = null;
					this.resolveQueueEntriesForGeneration(generation);
					return;
				}
				const previousTranslator = this.translator;
				this.translator = newTranslator;
				this.currentTarget = targetLanguage;
				this.currentSource = sourceLanguage;
				this.configuringGeneration = null;
				this.translatorGeneration = generation;
				this.pendingSource = null;
				this.pendingTarget = null;
				this.consecutiveFailures = 0;
				if (!preserveRecoveryCount) this.recoveryCycleCount = 0;
				this.lastSuccessTimestamp = 0;
				if (previousTranslator && previousTranslator !== newTranslator) this.disposeTranslator(previousTranslator);
				log$8.info("translation.service.ready", {
					source: sourceLanguage,
					target: targetLanguage
				});
				this.startDrainIfNeeded();
			} catch (err) {
				if (generation !== this.configurationGeneration) return;
				log$8.warn("translation.service.create-failed", { error: String(err) });
				this.disposeTranslator(this.translator);
				this.translator = null;
				this.currentTarget = null;
				this.currentSource = null;
				this.configuringGeneration = null;
				this.translatorGeneration = null;
				this.resolveQueueEntriesForGeneration(generation);
			}
		}
		static isSupported() {
			return isTranslationSupported();
		}
		get isActive() {
			return this.isGenerationReady(this.configurationGeneration);
		}
		get isEnabled() {
			return this.enabled;
		}
		async translate(text) {
			if (!text.trim()) return text;
			if (!this.enabled) return null;
			const cacheKey = `${this.pendingSource ?? this.currentSource ?? "auto"}:${this.pendingTarget ?? this.currentTarget}:${text}`;
			const cached = this.translationCache.get(cacheKey);
			if (cached !== void 0) return cached;
			return new Promise((resolve) => {
				if (this.translateQueue.length >= TranslationService.MAX_TRANSLATE_QUEUE_SIZE) {
					const dropped = this.translateQueue.shift();
					if (dropped) this.resolveQueueEntry(dropped, null);
					log$8.debug(`Translate queue at capacity (${TranslationService.MAX_TRANSLATE_QUEUE_SIZE}) — dropped oldest entry`);
				}
				this.translateQueue.push({
					text,
					cacheKey,
					generation: this.configurationGeneration,
					resolve,
					settled: false
				});
				this.startDrainIfNeeded();
			});
		}
		async drainQueue() {
			try {
				while (this.translateQueue.length > 0) {
					const queuedEntry = this.translateQueue[0];
					if (!queuedEntry) break;
					if (queuedEntry.generation !== this.configurationGeneration) {
						const staleEntry = this.translateQueue.shift();
						if (staleEntry) this.resolveQueueEntry(staleEntry, null);
						continue;
					}
					if (!this.isGenerationReady(queuedEntry.generation)) {
						const recoveryCapped = !this.translator && this.recoveryCycleCount >= TranslationService.MAX_RECOVERY_CYCLES && !this.pendingSource && !this.pendingTarget;
						if (!this.enabled || recoveryCapped) {
							this.resolveQueueEntriesForGeneration(queuedEntry.generation);
							continue;
						}
						if (!this.translator && this.enabled && this.pendingSource && this.pendingTarget && this.configuringGeneration !== queuedEntry.generation) this.resolveQueueAfterRecovery();
						break;
					}
					const entry = this.translateQueue.shift();
					if (!entry) break;
					this.activeEntry = entry;
					try {
						const reCached = this.translationCache.get(entry.cacheKey);
						if (reCached !== void 0) {
							this.resolveQueueEntry(entry, reCached);
							continue;
						}
						const translator = this.translator;
						if (!translator) {
							this.resolveQueueEntry(entry, null);
							continue;
						}
						let cancel = null;
						const cancellation = new Promise((resolve) => {
							cancel = () => resolve(TRANSLATION_CANCELLED);
							this.activeCancellation = cancel;
						});
						try {
							const result = await Promise.race([translator.translate(entry.text), cancellation]);
							if (result === TRANSLATION_CANCELLED) {
								this.resolveQueueEntry(entry, null);
								continue;
							}
							if (entry.generation !== this.configurationGeneration || this.translator !== translator || !this.enabled) {
								this.resolveQueueEntry(entry, null);
								continue;
							}
							this.consecutiveFailures = 0;
							this.lastSuccessTimestamp = Date.now();
							this.translationCache.set(entry.cacheKey, result);
							this.resolveQueueEntry(entry, result);
						} catch (err) {
							if (entry.generation !== this.configurationGeneration || this.translator !== translator || !this.enabled) {
								this.resolveQueueEntry(entry, null);
								continue;
							}
							this.consecutiveFailures++;
							const errName = err instanceof DOMException ? err.name : "Unknown";
							if (this.consecutiveFailures >= TranslationService.MAX_CONSECUTIVE_FAILURES) {
								this.recoveryCycleCount++;
								if (this.recoveryCycleCount === 1) log$8.warn(`Translator failed ${this.consecutiveFailures} times consecutively (last: ${errName}) — invalidating instance for recovery`);
								else log$8.debug(`Translator failed again (cycle #${this.recoveryCycleCount}, last: ${errName}) — invalidating instance`);
								if (!this.pendingSource && this.currentSource) this.pendingSource = this.currentSource;
								if (!this.pendingTarget && this.currentTarget) this.pendingTarget = this.currentTarget;
								this.disposeTranslator(translator);
								this.translator = null;
								this.currentTarget = null;
								this.currentSource = null;
								this.consecutiveFailures = 0;
							} else log$8.debug("translation.service.translate-failed", {
								errorName: errName,
								error: String(err)
							});
							this.resolveQueueEntry(entry, null);
						} finally {
							if (cancel && this.activeCancellation === cancel) this.activeCancellation = null;
						}
					} finally {
						if (this.activeEntry === entry) this.activeEntry = null;
					}
				}
			} finally {
				this.drainActive = false;
				const restartRequested = this.drainRestartRequested;
				this.drainRestartRequested = false;
				if (restartRequested) this.startDrainIfNeeded();
			}
		}
		destroy() {
			this.cancelConfiguration();
			this.configurationGeneration++;
			this.configuringGeneration = null;
			this.translatorGeneration = null;
			this.cancelActiveTranslation();
			this.disposeTranslator(this.translator, "translation.service.shutdown-destroy-failed");
			this.translator = null;
			this.currentTarget = null;
			this.currentSource = null;
			this.pendingSource = null;
			this.pendingTarget = null;
			this.enabled = false;
			this.consecutiveFailures = 0;
			this.recoveryCycleCount = 0;
			this.lastSuccessTimestamp = 0;
			for (const entry of this.translateQueue) this.resolveQueueEntry(entry, null);
			this.translateQueue = [];
			this.translationCache.clear();
		}
	};
	var DENSITY_CONFIG = {
		elevated: {
			label: t("indicator.busy"),
			bg: "rgba(255,193,7,0.8)",
			color: "#000"
		},
		high: {
			label: t("indicator.heavy"),
			bg: "rgba(255,87,34,0.85)",
			color: "#fff"
		},
		extreme: {
			label: t("indicator.overload"),
			bg: "rgba(244,67,54,0.9)",
			color: "#fff"
		}
	};
	var DensityIndicator = class {
		el = null;
		currentLevel = "normal";
		create(parent) {
			if (this.el) return;
			const el = document.createElement("div");
			el.style.cssText = "position:absolute;bottom:8px;left:8px;z-index:99;font:11px/1.4 sans-serif;padding:3px 8px;border-radius:3px;pointer-events:none;opacity:0;transition:opacity 0.4s";
			parent.appendChild(el);
			this.el = el;
		}
		update(activeCount, maxConcurrent) {
			if (!this.el) return;
			const ratio = activeCount / Math.max(1, maxConcurrent);
			let level;
			if (ratio > .85) level = "extreme";
			else if (ratio > .65) level = "high";
			else if (ratio > .45) level = "elevated";
			else level = "normal";
			if (level === this.currentLevel) return;
			this.currentLevel = level;
			if (level === "normal") {
				this.el.style.opacity = "0";
				return;
			}
			const config = DENSITY_CONFIG[level];
			this.el.textContent = config.label;
			this.el.style.background = config.bg;
			this.el.style.color = config.color;
			this.el.style.opacity = "0.85";
		}
		destroy() {
			if (this.el) {
				this.el.remove();
				this.el = null;
			}
			this.currentLevel = "normal";
		}
	};
	var MapCompatibleLruMap = class extends Map {
		maxSize;
		constructor(maxSize) {
			super();
			this.maxSize = maxSize;
			if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new RangeError("maxSize must be a positive safe integer");
		}
		set(key, value) {
			if (this.has(key)) this.delete(key);
			else if (this.size >= this.maxSize) {
				const oldest = this.keys().next();
				if (!oldest.done) this.delete(oldest.value);
			}
			return super.set(key, value);
		}
		get(key) {
			if (!this.has(key)) return void 0;
			const value = super.get(key);
			this.delete(key);
			super.set(key, value);
			return value;
		}
	};
	var MessageActivator = class {
		messagePool = [];
		translationService;
		config;
		constructor(translationService, config) {
			this.translationService = translationService;
			this.config = config;
		}
		acquireMessage() {
			return this.messagePool.pop() ?? {
				message: EMPTY_CHAT_MESSAGE,
				startTime: 0,
				fadeStartTime: 0,
				duration: 0,
				invDuration: 0,
				width: 0,
				height: 0,
				startX: 0,
				x: 0,
				y: 0,
				pausedDuration: 0,
				laneIndex: 0,
				staggerDelay: 0,
				speedTier: 0,
				renderMessage: EMPTY_CHAT_MESSAGE,
				ghostText: "",
				laneArrayIndices: []
			};
		}
		releaseMessage(msg) {
			msg.message = EMPTY_CHAT_MESSAGE;
			msg.renderMessage = EMPTY_CHAT_MESSAGE;
			msg.translatedText = null;
			msg.ghostText = "";
			delete msg.translatedRenderMessage;
			delete msg.desaturatedUserColor;
			this.messagePool.push(msg);
		}
		activate(message, now, msgWidth, msgHeight, laneY, callbacks, duration, startX, laneIndex, staggerDelay = 0, speedTier) {
			const effectiveDuration = duration ?? this.config.topBottomDurationMs;
			const effectiveStartX = startX ?? 0;
			const cm = this.acquireMessage();
			Object.assign(cm, {
				message,
				fadeStartTime: now + staggerDelay,
				startTime: now + staggerDelay,
				duration: effectiveDuration,
				invDuration: 1 / Math.max(1, effectiveDuration),
				width: msgWidth,
				height: msgHeight,
				startX: effectiveStartX,
				x: effectiveStartX,
				y: laneY,
				pausedDuration: 0,
				laneIndex: laneIndex ?? 0,
				staggerDelay,
				speedTier: speedTier ?? SPEED_TIER.MID,
				renderMessage: message,
				ghostText: getDisplayText(message.content)
			});
			if (this.config.depthLayersEnabled && speedTier === SPEED_TIER.FAR && message.userColor) {
				cm.desaturatedUserColor = desaturateColor(message.userColor, FAR_LAYER_DESATURATION_FACTOR);
				cm.renderMessage = {
					...message,
					userColor: cm.desaturatedUserColor
				};
			} else cm.renderMessage = message;
			callbacks.onActivated(cm);
			callbacks.onMessageRendered();
			const translatableText = getTranslatableText(message);
			if (this.translationService.isEnabled && translatableText) {
				const capturedId = message.id;
				this.translationService.translate(translatableText).then((translated) => {
					if (cm.message.id === capturedId) callbacks.onTranslationResult(cm, translated);
				}).catch(() => {});
			}
		}
	};
	var HighFirstPriorityBucketQueue = class {
		buckets = new Map();
		priorityLevels = [];
		_size = 0;
		get size() {
			return this._size;
		}
		get isEmpty() {
			return this._size === 0;
		}
		enqueue(message, priority) {
			let entry = this.buckets.get(priority);
			if (!entry) {
				entry = {
					msgs: [],
					offset: 0
				};
				this.buckets.set(priority, entry);
				this.priorityLevels = Array.from(this.buckets.keys()).sort((a, b) => b - a);
			}
			entry.msgs.push(message);
			this._size++;
		}
		dequeue() {
			for (const prio of this.priorityLevels) {
				const entry = this.buckets.get(prio);
				if (!entry) continue;
				const { msgs } = entry;
				if (entry.offset < msgs.length) {
					const msg = msgs[entry.offset];
					if (!msg) continue;
					entry.offset++;
					this._size--;
					if (entry.offset > 0 && entry.offset >= msgs.length / 2) {
						entry.msgs = msgs.slice(entry.offset);
						entry.offset = 0;
					}
					return msg;
				}
			}
		}
		peek() {
			for (const prio of this.priorityLevels) {
				const entry = this.buckets.get(prio);
				if (!entry) continue;
				if (entry.offset < entry.msgs.length) return entry.msgs[entry.offset];
			}
		}
		peekLowest() {
			for (let i = this.priorityLevels.length - 1; i >= 0; i--) {
				const prio = this.priorityLevels[i];
				if (prio === void 0) continue;
				const entry = this.buckets.get(prio);
				if (!entry) continue;
				if (entry.offset < entry.msgs.length) return entry.msgs[entry.msgs.length - 1];
			}
		}
		dropLowest() {
			for (let i = this.priorityLevels.length - 1; i >= 0; i--) {
				const prio = this.priorityLevels[i];
				if (prio === void 0) continue;
				const entry = this.buckets.get(prio);
				if (!entry) continue;
				if (entry.offset < entry.msgs.length) {
					entry.offset++;
					this._size--;
					return;
				}
			}
		}
		removeAll(messages) {
			if (messages.length === 0) return 0;
			const toRemove = new Set(messages);
			let removed = 0;
			for (const prio of this.priorityLevels) {
				const entry = this.buckets.get(prio);
				if (!entry) continue;
				const { msgs } = entry;
				if (entry.offset >= msgs.length) continue;
				let writeIdx = entry.offset;
				for (let i = entry.offset; i < msgs.length; i++) {
					const msg = msgs[i];
					if (msg !== void 0 && !toRemove.has(msg)) msgs[writeIdx++] = msg;
					else removed++;
				}
				msgs.length = writeIdx;
			}
			this._size -= removed;
			return removed;
		}
		clear() {
			this.buckets.clear();
			this.priorityLevels = [];
			this._size = 0;
		}
		toArray() {
			const result = [];
			for (const prio of this.priorityLevels) {
				const entry = this.buckets.get(prio);
				if (!entry) continue;
				for (let i = entry.offset; i < entry.msgs.length; i++) result.push(entry.msgs[i]);
			}
			return result;
		}
		trim(maxSize) {
			if (this._size <= maxSize) return;
			let toRemove = this._size - maxSize;
			for (let i = this.priorityLevels.length - 1; i >= 0 && toRemove > 0; i--) {
				const prio = this.priorityLevels[i];
				if (prio === void 0) continue;
				const entry = this.buckets.get(prio);
				if (!entry) continue;
				if (entry.offset < entry.msgs.length) {
					const activeCount = entry.msgs.length - entry.offset;
					const removeCount = Math.min(toRemove, activeCount);
					entry.msgs.length -= removeCount;
					this._size -= removeCount;
					toRemove -= removeCount;
				}
			}
		}
	};
	var YIELD_BUDGET_MS = 50;
	var hasPostTask = typeof globalThis !== "undefined" && globalThis.scheduler !== void 0 && typeof globalThis.scheduler.postTask === "function";
	function scheduleOverlayTask(fn, options) {
		if (hasPostTask) try {
			return globalThis.scheduler.postTask(fn, { priority: options?.priority ?? "user-visible" });
		} catch {}
		const priority = options?.priority ?? "user-visible";
		return new Promise((resolve, reject) => {
			setTimeout(() => {
				try {
					resolve(fn());
				} catch (error) {
					reject(error);
				}
			}, priority === "background" ? 4 : 0);
		});
	}
	async function yieldAtDeadline(deadline, budgetMs = YIELD_BUDGET_MS) {
		if (performance.now() >= deadline) {
			await schedulerYield();
			return performance.now() + budgetMs;
		}
		return deadline;
	}
	var log$7 = createLogger("RendererCanvas");
	var CANVAS_CSS = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;text-rendering:optimizeSpeed";
	var DISCONNECTED_DOT_ALPHA = .15;
	var fallbackMessageIdCounter = 0;
	var CanvasRenderer = class CanvasRenderer extends RendererBase {
		canvas = null;
		statusActionButton = null;
		_destroyed = false;
		fallbackInProgress = false;
		ctx = null;
		animFrameId = null;
		invFadeDuration = 0;
		overlayDimensionsUnsubscribe = null;
		overlayUserPauseUnsubscribe = null;
		densityIndicator = new DensityIndicator();
		needsRerender = false;
		imageFetchManager;
		activeMessages = [];
		activeMessagesByLane = new Map();
		pendingQueue = new HighFirstPriorityBucketQueue();
		reducedMotionQuery = null;
		reducedMotion = false;
		reducedMotionListener = null;
		lastDpr = 0;
		idleSince = null;
		antiBlockSinceRef = { value: null };
		offscreenPollCleanup = null;
		offscreenObserver = null;
		connectionStatus = "connected";
		statusRegion = null;
		translationService;
		messageActivator;
		languageDetector = null;
		channelMemory = null;
		sourceDetectionDone = false;
		sourceSampleBuffer = [];
		sourceDetectionRun = null;
		sourceDetectionGeneration = 0;
		static SOURCE_SAMPLE_COUNT = 8;
		translationBatchSize;
		pendingTranslations = [];
		pendingTranslationReadIdx = 0;
		translationConfigurationGeneration = 0;
		expiredMessagesScratch = [];
		workerManager;
		textBitmapCache = new ResizableByteLimitedCache(this.settings.textCacheMb * 1e6, (c) => c.width * c.height * 4);
		superChatGradientCache = new MapCompatibleLruMap(64);
		dimensionCache = new Map();
		static DIMENSION_CACHE_MAX = 1e3;
		farOpacityBuckets = Array.from({ length: 21 }, () => []);
		midOpacityBuckets = Array.from({ length: 21 }, () => []);
		nearOpacityBuckets = Array.from({ length: 21 }, () => []);
		cachedOpacityConfig;
		boundGetFont = (fs) => this.getFont(fs);
		boundMeasureTextWidth = (text) => measureTextWidth(text, this.boundGetFont(this.settings.fontSize));
		regularRenderConfig = {
			showAuthor: true,
			fontSize: 1,
			fontWeight: "bold",
			fontFamily: "",
			color: "",
			outlineWidthPx: 0,
			outlineOpacity: 0,
			backgroundColor: "#00000000",
			messageWidth: 0,
			messageHeight: 0
		};
		renderContext = null;
		boundIsAntiBlockActive = () => this.isAntiBlockActive();
		boundDrainQueue = (now) => this.drainQueue(now);
		boundUpdateLiveRegion = (messages) => this.overlay.updateLiveRegion(messages);
		static STAGGER_EXP_TABLE = (() => {
			const t = new Float64Array(256);
			for (let i = 0; i < 256; i++) t[i] = -Math.log(1 - (i + .5) / 256);
			return t;
		})();
		hasRenderedStatusBar = false;
		lastLiveRegionUpdateRef = { value: 0 };
		constructor(overlay, settings) {
			super(overlay, settings);
			this.invFadeDuration = computeInvFadeDuration(settings.fadeDurationMs);
			this.translationBatchSize = settings.translationBatchSize;
			this.translationService = new TranslationService();
			if (settings.translationEnabled) this.initializeSourceDetectionPipeline();
			const channelKey = ChannelLanguageMemory.resolveKey(location.href, document);
			const cachedSource = channelKey ? this.channelMemory?.get(channelKey) : void 0;
			this.translationService.configure({
				enabled: settings.translationEnabled,
				service: settings.translationService,
				source: cachedSource ?? settings.translationSource,
				target: settings.translationTarget
			}).catch((err) => {
				log$7.debug("renderer.translation.configure-failed", { error: String(err) });
			});
			this.messageActivator = new MessageActivator(this.translationService, {
				topBottomDurationMs: settings.topBottomDurationMs,
				depthLayersEnabled: settings.depthLayersEnabled
			});
			const container = overlay.getContainer();
			const canvas = document.createElement("canvas");
			canvas.style.cssText = CANVAS_CSS;
			canvas.setAttribute("aria-hidden", "true");
			if (container) container.appendChild(canvas);
			this.canvas = canvas;
			if (container) this.densityIndicator.create(container);
			this.setupOffscreenObserver(canvas);
			const statusRegion = document.createElement("div");
			statusRegion.setAttribute("aria-live", "polite");
			statusRegion.setAttribute("role", "status");
			statusRegion.style.cssText = SCREEN_READER_CSS;
			if (container) container.appendChild(statusRegion);
			this.statusRegion = statusRegion;
			if (container) {
				const colors = statusBarLayout.colors.disconnected;
				const statusActionButton = document.createElement("button");
				statusActionButton.id = "yt-chat-overlay-status-action";
				statusActionButton.type = "button";
				statusActionButton.style.cssText = `position:absolute;left:50%;bottom:${statusBarLayout.bottomOffset}px;transform:translateX(-50%);display:none;align-items:center;pointer-events:auto;z-index:1;cursor:pointer;border:0;border-radius:${statusBarLayout.pillRadius}px;padding:${statusBarLayout.paddingY}px ${statusBarLayout.paddingX}px;background:${colors.bg};color:${colors.text};font:${statusBarLayout.fontSize}px/1.5 ${this.settings.fontFamily}`;
				statusActionButton.addEventListener("click", () => {
					if (this.connectionStatus === "disconnected") this.onStatusBarClick?.();
				});
				container.appendChild(statusActionButton);
				this.statusActionButton = statusActionButton;
			}
			this.imageFetchManager = new ImageFetchManager();
			this.workerManager = new RenderWorkerManager({
				settings: this.settings,
				observability: this.observability,
				imageFetchManager: this.imageFetchManager,
				estimateDimensions: (msg) => this.estimateDimensions(msg),
				getMessagePriority: CanvasRenderer.getMessagePriority,
				getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeedPxPerSec()
			});
			this.workerManager.setFatalErrorCallback((reason) => this.fallbackToMainThread(reason));
			const useWorker = this.workerManager.init(canvas, settings, overlay);
			if (useWorker) this.workerManager.setLiveRegionCallback((snippets) => overlay.updateLiveRegion(snippets));
			const dims = overlay.getDimensions();
			if (!useWorker) {
				this.ctx = canvas.getContext("2d", { desynchronized: true });
				if (!this.ctx) log$7.warn("renderer.canvas.get-context-failed", { reason: "no-2d-context" });
				else if (!canvas.isConnected) log$7.warn("renderer.canvas.not-connected", { reason: "not-in-dom" });
				canvas.addEventListener("contextlost", (e) => {
					e.preventDefault();
					this.ctx = null;
					log$7.warn("renderer.canvas.context-lost", { reason: "initial-create" });
				});
				canvas.addEventListener("contextrestored", () => this.handleContextRestored());
				this.applyDevicePixelRatio(dims);
			}
			this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
				if (d && this.canvas) {
					this.applyDevicePixelRatio(d);
					this.laneAllocator.reset(d);
					this.reflowActiveMessages(d);
				}
			});
			this.overlayUserPauseUnsubscribe = overlay.onUserPauseChanged((paused) => {
				this.setUserPaused(paused);
				if (this.workerManager.isActive) this.workerManager.setUserPaused(paused);
			});
			this.startRenderLoop();
			this.imageFetchManager.updateConfig(settings, this.workerManager.workerRef);
			this.imageFetchManager.setOnImageReady(() => {
				if (!this.isPaused && !this.isVideoPaused && !this.needsRerender) {
					if (this.animFrameId !== null) this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
					this.needsRerender = true;
					this.startRenderLoop();
				}
			});
			this.buildOpacityConfig();
			this.reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
			this.reducedMotion = this.reducedMotionQuery.matches;
			this.reducedMotionListener = (e) => {
				this.reducedMotion = e.matches;
				if (this.workerManager.isActive) this.workerManager.sendReducedMotion(e.matches);
			};
			this.reducedMotionQuery.addEventListener("change", this.reducedMotionListener);
			log$7.info("renderer.created", { mode: "canvas2d" });
		}
		reflowActiveMessages(dimensions) {
			const laneCount = this.laneAllocator.getLaneCount();
			const laneHeight = this.laneAllocator.getLaneHeight();
			if (laneCount <= 0 || laneHeight <= 0) return;
			const now = performance.now();
			const isScrolling = this.settings.danmakuMode === "scroll" || this.settings.danmakuMode === "reverse";
			this.activeMessagesByLane.clear();
			for (const message of this.activeMessages) {
				const requestedSlots = Math.max(1, message.slotCount ?? 1);
				const slotCount = Math.min(requestedSlots, laneCount);
				const laneIndex = Math.min(message.laneIndex, Math.max(0, laneCount - slotCount));
				message.laneIndex = laneIndex;
				message.slotCount = slotCount;
				message.y = this.laneAllocator.getLaneY(laneIndex, dimensions.height) + Math.floor((slotCount * laneHeight - message.height) / 2);
				message.laneArrayIndices.length = 0;
				const elapsed = Math.max(0, now - message.startTime - message.pausedDuration);
				const progress = Math.min(1, elapsed * message.invDuration);
				if (isScrolling) if (this.settings.danmakuMode === "scroll") {
					message.startX = dimensions.width;
					message.x = message.startX - progress * (message.startX + message.width + this.settings.exitPaddingPx);
				} else {
					message.startX = -message.width;
					message.x = message.startX + progress * (dimensions.width - message.startX + this.settings.exitPaddingPx);
				}
				else message.x = (dimensions.width - message.width) / 2;
				addMessageToLaneIndex(this.activeMessagesByLane, message, slotCount);
				const remainingDuration = Math.max(1, message.duration - elapsed);
				this.laneAllocator.commitPlacement({
					laneIndex,
					waitMs: 0,
					laneY: this.laneAllocator.getLaneY(laneIndex, dimensions.height),
					slotCount,
					verticalOffset: 0
				}, now, remainingDuration, isScrolling ? message.width : void 0, isScrolling ? dimensions.width : void 0, message.speedTier);
			}
		}
		get isReducedMotionActive() {
			return this.reducedMotion && !this.settings.ignoreReducedMotion;
		}
		get laneCount() {
			return this.laneAllocator.getLaneCount();
		}
		getLaneUtilization() {
			return this.laneAllocator.getUtilization();
		}
		setStandbyStatus(standby) {
			this.setConnectionStatus(standby ? "standby" : "connected");
		}
		setConnectionStatus(status) {
			if (status !== this.connectionStatus) this.hasRenderedStatusBar = false;
			this.connectionStatus = status;
			if (this.statusRegion) this.statusRegion.textContent = this.getStatusMessage(status);
			if (this.canvas) this.canvas.style.pointerEvents = "none";
			if (this.statusActionButton) {
				const isDisconnected = status === "disconnected";
				const statusMessage = this.getStatusMessage(status);
				this.statusActionButton.style.display = isDisconnected ? "flex" : "none";
				this.statusActionButton.textContent = statusMessage;
				this.statusActionButton.setAttribute("aria-label", statusMessage);
			}
			if (status !== "connected" && this.animFrameId === null) this.startRenderLoop();
		}
		setReplayMode(enabled) {
			super.setReplayMode(enabled);
			this.workerManager.sendReplayModeToWorker(enabled);
		}
		getQueueLength() {
			return this.pendingQueue.size + this.workerManager.queueDepth;
		}
		getActiveMessageCount() {
			return this.activeMessages.length + this.workerManager.activeMessageCount;
		}
		isWorkerAlive() {
			return this.workerManager.isActive ? this.workerManager.isAlive() : true;
		}
		applyLaneDensityIfChanged() {
			const changed = super.applyLaneDensityIfChanged();
			if (changed && this.workerManager.isActive) this.workerManager.sendLaneDensity(this.currentLaneDensityFactor);
			else if (changed) {
				const dimensions = this.overlay.getDimensions();
				if (dimensions) this.reflowActiveMessages(dimensions);
			}
			return changed;
		}
		addMessage(message) {
			if (!this.isMessageAllowed(message)) return;
			if (this.workerManager.isActive) {
				const msgId = message.id ?? `${message.timestamp}-${++fallbackMessageIdCounter}`;
				this.workerManager.sendToWorker(message, msgId);
				this.prefetchAndTranslateForWorker(message, msgId);
				this.lastRenderActivity = performance.now();
				return;
			}
			this.enqueueMessage(message, true);
		}
		replayMessage(message) {
			if (this.isVideoPaused) return;
			if (this.workerManager.isActive) {
				const msgId = message.id ?? `${message.timestamp}-${++fallbackMessageIdCounter}`;
				this.workerManager.sendToWorker(message, msgId);
				this.prefetchAndTranslateForWorker(message, msgId);
				return;
			}
			this.enqueueMessage(message, false);
		}
		onResumeFromVideoPause(messages) {
			for (const message of messages) if (this.workerManager.isActive) {
				const msgId = message.id ?? `${message.timestamp}-${++fallbackMessageIdCounter}`;
				this.workerManager.sendToWorker(message, msgId);
				this.prefetchAndTranslateForWorker(message, msgId);
			} else this.enqueueMessage(message, false);
		}
		enqueueMessage(message, trackDrops) {
			const priority = CanvasRenderer.getMessagePriority(message);
			this.imageFetchManager.prefetchImages(message);
			if (enqueueWithOverflow(this.pendingQueue, message, priority, (reason) => {
				if (trackDrops) this.observability.onMessageDropped(reason);
			}, this.settings.queueMaxSize) === "dropped") return;
			this.updateBacklogPause();
			if (this.pendingQueue.size === 1 && !this.isPaused && !this.isVideoPaused) {
				if (this.animFrameId !== null) this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
				this.startRenderLoop();
			}
		}
		trimBackgroundQueue() {
			if (this.pendingQueue.size <= this.settings.backgroundQueueMax) return;
			scheduleOverlayTask(() => {
				this.pendingQueue.trim(this.settings.backgroundQueueMax);
			}, { priority: "background" });
		}
		drainPendingQueue() {
			const messages = [];
			while (!this.pendingQueue.isEmpty) {
				const msg = this.pendingQueue.dequeue();
				if (msg) messages.push(msg);
			}
			return messages;
		}
		clearActiveMessages() {
			this.activeMessages.length = 0;
			this.activeMessagesByLane.clear();
		}
		clearPendingQueue() {
			this.pendingQueue.clear();
		}
		getPendingQueueMessages() {
			return this.pendingQueue.toArray();
		}
		resumeRenderLoop() {
			this.idleSince = null;
			this.hasRenderedStatusBar = false;
			this.startRenderLoop();
		}
		prepareForRefresh() {
			this.clearActiveMessages();
			this.clearPendingQueue();
			this.workerManager.clearState();
			this.backlogPaused = false;
			this.dimensionCache.clear();
			for (const bucket of this.farOpacityBuckets) bucket.length = 0;
			for (const bucket of this.midOpacityBuckets) bucket.length = 0;
			for (const bucket of this.nearOpacityBuckets) bucket.length = 0;
			this.idleSince = null;
			this.hasRenderedStatusBar = false;
			this.lastRenderActivity = performance.now();
		}
		applyDevicePixelRatio(dims) {
			const canvas = this.canvas;
			const ctx = this.ctx;
			if (!canvas || !ctx || !dims) return;
			this.lastDpr = applyDevicePixelRatio(canvas, ctx, dims);
		}
		startRenderLoop() {
			if (this.animFrameId !== null) return;
			this.idleSince = null;
			const loop = () => {
				if (!this.canvas?.isConnected) {
					this.animFrameId = null;
					return;
				}
				this.renderFrame();
				if (this.activeMessages.length === 0 && this.pendingQueue.isEmpty) if (!this.hasRenderedStatusBar && this.connectionStatus !== "connected") this.hasRenderedStatusBar = true;
				else {
					const now = performance.now();
					if (this.idleSince === null) this.idleSince = now;
					else if (now - this.idleSince >= 500) {
						this.animFrameId = null;
						this.idleSince = null;
						return;
					}
				}
				else this.idleSince = null;
				this.animFrameId = requestAnimationFrame(loop);
			};
			this.animFrameId = requestAnimationFrame(loop);
		}
		stopRenderLoop() {
			this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
		}
		setupOffscreenObserver(canvas) {
			this.offscreenObserver?.disconnect();
			this.stopOffscreenPoll();
			this.offscreenObserver = setupOffscreenObserver(canvas, () => {
				if (!this.isPaused) this.pause();
				this.startOffscreenPoll(canvas);
			}, () => {
				this.stopOffscreenPoll();
				if (this.isPaused && document.visibilityState !== "hidden") this.resume();
			});
		}
		startOffscreenPoll(canvas) {
			if (this.offscreenPollCleanup !== null) return;
			this.offscreenPollCleanup = startOffscreenPoll(canvas, () => {
				if (this.isPaused && document.visibilityState !== "hidden") this.resume();
			});
		}
		stopOffscreenPoll() {
			if (this.offscreenPollCleanup !== null) {
				this.offscreenPollCleanup();
				this.offscreenPollCleanup = null;
			}
		}
		renderFrame() {
			const ctx = this.ctx;
			const canvas = this.canvas;
			if (!ctx || !canvas) return;
			if (!canvas.isConnected) return;
			if (this.isPaused) return;
			if (this.isVideoPaused) return;
			if (this.isUserPaused) return;
			if (this.workerManager.isActive) return;
			const t0 = performance.now();
			this.needsRerender = false;
			const now = t0;
			const dims = this.overlay.getDimensions();
			if (!dims) return;
			const rctx = this.buildRenderContext();
			this.applyPendingTranslations();
			this.updateCanvasDpr(canvas, ctx, dims);
			ctx.clearRect(0, 0, dims.width, dims.height);
			const hasContent = this.activeMessages.length > 0 || this.connectionStatus !== "connected";
			if (this.connectionStatus !== "connected") this.renderStatusBar(ctx, dims);
			const mode = this.settings.danmakuMode;
			this.applyLaneDensityIfChanged();
			drainStage(rctx, now, dims);
			this.observability.updateLaneUtilization(this.laneAllocator.getUtilization());
			this.observability.tick();
			this.densityIndicator.update(this.activeMessages.length, this.settings.maxConcurrentMessages);
			if (!hasContent) return;
			const cleanupResult = cleanupAndBucketStage(rctx, now, dims, mode);
			if (cleanupResult.anyRemoved) compactRemovedMessages(rctx, cleanupResult.writeIdx, cleanupResult.oldLength);
			drawGlowStage(rctx, ctx, cleanupResult.farBuckets);
			drawGlowStage(rctx, ctx, cleanupResult.midBuckets);
			drawGlowStage(rctx, ctx, cleanupResult.nearBuckets);
			drawStage(rctx, ctx, cleanupResult.farBuckets);
			drawStage(rctx, ctx, cleanupResult.midBuckets);
			drawStage(rctx, ctx, cleanupResult.nearBuckets);
			mirrorVisibleMessages(rctx);
			this.observability.recordRenderFrame(performance.now() - t0);
		}
		buildRenderContext() {
			if (this.renderContext) {
				this.renderContext.settings = this.settings;
				this.renderContext.messageActivator = this.messageActivator;
				this.renderContext.cachedOpacityConfig = this.cachedOpacityConfig;
				this.renderContext.isReplayMode = this.isReplayMode;
				this.renderContext.isReducedMotionActive = this.isReducedMotionActive;
				return this.renderContext;
			}
			this.renderContext = {
				settings: this.settings,
				textBitmapCache: this.textBitmapCache,
				superChatGradientCache: this.superChatGradientCache,
				imageFetchManager: this.imageFetchManager,
				boundGetFont: this.boundGetFont,
				boundMeasureTextWidth: this.boundMeasureTextWidth,
				regularRenderConfig: this.regularRenderConfig,
				activeMessages: this.activeMessages,
				activeMessagesByLane: this.activeMessagesByLane,
				farOpacityBuckets: this.farOpacityBuckets,
				midOpacityBuckets: this.midOpacityBuckets,
				nearOpacityBuckets: this.nearOpacityBuckets,
				expiredMessagesScratch: this.expiredMessagesScratch,
				messageActivator: this.messageActivator,
				cachedOpacityConfig: this.cachedOpacityConfig,
				antiBlockSince: this.antiBlockSinceRef,
				pendingQueue: this.pendingQueue,
				laneAllocator: this.laneAllocator,
				observability: this.observability,
				isReplayMode: this.isReplayMode,
				isReducedMotionActive: this.isReducedMotionActive,
				isAntiBlockActive: this.boundIsAntiBlockActive,
				drainQueue: this.boundDrainQueue,
				lastLiveRegionUpdate: this.lastLiveRegionUpdateRef,
				updateLiveRegion: this.boundUpdateLiveRegion
			};
			return this.renderContext;
		}
		applyPendingTranslations() {
			if (this.pendingTranslations.length === 0) return;
			const end = Math.min(this.pendingTranslationReadIdx + this.translationBatchSize, this.pendingTranslations.length);
			for (let i = this.pendingTranslationReadIdx; i < end; i++) {
				const entry = this.pendingTranslations[i];
				if (!entry) continue;
				entry.msg.translatedText = entry.text;
				if (entry.text) entry.msg.translatedRenderMessage = {
					...entry.msg.renderMessage,
					text: entry.text,
					content: [{
						type: "text",
						content: entry.text
					}]
				};
				else delete entry.msg.translatedRenderMessage;
			}
			this.pendingTranslationReadIdx = end;
			if (this.pendingTranslationReadIdx >= this.pendingTranslations.length) {
				this.pendingTranslations.length = 0;
				this.pendingTranslationReadIdx = 0;
			} else if (this.pendingTranslationReadIdx > 0) {
				this.pendingTranslations.splice(0, this.pendingTranslationReadIdx);
				this.pendingTranslationReadIdx = 0;
			}
		}
		queueTranslationResult(msg, text, generation) {
			if (generation !== this.translationConfigurationGeneration || !this.settings.translationEnabled) return;
			this.pendingTranslations.push({
				msg,
				text
			});
		}
		updateCanvasDpr(canvas, ctx, dims) {
			this.lastDpr = updateCanvasDpr(canvas, ctx, dims, this.lastDpr);
		}
		placeQueuedMessage(message, now, dimensions, batchIndex) {
			const result = this.checkPlacement(message, now, dimensions);
			if (!result.ok) return {
				placed: false,
				oversized: result.reason === "oversized"
			};
			this.enqueueMessageWithPlacement(message, now, result.placement, batchIndex, result.dimensions, result.speedTier, dimensions);
			if (this.settings.outline.enabled && this.settings.outline.widthPx > 0 && this.settings.outline.opacity > 0) {
				const warmColor = this.settings.preserveUserColor && message.userColor ? message.userColor : this.settings.colors[message.authorType] ?? this.settings.colors.normal;
				const farSpacing = result.speedTier === SPEED_TIER.FAR ? "1px" : void 0;
				warmTextBitmapCache(toSharedContentSegments(message.content), this.settings.fontSize, this.settings.fontWeight, this.settings.fontFamily, warmColor, this.settings.outline.widthPx, this.settings.outline.opacity, this.textBitmapCache, this.ctx, farSpacing);
			}
			return {
				placed: true,
				oversized: false
			};
		}
		drainQueue(now) {
			if (this.drainLocked) return;
			this.drainLocked = true;
			try {
				const t0 = performance.now();
				const dims = this.overlay.getDimensions();
				if (!dims) return;
				const batch = createDrainBatch(this.pendingQueue.toArray());
				for (const msg of batch.candidates) {
					if (this.activeMessages.length >= this.settings.maxConcurrentMessages) break;
					recordDrainResult(batch, msg, this.placeQueuedMessage(msg, now, dims, batch.batchIndex));
				}
				this.finalizeDrainBatch(batch, true);
				this.observability.recordDrainQueue(performance.now() - t0);
			} finally {
				this.drainLocked = false;
			}
		}
		async drainQueueAsync(now) {
			if (this.drainLocked) return;
			this.drainLocked = true;
			try {
				const dims = this.overlay.getDimensions();
				if (!dims) return;
				const batch = createDrainBatch(this.pendingQueue.toArray());
				let deadline = performance.now() + 50;
				for (const msg of batch.candidates) {
					if (this.activeMessages.length >= this.settings.maxConcurrentMessages) break;
					if (!recordDrainResult(batch, msg, this.placeQueuedMessage(msg, now, dims, batch.batchIndex))) continue;
					deadline = await yieldAtDeadline(deadline);
					if (this._destroyed) return;
				}
				this.finalizeDrainBatch(batch, false);
			} finally {
				this.drainLocked = false;
			}
		}
		finalizeDrainBatch(batch, reportOversized) {
			commitDrainBatch(this.pendingQueue, batch);
			if (batch.unplaceable.length === 0) return;
			this.lastRenderActivity = performance.now();
			if (!reportOversized) return;
			const first = batch.unplaceable[0];
			const firstEstHeight = Math.round(this.estimateDimensions(first).height);
			const laneCount = this.laneAllocator.getLaneCount();
			const requiredSlots = Math.ceil(firstEstHeight / Math.round(this.laneAllocator.getLaneHeight()));
			log$7.warn("renderer.message.drop", {
				reason: "oversized",
				dropped: batch.unplaceable.length,
				requiredSlots,
				laneCount,
				sampleKind: first.kind
			});
			this.observability.onMessageDropped("oversized");
		}
		checkPlacement(message, now, precomputedDims) {
			const t0 = performance.now();
			const dims = precomputedDims ?? this.overlay.getDimensions();
			if (!dims) {
				this.observability.recordCollisionCheck(performance.now() - t0);
				return {
					ok: false,
					reason: "temporarily_unavailable"
				};
			}
			const mode = this.settings.danmakuMode;
			const isScrolling = mode === "scroll" || mode === "reverse";
			const dimensions = this.estimateDimensions(message);
			const { height: msgHeight } = dimensions;
			const totalLanes = this.laneAllocator.getLaneCount();
			const laneHeight = this.laneAllocator.getLaneHeight();
			if (Math.max(1, Math.ceil(msgHeight / laneHeight)) > totalLanes) {
				this.observability.recordCollisionCheck(performance.now() - t0);
				return {
					ok: false,
					reason: "oversized"
				};
			}
			const speedTier = this.getSpeedTier(message);
			const placement = this.laneAllocator.findPlacement(msgHeight, dims, speedTier, now);
			if (!placement) {
				this.observability.recordCollisionCheck(performance.now() - t0);
				return {
					ok: false,
					reason: "temporarily_unavailable"
				};
			}
			const newLaneY = placement.laneY + placement.verticalOffset;
			const adjacentMessages = [];
			const scanEnd = placement.laneIndex + placement.slotCount;
			for (let li = placement.laneIndex - 1; li <= scanEnd; li++) {
				const laneMsgs = this.activeMessagesByLane.get(li);
				if (laneMsgs) for (const m of laneMsgs) adjacentMessages.push(m);
			}
			for (let i = adjacentMessages.length - 1; i >= 0; i--) {
				const active = adjacentMessages[i];
				if (!active) continue;
				const activeElapsed = now - active.startTime - active.pausedDuration;
				if (activeElapsed < 0) continue;
				if (active.y + active.height <= newLaneY || active.y >= newLaneY + dimensions.height) continue;
				if (isScrolling) {
					const headwayPx = this.computeHeadwayPx(active.width, active.speedTier, speedTier);
					const travelDistance = active.startX + active.width + this.settings.exitPaddingPx;
					const activeProgress = Math.min(1, activeElapsed * active.invDuration);
					const activeRightEdge = active.startX - activeProgress * travelDistance + active.width;
					if (mode === "scroll") {
						if (activeRightEdge > dims.width - headwayPx) {
							forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
								this.laneAllocator.markCollision(slotIdx);
							});
							this.observability.recordCollisionCheck(performance.now() - t0);
							return {
								ok: false,
								reason: "collision"
							};
						}
					} else {
						const reverseTravel = dims.width - active.startX + this.settings.exitPaddingPx;
						if (active.startX + activeProgress * reverseTravel < headwayPx) {
							forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
								this.laneAllocator.markCollision(slotIdx);
							});
							this.observability.recordCollisionCheck(performance.now() - t0);
							return {
								ok: false,
								reason: "collision"
							};
						}
					}
				} else if (activeElapsed < active.duration) {
					forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
						this.laneAllocator.markCollision(slotIdx);
					});
					this.observability.recordCollisionCheck(performance.now() - t0);
					return {
						ok: false,
						reason: "collision"
					};
				}
			}
			return {
				ok: true,
				placement,
				dimensions,
				speedTier
			};
		}
		enqueueMessageWithPlacement(message, now, placement, batchIndex = 0, precomputedDimensions, precomputedSpeedTier, precomputedDims) {
			const dims = precomputedDims ?? this.overlay.getDimensions();
			if (!dims) return;
			const mode = this.settings.danmakuMode;
			const { width: msgWidth, height: msgHeight } = precomputedDimensions ?? this.estimateDimensions(message);
			const isScrolling = mode === "scroll" || mode === "reverse";
			const speedTier = precomputedSpeedTier ?? this.getSpeedTier(message);
			const horizontalStagger = isScrolling && batchIndex > 0 ? Math.min(200, batchIndex * 40) : 0;
			const startX = isScrolling ? mode === "scroll" ? dims.width + horizontalStagger : -(msgWidth + horizontalStagger) : Math.max(0, Math.floor((dims.width - msgWidth) / 2));
			let effectiveDuration;
			if (isScrolling) {
				const speed = this.getSpeedForTier(speedTier);
				const totalDistance = mode === "scroll" ? startX + msgWidth + this.settings.exitPaddingPx : dims.width + msgWidth + this.settings.exitPaddingPx + horizontalStagger;
				effectiveDuration = speed > 0 ? computeScrollDuration(totalDistance, speed, this.settings.scrollDurationMinMs, this.settings.scrollDurationMaxMs, this.settings.exitPaddingPx) : this.settings.scrollDurationMinMs;
			} else effectiveDuration = this.settings.topBottomDurationMs;
			if (message.authorType === "moderator" || message.authorType === "owner") effectiveDuration *= this.settings.modOwnerDurationMultiplier;
			const laneY = placement.laneY + placement.verticalOffset;
			const maxStagger = this.pendingQueue.size > 50 ? 0 : this.pendingQueue.size > 30 ? this.settings.staggerMediumDelayMs : this.settings.staggerMaxDelayMs;
			const staggerDelay = batchIndex > 0 && maxStagger > 0 ? Math.round(Math.min(maxStagger, Math.min(batchIndex, 3) * 25 * CanvasRenderer.STAGGER_EXP_TABLE[fastRandom() * 256 >>> 0])) : 0;
			const effectiveStartTime = now + staggerDelay + placement.waitMs;
			this.laneAllocator.commitPlacement(placement, effectiveStartTime, effectiveDuration, isScrolling ? msgWidth : void 0, isScrolling ? dims.width : void 0, speedTier);
			const translationGeneration = this.translationConfigurationGeneration;
			this.messageActivator.activate(message, now, msgWidth, msgHeight, laneY, {
				onActivated: (cm) => {
					this.activeMessages.push(cm);
					const slotCount = placement.slotCount;
					cm.slotCount = slotCount;
					addMessageToLaneIndex(this.activeMessagesByLane, cm, slotCount);
				},
				onMessageRendered: () => this.observability.onMessageRendered(),
				onTranslationResult: (cm, text) => {
					this.queueTranslationResult(cm, text, translationGeneration);
				}
			}, effectiveDuration, startX, placement.laneIndex, staggerDelay + placement.waitMs, speedTier);
			this.collectSourceLanguageSample(message);
			this.lastRenderActivity = performance.now();
		}
		estimateDimensions(message) {
			let cached;
			if (message.id) cached = this.dimensionCache.get(message.id);
			let transHeight = 0;
			if (this.settings.translationEnabled && this.translationService.isActive && this.settings.translationMode === "dual") {
				const transFontSize = Math.max(1, Math.round(this.settings.fontSize * TRANSLATION_FONT_SCALE));
				transHeight = measureTextHeight(getFontString(transFontSize, "normal", this.settings.fontFamily), transFontSize) + 2;
			}
			if (cached) {
				if (transHeight > 0) return {
					width: cached.width,
					height: cached.height + transHeight
				};
				return cached;
			}
			const showAuthor = message.kind === "superchat" ? this.settings.showAuthor.superChat : this.settings.showAuthor[message.authorType];
			const dims = estimateMessageDimensions(message, this.settings.fontSize, showAuthor, this.settings.fontWeight, this.settings.fontFamily, {
				superchat: this.settings.superChatMaxBodyLines,
				membership: this.settings.membershipMaxBodyLines
			}, this.settings.showSuperChatAmount, this.getSpeedTier(message) === SPEED_TIER.FAR ? "1px" : "0px");
			if (message.id) {
				if (this.dimensionCache.size >= CanvasRenderer.DIMENSION_CACHE_MAX) {
					const oldestKey = this.dimensionCache.keys().next().value;
					if (oldestKey !== void 0) this.dimensionCache.delete(oldestKey);
				}
				this.dimensionCache.set(message.id, dims);
			}
			if (transHeight > 0) return {
				width: dims.width,
				height: dims.height + transHeight
			};
			return dims;
		}
		getFont(fontSize) {
			return getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
		}
		buildOpacityConfig() {
			this.cachedOpacityConfig = {
				baseOpacity: this.settings.opacity,
				fadeDurationMs: this.settings.fadeDurationMs,
				invFadeDuration: this.invFadeDuration,
				backlogOpacityMultiplier: this.settings.backlogOpacityMultiplier,
				depthLayersEnabled: this.settings.depthLayersEnabled,
				depthFarOpacityMul: this.settings.depthFarOpacityMul,
				ageFadeRate: computeAgeFadeRate(this.settings.maxMessageAgeMs)
			};
		}
		computeHeadwayPx(activeWidth, _activeSpeedTier, _newSpeedTier) {
			return computeBaseHeadwayPx(activeWidth, this.settings.headwayGapRatio);
		}
		prefetchAndTranslateForWorker(message, msgId) {
			this.imageFetchManager.prefetchImages(message);
			this.collectSourceLanguageSample(message);
			const translatableText = getTranslatableText(message);
			if (this.translationService.isEnabled && translatableText) this.translationService.translate(translatableText).then((translated) => {
				this.workerManager.sendTranslation(msgId, translated);
			}).catch(() => {});
		}
		getEffectiveBacklogSpeed() {
			const speed = this.settings.speedPxPerSec * Math.max(1, this.settings.backlogSpeedMultiplier);
			return Math.max(1, speed);
		}
		getSpeedForTier(tier) {
			const base = this.getEffectiveSpeedPxPerSec();
			switch (tier) {
				case SPEED_TIER.FAR: return Math.max(30, base * this.settings.depthFarSpeedMul);
				case SPEED_TIER.NEAR: return base * this.settings.depthNearSpeedMul;
				case SPEED_TIER.BACKLOG: return this.getEffectiveBacklogSpeed();
				default: return base;
			}
		}
		getSpeedTier(message) {
			return getSpeedTier(message, {
				depthLayersEnabled: this.settings.depthLayersEnabled,
				danmakuMode: this.settings.danmakuMode
			});
		}
		updateSettings(settings, options) {
			const wasTranslationEnabled = this.settings.translationEnabled;
			const prevSource = this.settings.translationSource;
			const prevDanmakuMode = this.settings.danmakuMode;
			const translationConfigurationChanged = settings.translationEnabled !== this.settings.translationEnabled || settings.translationService !== this.settings.translationService || settings.translationSource !== this.settings.translationSource || settings.translationTarget !== this.settings.translationTarget || settings.translationMode !== this.settings.translationMode;
			const laneGeometryChanged = settings.fontSize !== this.settings.fontSize || settings.fontWeight !== this.settings.fontWeight || settings.fontFamily !== this.settings.fontFamily || settings.laneSpacing !== this.settings.laneSpacing || settings.safeTop !== this.settings.safeTop || settings.safeBottom !== this.settings.safeBottom;
			super.updateSettings(settings, options);
			this.translationBatchSize = settings.translationBatchSize;
			if (translationConfigurationChanged) {
				this.translationConfigurationGeneration++;
				this.pendingTranslations.length = 0;
				this.pendingTranslationReadIdx = 0;
			}
			this.dimensionCache.clear();
			this.textBitmapCache.resize(settings.textCacheMb * 1e6);
			this.textBitmapCache.clear();
			this.invFadeDuration = computeInvFadeDuration(settings.fadeDurationMs);
			this.workerManager.updateSettings(settings);
			this.imageFetchManager.updateConfig(settings, this.workerManager.workerRef);
			if (laneGeometryChanged && !options?.resetState && !this.workerManager.isActive) {
				const dimensions = this.overlay.getDimensions();
				if (dimensions) {
					this.laneAllocator.reset(dimensions);
					this.reflowActiveMessages(dimensions);
				}
			}
			if (wasTranslationEnabled && !settings.translationEnabled) for (const msg of this.activeMessages) {
				msg.translatedText = null;
				delete msg.translatedRenderMessage;
			}
			this.translationService.onUserActivation();
			if (settings.translationSource !== prevSource || wasTranslationEnabled !== settings.translationEnabled) this.resetSourceDetection();
			if (settings.translationEnabled) this.initializeSourceDetectionPipeline();
			this.translationService.configure({
				enabled: settings.translationEnabled,
				service: settings.translationService,
				source: settings.translationSource,
				target: settings.translationTarget
			}).catch((err) => {
				log$7.debug("renderer.translation.reconfigure-failed", { error: String(err) });
			});
			this.messageActivator = new MessageActivator(this.translationService, {
				topBottomDurationMs: settings.topBottomDurationMs,
				depthLayersEnabled: settings.depthLayersEnabled
			});
			this.buildOpacityConfig();
			if (prevDanmakuMode !== settings.danmakuMode) {
				const dims = this.overlay.getDimensions();
				if (dims && this.activeMessages.length > 0) {
					const newIsScrolling = settings.danmakuMode === "scroll" || settings.danmakuMode === "reverse";
					const now = performance.now();
					for (const msg of this.activeMessages) {
						const elapsed = now - msg.startTime - msg.pausedDuration;
						const oldProgress = msg.duration > 0 ? Math.min(1, Math.max(0, elapsed / msg.duration)) : 0;
						if (newIsScrolling) msg.startX = settings.danmakuMode === "scroll" ? dims.width : -(msg.width + 0);
						else msg.startX = Math.max(0, Math.floor((dims.width - msg.width) / 2));
						if (newIsScrolling) {
							const totalDistance = settings.danmakuMode === "scroll" ? msg.startX + msg.width + settings.exitPaddingPx : dims.width + msg.width + settings.exitPaddingPx;
							const speed = this.getEffectiveSpeedPxPerSec();
							msg.duration = speed > 0 ? computeScrollDuration(totalDistance, speed, settings.scrollDurationMinMs, settings.scrollDurationMaxMs, settings.exitPaddingPx) : settings.scrollDurationMinMs;
						} else msg.duration = settings.topBottomDurationMs;
						msg.invDuration = msg.duration > 0 ? 1 / msg.duration : 0;
						if (newIsScrolling) if (settings.danmakuMode === "scroll") {
							const travelDistance = msg.startX + msg.width + settings.exitPaddingPx;
							msg.x = msg.startX - oldProgress * travelDistance;
						} else {
							const reverseTravel = dims.width - msg.startX + settings.exitPaddingPx;
							msg.x = msg.startX + oldProgress * reverseTravel;
						}
						else msg.x = msg.startX;
					}
				}
			}
		}
		setChatPanelOpen(open) {
			log$7.debug("renderer.chat-panel.changed", { open });
		}
		onPause() {
			this.stopRenderLoop();
			this.workerManager.setPaused(true);
			this.imageFetchManager.pause();
		}
		onResume() {
			this.startRenderLoop();
			const now = performance.now();
			this.laneAllocator.resetBatch(now);
			this.drainQueueAsync(now);
			this.workerManager.setPaused(false);
			this.imageFetchManager.resume();
		}
		applyPausedDuration(pausedMs) {
			const now = performance.now();
			for (const msg of this.activeMessages) {
				const elapsedBeforePause = now - pausedMs - msg.startTime;
				const remainingDisplay = msg.duration - elapsedBeforePause;
				const capped = Math.max(0, Math.min(pausedMs, Math.max(0, remainingDisplay) + 1e3));
				msg.pausedDuration += capped;
			}
		}
		resetState() {
			this.activeMessages.length = 0;
			this.activeMessagesByLane.clear();
			this.pendingQueue.clear();
			this.workerManager.clearState();
			this.backlogPaused = false;
			this.onBacklogPauseChange = null;
			clearTextMeasurementCaches();
			this.textBitmapCache.clear();
			this.dimensionCache.clear();
		}
		initializeSourceDetectionPipeline() {
			this.channelMemory ??= new ChannelLanguageMemory();
			if (this.languageDetector) return;
			const detector = new LanguageDetectorService();
			this.languageDetector = detector;
			detector.initialize().catch((err) => {
				log$7.debug("renderer.translation.init-failed", {
					reason: "language-detector",
					error: String(err)
				});
			});
		}
		collectSourceLanguageSample(message) {
			if (!this.settings.translationEnabled || this.settings.translationSource !== "auto" || this.sourceDetectionDone || this.sourceDetectionRun !== null || !message.text.trim()) return;
			this.sourceSampleBuffer.push(message.text);
			if (this.sourceSampleBuffer.length >= CanvasRenderer.SOURCE_SAMPLE_COUNT) this.performSourceDetection();
		}
		async performSourceDetection() {
			const detector = this.languageDetector;
			if (!detector || this.sourceDetectionRun !== null) return;
			const run = Symbol("source-detection-run");
			const generation = this.sourceDetectionGeneration;
			const samples = this.sourceSampleBuffer.slice(0, CanvasRenderer.SOURCE_SAMPLE_COUNT);
			this.sourceDetectionRun = run;
			try {
				const detected = await detector.detectFromSamples(samples);
				if (this.sourceDetectionRun !== run || this.sourceDetectionGeneration !== generation || !this.settings.translationEnabled || this.settings.translationSource !== "auto") return;
				if (detected) {
					const channelKey = ChannelLanguageMemory.resolveKey(location.href, document);
					if (channelKey && this.channelMemory) this.channelMemory.set(channelKey, detected);
					await this.translationService.setDetectedSource(detected);
				}
			} catch (err) {
				log$7.debug("renderer.translation.source-detection-failed", { error: String(err) });
			} finally {
				if (this.sourceDetectionRun === run) {
					this.sourceDetectionRun = null;
					if (this.sourceDetectionGeneration === generation) {
						this.sourceDetectionDone = true;
						this.sourceSampleBuffer = [];
					}
				}
			}
		}
		resetSourceDetection() {
			this.sourceDetectionGeneration++;
			this.sourceDetectionDone = false;
			this.sourceSampleBuffer = [];
		}
		onDestroy() {
			this._destroyed = true;
			this.stopRenderLoop();
			this.workerManager.destroy();
			this.imageFetchManager.destroy();
			this.overlayDimensionsUnsubscribe?.();
			this.overlayUserPauseUnsubscribe?.();
			this.densityIndicator.destroy();
			if (this.reducedMotionQuery && this.reducedMotionListener) this.reducedMotionQuery.removeEventListener("change", this.reducedMotionListener);
			this.reducedMotionListener = null;
			this.reducedMotionQuery = null;
			this.statusActionButton?.remove();
			this.statusActionButton = null;
			this.canvas?.remove();
			this.canvas = null;
			this.ctx = null;
			this.imageFetchManager.emojiCache.clear();
			this.imageFetchManager.emojiFetching.clear();
			this.imageFetchManager.emojiFetchingStarted.clear();
			this.imageFetchManager.authorPhotoCache.clear();
			this.imageFetchManager.stickerCache.clear();
			this.textBitmapCache.clear();
			this.superChatGradientCache.clear();
			this.dimensionCache.clear();
			this.activeMessagesByLane.clear();
			this.pendingTranslations.length = 0;
			this.onBacklogPauseChange = null;
			this.onStatusBarClick = null;
			this.translationService.destroy();
			this.resetSourceDetection();
			this.languageDetector?.destroy();
			this.languageDetector = null;
			this.channelMemory = null;
			this.stopOffscreenPoll();
			disconnectObserver(this.offscreenObserver);
			this.offscreenObserver = null;
			clearTextMeasurementCaches();
		}
		replaceCanvas() {
			const container = this.overlay.getContainer();
			if (!container || !this.canvas) return false;
			this.canvas.remove();
			const newCanvas = document.createElement("canvas");
			const dims = this.overlay.getDimensions();
			if (dims) {
				newCanvas.style.width = `${dims.width}px`;
				newCanvas.style.height = `${dims.height}px`;
				const dpr = window.devicePixelRatio || 1;
				newCanvas.width = dims.width * dpr;
				newCanvas.height = dims.height * dpr;
			}
			newCanvas.style.cssText = CANVAS_CSS;
			newCanvas.setAttribute("aria-hidden", "true");
			container.appendChild(newCanvas);
			const ctx = newCanvas.getContext("2d", { desynchronized: true });
			if (!ctx) return false;
			newCanvas.addEventListener("contextlost", (e) => {
				e.preventDefault();
				this.ctx = null;
				log$7.warn("renderer.canvas.context-lost", { reason: "runtime" });
			});
			newCanvas.addEventListener("contextrestored", () => this.handleContextRestored());
			this.canvas = newCanvas;
			this.ctx = ctx;
			const dpr = window.devicePixelRatio || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			this.setupOffscreenObserver(newCanvas);
			log$7.info("renderer.fallback.started", { reason: "main-thread" });
			return true;
		}
		fallbackToMainThread(reason) {
			if (this._destroyed || this.fallbackInProgress) return;
			this.fallbackInProgress = true;
			log$7.info("renderer.fallback.started", { reason });
			this.workerManager.snapshotMessages().then((messages) => {
				if (this._destroyed) return;
				this.workerManager.destroy();
				this.workerManager.setActive(false);
				this.imageFetchManager.updateConfig(this.settings, null);
				if (!this.replaceCanvas()) {
					log$7.warn("renderer.fallback.failed", { reason: "could-not-replace-canvas" });
					return;
				}
				this.activeMessages.length = 0;
				this.activeMessagesByLane.clear();
				this.pendingQueue.clear();
				this.backlogPaused = false;
				clearTextMeasurementCaches();
				this.textBitmapCache.clear();
				this.dimensionCache.clear();
				for (const bucket of this.farOpacityBuckets) bucket.length = 0;
				for (const bucket of this.midOpacityBuckets) bucket.length = 0;
				for (const bucket of this.nearOpacityBuckets) bucket.length = 0;
				const dims = this.overlay.getDimensions();
				if (dims) this.laneAllocator.reset(dims);
				this.laneAllocator.resetBatch();
				for (const message of messages) this.enqueueMessage(message, false);
				this.idleSince = null;
				this.startRenderLoop();
				log$7.info("renderer.fallback.complete", { restoredMessages: messages.length });
			}).catch((error) => {
				log$7.warn("renderer.fallback.failed", {
					reason: "message-snapshot-failed",
					error: String(error)
				});
			}).finally(() => {
				this.fallbackInProgress = false;
			});
		}
		handleContextRestored() {
			if (!this.canvas) return;
			if (this.workerManager.isActive) {
				log$7.warn("renderer.canvas.context-lost-while-worker", { reason: "worker-mode" });
				this.fallbackToMainThread("gpu-reset-worker");
				return;
			}
			const ctx = this.canvas.getContext("2d");
			if (!ctx) {
				log$7.warn("renderer.canvas.context-restore-failed", { reason: "get-context-returned-null" });
				return;
			}
			this.ctx = ctx;
			const dims = this.overlay?.getDimensions();
			if (dims && this.canvas) this.lastDpr = applyDevicePixelRatio(this.canvas, ctx, dims);
			log$7.info("renderer.canvas.context-restored");
			if (!this.isPaused && !this.isVideoPaused) this.startRenderLoop();
		}
		renderStatusBar(ctx, dims) {
			const status = this.connectionStatus;
			if (status === "connected") {
				this.renderStatusDot(ctx, dims);
				return;
			}
			if (status === "disconnected") return;
			const colors = statusBarLayout.colors[status];
			const message = this.getStatusMessage(status);
			const { fontSize, paddingX, paddingY, bottomOffset, pillRadius, dotRadius, dotGap } = statusBarLayout;
			const font = getFontString(fontSize, "normal", this.settings.fontFamily);
			ctx.save();
			ctx.font = font;
			ctx.textBaseline = "middle";
			ctx.textAlign = "left";
			const textWidth = ctx.measureText(message).width;
			const boxW = dotRadius * 2 + dotGap + textWidth + paddingX * 2;
			const boxH = fontSize * 1.5 + paddingY * 2;
			const boxX = (dims.width - boxW) / 2;
			const boxY = dims.height - boxH - bottomOffset;
			ctx.fillStyle = colors.bg;
			drawRoundRect(ctx, boxX, boxY, boxW, boxH, pillRadius);
			ctx.fill();
			const dotX = boxX + paddingX + dotRadius;
			const dotY = boxY + boxH / 2;
			ctx.fillStyle = colors.dot;
			ctx.beginPath();
			ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = colors.text;
			ctx.fillText(message, dotX + dotRadius + dotGap, boxY + boxH / 2);
			ctx.restore();
		}
		renderStatusDot(ctx, dims) {
			const { dotRadius, bottomOffset, fontSize, paddingY } = statusBarLayout;
			const colors = statusBarLayout.colors.connected;
			const boxH = fontSize * 1.5 + paddingY * 2;
			const x = dims.width / 2;
			const y = dims.height - boxH - bottomOffset + boxH / 2;
			ctx.save();
			ctx.fillStyle = colors.dot;
			ctx.globalAlpha = DISCONNECTED_DOT_ALPHA;
			ctx.beginPath();
			ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		getStatusMessage(status) {
			switch (status) {
				case "connecting": return t("status.connecting");
				case "degraded": return t("status.unstable");
				case "disconnected": return t("status.disconnected");
				case "standby": return t("status.waiting");
				default: return "";
			}
		}
	};
	var BacklogIndicator = class BacklogIndicator {
		static HIDE_DELAY_MS = 300;
		indicatorEl = null;
		hideIndicatorTimer = null;
		_indicatorFadeRaf = null;
		show() {
			if (this.indicatorEl) return;
			const el = document.createElement("div");
			el.id = "yt-chat-overlay-backlog-indicator";
			el.style.cssText = `
      position: fixed; top: 40px; right: 8px; z-index: ${INDICATOR_Z_INDEX};
      background: ${BACKLOG_INDICATOR_BG}; color: ${DEFAULT_TEXT_COLOR};
      font: 12px/1.4 ${DEFAULT_FONT_FAMILY}; padding: 6px 10px;
      border-radius: 4px; pointer-events: none; user-select: none;
      opacity: 0; transition: opacity 0.3s ease;
    `;
			el.textContent = t("indicator.loading");
			document.body.appendChild(el);
			this.indicatorEl = el;
			this._indicatorFadeRaf = requestAnimationFrame(() => {
				el.style.opacity = "1";
				this._indicatorFadeRaf = null;
			});
		}
		update(processed, total) {
			if (!this.indicatorEl) return;
			const pct = Math.round((total > 0 ? processed / total : 1) * 100);
			this.indicatorEl.textContent = `${t("indicator.loading")} ${processed}/${total} (${pct}%)`;
		}
		hide() {
			if (!this.indicatorEl) return;
			if (this._indicatorFadeRaf !== null) {
				cancelAnimationFrame(this._indicatorFadeRaf);
				this._indicatorFadeRaf = null;
			}
			this.indicatorEl.style.opacity = "0";
			this.hideIndicatorTimer = setTimeout(() => {
				this.hideIndicatorTimer = null;
				if (this.indicatorEl) {
					this.indicatorEl.remove();
					this.indicatorEl = null;
				}
			}, BacklogIndicator.HIDE_DELAY_MS);
		}
		destroy() {
			if (this._indicatorFadeRaf !== null) {
				cancelAnimationFrame(this._indicatorFadeRaf);
				this._indicatorFadeRaf = null;
			}
			this.hideIndicatorTimer = clearSafeTimeout(this.hideIndicatorTimer);
			if (this.indicatorEl) {
				this.indicatorEl.remove();
				this.indicatorEl = null;
			}
		}
	};
	function isPriorityMessage(m) {
		return m.kind === "superchat" || m.kind === "membership";
	}
	function prioritySortOrder(kind) {
		return kind === "superchat" ? 0 : kind === "membership" ? 1 : 2;
	}
	function sampleExponential(mean, random = Math.random) {
		return -mean * Math.log(Math.max(Number.EPSILON, 1 - random()));
	}
	var BacklogSampler = class BacklogSampler {
		static SAMPLE_RATIO_SMALL = .6;
		static SAMPLE_RATIO_LARGE = .35;
		filterByMode(allMessages, config, now) {
			if (config.backlogMode === "none") return [];
			if (config.backlogMode === "recent") {
				const cutoffMs = config.backlogRecentMinutes * 60 * 1e3;
				return allMessages.filter((m) => now - m.timestamp < cutoffMs);
			}
			return allMessages;
		}
		extractPriorityMessages(messages) {
			const priority = [];
			const regular = [];
			for (const msg of messages) if (isPriorityMessage(msg)) priority.push(msg);
			else regular.push(msg);
			return {
				priority,
				regular
			};
		}
		sampleMessages(messages) {
			const count = messages.length;
			if (count < 200) return messages;
			const isSubstantialText = (m) => {
				if (isPriorityMessage(m)) return false;
				const text = m.text.trim();
				return text.length >= 3 && !/^[\sㅋㅎㅇㄱ]+$/.test(text);
			};
			const tier1 = [];
			const tier2 = [];
			const tier3 = [];
			for (const m of messages) if (isPriorityMessage(m)) tier1.push(m);
			else if (isSubstantialText(m)) tier2.push(m);
			else tier3.push(m);
			const normalBudget = count < 500 ? Math.floor(count * BacklogSampler.SAMPLE_RATIO_SMALL) : Math.floor(count * BacklogSampler.SAMPLE_RATIO_LARGE);
			const selected = [...tier1];
			let remaining = normalBudget;
			if (tier2.length > 0 && remaining > 0) {
				const pick = Math.min(remaining, tier2.length);
				selected.push(...this.timeDistributedPick(tier2, pick));
				remaining -= pick;
			}
			if (tier3.length > 0 && remaining > 0) {
				const pick = Math.min(remaining, tier3.length);
				selected.push(...this.timeDistributedPick(tier3, pick));
			}
			return selected.sort((a, b) => {
				const priorityA = prioritySortOrder(a.kind);
				const priorityB = prioritySortOrder(b.kind);
				if (priorityA !== priorityB) return priorityA - priorityB;
				return a.timestamp - b.timestamp;
			});
		}
		timeDistributedPick(messages, count) {
			if (count >= messages.length) return [...messages];
			if (count <= 0) return [];
			const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
			const step = Math.max(1, Math.floor(sorted.length / count));
			const picked = [];
			for (let i = 0; i < count; i++) {
				const msg = sorted[Math.min(i * step, sorted.length - 1)];
				if (msg) picked.push(msg);
			}
			return picked;
		}
	};
	var REAL_TIME_FACTOR_MIN = .25;
	var REAL_TIME_FACTOR_STEP = .2;
	var UTILIZATION_FACTOR_MIN = .1;
	var UTILIZATION_FACTOR_SLOPE = .9;
	var REAL_TIME_DECAY_MS = 2e3;
	function computeDensityRampFactor(elapsedMs, densityRampMs) {
		if (elapsedMs >= densityRampMs) return 1;
		return .25 + .75 * (elapsedMs / densityRampMs);
	}
	function decayActivityCount(count, elapsedMs) {
		if (elapsedMs > REAL_TIME_DECAY_MS) return 0;
		if (count <= 0) return count;
		const decayProgress = elapsedMs / REAL_TIME_DECAY_MS;
		return Math.max(Math.ceil(count * (1 - decayProgress)), 0);
	}
	function computeAdaptiveMeanInterval(maxRate, minRate, activityCount, utilizationFactor, rampFactor) {
		const realTimeFactor = Math.max(REAL_TIME_FACTOR_MIN, 1 - activityCount * REAL_TIME_FACTOR_STEP);
		const rawRate = Math.round(maxRate * Math.min(realTimeFactor, utilizationFactor) * rampFactor);
		return Math.round(1e3 / Math.min(maxRate, Math.max(minRate, rawRate)));
	}
	var BacklogScheduler = class BacklogScheduler {
		static REAL_TIME_ACTIVITY_CAP = 5;
		static REAL_TIME_FACTOR_MIN = REAL_TIME_FACTOR_MIN;
		static REAL_TIME_FACTOR_STEP = REAL_TIME_FACTOR_STEP;
		static UTILIZATION_FACTOR_MIN = UTILIZATION_FACTOR_MIN;
		static UTILIZATION_FACTOR_SLOPE = UTILIZATION_FACTOR_SLOPE;
		static REAL_TIME_DECAY_MS = REAL_TIME_DECAY_MS;
		config;
		lanes;
		densityRampMs;
		constructor(config, lanes) {
			this.config = config;
			this.lanes = lanes;
			this.densityRampMs = config.backlogDensityRampMs;
		}
		computeDensityRampMs(backlogSize) {
			const { backlogDensityRampMs, backlogDensityRampMaxMs } = this.config;
			if (backlogSize >= 500) return backlogDensityRampMaxMs;
			if (backlogSize >= 200) {
				const t = (backlogSize - 200) / 300;
				return Math.round(backlogDensityRampMs + t * (backlogDensityRampMaxMs - backlogDensityRampMs));
			}
			return backlogDensityRampMs;
		}
		setDensityRampMs(ms) {
			this.densityRampMs = ms;
		}
		getDensityRampFactor(injectionStartTime, now = Date.now()) {
			return computeDensityRampFactor(now - injectionStartTime, this.densityRampMs);
		}
		getUtilizationFactor(onUtilizationQuery) {
			if (!onUtilizationQuery) return 1;
			const utilization = onUtilizationQuery();
			return Math.max(BacklogScheduler.UTILIZATION_FACTOR_MIN, 1 - utilization * BacklogScheduler.UTILIZATION_FACTOR_SLOPE);
		}
		computeMeanIntervalWithUtilization(realTimeActivityCount, lastRealTimeActivityAt, injectionStartTime, onUtilizationQuery, now = Date.now()) {
			const maxRate = Math.max(this.config.backlogInjectionRateMin, Math.min(this.config.backlogInjectionMax, this.config.backlogMaxRate, this.lanes * 2));
			const updatedCount = decayActivityCount(realTimeActivityCount, now - lastRealTimeActivityAt);
			const utilizationFactor = this.getUtilizationFactor(onUtilizationQuery);
			const rampFactor = this.getDensityRampFactor(injectionStartTime, now);
			return {
				meanInterval: computeAdaptiveMeanInterval(maxRate, Math.max(this.lanes + 1, 2), updatedCount, utilizationFactor, rampFactor),
				updatedActivityCount: updatedCount
			};
		}
		scheduleNextTick(processTick, meanInterval, random = Math.random) {
			const floorMs = Math.max(32, Math.round(meanInterval * .6));
			const poissonDelay = Math.max(floorMs, Math.min(meanInterval * 2, sampleExponential(meanInterval, random)));
			return setTimeout(() => processTick(), poissonDelay);
		}
		updateConfig(config) {
			this.config = {
				...this.config,
				...config
			};
			if ("backlogDensityRampMs" in config) this.densityRampMs = this.config.backlogDensityRampMs;
		}
	};
	var BACKLOG_QUEUE_COMPACT_THRESHOLD = 64;
	var log$6 = createLogger("Backlog");
	var BacklogInjectionController = class {
		backlogQueue = [];
		backlogQueueOffset = 0;
		backlogSeenIds = new Set();
		isActive = false;
		isInjecting = false;
		paused = false;
		injectionTimer = null;
		totalBacklog = 0;
		processedBacklog = 0;
		config;
		observability;
		realTimeActivityCount = 0;
		lastRealTimeActivityAt = 0;
		injectionStartTime = 0;
		scheduler;
		sampler;
		indicator;
		onUtilizationQuery = null;
		onBacklogMessage = null;
		constructor(config, lanes, observability) {
			this.config = config;
			this.observability = observability;
			this.scheduler = new BacklogScheduler(config, lanes);
			this.sampler = new BacklogSampler();
			this.indicator = new BacklogIndicator();
		}
		dequeueBacklog() {
			if (this.backlogQueueOffset >= this.backlogQueue.length) return;
			const msg = this.backlogQueue[this.backlogQueueOffset];
			this.backlogQueue[this.backlogQueueOffset] = void 0;
			this.backlogQueueOffset++;
			if (this.backlogQueueOffset > BACKLOG_QUEUE_COMPACT_THRESHOLD) {
				this.backlogQueue = this.backlogQueue.slice(this.backlogQueueOffset);
				this.backlogQueueOffset = 0;
			}
			return msg;
		}
		appendUniqueMessages(messages) {
			let added = 0;
			for (const msg of messages) {
				if (msg.id && this.backlogSeenIds.has(msg.id)) continue;
				this.backlogQueue.push(msg);
				if (msg.id) this.backlogSeenIds.add(msg.id);
				added++;
			}
			return added;
		}
		startBacklogInjection(messages) {
			if (messages.length === 0) return;
			if (this.isInjecting) {
				const added = this.appendUniqueMessages(messages);
				if (added > 0) {
					this.totalBacklog += added;
					log$6.debug("backlog.injection-queued", {
						added,
						total: this.totalBacklog
					});
				}
				return;
			}
			if (this.paused && this.backlogQueue.length > 0) {
				const added = this.appendUniqueMessages(messages);
				if (added > 0) {
					this.totalBacklog += added;
					log$6.debug("backlog.paused-merge", {
						added,
						total: this.totalBacklog
					});
				}
				return;
			}
			if (this.config.backlogMode === "none") {
				log$6.debug("backlog.mode-none");
				return;
			}
			const now = Date.now();
			const filtered = this.sampler.filterByMode(messages, this.config, now);
			if (this.config.backlogMode === "recent") log$6.debug(`Backlog recent mode: ${messages.length} → ${filtered.length} (last ${this.config.backlogRecentMinutes} min)`);
			const sampled = this.sampler.sampleMessages(filtered);
			const { priority: priorityMessages, regular: normalMessages } = this.sampler.extractPriorityMessages(sampled);
			let queueMessages = normalMessages;
			if (priorityMessages.length > 0) if (this.paused) queueMessages = [...priorityMessages, ...normalMessages];
			else {
				for (const msg of priorityMessages) {
					msg.isBacklog = true;
					this.onBacklogMessage?.(msg);
				}
				log$6.debug("backlog.priority-emitted", { count: priorityMessages.length });
			}
			this.backlogQueue = queueMessages;
			this.backlogSeenIds = new Set();
			for (const msg of queueMessages) if (msg.id) this.backlogSeenIds.add(msg.id);
			this.totalBacklog = queueMessages.length;
			this.processedBacklog = 0;
			this.isActive = queueMessages.length > 0;
			this.injectionStartTime = now;
			this.realTimeActivityCount = 0;
			this.lastRealTimeActivityAt = 0;
			this.scheduler.setDensityRampMs(this.scheduler.computeDensityRampMs(sampled.length));
			log$6.debug("backlog.sampled", {
				total: messages.length,
				sampled: sampled.length
			});
			this.indicator.show();
			this.observability?.updateBacklogProgress(0);
			this.startInjection();
		}
		notifyRealTimeActivity() {
			this.realTimeActivityCount = Math.min(this.realTimeActivityCount + 1, BacklogScheduler.REAL_TIME_ACTIVITY_CAP);
			this.lastRealTimeActivityAt = Date.now();
		}
		getSpeedMultiplier() {
			return this.config.backlogSpeedMultiplier;
		}
		get isBacklogActive() {
			return this.isActive;
		}
		updateConfig(config) {
			this.config = {
				...this.config,
				...config
			};
			this.scheduler.updateConfig(config);
		}
		drainPending() {
			if (!this.isActive && this.backlogQueueLength === 0) return [];
			const messages = [];
			for (let i = this.backlogQueueOffset; i < this.backlogQueue.length; i++) {
				const msg = this.backlogQueue[i];
				if (msg !== void 0) messages.push(msg);
			}
			return messages;
		}
		setPaused(paused) {
			this.paused = paused;
			if (paused) {
				this.isInjecting = false;
				this.injectionTimer = clearSafeTimeout(this.injectionTimer);
			} else if (!this.isInjecting && this.isActive && this.backlogQueueLength > 0) {
				this.isInjecting = true;
				this.processTick();
			}
		}
		destroy() {
			this.isActive = false;
			this.isInjecting = false;
			this.injectionTimer = clearSafeTimeout(this.injectionTimer);
			this.indicator.destroy();
			this.backlogQueue = [];
			this.backlogQueueOffset = 0;
			this.backlogSeenIds.clear();
			this.onBacklogMessage = null;
		}
		startInjection() {
			if (this.isInjecting || !this.isActive || this.backlogQueueLength === 0) {
				if (this.backlogQueueLength === 0) this.finishBacklogInjection();
				return;
			}
			this.isInjecting = true;
			this.processTick();
		}
		processTick() {
			if (!this.isActive || this.backlogQueueLength === 0) {
				this.isInjecting = false;
				this.injectionTimer = clearSafeTimeout(this.injectionTimer);
				if (this.backlogQueueLength === 0) this.finishBacklogInjection();
				return;
			}
			const { meanInterval, updatedActivityCount } = this.scheduler.computeMeanIntervalWithUtilization(this.realTimeActivityCount, this.lastRealTimeActivityAt, this.injectionStartTime, this.onUtilizationQuery);
			this.realTimeActivityCount = updatedActivityCount;
			const message = this.dequeueBacklog();
			if (!message) {
				this.finishBacklogInjection();
				return;
			}
			message.isBacklog = true;
			this.processedBacklog++;
			const progress = this.totalBacklog > 0 ? this.processedBacklog / this.totalBacklog : 1;
			this.observability?.updateBacklogProgress(progress);
			this.indicator.update(this.processedBacklog, this.totalBacklog);
			this.onBacklogMessage?.(message);
			this.injectionTimer = this.scheduler.scheduleNextTick(() => this.processTick(), meanInterval);
		}
		finishBacklogInjection() {
			this.isActive = false;
			this.isInjecting = false;
			this.backlogQueue = [];
			this.backlogQueueOffset = 0;
			this.backlogSeenIds.clear();
			this.observability?.updateBacklogProgress(1);
			this.indicator.hide();
			log$6.debug("backlog.injection-complete");
		}
		get backlogQueueLength() {
			return this.backlogQueue.length - this.backlogQueueOffset;
		}
	};
	var BatchMessageBus = class {
		subscribers = new Set();
		_publishedCount = 0;
		_lastPublishTime = 0;
		publish(messages) {
			if (messages.length === 0 || this.subscribers.size === 0) return;
			this._publishedCount += messages.length;
			this._lastPublishTime = performance.now();
			for (const handler of this.subscribers) handler(messages);
		}
		subscribe(handler) {
			this.subscribers.add(handler);
			return () => {
				this.subscribers.delete(handler);
			};
		}
		get subscriberCount() {
			return this.subscribers.size;
		}
		get publishedCount() {
			return this._publishedCount;
		}
		get lastPublishTime() {
			return this._lastPublishTime;
		}
		destroy() {
			this.subscribers.clear();
			this._publishedCount = 0;
			this._lastPublishTime = 0;
		}
	};
	var log$5 = createLogger("RuntimeManager");
	var NAVIGATION_SETTLE_DELAY_MS = 2e3;
	var START_RETRY_DELAYS_MS = [
		2e3,
		4e3,
		8e3
	];
	var MAX_START_ATTEMPTS = 3;
	var RECENT_MESSAGE_REPLAY_LIMIT = 20;
	var CHAT_WATCHDOG_INTERVAL_MS = 15e3;
	var SHORT_HIDDEN_TIMEJUMP_MS = 2e4;
	var LONG_HIDDEN_FULL_REFRESH_MS = 6e4;
	async function createChatSource(getSettings, signal) {
		const result = await bootstrapChatSession(signal);
		return {
			chatSource: result.status === "ready" && result.data?.isReplay ? new ReplayChatSource(getSettings) : new LiveChatSource(getSettings),
			bootstrapResult: result
		};
	}
	function seedBootstrapIfReady(chatSource, result) {
		if (result.status === "ready") chatSource.setInitialBootstrap(result.data);
	}
	var CHAT_STALL_TIMEOUT_MS = 3e4;
	var RENDERER_STUCK_THRESHOLD_MS = 1e4;
	var MAX_CONSECUTIVE_REFRESHES = 2;
	var RuntimeManager = class RuntimeManager {
		getCurrentUrl;
		getSettings;
		isValidPage;
		reconcileRequested = false;
		forceNewSession = false;
		static BACKLOG_BATCH_THRESHOLD = 50;
		static BACKLOG_UTILIZATION_THRESHOLD = .8;
		static SMALL_BATCH_THRESHOLD = 5;
		reconcilePromise = null;
		scheduledReconcileTimer = null;
		lastPageChangeAt = 0;
		chatPreflight = createChatPreflight();
		startFailureState = {
			url: null,
			attempts: 0
		};
		settings = null;
		targetUrl = null;
		abortController = new AbortController();
		overlay = null;
		renderer = null;
		chatSource = null;
		foregroundCleanup = null;
		videoPauseController = new VideoPauseController();
		standbyController;
		backlogController = null;
		messageBus = null;
		chatWatchdogTimer = null;
		state = "init";
		hiddenSince = null;
		sessionDedup = createMessageIdRegistry(5e3);
		fetchInterceptorUnsubscribe = null;
		domWatcherUnsubscribe = null;
		chatPanelObserver = new ChatPanelObserver();
		domWatcherPanelElement = null;
		_pendingBacklogMessages = [];
		_recoveringFromError = false;
		consecutiveRefreshFailures = 0;
		recentRestartTimestamps = [];
		consecutiveWatchdogRestarts = 0;
		restartTimer = null;
		sessionGeneration = 0;
		chatRestartPromise = null;
		dimensionsNullSince = null;
		visibilityHandled = false;
		get isDisposedState() {
			return this.state === "disposed" || this.state === "restarting" || this.state === "destroyed";
		}
		get isTerminalState() {
			return this.state === "disposed" || this.state === "destroyed";
		}
		get isActiveState() {
			return this.state === "starting" || this.state === "active";
		}
		constructor(options) {
			this.getCurrentUrl = options.getCurrentUrl;
			this.getSettings = options.getSettings;
			this.isValidPage = options.isValidPage;
			this.standbyController = new StandbyController(() => this.abortController.signal, () => this.isDisposedState, (reason) => this.requestManagedRestart(reason));
		}
		async start() {
			if (this.state === "destroyed") {
				log$5.warn("runtime.start", {
					reason: "already-destroyed",
					hint: "create a new RuntimeManager instance; destroyed instances cannot be reused"
				});
				return;
			}
			await this.reconcileNow("startup");
		}
		requestReconcile(reason) {
			if (this.state === "destroyed") {
				log$5.debug("runtime.reconcile", {
					reason,
					outcome: "ignored-destroyed"
				});
				return;
			}
			if (reason === "page-change") {
				this.lastPageChangeAt = Date.now();
				this.chatPreflight.reset();
				this.resetStartFailures();
				if (this.targetUrl !== null && !this.matchesSessionUrl(this.getCurrentUrl())) this.disposeActiveSession();
				else if (this.targetUrl !== null) this.forceNewSession = true;
			}
			this.reconcileRequested = true;
			this.clearScheduledReconcile();
			this.ensureReconcileLoop();
		}
		async reconcileNow(reason) {
			this.requestReconcile(reason);
			await this.ensureReconcileLoop();
		}
		async restartSession() {
			if (this.state === "destroyed") return;
			this.disposeActiveSession();
			await this.reconcileNow("session-restart");
		}
		destroy() {
			if (this.state === "destroyed") return;
			this.clearRestartTimer();
			this.clearScheduledReconcile();
			this.disposeActiveSession();
			this.state = "destroyed";
		}
		ensureReconcileLoop() {
			if (this.reconcilePromise) return this.reconcilePromise;
			this.reconcilePromise = this.runReconcileLoop().finally(() => {
				this.reconcilePromise = null;
			});
			return this.reconcilePromise;
		}
		async runReconcileLoop() {
			while (this.reconcileRequested && this.state !== "destroyed") {
				this.reconcileRequested = false;
				try {
					await this.reconcileOnce();
				} catch (err) {
					log$5.warn("runtime.reconcile.error", { error: String(err) });
				}
			}
		}
		async reconcileOnce() {
			const desired = this.getDesiredState();
			const hasActiveSession = this.targetUrl !== null && !this.isDisposedState;
			if (this.state === "restarting" && this.targetUrl !== null && (this.restartTimer !== null || this.chatRestartPromise !== null)) return;
			if (hasActiveSession && (!desired.shouldRun || !this.matchesSessionUrl(desired.url) || this.forceNewSession)) {
				this.forceNewSession = false;
				this.disposeActiveSession();
			}
			if (!desired.shouldRun) {
				this.resetStartFailures();
				return;
			}
			const remainingSettleDelay = this.getRemainingSettleDelay();
			if (remainingSettleDelay > 0) {
				this.scheduleReconcile(remainingSettleDelay);
				return;
			}
			if (this.targetUrl !== null && !this.isDisposedState) {
				this.updateSessionSettings(desired.settings);
				return;
			}
			if (isYouTubeWatch(location.href) && !document.querySelector("#chat")) {
				if (this.chatPreflight.isTerminalAbsent) return;
				if ((window.ytInitialData?.playabilityStatus)?.status === "LIVE_STREAM_OFFLINE") this.chatPreflight.reset();
				else if (this.chatPreflight.isSettling) {
					this.chatPreflight.markAbsent(desired.url);
					log$5.info("runtime.chat.preflight", {
						outcome: "expected-absent",
						reason: "chat-panel-missing"
					});
					return;
				} else {
					this.chatPreflight.startSettle(desired.url);
					this.lastPageChangeAt = Date.now();
					this.scheduleReconcile(NAVIGATION_SETTLE_DELAY_MS);
					log$5.info("runtime.chat.preflight", {
						outcome: "settling",
						reason: "chat-panel-missing"
					});
					return;
				}
			} else this.chatPreflight.reset();
			this.targetUrl = desired.url;
			this.settings = desired.settings;
			this.sessionGeneration += 1;
			this.state = "restarting";
			this.abortController = new AbortController();
			this.state = "starting";
			const startStatus = await this.startSession();
			if (this.isDisposedState) return;
			if (startStatus === "waiting") {
				this.resetStartFailures();
				log$5.info("runtime.chat.start", {
					outcome: "standby",
					reason: "stream-not-yet-started"
				});
				return;
			}
			if (startStatus !== "started") {
				this.disposeActiveSession();
				this.handleStartFailure(desired.url, startStatus);
				return;
			}
			this.resetStartFailures();
			this.consecutiveWatchdogRestarts = 0;
		}
		handleSessionRestart(reason, expectedGeneration = this.sessionGeneration) {
			if (this.state === "destroyed" || this.sessionGeneration !== expectedGeneration) return;
			log$5.info("runtime.session.restart-requested", { reason });
			this.standbyController?.exit();
			if (!((reason === "watchdog" ? this.getRuntimeHealthSnapshot() : null)?.isRendererStuck ?? false) && this.overlay != null && this.renderer != null) {
				this.state = "restarting";
				this.stopChatWatchdog();
				this.abortController?.abort();
				this.abortController = new AbortController();
				this.resetStartFailures();
				const generation = this.sessionGeneration;
				const restartPromise = this.restartChatOnly(reason);
				this.chatRestartPromise = restartPromise;
				restartPromise.then((status) => {
					if (this.isTerminalState || this.sessionGeneration !== generation) return;
					if (status === "started") {
						this.state = "active";
						this.consecutiveWatchdogRestarts = 0;
						log$5.info("runtime.session.started");
						this.requestReconcile("settings-change");
					} else {
						log$5.warn("runtime.chat.restart-only-failed", { status });
						this.disposeActiveSession();
						this.requestReconcile("session-restart");
					}
				}).catch((error) => {
					if (this.isTerminalState || this.sessionGeneration !== generation || isAbortError(error)) return;
					log$5.warn("runtime.chat.restart-only-error", { error: String(error) });
					this.disposeActiveSession();
					this.requestReconcile("session-restart");
				}).finally(() => {
					if (this.chatRestartPromise === restartPromise) this.chatRestartPromise = null;
				});
			} else {
				this.restartChatSourceSoft();
				this.resetStartFailures();
				this.requestReconcile("session-restart");
			}
		}
		performOverlayRefresh(reason) {
			if (this.isDisposedState) return;
			const renderer = this.renderer;
			if (!renderer) return;
			log$5.info("runtime.overlay.refreshed", { reason });
			renderer.prepareForRefresh();
			const dims = this.overlay?.getDimensions();
			if (dims) renderer.resetAllocator(dims);
			renderer.resetBurstDetector();
			renderer.resume();
			this.chatSource?.setPauseReason("visibility", false);
			this.sessionDedup.clear();
			if (this.renderer && this.chatSource instanceof ReplayChatSource) {
				const pending = this.chatSource.drainPendingMessages();
				if (pending.length > 0) {
					this.ensureBacklogController(this.renderer);
					this.backlogController?.startBacklogInjection(pending);
				}
			}
			const recentMessages = this.chatSource?.getLatestMessages(20) ?? [];
			if (recentMessages.length > 0) {
				this.ensureBacklogController(renderer);
				this.backlogController?.startBacklogInjection(recentMessages);
			}
			renderer.resumeRenderLoop();
			this.stopForegroundListeners();
			this.startForegroundListeners();
			this.stopChatWatchdog();
			this.startChatWatchdog();
		}
		computeConnectionStatus() {
			if (this.standbyController.isStandby()) return "standby";
			if (!this.chatSource || this.isDisposedState) return "connecting";
			const health = this.chatSource.getHealthSnapshot();
			if (health.consecutiveErrors >= this.getSettings().livePollFailureLimit) return "disconnected";
			if (health.consecutiveErrors > 0) return "degraded";
			if (health.observerAlive && health.recentlyActive) return "connected";
			if (health.observerAlive) return "connecting";
			return "disconnected";
		}
		restartChatSourceSoft() {
			this.sessionGeneration += 1;
			this.stopForegroundListeners();
			this.stopVideoPauseListeners();
			this.stopChatWatchdog();
			this.fetchInterceptorUnsubscribe?.();
			this.fetchInterceptorUnsubscribe = null;
			this.domWatcherUnsubscribe?.();
			this.domWatcherUnsubscribe = null;
			const pendingBacklog = this.backlogController?.drainPending() ?? [];
			this.backlogController?.destroy();
			this.backlogController = null;
			this.abortController?.abort();
			this.chatSource?.stop();
			this.chatSource = null;
			this.sessionDedup.clear();
			this.targetUrl = null;
			this.abortController = new AbortController();
			this._pendingBacklogMessages = pendingBacklog;
		}
		matchesSessionUrl(url) {
			return this.targetUrl === url;
		}
		async startSession() {
			const signal = this.abortController.signal;
			const settings = this.settings;
			try {
				this.overlay?.destroy();
				this.overlay = null;
				this.renderer?.destroy();
				this.renderer = null;
				this.standbyController.setRenderer(null);
				this.removeLeftoverOverlays();
				const overlay = new Overlay();
				if (!await overlay.create(settings, signal)) {
					overlay.destroy();
					return "retryable";
				}
				this.overlay = overlay;
				throwIfAborted$1(signal);
				this.renderer = this.createRenderer(overlay, settings);
				this.renderer.setConnectionStatus("connecting");
				this.renderer.onStatusBarClick = () => {
					log$5.info("runtime.status-bar.clicked");
					this.restartSession();
				};
				this.standbyController.setRenderer(this.renderer);
				if (this._pendingBacklogMessages.length > 0) {
					this.ensureBacklogController(this.renderer);
					this.backlogController?.startBacklogInjection(this._pendingBacklogMessages);
					this._pendingBacklogMessages = [];
				}
				const chatStarted = await this.startChatSource(signal);
				throwIfAborted$1(signal);
				if (chatStarted === "waiting") {
					if (document.visibilityState !== "visible") this.noteHidden();
					this.startForegroundListeners();
					this.startChatPanelMonitor(this.chatSource);
					this.standbyController.enter();
					if (document.visibilityState !== "visible") this.standbyController.pause();
					log$5.info("runtime.standby.entered");
					return "started";
				}
				if (chatStarted !== "started") return chatStarted;
				this.state = "active";
				if (document.visibilityState !== "visible") this.noteHidden();
				this.startForegroundListeners();
				this.startVideoPauseListeners();
				this.startChatWatchdog();
				this.startChatPanelMonitor(this.chatSource);
				log$5.info("runtime.session.started");
				return "started";
			} catch (error) {
				this.stopChatWatchdog();
				if (isAbortError(error)) return "retryable";
				log$5.info("runtime.start-failed", { error: String(error) });
				return "retryable";
			}
		}
		updateSessionSettings(settings) {
			if (!this.isActiveState || !this.settings) return;
			const shouldResetRenderer = shouldResetRendererForSettingsChange(this.settings, settings);
			const prevLanguage = this.settings?.language;
			this.settings = settings;
			this.overlay?.updateSettings(settings);
			if (settings.language !== void 0 && settings.language !== prevLanguage) this.overlay?.updateLanguage();
			const renderer = this.renderer;
			if (!renderer) return;
			if (shouldResetRenderer) this.sessionDedup.clear();
			renderer.updateSettings(settings, { resetState: shouldResetRenderer });
			if (this.backlogController) this.backlogController.updateConfig({
				backlogMaxRate: settings.backlogMaxRate,
				backlogSpeedMultiplier: settings.backlogSpeedMultiplier,
				backlogMode: settings.backlogMode,
				backlogRecentMinutes: settings.backlogRecentMinutes,
				backlogInjectionMax: settings.backlogInjectionMax,
				backlogDensityRampMs: settings.backlogDensityRampMs,
				backlogDensityRampMaxMs: settings.backlogDensityRampMaxMs,
				backlogInjectionRateMin: settings.backlogInjectionRateMin
			});
			if (!shouldResetRenderer) return;
			this.replayLatestMessages(renderer);
		}
		disposeSession() {
			if (this.isTerminalState) return;
			this.standbyController.exit();
			this.state = "restarting";
			this.stopForegroundListeners();
			this.stopVideoPauseListeners();
			this.stopChatWatchdog();
			this.abortController.abort();
			this.backlogController?.destroy();
			this.backlogController = null;
			this.chatSource?.stop();
			this.chatSource = null;
			this.messageBus?.destroy();
			this.messageBus = null;
			this.fetchInterceptorUnsubscribe?.();
			this.fetchInterceptorUnsubscribe = null;
			this.domWatcherUnsubscribe?.();
			this.domWatcherUnsubscribe = null;
			this.domWatcherPanelElement = null;
			this.chatPanelObserver.stop();
			this.renderer?.destroy();
			this.renderer = null;
			this.standbyController.setRenderer(null);
			this.overlay?.destroy();
			this.overlay = null;
			this.hiddenSince = null;
			this.sessionDedup.clear();
			this._recoveringFromError = false;
			log$5.info("runtime.session.disposed");
		}
		async startChatSource(signal) {
			const { chatSource, bootstrapResult } = await createChatSource(() => this.getSessionSettings(), signal);
			this.chatSource = chatSource;
			if (chatSource instanceof ReplayChatSource && this.renderer) this.renderer.setReplayMode(true);
			seedBootstrapIfReady(chatSource, bootstrapResult);
			if (bootstrapResult.status === "waiting") {
				log$5.info("runtime.standby.entered");
				return "waiting";
			}
			if (!(chatSource instanceof ReplayChatSource)) this.installFetchInterceptor(chatSource);
			if (this.renderer) chatSource.burstRateProvider = () => this.renderer?.getBurstEmaRate() ?? 0;
			this.messageBus?.destroy();
			this.messageBus = new BatchMessageBus();
			this.messageBus.subscribe((msgs) => this.routeMessages(msgs));
			return chatSource.start((messages, _isInitialSeed) => {
				const msgs = Array.isArray(messages) ? messages : [messages];
				if (this.messageBus) this.messageBus.publish(msgs);
			});
		}
		async restartChatOnly(reason) {
			const signal = this.abortController.signal;
			log$5.info("runtime.chat.restart-only", { reason });
			this.fetchInterceptorUnsubscribe?.();
			this.fetchInterceptorUnsubscribe = null;
			this.domWatcherUnsubscribe?.();
			this.domWatcherUnsubscribe = null;
			this.chatSource?.stop();
			this.chatSource = null;
			this.sessionDedup.clear();
			this.messageBus?.destroy();
			this.messageBus = null;
			const chatStarted = await this.startChatSource(signal);
			throwIfAborted$1(signal);
			if (chatStarted !== "started") return chatStarted;
			this.chatPanelObserver.stop();
			this.startChatPanelMonitor(this.chatSource);
			this.renderer?.resume();
			this.renderer?.resumeRenderLoop();
			this.stopChatWatchdog();
			this.startChatWatchdog();
			log$5.info("runtime.chat.restart-only-done");
			return "started";
		}
		routeMessages(msgs) {
			if (this.isDisposedState) return;
			const renderer = this.renderer;
			if (!renderer) return;
			renderer.setStandbyStatus(false);
			if (msgs.some((m) => m.videoOffsetMs !== void 0)) {
				for (const msg of msgs) {
					if (!this.acceptForRenderer(msg)) continue;
					renderer.addMessage(msg);
				}
				return;
			}
			if (msgs.length > RuntimeManager.BACKLOG_BATCH_THRESHOLD) {
				this.ensureBacklogController(renderer);
				this.backlogController?.startBacklogInjection(msgs);
				return;
			}
			if (this._recoveringFromError && msgs.length >= 2) {
				this._recoveringFromError = false;
				this.ensureBacklogController(renderer);
				this.backlogController?.startBacklogInjection(msgs);
				return;
			}
			renderer.setStandbyStatus(false);
			if (renderer.getLaneUtilization() >= RuntimeManager.BACKLOG_UTILIZATION_THRESHOLD && msgs.length >= RuntimeManager.SMALL_BATCH_THRESHOLD) {
				this.ensureBacklogController(renderer);
				this.backlogController?.startBacklogInjection(msgs);
				return;
			}
			for (const msg of msgs) {
				if (!this.acceptForRenderer(msg)) continue;
				renderer.addMessage(msg);
			}
			if (this.backlogController?.isBacklogActive) this.backlogController.notifyRealTimeActivity();
		}
		startChatPanelMonitor(chatSource) {
			this.chatPanelObserver.start((state) => {
				this.renderer?.setChatPanelOpen(state.isOpen);
				if (state.isOpen) {
					if (this.domWatcherPanelElement !== state.element) {
						this.domWatcherUnsubscribe?.();
						this.domWatcherUnsubscribe = null;
						this.domWatcherPanelElement = null;
					}
					if (!this.domWatcherUnsubscribe) try {
						const unsub = installDomChatWatcher((messages) => {
							if (this.isDisposedState) return;
							chatSource.injectExternalMessages(messages);
						});
						if (unsub) {
							this.domWatcherUnsubscribe = unsub;
							this.domWatcherPanelElement = state.element;
							log$5.info("runtime.dom-watcher.installed");
						}
					} catch (error) {
						log$5.info("runtime.dom-watcher.install-failed", { error: String(error) });
					}
				} else {
					this.domWatcherUnsubscribe?.();
					this.domWatcherUnsubscribe = null;
					this.domWatcherPanelElement = null;
				}
			});
		}
		installFetchInterceptor(chatSource) {
			try {
				this.fetchInterceptorUnsubscribe = installFetchInterceptor(() => this.settings, (messages) => {
					if (this.isDisposedState) return;
					chatSource.injectExternalMessages(messages);
				});
			} catch (error) {
				log$5.info("runtime.interceptor.install-failed", { error: String(error) });
			}
			try {
				this.domWatcherUnsubscribe = installDomChatWatcher((messages) => {
					if (this.isDisposedState) return;
					chatSource.injectExternalMessages(messages);
				});
			} catch (error) {
				log$5.info("runtime.dom-watcher.install-failed", { error: String(error) });
			}
		}
		ensureBacklogController(renderer) {
			if (this.backlogController) return;
			const settings = this.settings;
			this.backlogController = new BacklogInjectionController({
				backlogMode: settings.backlogMode,
				backlogMaxRate: settings.backlogMaxRate,
				backlogSpeedMultiplier: settings.backlogSpeedMultiplier,
				backlogRecentMinutes: settings.backlogRecentMinutes,
				backlogInjectionMax: settings.backlogInjectionMax,
				backlogDensityRampMs: settings.backlogDensityRampMs,
				backlogDensityRampMaxMs: settings.backlogDensityRampMaxMs,
				backlogInjectionRateMin: settings.backlogInjectionRateMin
			}, renderer.laneCount, renderer.observability);
			this.backlogController.onBacklogMessage = (msg) => {
				if (!this.acceptForRenderer(msg)) return;
				renderer.addMessage(msg);
			};
			renderer.onBacklogPauseChange = (paused) => {
				this.backlogController?.setPaused(paused);
			};
			this.backlogController.onUtilizationQuery = () => renderer.getLaneUtilization();
		}
		removeLeftoverOverlays() {
			const leftoverOverlays = document.querySelectorAll(OVERLAY_SELECTOR);
			for (const element of leftoverOverlays) element.remove();
		}
		noteHidden() {
			if (this.hiddenSince === null) this.hiddenSince = Date.now();
		}
		clearHidden() {
			this.hiddenSince = null;
		}
		getIdleDurationMs(now = Date.now()) {
			return this.hiddenSince === null ? 0 : Math.max(0, now - this.hiddenSince);
		}
		getRuntimeHealthSnapshot(now = Date.now()) {
			const chat = this.chatSource?.getHealthSnapshot({ activeTimeoutMs: CHAT_STALL_TIMEOUT_MS }) ?? null;
			const idleDurationMs = this.getIdleDurationMs(now);
			const container = this.overlay?.getContainer();
			const dimensions = this.overlay?.getDimensions();
			const renderable = (container?.isConnected ?? false) && dimensions != null;
			if (!renderable && container?.isConnected) {
				if (this.dimensionsNullSince === null) this.dimensionsNullSince = now;
			} else this.dimensionsNullSince = null;
			const r = this.renderer;
			const isWorkerDead = r != null && !r.isWorkerAlive();
			const isRendererStuck = r != null && (isWorkerDead || r.getQueueLength() > 0 && r.getActiveMessageCount() === 0 && r.getMsSinceLastRenderActivity() >= RENDERER_STUCK_THRESHOLD_MS);
			if (this.standbyController.isStandby()) return {
				idleDurationMs: 0,
				renderable,
				dimensions: dimensions ?? null,
				reason: null,
				chat: null,
				shouldRestart: false,
				isRendererStuck
			};
			const isVideoPaused = this.getVideoElement()?.paused ?? false;
			const isChatInBackoff = chat?.isInBackoff ?? false;
			const reason = classifyRuntimeHealthFailure({
				idleDurationMs,
				renderable,
				chat,
				runtimeActive: this.state === "active",
				videoPaused: isVideoPaused,
				chatInBackoff: isChatInBackoff,
				dimensionsNullSince: this.dimensionsNullSince,
				now
			});
			return {
				idleDurationMs,
				renderable,
				dimensions: dimensions ?? null,
				reason,
				chat,
				shouldRestart: reason !== null,
				isRendererStuck
			};
		}
		requestManagedRestart(reason) {
			if (this.isDisposedState) return;
			const now = Date.now();
			this.recentRestartTimestamps = this.recentRestartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
			const recentCount = this.recentRestartTimestamps.length;
			this.recentRestartTimestamps.push(now);
			if (recentCount === 0) this.consecutiveWatchdogRestarts = 1;
			else this.consecutiveWatchdogRestarts++;
			const delayMs = getWatchdogRestartDelay(this.consecutiveWatchdogRestarts);
			if (delayMs === null) {
				log$5.warn("runtime.restart.max-reached", { consecutiveRestarts: this.consecutiveWatchdogRestarts - 1 });
				return;
			}
			log$5.info("runtime.restart.scheduled", {
				reason,
				attempt: this.consecutiveWatchdogRestarts,
				delayMs
			});
			this.stopChatWatchdog();
			this.state = "restarting";
			const generation = this.sessionGeneration;
			const targetUrl = this.targetUrl;
			if (delayMs > 0) {
				this.clearRestartTimer();
				this.restartTimer = setTimeout(() => {
					this.restartTimer = null;
					if (this.state === "disposed" || this.state === "destroyed" || this.sessionGeneration !== generation || this.targetUrl !== targetUrl) return;
					log$5.info("runtime.restart.requested", {
						reason,
						attempt: this.consecutiveWatchdogRestarts
					});
					this.handleSessionRestart(reason, generation);
				}, delayMs);
			} else {
				log$5.info("runtime.restart.requested", { reason });
				this.handleSessionRestart(reason);
			}
		}
		startForegroundListeners() {
			this.stopForegroundListeners();
			const cleanups = [];
			const handleVisibility = () => {
				if (this.isDisposedState) return;
				if (document.visibilityState !== "visible") {
					this.visibilityHandled = false;
					this.noteHidden();
					this.renderer?.pause();
					this.renderer?.trimBackgroundQueue();
					this.chatSource?.setPauseReason("visibility", true);
					this.chatPanelObserver.pause();
					this.standbyController.pause();
					return;
				}
				if (this.visibilityHandled) return;
				this.visibilityHandled = true;
				this.chatPanelObserver.resume();
				if (this.standbyController.isStandby()) {
					this.chatSource?.setPauseReason("visibility", false);
					this.clearHidden();
					this.standbyController.resume();
					this.renderer?.resume();
					return;
				}
				if (this.renderer?.isVideoPaused) {
					const pendingMessages = this.renderer.drainPendingQueue();
					if (pendingMessages && pendingMessages.length > 0 && this.renderer) {
						log$5.info("runtime.foreground.video-paused-backlog", { count: pendingMessages.length });
						this.ensureBacklogController(this.renderer);
						this.backlogController?.startBacklogInjection(pendingMessages);
					}
					this.chatSource?.setPauseReason("visibility", false);
					this.clearHidden();
					return;
				}
				const hiddenDuration = this.getIdleDurationMs(Date.now());
				this.clearHidden();
				if (hiddenDuration >= LONG_HIDDEN_FULL_REFRESH_MS) {
					this.performOverlayRefresh(`hidden-${Math.round(hiddenDuration / 1e3)}s`);
					return;
				}
				const pendingMessages = this.renderer?.drainPendingQueue();
				if (pendingMessages && pendingMessages.length > 0 && this.renderer) {
					this.ensureBacklogController(this.renderer);
					this.backlogController?.startBacklogInjection(pendingMessages);
				} else this.renderer?.trimBackgroundQueue();
				this.chatSource?.setPauseReason("visibility", false);
				if (this.renderer && this.chatSource instanceof ReplayChatSource) {
					const messages = this.chatSource.drainPendingMessages();
					if (messages.length > 0) {
						this.ensureBacklogController(this.renderer);
						this.backlogController?.startBacklogInjection(messages);
					}
				}
				if (hiddenDuration < SHORT_HIDDEN_TIMEJUMP_MS) this.renderer?.resume();
				else {
					this.renderer?.clearPausedDuration();
					this.renderer?.resume();
				}
				if (this.state === "active" && this.chatSource) {
					if (!this.chatSource.getHealthSnapshot({ activeTimeoutMs: CHAT_STALL_TIMEOUT_MS }).observerAlive && !this.standbyController.isStandby()) {
						log$5.info("runtime.foreground.observer-died");
						this.requestManagedRestart("foreground-return");
						return;
					}
				}
				if (this.getRuntimeHealthSnapshot().shouldRestart) {
					this.requestManagedRestart("foreground-return");
					return;
				}
				if (this.renderer != null) log$5.debug("runtime.foreground.renderer-state", {
					activeMessages: this.renderer.getActiveMessageCount(),
					queueLength: this.renderer.getQueueLength(),
					msSinceLastRender: this.renderer.getMsSinceLastRenderActivity(),
					workerAlive: this.renderer.isWorkerAlive(),
					videoPaused: this.renderer.isVideoPaused
				});
				if (this.chatSource != null) {
					const csHealth = this.chatSource.getHealthSnapshot({ activeTimeoutMs: CHAT_STALL_TIMEOUT_MS });
					log$5.debug("runtime.foreground.chat-state", {
						observerAlive: csHealth.observerAlive,
						recentlyActive: csHealth.recentlyActive,
						consecutiveErrors: csHealth.consecutiveErrors,
						isInBackoff: csHealth.isInBackoff
					});
				}
				if (this.getRuntimeHealthSnapshot().isRendererStuck) {
					if (this.renderer != null && !this.renderer.isWorkerAlive()) {
						log$5.warn("runtime.foreground.worker-dead", {
							queueLength: this.renderer.getQueueLength(),
							activeMessageCount: this.renderer.getActiveMessageCount()
						});
						this.renderer.fallbackToMainThread("worker-dead");
					} else {
						log$5.info("runtime.foreground.renderer-stuck");
						this.performOverlayRefresh("renderer-stuck-foreground");
					}
					return;
				}
			};
			document.addEventListener("visibilitychange", handleVisibility);
			cleanups.push(() => document.removeEventListener("visibilitychange", handleVisibility));
			const handlePageShow = (e) => {
				if (e.persisted) {
					log$5.info("runtime.bfcache.restored");
					this.requestReconcile("page-change");
				} else handleVisibility();
			};
			window.addEventListener("pageshow", handlePageShow);
			cleanups.push(() => window.removeEventListener("pageshow", handlePageShow));
			const handleResume = () => {
				if (document.visibilityState === "visible") {
					log$5.info("runtime.page.resume");
					handleVisibility();
				}
			};
			document.addEventListener("resume", handleResume);
			cleanups.push(() => document.removeEventListener("resume", handleResume));
			this.foregroundCleanup = () => {
				for (const fn of cleanups) fn();
				this.foregroundCleanup = null;
			};
		}
		stopForegroundListeners() {
			this.foregroundCleanup?.();
		}
		startVideoPauseListeners() {
			this.videoPauseController.start({
				pauseable: { setPaused: (paused) => {
					if (paused) {
						this.renderer?.pauseForVideo();
						this.chatSource?.setPauseReason("video", true);
					} else {
						const pendingMessages = this.renderer?.drainPendingQueue();
						if (pendingMessages && pendingMessages.length > 0 && this.renderer) {
							this.ensureBacklogController(this.renderer);
							this.backlogController?.startBacklogInjection(pendingMessages);
						} else this.renderer?.trimBackgroundQueue();
						this.renderer?.resumeForVideo();
						this.chatSource?.setPauseReason("video", false);
					}
				} },
				isDisposed: () => this.isDisposedState
			});
		}
		stopVideoPauseListeners() {
			this.videoPauseController.stop();
		}
		getVideoElement() {
			return findElementMatch(VIDEO_SELECTORS)?.element ?? null;
		}
		startChatWatchdog() {
			this.chatWatchdogTimer = clearSafeInterval(this.chatWatchdogTimer);
			this.chatWatchdogTimer = setInterval(() => {
				try {
					if (this.isDisposedState || document.visibilityState !== "visible") return;
					if (this.getVideoElement()?.paused) return;
					const health = this.getRuntimeHealthSnapshot();
					if (health.isRendererStuck) {
						if (this.renderer != null && !this.renderer.isWorkerAlive()) {
							log$5.warn("runtime.worker.dead", {
								queueLength: this.renderer.getQueueLength(),
								activeMessageCount: this.renderer.getActiveMessageCount(),
								msSinceLastRenderActivity: this.renderer.getMsSinceLastRenderActivity()
							});
							this.renderer.fallbackToMainThread("worker-dead");
							this.consecutiveRefreshFailures = 0;
							return;
						}
						this.consecutiveRefreshFailures++;
						if (this.consecutiveRefreshFailures > MAX_CONSECUTIVE_REFRESHES) {
							log$5.warn("runtime.renderer.stuck-escalated", { refreshAttempts: this.consecutiveRefreshFailures - 1 });
							this.consecutiveRefreshFailures = 0;
							this.requestManagedRestart("watchdog");
						} else {
							log$5.info("runtime.renderer.stuck-detected", {
								attempt: this.consecutiveRefreshFailures,
								max: MAX_CONSECUTIVE_REFRESHES
							});
							this.performOverlayRefresh("renderer-stuck");
						}
						return;
					}
					this.consecutiveRefreshFailures = 0;
					if (health.shouldRestart) {
						log$5.info("runtime.health.failed", {
							reason: health.reason,
							state: this.state,
							idleDurationMs: health.idleDurationMs,
							renderable: health.renderable,
							dimensions: health.dimensions,
							chat: health.chat ? {
								observerAlive: health.chat.observerAlive,
								recentlyActive: health.chat.recentlyActive,
								consecutiveErrors: health.chat.consecutiveErrors,
								isInBackoff: health.chat.isInBackoff
							} : null,
							isRendererStuck: health.isRendererStuck
						});
						this.requestManagedRestart("watchdog");
						return;
					}
					const connStatus = this.computeConnectionStatus();
					this.renderer?.setConnectionStatus(connStatus);
					const chatHealth = this.chatSource?.getHealthSnapshot();
					if (chatHealth && chatHealth.consecutiveErrors > 0) this._recoveringFromError = true;
					else if (chatHealth && chatHealth.consecutiveErrors === 0 && this._recoveringFromError) this._recoveringFromError = false;
				} catch (error) {
					log$5.warn("runtime.watchdog.error", { error: String(error) });
				}
			}, CHAT_WATCHDOG_INTERVAL_MS);
		}
		stopChatWatchdog() {
			this.chatWatchdogTimer = clearSafeInterval(this.chatWatchdogTimer);
		}
		replayLatestMessages(renderer, limit = RECENT_MESSAGE_REPLAY_LIMIT) {
			const latestMessages = this.chatSource?.getLatestMessages(limit) ?? [];
			for (const message of latestMessages) {
				if (renderer.isVideoPaused) continue;
				if (!this.acceptForRenderer(message)) continue;
				renderer.replayMessage(message);
			}
		}
		acceptForRenderer(message) {
			if (!message.id) return true;
			if (this.sessionDedup.has(message.id)) return false;
			this.sessionDedup.mark(message.id);
			return true;
		}
		getDesiredState() {
			const settings = this.getSettings();
			return {
				shouldRun: this.isValidPage() && settings.enabled,
				url: this.getCurrentUrl(),
				settings
			};
		}
		getSessionSettings() {
			return this.settings ?? this.getSettings();
		}
		getRemainingSettleDelay() {
			if (this.lastPageChangeAt === 0) return 0;
			const elapsed = Date.now() - this.lastPageChangeAt;
			return Math.max(0, NAVIGATION_SETTLE_DELAY_MS - elapsed);
		}
		scheduleReconcile(delayMs) {
			if (this.state === "destroyed") return;
			this.clearScheduledReconcile();
			this.scheduledReconcileTimer = setTimeout(() => {
				this.scheduledReconcileTimer = null;
				this.requestReconcile("retry");
			}, delayMs);
		}
		clearScheduledReconcile() {
			this.scheduledReconcileTimer = clearSafeTimeout(this.scheduledReconcileTimer);
		}
		clearRestartTimer() {
			if (this.restartTimer !== null) {
				clearTimeout(this.restartTimer);
				this.restartTimer = null;
			}
		}
		disposeActiveSession() {
			this.targetUrl;
			this.clearRestartTimer();
			this.sessionGeneration += 1;
			this.targetUrl = null;
			this.settings = null;
			this.disposeSession();
			this.abortController = new AbortController();
		}
		handleStartFailure(url, status) {
			if (status === "unavailable") {
				this.startFailureState = {
					url,
					attempts: MAX_START_ATTEMPTS
				};
				log$5.info("runtime.chat.start", {
					outcome: "unavailable",
					reason: "no-live-chat-renderer"
				});
				return;
			}
			const attempts = this.startFailureState.url === url ? this.startFailureState.attempts + 1 : 1;
			this.startFailureState = {
				url,
				attempts
			};
			log$5.warn("runtime.chat.start", {
				outcome: "retry",
				reason: `bootstrap-${status}`,
				attempt: attempts,
				maxAttempts: MAX_START_ATTEMPTS
			});
			if (attempts < MAX_START_ATTEMPTS) {
				const delay = START_RETRY_DELAYS_MS[attempts - 1] ?? 8e3;
				this.scheduleReconcile(delay);
				return;
			}
			log$5.warn("runtime.chat.start", {
				outcome: "retry-exhausted",
				reason: `bootstrap-${status}`,
				attempts: MAX_START_ATTEMPTS
			});
		}
		resetStartFailures() {
			this.startFailureState = {
				url: null,
				attempts: 0
			};
		}
		createRenderer(overlay, settings) {
			log$5.info("runtime.renderer.selected", { mode: "canvas2d" });
			return new CanvasRenderer(overlay, settings);
		}
	};
	var registeredCommandNames = new Set();
	function registerMenuCommands(commands) {
		if (typeof GM_registerMenuCommand === "undefined") return;
		for (const cmd of commands) {
			if (registeredCommandNames.has(cmd.name)) continue;
			registeredCommandNames.add(cmd.name);
			GM_registerMenuCommand(cmd.name, cmd.action);
		}
	}
	function createChromeSyncAdapter(storageKey) {
		const bridgeNonce = window.__ytExtensionBridge?.nonce;
		let currentCallback = null;
		const listener = (changes, areaName) => {
			if (areaName !== "local") return;
			const change = changes[storageKey];
			if (!change || !currentCallback) return;
			currentCallback(storageKey, change.newValue);
		};
		const directChangeEvent = getChromeSyncChangeEvent();
		let directListenerRegistered = false;
		let messageListener = null;
		if (!directChangeEvent) messageListener = (event) => {
			if (event.source !== window) return;
			if (event.origin !== window.location.origin) return;
			const data = event.data;
			if (data?.source !== "yt-storage-changed") return;
			if (!bridgeNonce || data.nonce !== bridgeNonce) return;
			if (data.key !== storageKey) return;
			if (currentCallback) currentCallback(storageKey, data.newValue);
		};
		return {
			addListener(callback) {
				if (directChangeEvent) {
					if (directListenerRegistered) directChangeEvent.removeListener(listener);
					currentCallback = callback;
					directChangeEvent.addListener(listener);
					directListenerRegistered = true;
					return;
				}
				currentCallback = callback;
				if (messageListener) window.addEventListener("message", messageListener);
			},
			removeListener() {
				currentCallback = null;
				if (directChangeEvent) {
					if (directListenerRegistered) {
						directChangeEvent.removeListener(listener);
						directListenerRegistered = false;
					}
					return;
				}
				if (messageListener) window.removeEventListener("message", messageListener);
			}
		};
	}
	function isChromeSyncAvailableDirect() {
		return getChromeSyncChangeEvent() !== null;
	}
	function getChromeSyncChangeEvent() {
		try {
			if (typeof chrome === "undefined") return null;
			const changeEvent = chrome?.storage?.onChanged;
			if (!changeEvent) return null;
			if (typeof changeEvent.addListener !== "function") return null;
			if (typeof changeEvent.removeListener !== "function") return null;
			return changeEvent;
		} catch (_error) {
			return null;
		}
	}
	function createGmSyncAdapter(storageKey) {
		let listenerId = null;
		let currentCallback = null;
		const addValueChangeListener = GM_addValueChangeListener;
		const removeValueChangeListener = GM_removeValueChangeListener;
		return {
			addListener(callback) {
				if (listenerId !== null) {
					removeValueChangeListener(listenerId);
					listenerId = null;
				}
				currentCallback = callback;
				listenerId = addValueChangeListener(storageKey, (_key, _oldValue, newValue, _remote) => {
					if (currentCallback) currentCallback(storageKey, newValue);
				});
			},
			removeListener() {
				if (listenerId !== null) {
					removeValueChangeListener(listenerId);
					listenerId = null;
				}
				currentCallback = null;
			}
		};
	}
	function isGmSyncAvailable() {
		return typeof GM_addValueChangeListener === "function" && typeof GM_removeValueChangeListener === "function";
	}
	function createLocalStorageSyncAdapter(storageKey) {
		let currentCallback = null;
		const handler = (event) => {
			if (event.key !== storageKey || event.newValue === null) return;
			if (currentCallback) currentCallback(storageKey, event.newValue);
		};
		return {
			addListener(callback) {
				currentCallback = callback;
				window.addEventListener("storage", handler);
			},
			removeListener() {
				currentCallback = null;
				window.removeEventListener("storage", handler);
			}
		};
	}
	var cachedAdapter$1 = null;
	var cachedKey = null;
	function getCrossTabSyncAdapter(storageKey) {
		if (cachedAdapter$1 && cachedKey === storageKey) return cachedAdapter$1;
		if (cachedAdapter$1) cachedAdapter$1.removeListener();
		if (isChromeSyncAvailableDirect() || window.__ytExtensionBridge?.storageType === "chrome.storage.local") cachedAdapter$1 = createChromeSyncAdapter(storageKey);
		else if (isGmSyncAvailable()) cachedAdapter$1 = createGmSyncAdapter(storageKey);
		else cachedAdapter$1 = createLocalStorageSyncAdapter(storageKey);
		cachedKey = storageKey;
		return cachedAdapter$1;
	}
	var log$4 = createLogger("StorageAdapter");
	function isQuotaExceededError(error) {
		if (error instanceof DOMException) return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014;
		if (error instanceof Error) return error.message.toLowerCase().includes("quota") || error.message.toLowerCase().includes("exceeded");
		return false;
	}
	function setupStorageRelay() {
		const nonce = window.__ytExtensionBridge?.nonce;
		if (!window.__ytExtensionBridge?.storageType || !nonce) return null;
		let requestId = 0;
		const pending = new Map();
		const relayListener = (event) => {
			if (event.source !== window) return;
			if (event.origin !== window.location.origin) return;
			const data = event.data;
			if (!data || typeof data !== "object") return;
			if (data.source !== "yt-storage-relay-response") return;
			if (data.nonce !== nonce) return;
			const responseRequestId = data.requestId;
			if (typeof responseRequestId !== "number") return;
			const entry = pending.get(responseRequestId);
			if (!entry) return;
			pending.delete(responseRequestId);
			clearTimeout(entry.timeout);
			if (data.error) entry.reject(new Error(String(data.error)));
			else entry.resolve(data.value);
		};
		window.addEventListener("message", relayListener);
		const relayRequest = (method, key, value) => new Promise((resolve, reject) => {
			const id = ++requestId;
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Storage relay ${method} request timed out for key "${key}"`));
			}, 2e3);
			pending.set(id, {
				resolve,
				reject,
				timeout
			});
			try {
				window.postMessage({
					source: "yt-storage-relay",
					nonce,
					requestId: id,
					method,
					key,
					...value === void 0 ? {} : { value }
				}, window.location.origin);
			} catch (error) {
				clearTimeout(timeout);
				pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		return {
			async getItem(key) {
				return relayRequest("get", key);
			},
			async setItem(key, value) {
				await relayRequest("set", key, value);
			}
		};
	}
	var cachedAdapter = null;
	function getStorageAdapter() {
		if (cachedAdapter) return cachedAdapter;
		if (window.__ytExtensionBridge?.storageType === "chrome.storage.local") {
			const relay = setupStorageRelay();
			if (relay) {
				cachedAdapter = relay;
				return cachedAdapter;
			}
		}
		if (typeof GM_getValue !== "undefined" && typeof GM_setValue !== "undefined") {
			cachedAdapter = {
				async getItem(key) {
					try {
						const rawValue = GM_getValue(key);
						if (rawValue === void 0 || rawValue === null) return null;
						if (typeof rawValue === "object") return JSON.stringify(rawValue);
						return String(rawValue);
					} catch (_error) {
						return null;
					}
				},
				async setItem(key, value) {
					if (typeof GM_setValue === "undefined") return;
					try {
						GM_setValue(key, value);
					} catch (error) {
						log$4.warn("platform.storage.set-failed", { error: String(error) });
					}
				}
			};
			return cachedAdapter;
		}
		if (typeof chrome !== "undefined" && chrome.storage?.local !== void 0) {
			const storage = chrome.storage.local;
			cachedAdapter = {
				async getItem(key) {
					try {
						const result = await storage.get(key);
						if (!result) return null;
						const value = result[key];
						if (value === void 0 || value === null) return null;
						return typeof value === "string" ? value : JSON.stringify(value);
					} catch (_error) {
						return null;
					}
				},
				async setItem(key, value) {
					try {
						await storage.set({ [key]: value });
					} catch (error) {
						if (isQuotaExceededError(error)) log$4.warn(`Chrome storage quota exceeded for key "${key}". Consider reducing settings data or clearing unused entries.`);
					}
				}
			};
			return cachedAdapter;
		}
		cachedAdapter = {
			async getItem(key) {
				try {
					return localStorage.getItem(key);
				} catch (_error) {
					return null;
				}
			},
			async setItem(key, value) {
				try {
					localStorage.setItem(key, value);
				} catch (error) {
					if (isQuotaExceededError(error)) log$4.warn(`Storage quota exceeded for key "${key}". Consider reducing settings data or clearing unused entries.`);
				}
			}
		};
		return cachedAdapter;
	}
	var log$3 = createLogger("Settings");
	var Settings = class {
		settings;
		onChangeCallbacks = new Set();
		saving = false;
		savePending = false;
		localRevision = 0;
		saveIdleHandle = 0;
		saveTimeoutHandle = null;
		savePromise = null;
		crossTabSyncAdapter = getCrossTabSyncAdapter(STORAGE_KEY);
		onCrossTabChange = (_key) => {
			if (this.saving || this.savePending || this.savePromise) return;
			log$3.debug("settings.store.cross-tab-change");
			this.reloadFromStorage();
		};
		constructor() {
			this.settings = cloneSettings(DEFAULT_SETTINGS);
		}
		async initialize() {
			try {
				const raw = await getStorageAdapter().getItem(STORAGE_KEY);
				if (raw) {
					const parsed = JSON.parse(raw);
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) this.settings = normalizeStoredSettings(parsed);
				}
			} catch (error) {
				log$3.warn("settings.store.load-failed", { error: String(error) });
			}
			this.startCrossTabSync();
		}
		subscribe(callback) {
			this.onChangeCallbacks.add(callback);
			return () => {
				this.onChangeCallbacks.delete(callback);
			};
		}
		async destroy() {
			this.stopCrossTabSync();
			this.onChangeCallbacks.clear();
			if (this.saveIdleHandle !== 0) {
				cancelIdleCallback(this.saveIdleHandle);
				this.saveIdleHandle = 0;
			}
			if (this.saveTimeoutHandle !== null) {
				clearTimeout(this.saveTimeoutHandle);
				this.saveTimeoutHandle = null;
			}
			await this.flushSave();
			if (this.savePromise) await this.savePromise;
		}
		startCrossTabSync() {
			this.crossTabSyncAdapter.addListener(this.onCrossTabChange);
		}
		stopCrossTabSync() {
			this.crossTabSyncAdapter.removeListener();
		}
		async reloadFromStorage() {
			const revisionAtStart = this.localRevision;
			try {
				const raw = await getStorageAdapter().getItem(STORAGE_KEY);
				if (!raw) return;
				if (revisionAtStart !== this.localRevision || this.savePending || this.saving || this.savePromise) return;
				const parsed = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					const loaded = normalizeStoredSettings(parsed);
					this.settings = loaded;
					for (const cb of this.onChangeCallbacks) cb();
				}
			} catch (error) {
				log$3.warn("settings.store.reload-failed", { error: String(error) });
			}
		}
		async save() {
			try {
				this.saving = true;
				const data = {
					...this.settings,
					_version: 2
				};
				await getStorageAdapter().setItem(STORAGE_KEY, JSON.stringify(data));
			} catch (error) {
				log$3.warn("settings.store.save-failed", { error: String(error) });
			} finally {
				this.saving = false;
			}
		}
		scheduleSave() {
			if (this.savePending) return;
			this.savePending = true;
			if (typeof requestIdleCallback !== "undefined") this.saveIdleHandle = requestIdleCallback(() => void this.flushSave(), { timeout: 2e3 });
			else this.saveTimeoutHandle = setTimeout(() => void this.flushSave(), 0);
		}
		async flushSave() {
			if (!this.savePending) return;
			this.savePending = false;
			if (this.saveIdleHandle !== 0) {
				cancelIdleCallback(this.saveIdleHandle);
				this.saveIdleHandle = 0;
			}
			if (this.saveTimeoutHandle !== null) {
				clearTimeout(this.saveTimeoutHandle);
				this.saveTimeoutHandle = null;
			}
			const previousSave = this.savePromise;
			const savePromise = previousSave ? previousSave.then(() => this.save()) : this.save();
			this.savePromise = savePromise;
			try {
				await savePromise;
			} finally {
				if (this.savePromise === savePromise) this.savePromise = null;
			}
		}
		get() {
			return cloneSettings(this.settings);
		}
		set(partial) {
			this.localRevision++;
			this.settings = applySettingsPatch(this.settings, partial);
			this.scheduleSave();
		}
		preview(partial) {
			this.localRevision++;
			this.settings = applySettingsPatch(this.settings, partial);
		}
		reset() {
			this.localRevision++;
			this.settings = cloneSettings(DEFAULT_SETTINGS);
			this.scheduleSave();
			for (const cb of this.onChangeCallbacks) cb();
		}
	};
	var OUTLINE_KEYS = new Set(["enabled", ...OUTLINE_NUMERIC_KEYS]);
	var AUTHOR_KEYS = new Set(AUTHOR_COLOR_KEYS);
	var SHOW_AUTHOR_KEY_SET = new Set(SHOW_AUTHOR_KEYS);
	function parsePrefixedKey(name, prefix, validKeys) {
		if (!name.startsWith(prefix)) return null;
		const key = name.slice(prefix.length);
		return validKeys.has(key) ? key : null;
	}
	function parseSettingsControlName(name) {
		const outlineKey = parsePrefixedKey(name, "outline-", OUTLINE_KEYS);
		if (outlineKey) return {
			group: "outline",
			key: outlineKey
		};
		const colorKey = parsePrefixedKey(name, "color-", AUTHOR_KEYS);
		if (colorKey) return {
			group: "color",
			key: colorKey
		};
		const backgroundColorKey = parsePrefixedKey(name, "backgroundColor-", AUTHOR_KEYS);
		if (backgroundColorKey) return {
			group: "backgroundColor",
			key: backgroundColorKey
		};
		const backgroundEnabledKey = parsePrefixedKey(name, "backgroundEnabled-", AUTHOR_KEYS);
		if (backgroundEnabledKey) return {
			group: "backgroundEnabled",
			key: backgroundEnabledKey
		};
		const showAuthorKey = parsePrefixedKey(name, "showAuthor-", SHOW_AUTHOR_KEY_SET);
		if (showAuthorKey) return {
			group: "showAuthor",
			key: showAuthorKey
		};
		if (name in ROOT_SETTING_META) return {
			group: "root",
			key: name
		};
		return null;
	}
	var num = (label, key, title, modifier) => ({
		type: "number",
		label,
		key,
		...title !== void 0 ? { title } : {},
		...modifier !== void 0 ? { modifier } : {}
	});
	var chk = (label, key, title, modifier) => ({
		type: "checkbox",
		label,
		key,
		...title !== void 0 ? { title } : {},
		...modifier !== void 0 ? { modifier } : {}
	});
	var sel = (label, key, options, title) => ({
		type: "select",
		label,
		key,
		options,
		...title !== void 0 ? { title } : {}
	});
	var range = (label, key, title, modifier) => ({
		type: "range",
		label,
		key,
		...title !== void 0 ? { title } : {},
		...modifier !== void 0 ? { modifier } : {}
	});
	var fontPreview = () => ({ type: "font-preview" });
	var weightToggle = (label, key, options, title) => ({
		type: "weight-toggle",
		label,
		key,
		options,
		...title !== void 0 ? { title } : {}
	});
	var fontChips = (label, key, suggestions, title) => ({
		type: "font-chips",
		label,
		key,
		suggestions,
		...title !== void 0 ? { title } : {}
	});
	var PANES = [
		{
			id: "comments",
			label: "pane.comments",
			sections: [
				{
					title: "",
					fields: [{
						type: "enabled",
						title: "app.enabledDesc"
					}]
				},
				{
					title: "",
					fields: [
						sel("danmaku.mode", "danmakuMode", [
							["scroll", "danmaku.scroll"],
							["reverse", "danmaku.reverse"],
							["top", "danmaku.top"],
							["bottom", "danmaku.bottom"]
						], "danmaku.modeDesc"),
						num("danmaku.scrollSpeed", "speedPxPerSec", "danmaku.scrollSpeedDesc"),
						range("danmaku.textOpacity", "opacity", "danmaku.textOpacityDesc"),
						range("danmaku.laneGap", "laneSpacing", "danmaku.laneGapDesc"),
						num("danmaku.exitPadding", "exitPaddingPx", "danmaku.exitPaddingDesc"),
						num("danmaku.durationMul", "modOwnerDurationMultiplier", "danmaku.durationMulDesc")
					]
				},
				{
					title: "danmaku.timing",
					fields: [
						num("danmaku.minScrollDuration", "scrollDurationMinMs", "danmaku.minScrollDurationDesc"),
						num("danmaku.maxScrollDuration", "scrollDurationMaxMs", "danmaku.maxScrollDurationDesc"),
						num("danmaku.topBottomDuration", "topBottomDurationMs", "danmaku.topBottomDurationDesc")
					]
				},
				{
					title: "danmaku.safeZone",
					fields: [range("danmaku.topClearZone", "safeTop", "danmaku.topClearZoneDesc"), range("danmaku.bottomClearZone", "safeBottom", "danmaku.bottomClearZoneDesc")]
				},
				{
					title: "danmaku.font",
					fields: [
						fontPreview(),
						num("danmaku.fontSize", "fontSize", "danmaku.fontSizeDesc"),
						weightToggle("Weight", "fontWeight", [["bold", "Bold"], ["normal", "Regular"]], "danmaku.fontWeightDesc"),
						fontChips("Family", "fontFamily", [
							"system-ui, -apple-system, sans-serif",
							"\"Segoe UI\", system-ui, sans-serif",
							"\"-apple-system\", \"Helvetica Neue\", sans-serif",
							"\"Roboto\", system-ui, sans-serif",
							"\"Noto Sans KR\", sans-serif",
							"\"Noto Sans JP\", sans-serif",
							"\"Noto Sans SC\", sans-serif",
							"\"Noto Sans TC\", sans-serif",
							"\"Malgun Gothic\", sans-serif",
							"\"Microsoft YaHei\", sans-serif",
							"\"Meiryo\", sans-serif",
							"\"Cascadia Code\", \"Fira Code\", monospace",
							"\"JetBrains Mono\", monospace",
							"\"Source Code Pro\", monospace",
							"monospace",
							"Arial, sans-serif",
							"\"Helvetica Neue\", Arial, sans-serif",
							"Verdana, sans-serif",
							"\"Trebuchet MS\", sans-serif",
							"sans-serif",
							"Georgia, serif",
							"\"Times New Roman\", serif",
							"serif",
							"\"Comic Sans MS\", cursive",
							"Impact, sans-serif",
							"\"Arial Black\", sans-serif"
						], "danmaku.fontFamilyDesc")
					]
				}
			]
		},
		{
			id: "colors",
			label: "pane.appearance",
			sections: [
				{
					title: "appearance.cards",
					fields: [
						range("appearance.superchatOpacity", "superChatOpacity", "appearance.superchatOpacityDesc"),
						num("appearance.superchatMaxLines", "superChatMaxBodyLines", "appearance.superchatMaxLinesDesc"),
						num("appearance.membershipMaxLines", "membershipMaxBodyLines", "appearance.membershipMaxLinesDesc"),
						chk("appearance.showSuperchatAmount", "showSuperChatAmount", "appearance.showSuperchatAmountDesc"),
						chk("appearance.preserveUserColors", "preserveUserColor", "Use author's chosen text color from YouTube chat instead of overlay defaults")
					]
				},
				{
					title: "appearance.outline",
					fields: [
						chk("appearance.outlineEnabled", "enabled", "appearance.outlineEnabledDesc", "outline"),
						num("appearance.outlineWidth", "widthPx", "appearance.outlineWidthDesc", "outline"),
						range("appearance.outlineOpacity", "opacity", "appearance.outlineOpacityDesc", "outline")
					]
				},
				{
					title: "appearance.authors",
					fields: [{ type: "author-grid" }]
				}
			]
		},
		{
			id: "advanced",
			label: "pane.advanced",
			sections: [
				{
					title: "advanced.messageRate",
					fields: [
						chk("advanced.ignoreMinLength", "allowShortTextMessages", "advanced.ignoreMinLengthDesc"),
						num("advanced.minLength", "minTextLength", "advanced.minLengthDesc"),
						sel("advanced.authorRateLimit", "authorRateLimit", [
							["off", "advanced.authorRateLimitOff"],
							["normal", "advanced.authorRateLimitNormal"],
							["strict", "advanced.authorRateLimitStrict"]
						], "advanced.authorRateLimitDesc")
					]
				},
				{
					title: "advanced.backlog",
					fields: [
						sel("advanced.backlogMode", "backlogMode", [
							["playback", "advanced.backlogPlayback"],
							["recent", "advanced.backlogRecent"],
							["full", "advanced.backlogFull"],
							["none", "advanced.backlogNone"]
						], "advanced.backlogModeDesc"),
						range("advanced.backlogOpacity", "backlogOpacityMultiplier", "advanced.backlogOpacityDesc"),
						num("advanced.backlogInjectionRate", "backlogMaxRate", "advanced.backlogInjectionRateDesc"),
						num("advanced.backlogSpeed", "backlogSpeedMultiplier", "advanced.backlogSpeedDesc"),
						num("advanced.backlogRecentWindow", "backlogRecentMinutes", "advanced.backlogRecentWindowDesc")
					]
				},
				{
					title: "advanced.depthLayers",
					fields: [
						chk("appearance.outlineEnabled", "depthLayersEnabled", "advanced.depthLayersDesc"),
						range("advanced.depthNearSpeed", "depthNearSpeedMul", "advanced.depthNearSpeedDesc"),
						range("advanced.depthFarSpeed", "depthFarSpeedMul", "advanced.depthFarSpeedDesc"),
						range("advanced.depthFarOpacity", "depthFarOpacityMul", "advanced.depthFarOpacityDesc")
					]
				},
				{
					title: "advanced.performance",
					fields: [
						num("advanced.maxConcurrent", "maxConcurrentMessages", "advanced.maxConcurrentDesc"),
						num("advanced.fadeDuration", "fadeDurationMs", "advanced.fadeDurationDesc"),
						num("advanced.minPollInterval", "minPollIntervalMs", "advanced.minPollIntervalDesc"),
						num("advanced.maxPollInterval", "maxPollIntervalMs", "advanced.maxPollIntervalDesc"),
						num("advanced.maxQueueDepth", "queueMaxSize", "advanced.maxQueueDepthDesc"),
						num("advanced.tabTrimTarget", "backgroundQueueMax", "advanced.tabTrimTargetDesc"),
						num("advanced.maxMessageAge", "maxMessageAgeMs", "advanced.maxMessageAgeDesc"),
						range("danmaku.messageSpacing", "headwayGapRatio", "danmaku.messageSpacingDesc"),
						num("advanced.translationBatchSize", "translationBatchSize", "advanced.translationBatchSizeDesc")
					]
				},
				{
					title: "advanced.cache",
					fields: [
						num("advanced.emojiCache", "emojiCacheMb", "advanced.emojiCacheDesc"),
						num("advanced.photoCache", "photoCacheMb", "advanced.photoCacheDesc"),
						num("advanced.stickerCache", "stickerCacheMb", "advanced.stickerCacheDesc"),
						num("advanced.textCache", "textCacheMb", "advanced.textCacheDesc"),
						num("advanced.emojiFetchLimit", "emojiFetchLimit", "advanced.emojiFetchLimitDesc"),
						num("advanced.emojiRetryMin", "failedEmojiRetryMins", "advanced.emojiRetryMinDesc")
					]
				},
				{
					title: "advanced.burst",
					fields: [
						num("advanced.burstSampleWindow", "burstSampleWindow", "advanced.burstSampleWindowDesc"),
						num("advanced.burstElevated", "burstElevatedThreshold", "advanced.burstElevatedDesc"),
						num("advanced.burstHigh", "burstHighThreshold", "advanced.burstHighDesc"),
						num("advanced.burstExtreme", "burstExtremeThreshold", "advanced.burstExtremeDesc")
					]
				},
				{
					title: "advanced.tuning",
					fields: [
						num("advanced.tuningBacklogInjectionMax", "backlogInjectionMax", "advanced.tuningBacklogInjectionMaxDesc"),
						num("advanced.tuningDensityRamp", "backlogDensityRampMs", "advanced.tuningDensityRampDesc"),
						num("advanced.tuningPollFallback", "livePollFallbackMs", "advanced.tuningPollFallbackDesc"),
						num("advanced.tuningPollFailureLimit", "livePollFailureLimit", "advanced.tuningPollFailureLimitDesc"),
						num("advanced.tuningSpeedBoostThreshold", "speedBoostThreshold", "advanced.tuningSpeedBoostThresholdDesc"),
						range("advanced.tuningBacklogPause", "backlogPauseThreshold", "advanced.tuningBacklogPauseDesc"),
						range("advanced.tuningBacklogResume", "backlogResumeThreshold", "advanced.tuningBacklogResumeDesc"),
						num("advanced.tuningActivityTimeout", "activityTimeoutMs", "advanced.tuningActivityTimeoutDesc"),
						num("advanced.tuningStaggerMax", "staggerMaxDelayMs", "advanced.tuningStaggerMaxDesc"),
						num("advanced.tuningStaggerMedium", "staggerMediumDelayMs", "advanced.tuningStaggerMediumDesc"),
						num("advanced.tuningEmojiTimeout", "emojiFetchTimeoutMs", "advanced.tuningEmojiTimeoutDesc"),
						num("advanced.tuningDensityRampMax", "backlogDensityRampMaxMs", "advanced.tuningDensityRampMaxDesc"),
						num("advanced.tuningInjectionRateMin", "backlogInjectionRateMin", "advanced.tuningInjectionRateMinDesc"),
						num("advanced.tuningSpeedBoostMax", "speedBoostMax", "advanced.tuningSpeedBoostMaxDesc"),
						num("advanced.tuningSpeedBoostDenom", "speedBoostDenom", "advanced.tuningSpeedBoostDenomDesc"),
						num("advanced.tuningToggleCooldown", "backlogToggleCooldownMs", "advanced.tuningToggleCooldownDesc"),
						num("advanced.replayPrefetchPages", "replayPrefetchPages", "advanced.replayPrefetchPagesDesc"),
						num("advanced.replayBatchLimit", "replayBatchLimit", "advanced.replayBatchLimitDesc")
					]
				},
				{
					title: "advanced.developer",
					fields: [
						sel("advanced.logLevel", "logLevel", [
							["warn", "advanced.logLevelWarn"],
							["info", "advanced.logLevelInfo"],
							["debug", "advanced.logLevelDebug"]
						], "advanced.logLevelDesc"),
						chk("advanced.debugOverlay", "showDebugOverlay", "advanced.debugOverlayDesc"),
						chk("advanced.ignoreReducedMotion", "ignoreReducedMotion", "advanced.ignoreReducedMotionDesc")
					]
				}
			]
		},
		{
			id: "translation",
			label: "pane.translation",
			sections: [{
				title: "translation.interface",
				fields: [sel("translation.language", "language", [
					["auto", "translation.languageAuto"],
					["en", "English"],
					["ko", "한국어"],
					["ja", "日本語"],
					["es", "Español"],
					["zh-CN", "中文"],
					["ar", "العربية"]
				], "translation.languageDesc")]
			}, {
				title: "translation.chat",
				fields: [
					chk("translation.enable", "translationEnabled", "translation.enableDesc"),
					sel("translation.service", "translationService", [["auto", "translation.serviceAuto"]], "translation.serviceDesc"),
					sel("translation.source", "translationSource", [
						["auto", "translation.sourceAuto"],
						["en", "English"],
						["ko", "한국어"],
						["ja", "日本語"],
						["es", "Español"],
						["zh-CN", "中文"],
						["ar", "العربية"]
					], "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection."),
					sel("translation.target", "translationTarget", [
						["auto", "translation.languageAuto"],
						["ko", "한국어"],
						["en", "English"],
						["ja", "日本語"],
						["es", "Español"],
						["zh-CN", "中文"],
						["ar", "العربية"]
					], "translation.sourceDesc"),
					sel("translation.displayMode", "translationMode", [["dual", "translation.displayModeDual"], ["replace", "translation.displayModeReplace"]], "translation.displayModeDesc")
				]
			}]
		}
	];
	var log$2 = createLogger("SettingsUiForm");
	var _fieldIdCounter = 0;
	function nextFieldId(prefix) {
		return `yt-field-${prefix}-${_fieldIdCounter++}`;
	}
	function setupTabKeyNavigation(tablist) {
		const tabs = Array.from(tablist.querySelectorAll("[role=\"tab\"]"));
		if (tabs.length === 0) return;
		const handleKeyDown = (event) => {
			const currentTab = document.activeElement;
			if (currentTab?.getAttribute("role") !== "tab") return;
			const currentIndex = tabs.indexOf(currentTab);
			if (currentIndex === -1) return;
			let newIndex = -1;
			switch (event.key) {
				case "ArrowLeft":
					newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
					event.preventDefault();
					break;
				case "ArrowRight":
					newIndex = (currentIndex + 1) % tabs.length;
					event.preventDefault();
					break;
				case "Home":
					newIndex = 0;
					event.preventDefault();
					break;
				case "End":
					newIndex = tabs.length - 1;
					event.preventDefault();
					break;
				default: return;
			}
			if (newIndex >= 0 && newIndex !== currentIndex) {
				currentTab.setAttribute("tabindex", "-1");
				const newTab = tabs[newIndex];
				if (newTab) {
					newTab.setAttribute("tabindex", "0");
					newTab.focus();
					newTab.click();
				}
			}
		};
		tablist.addEventListener("keydown", handleKeyDown);
	}
	var STYLE_ID = "yt-chat-overlay-settings-style";
	var BUTTON_ID = "yt-chat-overlay-settings-button";
	var RELOAD_BUTTON_ID = "yt-chat-overlay-reload-button";
	var BACKDROP_ID = "yt-chat-overlay-settings-backdrop";
	var OUTLINE_NUMERIC_KEY_SET = new Set(OUTLINE_NUMERIC_KEYS);
	var isOutlineNumericKey = (key) => OUTLINE_NUMERIC_KEY_SET.has(key);
	function domDiv(className) {
		const el = document.createElement("div");
		el.className = className;
		return el;
	}
	function domInput(props) {
		const el = document.createElement("input");
		el.type = props.type;
		el.name = props.name;
		if (props.className) el.className = props.className;
		el.autocomplete = "off";
		return el;
	}
	function domField(labelText, control, _id) {
		const label = document.createElement("label");
		label.className = "yt-chat-overlay-settings-field";
		const text = document.createElement("span");
		text.textContent = labelText;
		label.append(text, control);
		return label;
	}
	function domSection(titleText) {
		const sec = domDiv("yt-chat-overlay-settings-section");
		const title = document.createElement("h3");
		title.className = "yt-chat-overlay-settings-section-title";
		title.textContent = titleText;
		sec.appendChild(title);
		return sec;
	}
	function domGridCheckbox(name, id) {
		const el = domInput({
			type: "checkbox",
			name
		});
		el.className = "yt-chat-overlay-author-grid-checkbox";
		if (id) el.id = id;
		return el;
	}
	var TITLE_ID = "yt-chat-overlay-settings-title";
	function createHeader() {
		const header = domDiv("yt-chat-overlay-settings-header");
		const title = document.createElement("h2");
		title.id = TITLE_ID;
		title.className = "yt-chat-overlay-settings-title";
		title.textContent = t("app.title");
		const closeButton = document.createElement("button");
		closeButton.type = "button";
		closeButton.className = "yt-chat-overlay-settings-close";
		closeButton.setAttribute("data-action", "close");
		closeButton.setAttribute("aria-label", t("app.close"));
		closeButton.setAttribute("command", "close");
		closeButton.textContent = "×";
		header.append(title, closeButton);
		return header;
	}
	function createTabs() {
		const nav = document.createElement("nav");
		nav.className = "yt-chat-overlay-settings-tabs";
		nav.setAttribute("role", "tablist");
		nav.setAttribute("aria-orientation", "horizontal");
		nav.setAttribute("aria-label", t("app.settingsCategories"));
		for (const [index, pane] of PANES.entries()) {
			const tabId = `tab-${pane.id}`;
			const button = document.createElement("button");
			button.type = "button";
			button.id = tabId;
			button.className = "yt-chat-overlay-settings-tab";
			button.dataset.tab = pane.id;
			button.setAttribute("role", "tab");
			button.setAttribute("aria-selected", String(index === 0));
			button.setAttribute("aria-controls", `pane-${pane.id}`);
			button.setAttribute("tabindex", String(index === 0 ? 0 : -1));
			button.textContent = t(pane.label);
			if (pane.id === "comments") button.classList.add("active");
			nav.appendChild(button);
		}
		setupTabKeyNavigation(nav);
		return nav;
	}
	var ACTIONS = [
		"reset",
		"export",
		"import",
		"close"
	];
	function createActions() {
		const wrapper = domDiv("yt-chat-overlay-settings-actions-wrapper");
		const actions = domDiv("yt-chat-overlay-settings-actions");
		for (const action of ACTIONS) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.action = action;
			button.textContent = action === "close" ? t("app.done") : t(`actions.${action}`);
			actions.appendChild(button);
		}
		wrapper.appendChild(actions);
		const autoSaveHint = document.createElement("p");
		autoSaveHint.className = "yt-chat-overlay-settings-autosave-hint";
		autoSaveHint.textContent = t("app.autoSave");
		wrapper.appendChild(autoSaveHint);
		return wrapper;
	}
	function createEnabledField(title) {
		const id = nextFieldId("enabled");
		const label = document.createElement("label");
		label.className = "yt-chat-overlay-settings-enabled";
		const text = document.createElement("span");
		text.textContent = t("app.enabled");
		const input = domInput({
			type: "checkbox",
			name: "enabled"
		});
		input.id = id;
		if (title) input.title = t(title);
		label.append(text, input);
		return label;
	}
	function createCheckboxField(labelText, name, title) {
		const id = nextFieldId(name);
		const input = domInput({
			type: "checkbox",
			name
		});
		input.id = id;
		if (title) input.title = t(title);
		return domField(t(labelText), input, id);
	}
	function getRangeUnit(key) {
		switch (key) {
			case "opacity":
			case "safeTop":
			case "safeBottom":
			case "depthNearSpeedMul":
			case "depthFarSpeedMul":
			case "depthFarOpacityMul": return "%";
			case "fontSize": return "px";
			case "speedPxPerSec": return "px/s";
			default: return "";
		}
	}
	var ROUNDING_PRECISION = 1e4;
	var scaleUiValue = (value, scale) => Math.round(value * scale * ROUNDING_PRECISION) / ROUNDING_PRECISION;
	var getRootScale = (key) => getRootDisplayMeta(key).scale;
	var normalizeNumericValue = (value, fallback, limits, rounded, scale = 1) => {
		const rawValue = typeof value === "number" ? value : Number(value);
		const scaledValue = (rounded ? Math.round(rawValue) : rawValue) / scale;
		const numericValue = Number.isFinite(scaledValue) ? scaledValue : fallback;
		return Math.min(limits.max, Math.max(limits.min, numericValue));
	};
	var formatRootNumericSettingForInput = (key, value) => {
		const { scale, precision } = getRootDisplayMeta(key);
		const scaledValue = scaleUiValue(value, scale);
		return precision > 0 ? scaledValue.toFixed(precision) : scaledValue;
	};
	var normalizeRootNumericInputValue = (key, value, fallback) => {
		return normalizeNumericValue(value, fallback, resolveLimits(key), getRootDisplayMeta(key).precision <= 0, getRootScale(key));
	};
	var normalizeOutlineNumericInputValue = (key, value, fallback) => {
		return normalizeNumericValue(value, fallback, resolveOutlineLimits(key), false, getOutlineDisplayScale(key));
	};
	var getNumericInputAttributes = (key) => {
		const limits = isOutlineNumericKey(key) ? resolveOutlineLimits(key) : resolveLimits(key);
		const scale = isOutlineNumericKey(key) ? getOutlineDisplayScale(key) : getRootScale(key);
		return {
			min: scaleUiValue(limits.min, scale),
			max: scaleUiValue(limits.max, scale),
			step: scaleUiValue(limits.step, scale)
		};
	};
	var applyNumberInputAttributes = (input, key) => {
		const { min, max, step } = getNumericInputAttributes(key);
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
	};
	function patchOutline(partial, patch) {
		partial.outline = {
			...partial.outline ?? {},
			...patch
		};
	}
	var SettingsUiForm = class {
		getSettings;
		onPreview;
		modal = null;
		isUpdating = false;
		errorDismissTimeouts = [];
		_modalCleanupFns = [];
		constructor(getSettings, onPreview) {
			this.getSettings = getSettings;
			this.onPreview = onPreview;
		}
		setModal(modal) {
			for (const fn of this._modalCleanupFns) fn();
			this._modalCleanupFns = [];
			this.modal = modal;
			if (modal) {
				this.bindNumberInputKeys(modal);
				this.bindAriaInvalidSync(modal);
			} else this.clearErrorDismissTimeouts();
			log$2.debug("Modal set", { attached: modal !== null });
		}
		destroy() {
			this.clearErrorDismissTimeouts();
			this.modal = null;
		}
		clearErrorDismissTimeouts() {
			for (const t of this.errorDismissTimeouts) clearTimeout(t);
			this.errorDismissTimeouts = [];
		}
		bindNumberInputKeys(modal) {
			const handler = (event) => {
				const target = event.target;
				if (!(target instanceof HTMLInputElement) || target.type !== "number") return;
				const step = parseFloat(target.step || "1");
				if (!step || !Number.isFinite(step)) return;
				let direction = 0;
				if (event.key === "ArrowUp") direction = 1;
				else if (event.key === "ArrowDown") direction = -1;
				else return;
				if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return;
				const scale = event.ctrlKey || event.metaKey ? 100 : 10;
				const delta = direction * step * scale;
				event.preventDefault();
				const min = target.min ? parseFloat(target.min) : -Infinity;
				const max = target.max ? parseFloat(target.max) : Infinity;
				const current = parseFloat(target.value);
				const newValue = Math.min(max, Math.max(min, (Number.isFinite(current) ? current : min) + delta));
				target.value = String(Math.round(newValue / step) * step);
				target.dispatchEvent(new Event("input", { bubbles: true }));
			};
			modal.addEventListener("keydown", handler);
			this._modalCleanupFns.push(() => modal.removeEventListener("keydown", handler));
		}
		bindAriaInvalidSync(modal) {
			const supportsUserInvalid = (() => {
				try {
					return CSS.supports("selector(:user-invalid)");
				} catch {
					return false;
				}
			})();
			const sync = (input) => {
				if (input.willValidate) {
					const isInvalid = supportsUserInvalid ? input.matches(":user-invalid") : input.matches(":invalid") || !input.checkValidity();
					input.setAttribute("aria-invalid", String(isInvalid));
				}
			};
			const blurHandler = (event) => {
				const target = event.target;
				if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
					if (target.name) sync(target);
				}
			};
			const inputHandler = (event) => {
				const target = event.target;
				if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
					if (target.name) sync(target);
				}
			};
			modal.addEventListener("blur", blurHandler, true);
			modal.addEventListener("input", inputHandler);
			this._modalCleanupFns.push(() => {
				modal.removeEventListener("blur", blurHandler, true);
				modal.removeEventListener("input", inputHandler);
			});
		}
		attachLivePreview(element) {
			if (!this.onPreview) return;
			const handler = () => {
				if (this.isUpdating) return;
				this.onPreview?.();
			};
			const inputs = element.querySelectorAll("input, select");
			for (const input of inputs) if (input instanceof HTMLInputElement && input.type === "number") input.addEventListener("input", handler);
			else input.addEventListener("change", handler);
			const fontPreviewEl = element.querySelector(".yt-chat-overlay-settings-font-preview-text");
			if (fontPreviewEl) {
				const fontSizeInput = element.querySelector("input[name=\"fontSize\"]");
				if (fontSizeInput) fontSizeInput.addEventListener("input", () => {
					fontPreviewEl.style.fontSize = `${fontSizeInput.value}px`;
				});
				const weightToggle = element.querySelector(".yt-chat-overlay-settings-weight-toggle");
				if (weightToggle) weightToggle.addEventListener("change", () => {
					const activeBtn = weightToggle.querySelector(".yt-chat-overlay-settings-weight-toggle-btn.active");
					if (activeBtn?.dataset.value) fontPreviewEl.style.fontWeight = activeBtn.dataset.value === "bold" ? "700" : "400";
				});
				const chipsWrapper = element.querySelector(".yt-chat-overlay-settings-font-chips-wrapper");
				if (chipsWrapper) chipsWrapper.addEventListener("change", () => {
					const hiddenInput = chipsWrapper.querySelector(".yt-chat-overlay-settings-font-value");
					if (hiddenInput?.value) fontPreviewEl.style.fontFamily = hiddenInput.value;
				});
			}
		}
		createModalContent() {
			const panes = PANES.map((pane) => this.buildPane(pane));
			for (const pane of panes) this.attachLivePreview(pane);
			return [
				createHeader(),
				createTabs(),
				...panes,
				createActions()
			];
		}
		buildPane(def) {
			const pane = domDiv("yt-chat-overlay-settings-pane");
			pane.id = `pane-${def.id}`;
			pane.dataset.pane = def.id;
			pane.setAttribute("role", "tabpanel");
			pane.setAttribute("aria-labelledby", `tab-${def.id}`);
			if (def.id !== "comments") pane.hidden = true;
			if (def.id === "translation" && !TranslationService.isSupported()) {
				const msg = domDiv("yt-chat-overlay-settings-unsupported");
				msg.textContent = t("Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.");
				pane.appendChild(msg);
				return pane;
			}
			for (const section of def.sections) {
				if (section.fields.find((f) => f.type === "author-grid")) {
					pane.appendChild(this.buildAuthorGrid());
					continue;
				}
				if (section.fields.length === 0) continue;
				if (section.title) {
					const secEl = domSection(t(section.title));
					for (const field of section.fields) secEl.appendChild(this.buildField(field));
					pane.appendChild(secEl);
				} else for (const field of section.fields) {
					const el = this.buildField(field);
					if (field.type === "enabled") el.classList.add("yt-chat-overlay-settings-enabled");
					pane.appendChild(el);
				}
			}
			return pane;
		}
		buildField(def) {
			switch (def.type) {
				case "enabled": return createEnabledField(def.title);
				case "checkbox": return createCheckboxField(def.label, this.resolveKey(def), def.title);
				case "number": {
					const inputId = nextFieldId(`number-${this.resolveKey(def)}`);
					const input = domInput({
						type: "number",
						name: this.resolveKey(def)
					});
					input.id = inputId;
					input.required = true;
					input.setAttribute("aria-required", "true");
					applyNumberInputAttributes(input, def.key);
					if (def.title) input.title = t(def.title);
					return domField(t(def.label), input, inputId);
				}
				case "range": {
					const container = domDiv("yt-chat-overlay-settings-range");
					const isOutline = def.modifier === "outline" && isOutlineNumericKey(def.key);
					const limits = isOutline ? resolveOutlineLimits(def.key) : resolveLimits(def.key);
					const scale = isOutline ? getOutlineDisplayScale(def.key) : getRootDisplayMeta(def.key).scale || 1;
					const sliderId = nextFieldId(`range-${this.resolveKey(def)}`);
					const slider = document.createElement("input");
					slider.type = "range";
					slider.id = sliderId;
					slider.name = `${this.resolveKey(def)}-slider`;
					slider.autocomplete = "off";
					slider.min = String(limits.min * scale);
					slider.max = String(limits.max * scale);
					slider.step = String(limits.step * scale);
					slider.classList.add("yt-chat-overlay-settings-range-slider");
					slider.setAttribute("aria-valuemin", String(limits.min * scale));
					slider.setAttribute("aria-valuemax", String(limits.max * scale));
					slider.setAttribute("aria-valuenow", String(limits.min * scale));
					const displayUnit = getRangeUnit(def.key);
					const formatValue = (v) => displayUnit ? `${v} ${displayUnit}` : `${v} `;
					slider.setAttribute("aria-valuetext", formatValue(limits.min * scale));
					const rangeValueId = `range-value-${this.resolveKey(def)}`;
					const numberInput = domInput({
						type: "number",
						name: this.resolveKey(def)
					});
					numberInput.id = rangeValueId;
					applyNumberInputAttributes(numberInput, def.key);
					numberInput.classList.add("yt-chat-overlay-settings-range-number");
					numberInput.setAttribute("aria-label", t(def.label));
					slider.setAttribute("aria-describedby", rangeValueId);
					if (def.title) {
						numberInput.title = t(def.title);
						slider.title = t(def.title);
					}
					slider.addEventListener("input", () => {
						const val = parseFloat(slider.value);
						slider.setAttribute("aria-valuenow", slider.value);
						slider.setAttribute("aria-valuetext", formatValue(val));
						numberInput.value = slider.value;
					});
					numberInput.addEventListener("input", () => {
						slider.value = numberInput.value;
						const val = parseFloat(numberInput.value);
						slider.setAttribute("aria-valuenow", numberInput.value);
						slider.setAttribute("aria-valuetext", Number.isFinite(val) ? formatValue(val) : numberInput.value);
					});
					container.appendChild(domField(t(def.label), slider, sliderId));
					container.appendChild(numberInput);
					return container;
				}
				case "select": {
					const selectId = nextFieldId(`select-${this.resolveKey(def)}`);
					const select = document.createElement("select");
					select.name = this.resolveKey(def);
					select.id = selectId;
					select.autocomplete = "off";
					if (def.title) select.title = t(def.title);
					for (const [value, label] of def.options) {
						const opt = document.createElement("option");
						opt.value = value;
						opt.textContent = t(label);
						select.appendChild(opt);
					}
					return domField(t(def.label), select, selectId);
				}
				case "text": {
					const inputId = nextFieldId(`text-${this.resolveKey(def)}`);
					const input = domInput({
						type: "text",
						name: this.resolveKey(def)
					});
					input.id = inputId;
					input.required = true;
					input.setAttribute("aria-required", "true");
					if (def.title) input.title = t(def.title);
					if (def.placeholder) input.placeholder = t(def.placeholder);
					const field = domField(t(def.label), input, inputId);
					if (def.suggestions && def.suggestions.length > 0) {
						const datalistId = `${inputId}-list`;
						input.setAttribute("list", datalistId);
						const datalist = document.createElement("datalist");
						datalist.id = datalistId;
						for (const suggestion of def.suggestions) {
							const opt = document.createElement("option");
							opt.value = suggestion;
							datalist.appendChild(opt);
						}
						field.appendChild(datalist);
					}
					return field;
				}
				case "font-preview": return this.buildFontPreview(def);
				case "weight-toggle": {
					const field = this.buildWeightToggle(def);
					field.classList.add("yt-chat-overlay-settings-field--top-align");
					return field;
				}
				case "font-chips": {
					const field = this.buildFontChips(def);
					field.classList.add("yt-chat-overlay-settings-field--top-align");
					return field;
				}
				default: throw new Error("Unhandled field type");
			}
		}
		resolveKey(def) {
			return def.modifier ? `${def.modifier}-${def.key}` : def.key;
		}
		buildFontPreview(_def) {
			const container = domDiv("yt-chat-overlay-settings-font-preview");
			const previewText = document.createElement("span");
			previewText.className = "yt-chat-overlay-settings-font-preview-text";
			previewText.textContent = "The quick brown fox jumped over the lazy dog. 안녕하세요 こんにちは";
			container.appendChild(previewText);
			return container;
		}
		buildWeightToggle(def) {
			const resolvedKey = this.resolveKey(def);
			const container = domDiv("yt-chat-overlay-settings-weight-toggle");
			container.dataset.key = resolvedKey;
			for (const [value, label] of def.options) {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "yt-chat-overlay-settings-weight-toggle-btn";
				btn.dataset.value = value;
				btn.textContent = t(label);
				btn.addEventListener("click", () => {
					container.querySelectorAll(".yt-chat-overlay-settings-weight-toggle-btn").forEach((b) => {
						b.classList.remove("active");
					});
					btn.classList.add("active");
					container.dispatchEvent(new Event("change", { bubbles: true }));
				});
				container.appendChild(btn);
			}
			return domField(t(def.label), container);
		}
		buildFontChips(def) {
			const resolvedKey = this.resolveKey(def);
			const container = domDiv("yt-chat-overlay-settings-font-chips-wrapper");
			const chipsContainer = domDiv("yt-chat-overlay-settings-font-chips");
			for (const suggestion of def.suggestions) {
				const chip = document.createElement("button");
				chip.type = "button";
				chip.className = "yt-chat-overlay-settings-font-chip";
				chip.setAttribute("aria-pressed", "false");
				chip.dataset.value = suggestion;
				chip.textContent = this.fontChipLabel(suggestion);
				chip.addEventListener("click", () => {
					chipsContainer.querySelectorAll(".yt-chat-overlay-settings-font-chip").forEach((c) => {
						c.classList.remove("active");
						c.setAttribute("aria-pressed", "false");
					});
					chip.classList.add("active");
					chip.setAttribute("aria-pressed", "true");
					const customInput = container.querySelector(".yt-chat-overlay-settings-font-custom-input");
					if (customInput) customInput.value = "";
					const hiddenInput = container.querySelector(".yt-chat-overlay-settings-font-value");
					if (hiddenInput) hiddenInput.value = suggestion;
					container.dispatchEvent(new Event("change", { bubbles: true }));
				});
				chipsContainer.appendChild(chip);
			}
			container.appendChild(chipsContainer);
			const customRow = domDiv("yt-chat-overlay-settings-font-custom-row");
			const customInputId = nextFieldId(`font-custom-${this.resolveKey(def)}`);
			const customInput = document.createElement("input");
			customInput.type = "text";
			customInput.id = customInputId;
			customInput.autocomplete = "off";
			customInput.className = "yt-chat-overlay-settings-font-custom-input";
			customInput.placeholder = t("danmaku.fontCustom");
			customInput.addEventListener("input", () => {
				chipsContainer.querySelectorAll(".yt-chat-overlay-settings-font-chip").forEach((c) => {
					c.classList.remove("active");
					c.setAttribute("aria-pressed", "false");
				});
				const hiddenInput = container.querySelector(".yt-chat-overlay-settings-font-value");
				if (hiddenInput) hiddenInput.value = customInput.value;
				container.dispatchEvent(new Event("change", { bubbles: true }));
			});
			customRow.appendChild(customInput);
			const hiddenInput = document.createElement("input");
			hiddenInput.type = "hidden";
			hiddenInput.name = resolvedKey;
			hiddenInput.autocomplete = "off";
			hiddenInput.className = "yt-chat-overlay-settings-font-value";
			customRow.appendChild(hiddenInput);
			container.appendChild(customRow);
			return domField(t(def.label), container);
		}
		fontChipLabel(cssFamily) {
			return {
				"system-ui, -apple-system, sans-serif": "System Default",
				"\"Segoe UI\", system-ui, sans-serif": "Segoe UI",
				"\"-apple-system\", \"Helvetica Neue\", sans-serif": "SF / Helvetica",
				"\"Roboto\", system-ui, sans-serif": "Roboto",
				"\"Noto Sans KR\", sans-serif": "Noto Sans KR",
				"\"Noto Sans JP\", sans-serif": "Noto Sans JP",
				"\"Noto Sans SC\", sans-serif": "Noto Sans SC",
				"\"Noto Sans TC\", sans-serif": "Noto Sans TC",
				"\"Malgun Gothic\", sans-serif": "Malgun Gothic",
				"\"Microsoft YaHei\", sans-serif": "Microsoft YaHei",
				"\"Meiryo\", sans-serif": "Meiryo",
				"\"Cascadia Code\", \"Fira Code\", monospace": "Cascadia Code",
				"\"JetBrains Mono\", monospace": "JetBrains Mono",
				"\"Source Code Pro\", monospace": "Source Code Pro",
				monospace: "Monospace",
				"Arial, sans-serif": "Arial",
				"\"Helvetica Neue\", Arial, sans-serif": "Helvetica Neue",
				"Verdana, sans-serif": "Verdana",
				"\"Trebuchet MS\", sans-serif": "Trebuchet MS",
				"sans-serif": "Sans-serif",
				"Georgia, serif": "Georgia",
				"\"Times New Roman\", serif": "Times New Roman",
				serif: "Serif",
				"\"Comic Sans MS\", cursive": "Comic Sans MS",
				"Impact, sans-serif": "Impact",
				"\"Arial Black\", sans-serif": "Arial Black"
			}[cssFamily] ?? cssFamily;
		}
		buildAuthorGrid() {
			const section = domDiv("yt-chat-overlay-settings-section");
			const heading = document.createElement("h3");
			heading.className = "yt-chat-overlay-settings-section-title";
			heading.textContent = t("appearance.authors");
			section.appendChild(heading);
			const fieldset = document.createElement("fieldset");
			fieldset.className = "yt-chat-overlay-author-grid-fieldset";
			const grid = domDiv("yt-chat-overlay-author-grid");
			grid.setAttribute("role", "grid");
			grid.setAttribute("aria-label", t("appearance.authors"));
			const headerRow = document.createElement("div");
			headerRow.setAttribute("role", "row");
			const emptyHeader = document.createElement("span");
			emptyHeader.setAttribute("role", "gridcell");
			headerRow.appendChild(emptyHeader);
			const nameColorHeader = document.createElement("span");
			nameColorHeader.setAttribute("role", "gridcell");
			nameColorHeader.setAttribute("scope", "col");
			nameColorHeader.className = "yt-chat-overlay-author-grid-header";
			nameColorHeader.textContent = t("appearance.authorsNameColor");
			headerRow.appendChild(nameColorHeader);
			const showNameHeader = document.createElement("span");
			showNameHeader.setAttribute("role", "gridcell");
			showNameHeader.setAttribute("scope", "col");
			showNameHeader.className = "yt-chat-overlay-author-grid-header";
			showNameHeader.textContent = t("appearance.authorsShowName");
			const backgroundHeader = document.createElement("span");
			backgroundHeader.setAttribute("role", "gridcell");
			backgroundHeader.setAttribute("scope", "col");
			backgroundHeader.className = "yt-chat-overlay-author-grid-header";
			backgroundHeader.textContent = t("appearance.authorsBackground");
			headerRow.append(backgroundHeader, showNameHeader);
			grid.appendChild(headerRow);
			for (const key of AUTHOR_COLOR_KEYS) {
				const colorId = nextFieldId(`color-${key}`);
				const colorInput = domInput({
					type: "color",
					name: `color-${key}`,
					className: "yt-chat-overlay-author-grid-color"
				});
				colorInput.id = colorId;
				const labelKey = key.charAt(0).toUpperCase() + key.slice(1);
				colorInput.setAttribute("aria-label", `${t(labelKey)} ${t("Color")}`);
				const backgroundColorId = nextFieldId(`backgroundColor-${key}`);
				const backgroundColorInput = domInput({
					type: "color",
					name: `backgroundColor-${key}`,
					className: "yt-chat-overlay-author-grid-color"
				});
				backgroundColorInput.id = backgroundColorId;
				backgroundColorInput.setAttribute("aria-label", `${t(labelKey)} ${t("appearance.authorsBackground")}`);
				const backgroundEnabledId = nextFieldId(`backgroundEnabled-${key}`);
				const backgroundEnabled = domGridCheckbox(`backgroundEnabled-${key}`, backgroundEnabledId);
				backgroundEnabled.classList.add("yt-chat-overlay-author-grid-background-toggle");
				backgroundEnabled.setAttribute("aria-label", `${t("Show")} ${t(labelKey)} ${t("appearance.authorsBackground")}`);
				backgroundColorInput.addEventListener("change", () => {
					backgroundEnabled.checked = true;
				});
				const checkboxId = nextFieldId(`showAuthor-${key}`);
				const checkbox = domGridCheckbox(`showAuthor-${key}`, checkboxId);
				checkbox.setAttribute("aria-label", `${t("Show")} ${t(labelKey)}`);
				const label = document.createElement("label");
				label.className = "yt-chat-overlay-author-grid-label";
				label.htmlFor = colorId;
				label.textContent = t(labelKey);
				const row = document.createElement("div");
				row.setAttribute("role", "row");
				const labelCell = document.createElement("span");
				labelCell.setAttribute("role", "gridcell");
				labelCell.appendChild(label);
				const colorCell = document.createElement("span");
				colorCell.setAttribute("role", "gridcell");
				colorCell.appendChild(colorInput);
				const checkboxCell = document.createElement("span");
				checkboxCell.setAttribute("role", "gridcell");
				checkboxCell.appendChild(checkbox);
				const backgroundCell = document.createElement("span");
				backgroundCell.setAttribute("role", "gridcell");
				backgroundCell.className = "yt-chat-overlay-author-grid-background";
				backgroundCell.append(backgroundEnabled, backgroundColorInput);
				row.append(labelCell, colorCell, backgroundCell, checkboxCell);
				grid.appendChild(row);
			}
			const superChatCheckboxId = nextFieldId("showAuthor-superChat");
			const superChatCheckbox = domGridCheckbox("showAuthor-superChat", superChatCheckboxId);
			superChatCheckbox.setAttribute("aria-label", `${t("Show")} ${t("appearance.authorsSuperchat")}`);
			const superChatLabel = document.createElement("label");
			superChatLabel.className = "yt-chat-overlay-author-grid-label";
			superChatLabel.htmlFor = superChatCheckboxId;
			superChatLabel.textContent = t("appearance.authorsSuperchat");
			const superChatRow = document.createElement("div");
			superChatRow.setAttribute("role", "row");
			const superChatLabelCell = document.createElement("span");
			superChatLabelCell.setAttribute("role", "gridcell");
			superChatLabelCell.appendChild(superChatLabel);
			const superChatPlaceholder = document.createElement("span");
			superChatPlaceholder.setAttribute("role", "gridcell");
			superChatPlaceholder.className = "yt-chat-overlay-author-grid-color-superchat";
			superChatRow.appendChild(superChatLabelCell);
			superChatRow.appendChild(superChatPlaceholder);
			const superChatBackgroundPlaceholder = document.createElement("span");
			superChatBackgroundPlaceholder.setAttribute("role", "gridcell");
			superChatBackgroundPlaceholder.className = "yt-chat-overlay-author-grid-color-superchat";
			superChatRow.appendChild(superChatBackgroundPlaceholder);
			const superChatCheckboxCell = document.createElement("span");
			superChatCheckboxCell.setAttribute("role", "gridcell");
			superChatCheckboxCell.appendChild(superChatCheckbox);
			superChatRow.appendChild(superChatCheckboxCell);
			grid.appendChild(superChatRow);
			fieldset.appendChild(grid);
			section.appendChild(fieldset);
			return section;
		}
		populateForm(settings) {
			if (!this.modal) return;
			this.isUpdating = true;
			const els = this.modal.querySelectorAll("input, select");
			for (const el of els) {
				if (!el.name) continue;
				const target = parseSettingsControlName(el.name);
				if (!target) continue;
				if (target.group === "outline") {
					const value = settings.outline[target.key];
					if (target.key === "enabled" && el instanceof HTMLInputElement) el.checked = Boolean(value);
					else if (isOutlineNumericKey(target.key)) {
						const scale = getOutlineDisplayScale(target.key);
						const displayValue = value * scale;
						el.value = String(scale > 1 ? Math.round(displayValue) : displayValue);
						this.syncCompanionRange(el);
					}
					continue;
				}
				if (target.group === "color") {
					el.value = settings.colors[target.key];
					continue;
				}
				if (target.group === "backgroundColor") {
					el.value = normalizeBackgroundColor(settings.backgroundColors[target.key], "#00000000").slice(0, 7);
					continue;
				}
				if (target.group === "backgroundEnabled") {
					if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !normalizeBackgroundColor(settings.backgroundColors[target.key], "#00000000").endsWith("00");
					continue;
				}
				if (target.group === "showAuthor") {
					if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = settings.showAuthor[target.key];
					continue;
				}
				const value = settings[target.key];
				if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = Boolean(value);
				else el.value = typeof value === "number" ? String(formatRootNumericSettingForInput(target.key, value)) : String(value);
				this.syncCompanionRange(el);
			}
			this.syncMinTextLengthState();
			this.populateFontPreview(settings);
			this.populateWeightToggle(settings);
			this.populateFontChips(settings);
			this.isUpdating = false;
		}
		syncCompanionRange(el) {
			if (!this.modal || !el.name) return;
			const slider = this.modal.querySelector(`input[type="range"][name="${el.name}-slider"]`);
			if (!slider) return;
			slider.value = el.value;
			slider.setAttribute("aria-valuenow", slider.value);
		}
		populateFontPreview(settings) {
			if (!this.modal) return;
			const previewEl = this.modal.querySelector(".yt-chat-overlay-settings-font-preview-text");
			if (!previewEl) return;
			previewEl.style.fontSize = `${settings.fontSize}px`;
			previewEl.style.fontWeight = settings.fontWeight === "bold" ? "700" : "400";
			previewEl.style.fontFamily = settings.fontFamily;
		}
		populateWeightToggle(settings) {
			if (!this.modal) return;
			const container = this.modal.querySelector(".yt-chat-overlay-settings-weight-toggle");
			if (!container) return;
			const buttons = container.querySelectorAll(".yt-chat-overlay-settings-weight-toggle-btn");
			for (const btn of buttons) if (btn.dataset.value === settings.fontWeight) btn.classList.add("active");
			else btn.classList.remove("active");
		}
		populateFontChips(settings) {
			if (!this.modal) return;
			const chipsContainer = this.modal.querySelector(".yt-chat-overlay-settings-font-chips");
			const customInput = this.modal.querySelector(".yt-chat-overlay-settings-font-custom-input");
			const hiddenInput = this.modal.querySelector(".yt-chat-overlay-settings-font-value");
			const family = settings.fontFamily;
			let matched = false;
			if (chipsContainer) {
				const chips = chipsContainer.querySelectorAll(".yt-chat-overlay-settings-font-chip");
				for (const chip of chips) if (chip.dataset.value === family) {
					chip.classList.add("active");
					chip.setAttribute("aria-pressed", "true");
					matched = true;
				} else {
					chip.classList.remove("active");
					chip.setAttribute("aria-pressed", "false");
				}
			}
			if (customInput && !matched) customInput.value = family;
			if (hiddenInput) hiddenInput.value = family;
		}
		syncMinTextLengthState() {
			if (!this.modal) return;
			const allowShort = this.modal.querySelector("input[name=\"allowShortTextMessages\"]");
			const minText = this.modal.querySelector("input[name=\"minTextLength\"]");
			if (allowShort && minText) {
				const isDisabled = allowShort.checked;
				minText.disabled = isDisabled;
				if (isDisabled) minText.setAttribute("aria-disabled", "true");
				else minText.removeAttribute("aria-disabled");
				const existingHint = minText.name ? this.modal.querySelector(`.yt-chat-overlay-settings-field-hint[data-for="${minText.name}"]`) : null;
				if (isDisabled) {
					if (!existingHint) {
						const hint = document.createElement("span");
						hint.className = "yt-chat-overlay-settings-field-hint";
						if (minText.name) hint.dataset.for = minText.name;
						hint.textContent = t("format.shortMessagesShown");
						minText.insertAdjacentElement("afterend", hint);
					}
				} else existingHint?.remove();
			}
		}
		collectSettings() {
			const partial = {};
			if (!this.modal) return cloneSettings(this.getSettings());
			const els = this.modal.querySelectorAll("input:not([type=\"range\"]), select");
			for (const el of els) {
				if (!el.name) continue;
				const target = parseSettingsControlName(el.name);
				if (!target) continue;
				if (target.group === "outline") {
					if (target.key === "enabled") patchOutline(partial, { enabled: el.checked });
					else {
						const numericKey = isOutlineNumericKey(target.key) ? target.key : null;
						if (!numericKey) continue;
						patchOutline(partial, { [target.key]: normalizeOutlineNumericInputValue(numericKey, el.value, this.getSettings().outline[target.key]) });
					}
					continue;
				}
				if (target.group === "color") {
					if (!partial.colors) partial.colors = {};
					partial.colors[target.key] = el.value;
					continue;
				}
				if (target.group === "backgroundColor") {
					const enabled = this.modal.querySelector(`input[name="backgroundEnabled-${target.key}"]`);
					if (!partial.backgroundColors) partial.backgroundColors = {};
					partial.backgroundColors[target.key] = normalizeBackgroundColor(`${el.value}${enabled?.checked ? "59" : "00"}`, "#00000000");
					continue;
				}
				if (target.group === "backgroundEnabled") continue;
				if (target.group === "showAuthor") {
					if (!partial.showAuthor) partial.showAuthor = {};
					partial.showAuthor[target.key] = el.checked;
					continue;
				}
				const scalarKey = target.key;
				if (el instanceof HTMLInputElement) if (el.type === "checkbox") partial[scalarKey] = el.checked;
				else if (el.type === "number") {
					partial[scalarKey] = normalizeRootNumericInputValue(scalarKey, el.value, this.getSettings()[scalarKey]);
					const rawNum = Number(el.value);
					if (Number.isFinite(rawNum)) {
						const { min, max } = getNumericInputAttributes(scalarKey);
						if (rawNum < min) this.showFieldError(el, `${t("format.valueAdjusted")} ${min}`);
						else if (rawNum > max) this.showFieldError(el, `${t("format.valueAdjusted")} ${max}`);
					}
				} else partial[scalarKey] = el.value;
				else if (el instanceof HTMLSelectElement) partial[scalarKey] = el.value;
			}
			const weightToggleEl = this.modal.querySelector(".yt-chat-overlay-settings-weight-toggle");
			if (weightToggleEl) {
				const activeBtn = weightToggleEl.querySelector(".yt-chat-overlay-settings-weight-toggle-btn.active");
				if (activeBtn?.dataset.value) partial.fontWeight = activeBtn.dataset.value;
			}
			return cloneSettings({
				...this.getSettings(),
				...partial
			});
		}
		showFieldError(input, message) {
			if (!this.modal) return;
			if (input.name) this.modal.querySelectorAll(`.yt-chat-overlay-settings-field-error[data-for="${input.name}"]`).forEach((el) => {
				el.remove();
			});
			const errorId = nextFieldId(`error-${input.name}`);
			const error = document.createElement("span");
			error.className = "yt-chat-overlay-settings-field-error";
			error.id = errorId;
			error.setAttribute("role", "alert");
			error.setAttribute("aria-live", "polite");
			if (input.name) error.dataset.for = input.name;
			error.textContent = message;
			input.insertAdjacentElement("afterend", error);
			input.setAttribute("aria-errormessage", errorId);
			input.setAttribute("aria-invalid", "true");
			const timer = setTimeout(() => {
				error.remove();
				if (input.getAttribute("aria-errormessage") === errorId) {
					input.removeAttribute("aria-errormessage");
					input.setAttribute("aria-invalid", "false");
				}
				this.errorDismissTimeouts = this.errorDismissTimeouts.filter((t) => t !== timer);
			}, 3e3);
			this.errorDismissTimeouts.push(timer);
		}
		getFocusableElements() {
			if (!this.modal) return [];
			return [...this.modal.querySelectorAll("input:not([disabled]), select:not([disabled]), button, [tabindex]:not([tabindex=\"-1\"])")];
		}
	};
	var QUIET_INSTRUMENTS_TOKENS = {
		"reference.color.light-canvas": "#f7f8fa",
		"reference.color.light-surface": "#ffffff",
		"reference.color.light-raised": "#f1f4f7",
		"reference.color.light-text": "#15181d",
		"reference.color.light-muted": "#66717e",
		"reference.color.light-border": "#dde3ea",
		"reference.color.dark-canvas": "#0b0e13",
		"reference.color.dark-surface": "#131820",
		"reference.color.dark-raised": "#19212b",
		"reference.color.dark-text": "#f3f6f9",
		"reference.color.dark-muted": "#98a4b1",
		"reference.color.dark-border": "#29333f",
		"reference.color.focus-light": "#5546d8",
		"reference.color.focus-dark": "#8f86ff",
		"reference.color.success-light": "#187a52",
		"reference.color.warning-light": "#8a4d17",
		"reference.color.danger-light": "#b42318",
		"reference.color.info-light": "#166a8c",
		"reference.color.success-dark": "#62d6a4",
		"reference.color.warning-dark": "#f2b76b",
		"reference.color.danger-dark": "#ff8a80",
		"reference.color.info-dark": "#6bc7ea",
		"reference.color.iris-light": "#5f51c7",
		"reference.color.iris-dark": "#aea2ff",
		"reference.color.iris-on-dark": "#141025",
		"reference.color.tide-light": "#006c7d",
		"reference.color.tide-dark": "#65d2e0",
		"reference.color.tide-on-dark": "#07191c",
		"reference.color.flare-light": "#b5423f",
		"reference.color.flare-dark": "#ff9c93",
		"reference.color.flare-on-dark": "#27100f",
		"reference.space.2": "2px",
		"reference.space.4": "4px",
		"reference.space.8": "8px",
		"reference.space.12": "12px",
		"reference.space.16": "16px",
		"reference.space.24": "24px",
		"reference.space.32": "32px",
		"reference.radius.sm": "8px",
		"reference.radius.md": "12px",
		"reference.radius.lg": "16px",
		"reference.radius.full": "999px",
		"reference.font.family.ui": "\"Inter Variable\", \"Pretendard Variable\", \"Noto Sans\", system-ui, sans-serif",
		"reference.font.family.data": "\"Roboto Mono\", \"SFMono-Regular\", \"Consolas\", monospace",
		"reference.font.size.label": "12px",
		"reference.font.size.body": "14px",
		"reference.font.size.control": "16px",
		"reference.font.size.title": "20px",
		"reference.font.size.display": "28px",
		"reference.font.weight.medium": "500",
		"reference.font.weight.semibold": "600",
		"reference.font.weight.bold": "700",
		"reference.font.line-height.compact": "1.2",
		"reference.font.line-height.body": "1.5",
		"reference.duration.fast": "120ms",
		"reference.duration.standard": "180ms",
		"reference.duration.deliberate": "260ms",
		"reference.easing.standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
		"reference.shadow.floating": "0px 12px 32px -12px rgb(0 0 0 / 0.28)",
		"system.light.color.canvas": "#f7f8fa",
		"system.light.color.surface": "#ffffff",
		"system.light.color.raised": "#f1f4f7",
		"system.light.color.text": "#15181d",
		"system.light.color.muted": "#66717e",
		"system.light.color.border": "#dde3ea",
		"system.light.color.focus": "#5546d8",
		"system.light.color.success": "#187a52",
		"system.light.color.warning": "#8a4d17",
		"system.light.color.danger": "#b42318",
		"system.light.color.info": "#166a8c",
		"system.dark.color.canvas": "#0b0e13",
		"system.dark.color.surface": "#131820",
		"system.dark.color.raised": "#19212b",
		"system.dark.color.text": "#f3f6f9",
		"system.dark.color.muted": "#98a4b1",
		"system.dark.color.border": "#29333f",
		"system.dark.color.focus": "#8f86ff",
		"system.dark.color.success": "#62d6a4",
		"system.dark.color.warning": "#f2b76b",
		"system.dark.color.danger": "#ff8a80",
		"system.dark.color.info": "#6bc7ea",
		"component.target.minimum": "44px",
		"component.control.height-compact": "36px",
		"component.control.height-regular": "44px",
		"component.control.radius": "12px",
		"component.panel.radius": "16px",
		"component.panel.shadow": "0px 12px 32px -12px rgb(0 0 0 / 0.28)",
		"component.focus.ring-width": "2px",
		"component.focus.ring-offset": "2px",
		"component.icon.size-sm": "16px",
		"component.icon.size-md": "20px",
		"component.icon.size-lg": "24px",
		"component.icon.stroke-width": "1.75",
		"component.motion.duration-fast": "120ms",
		"component.motion.duration-standard": "180ms",
		"component.motion.duration-deliberate": "260ms",
		"component.motion.easing-standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
		"product.wmc.accent-light": "#5f51c7",
		"product.wmc.on-accent-light": "#ffffff",
		"product.wmc.accent-dark": "#aea2ff",
		"product.wmc.on-accent-dark": "#141025",
		"product.xeg.accent-light": "#006c7d",
		"product.xeg.on-accent-light": "#ffffff",
		"product.xeg.accent-dark": "#65d2e0",
		"product.xeg.on-accent-dark": "#07191c",
		"product.ytco.accent-light": "#b5423f",
		"product.ytco.on-accent-light": "#ffffff",
		"product.ytco.accent-dark": "#ff9c93",
		"product.ytco.on-accent-dark": "#27100f"
	};
	var DESIGN_ICON_CONTRACT = {
		viewBox: "0 0 24 24",
		sizes: {
			compact: QUIET_INSTRUMENTS_TOKENS["component.icon.size-sm"],
			default: QUIET_INSTRUMENTS_TOKENS["component.icon.size-md"],
			emphasis: QUIET_INSTRUMENTS_TOKENS["component.icon.size-lg"]
		},
		strokeWidth: QUIET_INSTRUMENTS_TOKENS["component.icon.stroke-width"],
		strokeLinecap: "round",
		strokeLinejoin: "round",
		fill: "none"
	};
	var tokens = QUIET_INSTRUMENTS_TOKENS;
	var SETTINGS_UI_DESIGN = {
		colorScheme: "dark",
		colors: {
			canvas: tokens["system.dark.color.canvas"],
			surface: tokens["system.dark.color.surface"],
			raised: tokens["system.dark.color.raised"],
			border: tokens["system.dark.color.border"],
			text: tokens["system.dark.color.text"],
			textMuted: tokens["system.dark.color.muted"],
			accent: tokens["product.ytco.accent-dark"],
			onAccent: tokens["product.ytco.on-accent-dark"],
			focus: tokens["system.dark.color.focus"],
			success: tokens["system.dark.color.success"],
			warning: tokens["system.dark.color.warning"],
			danger: tokens["system.dark.color.danger"],
			info: tokens["system.dark.color.info"]
		},
		radius: {
			small: tokens["reference.radius.sm"],
			control: tokens["component.control.radius"],
			panel: tokens["component.panel.radius"],
			full: tokens["reference.radius.full"]
		},
		motion: {
			fast: tokens["component.motion.duration-fast"],
			standard: tokens["component.motion.duration-standard"],
			deliberate: tokens["component.motion.duration-deliberate"],
			easing: tokens["component.motion.easing-standard"]
		},
		focus: {
			ringWidth: tokens["component.focus.ring-width"],
			ringOffset: tokens["component.focus.ring-offset"]
		},
		icon: {
			size: DESIGN_ICON_CONTRACT.sizes.default,
			strokeWidth: DESIGN_ICON_CONTRACT.strokeWidth
		},
		target: {
			minimum: tokens["component.target.minimum"],
			compactControlHeight: tokens["component.control.height-compact"]
		},
		shadow: { floating: tokens["component.panel.shadow"] }
	};
	var uiColors = {
		background: SETTINGS_UI_DESIGN.colors.surface,
		backgroundLight: SETTINGS_UI_DESIGN.colors.raised,
		border: SETTINGS_UI_DESIGN.colors.border,
		text: SETTINGS_UI_DESIGN.colors.text,
		textMuted: SETTINGS_UI_DESIGN.colors.textMuted,
		accent: SETTINGS_UI_DESIGN.colors.accent,
		accentHover: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.accent} 84%, black)`,
		onAccent: SETTINGS_UI_DESIGN.colors.onAccent,
		focus: SETTINGS_UI_DESIGN.colors.focus,
		danger: SETTINGS_UI_DESIGN.colors.danger,
		dangerFill: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.danger} 55%, black)`,
		dangerFillHover: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.danger} 65%, black)`,
		warning: SETTINGS_UI_DESIGN.colors.warning,
		success: SETTINGS_UI_DESIGN.colors.success,
		info: SETTINGS_UI_DESIGN.colors.info
	};
	var uiColorsAlpha = {
		accentBg: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.accent} 25%, transparent)`,
		accentBgLight: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.accent} 20%, transparent)`
	};
	var typography = {
		fontSize: {
			xs: "12px",
			sm: "14px",
			base: "16px",
			lg: "18px"
		},
		fontWeight: {
			normal: 400,
			semibold: 600,
			bold: 700
		},
		lineHeight: {
			normal: 1.5,
			tight: 1
		}
	};
	var shadows = { box: {
		sm: "0 2px 8px rgba(0, 0, 0, 0.6)",
		md: "0 4px 16px rgba(0, 0, 0, 0.8)",
		lg: SETTINGS_UI_DESIGN.shadow.floating
	} };
	var borderRadius = {
		sm: SETTINGS_UI_DESIGN.radius.control,
		md: SETTINGS_UI_DESIGN.radius.panel,
		lg: SETTINGS_UI_DESIGN.radius.panel,
		pill: SETTINGS_UI_DESIGN.radius.full,
		full: SETTINGS_UI_DESIGN.radius.full
	};
	var zIndex = { settingsButton: 120 };
	var uiSizing = {
		buttonSize: SETTINGS_UI_DESIGN.target.minimum,
		buttonFontSize: SETTINGS_UI_DESIGN.icon.size,
		targetMinimum: SETTINGS_UI_DESIGN.target.minimum,
		compactControlHeight: SETTINGS_UI_DESIGN.target.compactControlHeight,
		inputWidth: 86,
		colorSwatch: 44,
		colorSwatchHeight: 26,
		modalWidth: 400,
		modalMaxVW: 92,
		modalMaxWidth: 420,
		modalMaxVH: 82,
		confirmMinWidth: 240,
		checkboxSize: 18,
		borderAlpha: .25,
		scrimAlpha: .55,
		hoverScrimAlpha: .75
	};
	var tooltip = {
		bg: SETTINGS_UI_DESIGN.colors.canvas,
		border: SETTINGS_UI_DESIGN.colors.border,
		text: SETTINGS_UI_DESIGN.colors.text
	};
	var animDuration = {
		fast: SETTINGS_UI_DESIGN.motion.fast,
		normal: SETTINGS_UI_DESIGN.motion.standard,
		slow: SETTINGS_UI_DESIGN.motion.deliberate,
		transitions: {
			button: `opacity ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, background ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, transform ${SETTINGS_UI_DESIGN.motion.fast} ${SETTINGS_UI_DESIGN.motion.easing}`,
			action: `background ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, color ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}, border-color ${SETTINGS_UI_DESIGN.motion.standard} ${SETTINGS_UI_DESIGN.motion.easing}`,
			tab: `color ${SETTINGS_UI_DESIGN.motion.fast} ${SETTINGS_UI_DESIGN.motion.easing}`
		}
	};
	var CONFIRM_BACKDROP_ALPHA = .5;
	var scrollbar = {
		width: "6px",
		track: "transparent",
		thumb: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.border} 70%, transparent)`,
		thumbHover: `color-mix(in srgb, ${SETTINGS_UI_DESIGN.colors.textMuted} 45%, transparent)`
	};
	var TOAST_BG = SETTINGS_UI_DESIGN.colors.canvas;
	var TOAST_FONT = `12px/1.4 ${DEFAULT_FONT_FAMILY}`;
	var SETTINGS_UI_STYLES = `
      .yt-chat-overlay-settings-modal,
      .yt-chat-overlay-settings-confirm,
      #yt-chat-overlay-settings-backdrop {
        color-scheme: ${SETTINGS_UI_DESIGN.colorScheme};
      }
      .yt-chat-overlay-settings-button {
        position: absolute;
        top: ${spacing.sm}px;
        inset-inline-start: ${spacing.sm}px;
        width: ${uiSizing.buttonSize};
        height: ${uiSizing.buttonSize};
        border-radius: ${borderRadius.full};
        border: 1px solid rgba(255, 255, 255, ${uiSizing.borderAlpha});
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        backdrop-filter: blur(4px);
        color: ${uiColors.text};
        font-size: ${uiSizing.buttonFontSize};
        line-height: 1;
        cursor: pointer;
        z-index: ${zIndex.settingsButton};
        opacity: 0;
        pointer-events: none;
        transition: ${animDuration.transitions.button};
      }
      .yt-chat-overlay-settings-button:hover,
      .yt-chat-overlay-settings-button:focus-visible {
        background: rgba(0, 0, 0, ${uiSizing.hoverScrimAlpha});
        scale: 1.1;
      }
      .yt-chat-overlay-settings-button:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
        opacity: 1;
        pointer-events: auto;
      }
      #movie_player:hover .yt-chat-overlay-settings-button,
      .html5-video-player:hover .yt-chat-overlay-settings-button {
        opacity: 1;
        pointer-events: auto;
      }
      .yt-chat-overlay-reload-button {
        position: absolute;
        top: ${spacing.sm}px;
        inset-inline-start: calc(${spacing.sm}px + ${uiSizing.buttonSize} + ${spacing.xs}px);
        width: ${uiSizing.buttonSize};
        height: ${uiSizing.buttonSize};
        border-radius: ${borderRadius.full};
        border: 1px solid rgba(255, 255, 255, ${uiSizing.borderAlpha});
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        backdrop-filter: blur(4px);
        color: ${uiColors.text};
        font-size: ${uiSizing.buttonFontSize};
        line-height: 1;
        cursor: pointer;
        z-index: ${zIndex.settingsButton};
        opacity: 0;
        pointer-events: none;
        transition: ${animDuration.transitions.button};
      }
      .yt-chat-overlay-reload-button:hover,
      .yt-chat-overlay-reload-button:focus-visible {
        background: rgba(0, 0, 0, ${uiSizing.hoverScrimAlpha});
        scale: 1.1;
      }
      .yt-chat-overlay-reload-button:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
        opacity: 1;
        pointer-events: auto;
      }
      #movie_player:hover .yt-chat-overlay-reload-button,
      .html5-video-player:hover .yt-chat-overlay-reload-button {
        opacity: 1;
        pointer-events: auto;
      }
      /* Touch devices: no hover capability — show buttons at reduced opacity */
      @media (hover: none) {
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button {
          opacity: 0.7;
          pointer-events: auto;
        }
        .yt-chat-overlay-settings-button:focus-visible,
        .yt-chat-overlay-reload-button:focus-visible {
          opacity: 1;
        }
      }
      .yt-chat-overlay-reload-button--done {
        color: ${uiColors.success};
        border-color: ${uiColors.success}80;
      }
      @keyframes yt-overlay-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes yt-overlay-modal-scale-in {
        from { transform: scale(0.92); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
      @keyframes yt-overlay-confirm-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      /* Native <dialog> backdrop — replaces custom .yt-chat-overlay-settings-backdrop */
      dialog.yt-chat-overlay-settings-modal[open]::backdrop {
        background: rgba(0, 0, 0, ${uiSizing.scrimAlpha});
        animation: yt-overlay-fade-in ${animDuration.normal} ease-out;
      }
      dialog.yt-chat-overlay-settings-modal[open] {
        border: none;
        padding: ${spacing.lg}px;
        margin: auto;
        width: min(${uiSizing.modalWidth}px, ${uiSizing.modalMaxVW}vw);
        max-width: min(${uiSizing.modalMaxVW}vw, ${uiSizing.modalMaxWidth}px);
        max-height: ${uiSizing.modalMaxVH}vh;
        overflow: hidden;
        background: ${uiColors.background};
        color: ${uiColors.text};
        border-radius: ${borderRadius.md};
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        font-family: ${DEFAULT_FONT_FAMILY};
        box-shadow: ${shadows.box.lg};
        animation: yt-overlay-modal-scale-in ${animDuration.slow} ease-out;
      }
      @starting-style {
        dialog.yt-chat-overlay-settings-modal[open] {
          transform: scale(0.92);
          opacity: 0;
        }
      }
      /* Header */
      .yt-chat-overlay-settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: ${typography.fontWeight.bold};
        font-size: ${typography.fontSize.base};
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-close {
        border: none;
        background: transparent;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.lg};
        cursor: pointer;
        padding: ${spacing.sm}px;
        line-height: ${typography.lineHeight.tight};
        min-width: ${uiSizing.targetMinimum};
        min-height: ${uiSizing.targetMinimum};
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: ${borderRadius.sm};
      }
      .yt-chat-overlay-settings-close:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-close:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      /* Tab bar */
      .yt-chat-overlay-settings-tabs {
        display: flex;
        border-bottom: 1px solid ${uiColors.border};
        flex-shrink: 0;
      }
      .yt-chat-overlay-settings-tab {
        flex: 1;
        padding: ${spacing.sm + 2}px ${spacing.sm}px;
        min-height: ${uiSizing.targetMinimum};
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.xs};
        font-weight: ${typography.fontWeight.bold};
        letter-spacing: 0.05em;
        cursor: pointer;
        margin-bottom: -1px;
        transition: ${animDuration.transitions.tab};
      }
      .yt-chat-overlay-settings-tab:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-tab:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: calc(${SETTINGS_UI_DESIGN.focus.ringOffset} * -1);
      }
      .yt-chat-overlay-settings-tab.active {
        color: ${uiColors.accent};
        border-bottom-color: ${uiColors.accent};
      }
      /* Tab panes */
      .yt-chat-overlay-settings-pane {
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        padding-inline-end: ${spacing.xxs}px;
        scrollbar-width: thin;
        scrollbar-color: ${scrollbar.thumb} ${scrollbar.track};
        content-visibility: auto;
        contain-intrinsic-size: 300px;
        mask-image: linear-gradient(to bottom, black 94%, transparent 100%);
        -webkit-mask-image: linear-gradient(to bottom, black 94%, transparent 100%);
        padding-bottom: calc(${spacing.lg}px * 2);
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar {
        width: ${scrollbar.width};
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-track {
        background: ${scrollbar.track};
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-thumb {
        background: ${scrollbar.thumb};
        border-radius: ${scrollbar.width};
      }
      .yt-chat-overlay-settings-pane::-webkit-scrollbar-thumb:hover {
        background: ${scrollbar.thumbHover};
      }
      .yt-chat-overlay-settings-pane[hidden] {
        display: none;
      }
      /* Sections within a pane */
      .yt-chat-overlay-settings-section {
        display: flex;
        flex-direction: column;
        gap: ${spacing.md}px;
      }
      .yt-chat-overlay-settings-section-title {
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding-bottom: ${spacing.xs}px;
        border-bottom: 1px solid ${uiColors.border};
      }
      /* Row fields */
      .yt-chat-overlay-settings-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: ${spacing.md}px;
        font-size: ${typography.fontSize.sm};
        min-height: 40px;
      }
      .yt-chat-overlay-settings-field input[type="number"] {
        width: ${uiSizing.inputWidth}px;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        text-align: end;
        -moz-appearance: textfield;
      }
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-inner-spin-button,
      .yt-chat-overlay-settings-field input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .yt-chat-overlay-settings-field input[type="text"] {
        flex: 1;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        font-size: ${typography.fontSize.sm};
      }
      .yt-chat-overlay-settings-field input[type="text"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-field input[type="color"] {
        width: ${uiSizing.colorSwatch}px;
        height: ${uiSizing.colorSwatchHeight}px;
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field input[type="checkbox"] {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
        cursor: pointer;
        accent-color: ${uiColors.accent};
      }
      .yt-chat-overlay-settings-field input[type="checkbox"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-field select {
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        cursor: pointer;
      }
      .yt-chat-overlay-settings-field select:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      /* ── :user-invalid validation styles ── */
      .yt-chat-overlay-settings-field input:user-invalid,
      .yt-chat-overlay-settings-field select:user-invalid {
        border-color: ${uiColors.danger};
        outline: 1px solid ${uiColors.danger};
      }
      .yt-chat-overlay-settings-section:has(:user-invalid) .yt-chat-overlay-settings-section-title {
        color: ${uiColors.danger};
      }
      .yt-chat-overlay-settings-field input[type="number"],
      .yt-chat-overlay-settings-field input[type="text"] {
        field-sizing: content;
        min-inline-size: 60px;
        max-inline-size: 200px;
      }
      .yt-chat-overlay-settings-field input[type="number"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-field input[type="text"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-field input[type="number"]:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      /* Enabled toggle */
      .yt-chat-overlay-settings-enabled {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: ${spacing.sm}px ${spacing.md}px;
        background: ${uiColors.backgroundLight};
        border-radius: ${borderRadius.sm};
        font-size: ${typography.fontSize.sm};
        font-weight: ${typography.fontWeight.semibold};
        cursor: pointer;
      }
      .yt-chat-overlay-settings-enabled input[type="checkbox"] {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
        cursor: pointer;
        accent-color: ${uiColors.accent};
      }
      .yt-chat-overlay-settings-enabled input[type="checkbox"]:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      /* Authors grid — role="row" wrappers use display:contents so children
         become direct grid items (immune to wrapper insertion/removal) */
      .yt-chat-overlay-author-grid {
        display: grid;
        grid-template-columns: 1fr auto auto auto;
        gap: ${spacing.sm}px ${spacing.md}px;
        align-items: center;
      }
      .yt-chat-overlay-author-grid > [role="row"] {
        display: contents;
      }
      .yt-chat-overlay-author-grid-header {
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        text-align: center;
      }
      .yt-chat-overlay-author-grid-label {
        font-size: ${typography.fontSize.sm};
        unicode-bidi: isolate;
      }
      .yt-chat-overlay-author-grid-color {
        width: ${uiSizing.colorSwatch}px;
        height: ${uiSizing.colorSwatchHeight}px;
        cursor: pointer;
      }
      .yt-chat-overlay-author-grid-color:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-author-grid [role="gridcell"]:has(> .yt-chat-overlay-author-grid-color) {
        justify-self: center;
      }
      .yt-chat-overlay-author-grid-checkbox {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
        cursor: pointer;
        accent-color: ${uiColors.accent};
      }
      .yt-chat-overlay-author-grid-checkbox:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-author-grid [role="gridcell"]:has(> .yt-chat-overlay-author-grid-checkbox) {
        justify-self: center;
      }
      .yt-chat-overlay-author-grid-background {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: ${spacing.xs}px;
      }
      .yt-chat-overlay-author-grid-background-toggle {
        width: ${uiSizing.checkboxSize}px;
        height: ${uiSizing.checkboxSize}px;
      }
      .yt-chat-overlay-author-grid-color-superchat {
        width: ${uiSizing.colorSwatch}px;
        height: ${uiSizing.colorSwatchHeight}px;
      }
      /* Actions bar */
      .yt-chat-overlay-settings-actions-wrapper {
        flex-shrink: 0;
        padding-top: ${spacing.sm}px;
        border-top: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions {
        display: flex;
        justify-content: flex-end;
        gap: ${spacing.sm}px;
      }
      .yt-chat-overlay-settings-actions button {
        border: none;
        border-radius: ${borderRadius.sm};
        padding: ${spacing.sm}px ${spacing.md}px;
        min-height: ${uiSizing.compactControlHeight};
        cursor: pointer;
        font-weight: ${typography.fontWeight.semibold};
        font-size: ${typography.fontSize.sm};
        transition: ${animDuration.transitions.action};
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"] {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions button[data-action="reset"]:hover {
        color: ${uiColors.danger};
        border-color: ${uiColors.danger};
      }
      .yt-chat-overlay-settings-actions button[data-action="export"] {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions button[data-action="export"]:hover {
        color: ${uiColors.text};
        border-color: ${uiColors.accent};
      }
      .yt-chat-overlay-settings-actions button[data-action="import"] {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-actions button[data-action="import"]:hover {
        color: ${uiColors.warning};
        border-color: ${uiColors.warning};
      }
      .yt-chat-overlay-settings-actions button:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-actions button[data-action="close"] {
        background: ${uiColors.accent};
        color: ${uiColors.onAccent};
      }
      .yt-chat-overlay-settings-actions button[data-action="close"]:hover {
        background: ${uiColors.accentHover};
      }
      .yt-chat-overlay-settings-autosave-hint {
        margin: ${spacing.xs}px 0 0;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        text-align: end;
        font-family: ${DEFAULT_FONT_FAMILY};
      }

      /* Reset confirmation dialog — native <dialog> */
      dialog.yt-chat-overlay-settings-confirm[open] {
        border: none;
        padding: ${spacing.lg}px;
        margin: auto;
        background: ${uiColors.backgroundLight};
        border: 1px solid ${uiColors.border};
        border-radius: ${borderRadius.md};
        min-width: ${uiSizing.confirmMinWidth}px;
        box-shadow: ${shadows.box.lg};
        animation: yt-overlay-confirm-fade-in ${animDuration.normal} ease-out;
      }
      dialog.yt-chat-overlay-settings-confirm[open]::backdrop {
        background: rgba(0, 0, 0, ${CONFIRM_BACKDROP_ALPHA});
        animation: yt-overlay-confirm-fade-in ${animDuration.normal} ease-out;
      }
      .yt-chat-overlay-settings-confirm-message {
        margin: 0 0 ${spacing.md}px;
        font-size: ${typography.fontSize.sm};
        color: ${uiColors.text};
        font-family: ${DEFAULT_FONT_FAMILY};
      }
      .yt-chat-overlay-settings-confirm-buttons {
        display: flex;
        justify-content: flex-end;
        gap: ${spacing.sm}px;
        font-family: ${DEFAULT_FONT_FAMILY};
      }
      .yt-chat-overlay-settings-confirm-cancel,
      .yt-chat-overlay-settings-confirm-ok {
        border: none;
        border-radius: ${borderRadius.sm};
        padding: ${spacing.sm}px ${spacing.md}px;
        min-height: ${uiSizing.compactControlHeight};
        cursor: pointer;
        font-weight: ${typography.fontWeight.semibold};
        font-size: ${typography.fontSize.sm};
        font-family: inherit;
      }
      .yt-chat-overlay-settings-confirm-cancel {
        background: transparent;
        color: ${uiColors.textMuted};
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-confirm-cancel:hover {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-confirm-cancel:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-confirm-ok {
        background: ${uiColors.dangerFill};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-confirm-ok:hover {
        background: ${uiColors.dangerFillHover};
      }
      .yt-chat-overlay-settings-confirm-ok:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      /* Toast notification */
      .yt-chat-overlay-settings-toast {
        position: absolute;
        bottom: 60px;
        left: 50%;
        transform: translateX(-50%);
        background: ${TOAST_BG};
        color: ${uiColors.text};
        font: ${TOAST_FONT};
        padding: 6px 14px;
        border-radius: ${borderRadius.sm};
        z-index: 2;
        pointer-events: none;
        animation: yt-overlay-fade-in ${animDuration.normal} ease-out;
      }
      .yt-chat-overlay-settings-unsupported {
        padding: ${spacing.lg}px;
        margin: ${spacing.md}px 0;
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.sm};
        text-align: center;
        line-height: 1.5;
      }
      /* Range slider (dual: slider + number) */
      .yt-chat-overlay-settings-range {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
        padding: 6px 0;
        justify-content: space-between;
      }
      .yt-chat-overlay-settings-range label {
        flex: 1;
        font-size: ${typography.fontSize.sm};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-range-slider {
        flex: 2;
        height: ${spacing.sm}px;
        accent-color: ${uiColors.accent};
        cursor: pointer;
        margin: 0;
      }
      .yt-chat-overlay-settings-range-slider:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-range-number {
        width: ${uiSizing.inputWidth}px;
        text-align: end;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        font-size: ${typography.fontSize.sm};
        -moz-appearance: textfield;
      }
      .yt-chat-overlay-settings-range-number:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }
      .yt-chat-overlay-settings-range-number::-webkit-inner-spin-button,
      .yt-chat-overlay-settings-range-number::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      /* Inline validation error */
      .yt-chat-overlay-settings-field-error {
        display: block;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.danger};
        margin-top: ${spacing.xxs}px;
        animation: yt-overlay-error-fade 3s ease-out forwards;
      }
      @keyframes yt-overlay-error-fade {
        0%, 70% { opacity: 1; }
        100% { opacity: 0; }
      }
      /* Disabled-field helper hint */
      .yt-chat-overlay-settings-field-hint {
        display: block;
        font-size: ${typography.fontSize.xs};
        color: ${uiColors.textMuted};
        margin-top: ${spacing.xxs}px;
      }

      /* ── Font preview ── */
      .yt-chat-overlay-settings-font-preview {
        background: ${uiColors.background};
        border: 1px solid ${uiColors.border};
        border-radius: ${borderRadius.sm};
        padding: ${spacing.lg}px;
        margin-bottom: ${spacing.md}px;
        text-align: center;
        min-height: 60px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .yt-chat-overlay-settings-font-preview-text {
        color: ${uiColors.text};
        transition: font-size ${animDuration.fast} ${SETTINGS_UI_DESIGN.motion.easing}, font-weight ${animDuration.fast} ${SETTINGS_UI_DESIGN.motion.easing};
        line-height: 1.3;
      }

      /* ── Weight toggle pills ── */
      .yt-chat-overlay-settings-weight-toggle {
        display: flex;
        gap: 0;
        border-radius: ${borderRadius.sm};
        overflow: hidden;
        border: 1px solid ${uiColors.border};
      }
      .yt-chat-overlay-settings-weight-toggle-btn {
        flex: 1;
        padding: ${spacing.xs}px ${spacing.md}px;
        border: none;
        background: ${uiColors.backgroundLight};
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.sm};
        cursor: pointer;
        transition: ${animDuration.transitions.action};
        border-right: 1px solid ${uiColors.border};
        min-height: ${uiSizing.targetMinimum};
      }
      .yt-chat-overlay-settings-weight-toggle-btn:last-child {
        border-right: none;
      }
      .yt-chat-overlay-settings-weight-toggle-btn.active {
        background: ${uiColorsAlpha.accentBg};
        color: ${uiColors.text};
        font-weight: ${typography.fontWeight.bold};
      }
      .yt-chat-overlay-settings-weight-toggle-btn:hover:not(.active) {
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-weight-toggle-btn:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: calc(${SETTINGS_UI_DESIGN.focus.ringOffset} * -1);
      }

      /* ── Font family chips ── */
      .yt-chat-overlay-settings-font-chips-wrapper {
        width: 100%;
      }
      .yt-chat-overlay-settings-font-chips {
        display: flex;
        flex-wrap: wrap;
        gap: ${spacing.xs}px;
        margin-bottom: ${spacing.sm}px;
      }
      .yt-chat-overlay-settings-font-chip {
        appearance: none;
        -webkit-appearance: none;
        font-family: inherit;
        padding: ${spacing.sm - 1}px ${spacing.md}px;
        min-height: ${uiSizing.targetMinimum};
        line-height: 1.3;
        border-radius: ${borderRadius.pill};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.textMuted};
        font-size: ${typography.fontSize.xs};
        cursor: pointer;
        transition: all ${animDuration.normal} ${SETTINGS_UI_DESIGN.motion.easing};
        white-space: nowrap;
        text-wrap: nowrap;
        user-select: none;
      }
      .yt-chat-overlay-settings-font-chip:hover {
        border-color: ${uiColors.accent};
        color: ${uiColors.text};
      }
      .yt-chat-overlay-settings-font-chip.active {
        background: ${uiColorsAlpha.accentBgLight};
        border-color: ${uiColors.accent};
        color: ${uiColors.text};
        font-weight: ${typography.fontWeight.bold};
      }
      .yt-chat-overlay-settings-font-chip:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }

      /* ── Custom font input row ── */
      .yt-chat-overlay-settings-font-custom-row {
        display: flex;
        align-items: center;
        gap: ${spacing.sm}px;
      }
      .yt-chat-overlay-settings-font-custom-input {
        flex: 1;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        border: 1px solid ${uiColors.border};
        background: ${uiColors.backgroundLight};
        color: ${uiColors.text};
        font-size: ${typography.fontSize.xs};
      }
      .yt-chat-overlay-settings-font-custom-input:focus-visible {
        outline: ${SETTINGS_UI_DESIGN.focus.ringWidth} solid ${uiColors.focus};
        outline-offset: ${SETTINGS_UI_DESIGN.focus.ringOffset};
      }

      /* Font panel label override — vertical alignment for chip/weight containers */
      .yt-chat-overlay-settings-field--top-align {
        align-items: flex-start;
      }

      /* ── Accessibility: reduced motion ── */
      @media (prefers-reduced-motion: reduce) {
        .yt-chat-overlay-settings-toast,
        .yt-chat-overlay-settings-field-error,
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button,
        .yt-chat-overlay-settings-close,
        .yt-chat-overlay-settings-actions button,
        .yt-chat-overlay-settings-tab,
        .yt-chat-overlay-settings-font-preview-text,
        .yt-chat-overlay-settings-weight-toggle-btn,
        .yt-chat-overlay-settings-font-chip,
        dialog.yt-chat-overlay-settings-modal[open]::backdrop,
        dialog.yt-chat-overlay-settings-modal[open],
        dialog.yt-chat-overlay-settings-confirm[open]::backdrop,
        dialog.yt-chat-overlay-settings-confirm[open] {
          animation: none !important;
          transition: none !important;
        }
      }

      /* ── Accessibility: forced colors (Windows High Contrast) ── */
      @media (forced-colors: active) {
        .yt-chat-overlay-settings-tabs,
        .yt-chat-overlay-settings-section-title,
        .yt-chat-overlay-settings-actions button[data-action="reset"],
        .yt-chat-overlay-settings-actions button[data-action="export"],
        .yt-chat-overlay-settings-actions button[data-action="import"],
        dialog.yt-chat-overlay-settings-confirm[open],
        .yt-chat-overlay-settings-confirm-cancel {
          border-color: CanvasText;
        }
        .yt-chat-overlay-settings-button,
        .yt-chat-overlay-reload-button,
        .yt-chat-overlay-settings-close,
        .yt-chat-overlay-settings-actions button,
        .yt-chat-overlay-settings-tab,
        .yt-chat-overlay-settings-field input,
        .yt-chat-overlay-settings-field select,
        .yt-chat-overlay-settings-range-number,
        .yt-chat-overlay-settings-confirm-cancel,
        .yt-chat-overlay-settings-confirm-ok {
          forced-color-adjust: none;
        }
        .yt-chat-overlay-settings-button:focus-visible,
        .yt-chat-overlay-reload-button:focus-visible,
        .yt-chat-overlay-settings-close:focus-visible,
        .yt-chat-overlay-settings-actions button:focus-visible,
        .yt-chat-overlay-settings-tab:focus-visible {
          outline-color: Highlight;
        }
        .yt-chat-overlay-settings-tab.active {
          border-bottom-color: Highlight;
          color: Highlight;
        }
        .yt-chat-overlay-settings-actions button[data-action="close"] {
          background: Highlight;
          color: HighlightText;
        }
      }
      /* Black overlay opacity scale — documented rationale:
       * - 0.90: Tooltip bg (highest contrast, over white/dark content)
       * - 0.85: Toast bg (floating notification, slightly less opaque)
       * - 0.80: Debug overlay (dev-only, unobtrusive)
       * - 0.75: Backlog indicator (small pill, less intrusive)
       */
      /* Native Popover API tooltips */
      .yt-chat-overlay-tooltip {
        font-family: ${DEFAULT_FONT_FAMILY};
        font-size: ${typography.fontSize.xs};
        line-height: 1.4;
        padding: ${spacing.xs}px ${spacing.sm}px;
        border-radius: ${borderRadius.sm};
        background: ${tooltip.bg};
        color: ${tooltip.text};
        border: 1px solid ${tooltip.border};
        max-width: 240px;
        pointer-events: none;
        white-space: nowrap;
        opacity: 0;
        transition: opacity ${animDuration.normal} ${SETTINGS_UI_DESIGN.motion.easing};
      }
      @starting-style {
        .yt-chat-overlay-tooltip:popover-open {
          opacity: 0;
        }
      }
      .yt-chat-overlay-tooltip:popover-open {
        inset: unset;
        margin: 0;
        opacity: 1;
        /* Default placement: below the anchor element, center-aligned */
        position-area: block-end;
        /* Edge-aware fallbacks: flip above if no room below, then flip horizontally */
        position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
      }
      /* CSS Anchor Positioning — anchor-name targets use fixed ID strings */
      #yt-chat-overlay-settings-button {
        anchor-name: --yt-overlay-settings-btn;
      }
      #yt-chat-overlay-reload-button {
        anchor-name: --yt-overlay-reload-btn;
      }
      #yt-chat-overlay-settings-tooltip {
        position-anchor: --yt-overlay-settings-btn;
      }
      #yt-chat-overlay-reload-tooltip {
        position-anchor: --yt-overlay-reload-btn;
      }
`;
	var log$1 = createLogger("SettingsUi");
	var TOAST_DURATION_MS = 2500;
	var RELOAD_FEEDBACK_DURATION_MS = 1500;
	var SettingsUi = class SettingsUi {
		getSettings;
		onChange;
		resetSettings;
		onPersist;
		onReload;
		static supportsHints = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;
		static SETTINGS_TOOLTIP_ID = "yt-chat-overlay-settings-tooltip";
		static RELOAD_TOOLTIP_ID = "yt-chat-overlay-reload-tooltip";
		playerElement = null;
		button = null;
		reloadButton = null;
		reloadFeedbackTimer = null;
		modal = null;
		previousFocus = null;
		activeTab;
		modalLanguage = null;
		confirmPreviousFocus = null;
		closing = false;
		confirmDialog = null;
		importReader = null;
		lifecycleGeneration = 0;
		suppressConfirmClose = false;
		get defaultTabId() {
			const first = PANES[0];
			return first ? first.id : "comments";
		}
		form;
		isDialogOpen() {
			return this.modal?.open === true;
		}
		syncForm() {
			if (!this.isDialogOpen()) return;
			this.form.populateForm(this.getSettings());
		}
		constructor(getSettings, onChange, resetSettings, onPersist, onReload) {
			this.getSettings = getSettings;
			this.onChange = onChange;
			this.resetSettings = resetSettings;
			this.onPersist = onPersist;
			this.onReload = onReload;
			this.activeTab = this.defaultTabId;
			this.form = new SettingsUiForm(getSettings, () => {
				this.queuePreview();
			});
		}
		previewTimer = null;
		static PREVIEW_DEBOUNCE_MS = 100;
		attachAbortController = null;
		queuePreview() {
			this.previewTimer = clearSafeTimeout(this.previewTimer);
			this.previewTimer = setTimeout(() => {
				this.previewTimer = null;
				const preview = this.form.collectSettings();
				this.onChange(preview);
				this.form.populateForm(this.getSettings());
			}, SettingsUi.PREVIEW_DEBOUNCE_MS);
		}
		async attach() {
			this.attachAbortController?.abort();
			this.attachAbortController = new AbortController();
			const { signal } = this.attachAbortController;
			const player = await this.findPlayerContainer(signal);
			if (signal.aborted) return;
			this.attachAbortController = null;
			if (!player) return;
			if (this.playerElement === player && this.button?.isConnected && this.modal?.isConnected && (this.reloadButton ? this.reloadButton.isConnected : true)) return;
			this.playerElement = player;
			this.ensureButton(player);
			this.ensureModal();
			this.close();
		}
		close() {
			if (!this.modal) return;
			if (this.closing) return;
			this.closing = true;
			if (!this.modal.open) {
				this.closing = false;
				return;
			}
			if (this.previewTimer !== null) this.previewTimer = clearSafeTimeout(this.previewTimer);
			(this.onPersist ?? this.onChange)(this.form.collectSettings());
			this.modal.close();
			this.restoreDocumentLangDir();
			if (this.previousFocus?.isConnected) this.previousFocus.focus();
			this.previousFocus = null;
			this.closing = false;
		}
		findPlayerContainer(signal) {
			return findPlayerContainerElement({
				intervalMs: PLAYER_LOOKUP_INTERVAL_MS,
				signal
			});
		}
		ensureButton(player) {
			if (!this.button) {
				this.button = document.createElement("button");
				this.button.id = BUTTON_ID;
				this.button.type = "button";
				this.button.className = "yt-chat-overlay-settings-button";
				this.button.textContent = "⚙";
				this.button.setAttribute("aria-label", t("app.settings"));
				if (SettingsUi.supportsHints) this.button.setAttribute("interestfor", SettingsUi.SETTINGS_TOOLTIP_ID);
				else this.button.title = t("app.settings");
				this.button.addEventListener("click", () => this.open());
				if ("commandFor" in HTMLElement.prototype) {
					this.button.setAttribute("commandfor", BACKDROP_ID);
					this.button.setAttribute("command", "show-modal");
				}
			} else if (this.button.parentElement) this.button.remove();
			if (!this.reloadButton && this.onReload) {
				this.reloadButton = document.createElement("button");
				this.reloadButton.id = RELOAD_BUTTON_ID;
				this.reloadButton.type = "button";
				this.reloadButton.className = "yt-chat-overlay-reload-button";
				this.reloadButton.textContent = "↻";
				this.reloadButton.setAttribute("aria-label", t("app.reload"));
				if (SettingsUi.supportsHints) this.reloadButton.setAttribute("interestfor", SettingsUi.RELOAD_TOOLTIP_ID);
				else this.reloadButton.title = t("app.reload");
				this.reloadButton.addEventListener("click", () => {
					this.handleReloadClick();
				});
			} else if (this.reloadButton?.parentElement) this.reloadButton.remove();
			ensurePlayerPositioning(player);
			if (SettingsUi.supportsHints) this.ensureTooltips(player);
			player.appendChild(this.button);
			if (this.reloadButton) player.appendChild(this.reloadButton);
		}
		ensureTooltips(container) {
			if (!document.getElementById(SettingsUi.SETTINGS_TOOLTIP_ID)) {
				const settingsTip = document.createElement("div");
				settingsTip.id = SettingsUi.SETTINGS_TOOLTIP_ID;
				settingsTip.className = "yt-chat-overlay-tooltip";
				settingsTip.setAttribute("popover", "hint");
				settingsTip.textContent = t("app.settings");
				container.appendChild(settingsTip);
			}
			if (!document.getElementById(SettingsUi.RELOAD_TOOLTIP_ID)) {
				const reloadTip = document.createElement("div");
				reloadTip.id = SettingsUi.RELOAD_TOOLTIP_ID;
				reloadTip.className = "yt-chat-overlay-tooltip";
				reloadTip.setAttribute("popover", "hint");
				reloadTip.textContent = t("app.reload");
				container.appendChild(reloadTip);
			}
		}
		clearReloadFeedbackTimer() {
			this.reloadFeedbackTimer = clearSafeTimeout(this.reloadFeedbackTimer);
		}
		handleReloadClick() {
			if (!this.reloadButton) return;
			this.reloadButton.textContent = "✓";
			this.reloadButton.classList.add("yt-chat-overlay-reload-button--done");
			this.clearReloadFeedbackTimer();
			this.reloadFeedbackTimer = setTimeout(() => {
				this.reloadFeedbackTimer = null;
				if (this.reloadButton) {
					this.reloadButton.textContent = "↻";
					this.reloadButton.classList.remove("yt-chat-overlay-reload-button--done");
				}
			}, RELOAD_FEEDBACK_DURATION_MS);
			const reloadPromise = this.onReload?.();
			if (reloadPromise) reloadPromise.catch((error) => {
				log$1.warn("settings.reload-failed", { error: String(error) });
			});
		}
		ensureStyles() {
			if (document.getElementById("yt-chat-overlay-settings-style")) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = SETTINGS_UI_STYLES;
			document.head.appendChild(style);
		}
		bindTabEvents() {
			if (!this.modal) return;
			this.modal.addEventListener("click", (event) => {
				const tabBtn = event.target?.closest(".yt-chat-overlay-settings-tab");
				if (tabBtn) {
					const tabId = tabBtn.dataset.tab;
					if (tabId) this.switchTab(tabId);
				}
			});
		}
		switchTab(tabId) {
			if (!this.modal) return;
			this.activeTab = tabId;
			for (const btn of this.modal.querySelectorAll(".yt-chat-overlay-settings-tab")) {
				const isActive = btn.dataset.tab === tabId;
				btn.classList.toggle("active", isActive);
				btn.setAttribute("aria-selected", `${isActive}`);
				btn.setAttribute("tabindex", isActive ? "0" : "-1");
			}
			for (const pane of this.modal.querySelectorAll(".yt-chat-overlay-settings-pane")) pane.toggleAttribute("hidden", pane.dataset.pane !== tabId);
		}
		bindModalEvents() {
			if (!this.modal) return;
			this.modal.addEventListener("click", (event) => {
				const actionBtn = event.target?.closest("button[data-action]");
				if (actionBtn) {
					switch (actionBtn.dataset.action) {
						case "close":
							this.close();
							break;
						case "reset":
							this.handleReset();
							break;
						case "export":
							this.handleExport();
							break;
						case "import": this.handleImport();
					}
					return;
				}
			});
			this.modal.addEventListener("change", (event) => {
				const target = event.target;
				if (target instanceof HTMLInputElement && target.name === "allowShortTextMessages") this.form.syncMinTextLengthState();
			});
			this.bindTabEvents();
		}
		ensureModal() {
			this.ensureStyles();
			if (this.modal?.isConnected) return;
			this.modal?.remove();
			this.modal = null;
			this.modal = document.createElement("dialog");
			this.modal.id = BACKDROP_ID;
			this.modal.className = "yt-chat-overlay-settings-modal";
			this.modal.setAttribute("autocomplete", "off");
			this.modal.setAttribute("closedby", "any");
			this.modal.setAttribute("aria-labelledby", "yt-chat-overlay-settings-title");
			this.modal.setAttribute("aria-modal", "true");
			this.modal.append(...this.form.createModalContent());
			this.form.setModal(this.modal);
			this.bindModalEvents();
			this.modalLanguage = getActiveLanguage();
			this.modal.addEventListener("cancel", (event) => {
				event.preventDefault();
				this.close();
			});
			this.modal.addEventListener("close", () => {
				if (this.closing) return;
				this.closing = true;
				if (this.previewTimer !== null) this.previewTimer = clearSafeTimeout(this.previewTimer);
				(this.onPersist ?? this.onChange)(this.form.collectSettings());
				this.restoreDocumentLangDir();
				if (this.previousFocus?.isConnected) this.previousFocus.focus();
				this.previousFocus = null;
				this.closing = false;
			});
			document.body.appendChild(this.modal);
		}
		open() {
			if (!this.modal) return;
			if (this.modalLanguage !== getActiveLanguage()) this.rebuildModalContent();
			const activeElement = document.activeElement;
			this.previousFocus = activeElement instanceof HTMLElement ? activeElement : null;
			this.form.populateForm(this.getSettings());
			this.switchTab(this.activeTab);
			this.modal.showModal();
			this.focusInitialElement();
			this.updateDocumentLangDir();
		}
		rebuildModalContent() {
			if (!this.modal) return;
			while (this.modal.firstChild) this.modal.removeChild(this.modal.firstChild);
			this.modal.append(...this.form.createModalContent());
			this.form.setModal(this.modal);
			this.modalLanguage = getActiveLanguage();
		}
		syncLanguage() {
			if (!this.isDialogOpen() || !this.modal) return;
			if (this.modalLanguage === getActiveLanguage()) return;
			const savedTab = this.activeTab;
			this.rebuildModalContent();
			this.form.populateForm(this.getSettings());
			this.switchTab(savedTab);
			this.updateDocumentLangDir();
		}
		updateDocumentLangDir() {
			if (!this.modal) return;
			const lang = getActiveLanguage();
			this.modal.lang = lang;
			this.modal.dir = lang === "ar" ? "rtl" : "ltr";
		}
		restoreDocumentLangDir() {
			if (!this.modal) return;
			this.modal.lang = "";
			this.modal.dir = "";
		}
		createConfirmDialog(options) {
			const generation = this.lifecycleGeneration;
			const dialog = document.createElement("dialog");
			dialog.className = "yt-chat-overlay-settings-confirm";
			dialog.setAttribute("aria-label", t(options.message));
			const message = document.createElement("p");
			const messageId = "yt-chat-overlay-confirm-msg";
			message.className = "yt-chat-overlay-settings-confirm-message";
			message.textContent = t(options.message);
			message.id = messageId;
			dialog.setAttribute("aria-describedby", messageId);
			const buttons = document.createElement("div");
			buttons.className = "yt-chat-overlay-settings-confirm-buttons";
			const cancelBtn = document.createElement("button");
			cancelBtn.type = "button";
			cancelBtn.className = "yt-chat-overlay-settings-confirm-cancel";
			cancelBtn.textContent = t("app.cancel");
			const okBtn = document.createElement("button");
			okBtn.type = "button";
			okBtn.className = "yt-chat-overlay-settings-confirm-ok";
			okBtn.textContent = t(options.confirmLabel);
			buttons.append(cancelBtn, okBtn);
			dialog.append(message, buttons);
			const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			this.confirmPreviousFocus = previouslyFocused;
			let closed = false;
			const closeDialog = () => {
				if (closed) return;
				closed = true;
				if (dialog.open) dialog.close();
				dialog.remove();
				if (this.confirmDialog === dialog) this.confirmDialog = null;
				if (this.confirmPreviousFocus?.isConnected) this.confirmPreviousFocus.focus();
				this.confirmPreviousFocus = null;
			};
			dialog.addEventListener("close", () => {
				if (this.suppressConfirmClose) return;
				closeDialog();
			});
			cancelBtn.addEventListener("click", () => closeDialog());
			okBtn.addEventListener("click", () => {
				closeDialog();
				if (generation !== this.lifecycleGeneration) return;
				options.onConfirm();
			});
			cancelBtn.focus();
			return dialog;
		}
		handleReset() {
			if (!this.modal) return;
			const dialog = this.createConfirmDialog({
				message: "Reset all settings to defaults?",
				confirmLabel: "Reset",
				onConfirm: () => {
					this.resetSettings();
					this.form.populateForm(this.getSettings());
				}
			});
			this.confirmDialog = dialog;
			document.body.appendChild(dialog);
			dialog.showModal();
		}
		handleExport() {
			const settings = this.getSettings();
			const json = JSON.stringify({
				...settings,
				_version: 2
			}, null, 2);
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "yt-chat-overlay-settings.json";
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
		handleImport() {
			const generation = this.lifecycleGeneration;
			const input = document.createElement("input");
			input.type = "file";
			input.accept = ".json";
			input.autocomplete = "off";
			input.addEventListener("change", () => {
				const file = input.files?.[0];
				input.remove();
				if (!file || generation !== this.lifecycleGeneration) return;
				const reader = new FileReader();
				this.importReader = reader;
				reader.addEventListener("load", () => {
					if (generation !== this.lifecycleGeneration || this.importReader !== reader) return;
					this.importReader = null;
					try {
						const text = reader.result;
						if (typeof text !== "string") return;
						const parsed = JSON.parse(text);
						if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
							this.showToast(t("import.invalidFormat"));
							log$1.warn("settings.import.invalid-format");
							return;
						}
						const sanitized = Object.create(null);
						for (const key of Object.keys(parsed)) {
							if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
							sanitized[key] = parsed[key];
						}
						const settings = normalizeStoredSettings(sanitized);
						this.onChange(settings);
						this.form.populateForm(this.getSettings());
						(this.onPersist ?? this.onChange)(settings);
						this.showToast(t("import.success"));
					} catch (error) {
						this.showToast(t("import.invalidJson"));
						log$1.warn("settings.import.invalid-json", { error: String(error) });
					}
				});
				reader.addEventListener("error", () => {
					if (this.importReader === reader) this.importReader = null;
				});
				reader.readAsText(file);
			});
			input.click();
		}
		focusInitialElement() {
			if (!this.modal) return;
			const activeTabBtn = this.modal.querySelector(".yt-chat-overlay-settings-tab.active");
			if (activeTabBtn) {
				activeTabBtn.focus();
				return;
			}
			const closeButton = this.modal.querySelector(".yt-chat-overlay-settings-close");
			if (closeButton) {
				closeButton.focus();
				return;
			}
			const [first] = this.form.getFocusableElements();
			if (first) {
				first.focus();
				return;
			}
			this.modal.focus();
		}
		toastTimer = null;
		showToast(message, isError = false) {
			if (!this.modal) return;
			const existing = this.modal.querySelector(".yt-chat-overlay-settings-toast");
			if (existing) existing.remove();
			const toast = document.createElement("div");
			toast.className = "yt-chat-overlay-settings-toast";
			toast.setAttribute("role", "status");
			toast.setAttribute("aria-live", isError ? "assertive" : "polite");
			toast.textContent = message;
			this.modal.appendChild(toast);
			this.toastTimer = clearSafeTimeout(this.toastTimer);
			this.toastTimer = setTimeout(() => {
				toast.remove();
				this.toastTimer = null;
			}, TOAST_DURATION_MS);
		}
		destroy() {
			this.lifecycleGeneration++;
			this.importReader?.abort();
			this.importReader = null;
			this.suppressConfirmClose = true;
			const confirmDialog = this.confirmDialog;
			this.confirmDialog = null;
			if (confirmDialog) {
				if (confirmDialog.open) confirmDialog.close();
				confirmDialog.remove();
			}
			this.confirmPreviousFocus = null;
			this.suppressConfirmClose = false;
			this.attachAbortController?.abort();
			this.attachAbortController = null;
			if (this.isDialogOpen()) this.close();
			if (this.previewTimer !== null) this.previewTimer = clearSafeTimeout(this.previewTimer);
			this.button?.remove();
			this.reloadButton?.remove();
			this.clearReloadFeedbackTimer();
			this.toastTimer = clearSafeTimeout(this.toastTimer);
			this.modal?.close();
			this.modal?.remove();
			this.restoreDocumentLangDir();
			document.getElementById(STYLE_ID)?.remove();
			this.button = null;
			this.reloadButton = null;
			this.modal = null;
			this.playerElement = null;
			log$1.info("settings.controller.destroyed");
		}
	};
	var log = createLogger("App");
	var YT_NAVIGATE_FINISH_EVENT = "yt-navigate-finish";
	var spaBootstrapInstalled = false;
	function isVideoPage() {
		return isYouTubeWatch(location.href) || isYouTubeLive(location.href);
	}
	var App = class {
		pageWatcher = new PageWatcher();
		settings = new Settings();
		runtimeManager = new RuntimeManager({
			getCurrentUrl: () => location.href,
			getSettings: () => this.settings.get(),
			isValidPage: () => this.pageWatcher.isValidPage()
		});
		settingsUi = new SettingsUi(() => this.settings.get(), (partial) => this.previewSettings(partial), () => this.resetSettings(), (partial) => this.applySettings(partial), () => this.restartRuntime());
		unsubscribeCrossTab = null;
		handlePageWatcherChange = () => {
			if (this.pageWatcher.isValidPage()) this.ensureSettingsUi();
			else this.settingsUi.destroy();
			this.runtimeManager.requestReconcile("page-change");
		};
		constructor() {
			this.pageWatcher.onChange(this.handlePageWatcherChange);
			log.debug("app.initialized");
		}
		async start() {
			await this.settings.initialize();
			resolveActiveLanguage(this.settings.get().language);
			setOverlayLogLevel(this.settings.get().logLevel);
			this.unsubscribeCrossTab = this.settings.subscribe(() => {
				log.debug("app.cross-tab-change");
				resolveActiveLanguage(this.settings.get().language);
				setOverlayLogLevel(this.settings.get().logLevel);
				this.settingsUi.syncForm();
				this.settingsUi.syncLanguage();
				this.runtimeManager.requestReconcile("settings-change");
			});
			if (this.pageWatcher.isValidPage()) await this.ensureSettingsUi();
			await this.runtimeManager.start();
		}
		async stop() {
			this.runtimeManager.destroy();
			this.pageWatcher.destroy();
			this.settingsUi.destroy();
			this.unsubscribeCrossTab?.();
			await this.settings.destroy();
			log.debug("app.stopped");
		}
		getSettings() {
			return this.settings.get();
		}
		applySettings(partial) {
			const prevLanguage = this.settings.get().language;
			this.settings.set(partial);
			if (partial.language !== void 0 && partial.language !== prevLanguage) resolveActiveLanguage(this.settings.get().language);
			this.applySettingsSideEffects(partial);
		}
		previewSettings(partial) {
			const prevLanguage = this.settings.get().language;
			this.settings.preview(partial);
			if (partial.language !== void 0 && partial.language !== prevLanguage) {
				resolveActiveLanguage(partial.language);
				this.settingsUi.syncLanguage();
			}
			this.applySettingsSideEffects(partial);
		}
		applySettingsSideEffects(partial) {
			if (partial.logLevel !== void 0) setOverlayLogLevel(this.settings.get().logLevel);
			if (this.pageWatcher.isValidPage()) this.ensureSettingsUi();
			this.runtimeManager.requestReconcile("settings-change");
		}
		resetSettings() {
			this.settings.reset();
			resolveActiveLanguage(this.settings.get().language);
			this.applySettingsSideEffects({});
		}
		async restartRuntime() {
			log.info("app.restart.disposing");
			await this.runtimeManager.restartSession();
			log.info("app.restart.completed");
		}
		async ensureSettingsUi() {
			try {
				await this.settingsUi.attach();
			} catch (error) {
				log.info("app.settings-ui.error", { error: String(error) });
			}
		}
	};
	function setupSpaBootstrap() {
		if (spaBootstrapInstalled) return;
		spaBootstrapInstalled = true;
		const onNavigate = () => {
			if (!isVideoPage() || window.__ytChatOverlay) return;
			window.removeEventListener(YT_NAVIGATE_FINISH_EVENT, onNavigate);
			window.removeEventListener("popstate", onNavigate);
			spaBootstrapInstalled = false;
			log.info("app.spa.video-page-reached");
			initApp();
		};
		window.addEventListener(YT_NAVIGATE_FINISH_EVENT, onNavigate);
		window.addEventListener("popstate", onNavigate);
		log.debug("app.spa.watcher-installed");
	}
	function main() {
		if (location.hostname !== "www.youtube.com") return;
		log.debug("Script loaded", {
			readyState: document.readyState,
			url: location.href
		});
		if (!isVideoPage()) {
			setupSpaBootstrap();
			return;
		}
		if (document.readyState === "loading") {
			log.debug("app.waiting-dom-ready");
			document.addEventListener("DOMContentLoaded", () => {
				log.debug("app.dom-ready");
				initApp();
			}, { once: true });
		} else {
			log.debug("app.already-ready");
			initApp();
		}
	}
	var stopPreviousAppInstance = async () => {
		if (!window.__ytChatOverlay) return;
		log.debug("app.reinit-stopping-prev");
		try {
			await window.__ytChatOverlay.stop();
		} finally {
			window.__ytChatOverlay = void 0;
		}
	};
	async function initApp() {
		log.debug("app.initializing");
		try {
			await stopPreviousAppInstance();
			const app = new App();
			await app.start();
			setupMenuCommands();
			window.__ytChatOverlay = Object.freeze({
				start: () => app.start(),
				stop: () => app.stop(),
				restartRuntime: () => app.restartRuntime(),
				getSettings: () => app.getSettings(),
				applySettings: (partial) => app.applySettings(partial),
				resetSettings: () => app.resetSettings()
			});
			log.info("app.exposed");
		} catch (error) {
			log.error("app.fatal-error", { error: String(error) });
			if (!isVideoPage()) setupSpaBootstrap();
		}
	}
	main();
	function setupMenuCommands() {
		registerMenuCommands([{
			name: t("reset.confirmDesc"),
			action: () => {
				const app = window.__ytChatOverlay;
				if (app) app.resetSettings();
			}
		}, {
			name: t("app.reload"),
			action: () => {
				const app = window.__ytChatOverlay;
				if (app?.restartRuntime) app.restartRuntime().catch((error) => {
					log.warn("app.menu-reload-failed", { error: String(error) });
				});
			}
		}]);
	}
})();
