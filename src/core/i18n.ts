// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Lightweight i18n module — zero dependencies.
 *
 * Uses the gettext model: English strings serve as both fallback values
 * and translation lookup keys.  Unknown keys fall through unchanged.
 *
 * Language auto-detection: `navigator.language` is matched against the
 * supported set; unknown locales fall back to English.
 *
 * Usage:
 *   import { t, resolveActiveLanguage } from '@core/i18n';
 *   resolveActiveLanguage('auto');          // at startup
 *   element.textContent = t('Chat Overlay'); // in DOM construction
 */

import type { LanguageSetting } from '@app-types';

/** Language codes with actual translations (excluding 'auto'). Derived from LanguageSetting. */
type SupportedLanguage = Exclude<LanguageSetting, 'auto'>;

// ── Module-level active language ─────────────────────────────────────────

let activeLanguage: SupportedLanguage = 'en';

/**
 * Resolve and set the active language.
 * Call once at startup and whenever the language setting changes.
 */
export function resolveActiveLanguage(setting: LanguageSetting): void {
  activeLanguage = setting === 'auto' ? detectBrowserLanguage() : setting;
}

/**
 * Look up a translation for the given English text.
 * Returns the translation if found; otherwise returns the text unchanged.
 * The English source strings serve as both fallback and lookup key.
 */
export function t(text: string): string {
  const map = TRANSLATIONS[activeLanguage];
  if (!map) return text;
  return map[text] ?? text;
}

/** Return the currently active language code. */
export function getActiveLanguage(): SupportedLanguage {
  return activeLanguage;
}

// ── Browser language detection ────────────────────────────────────────────

const LANGUAGE_PATTERNS: ReadonlyArray<[SupportedLanguage, RegExp]> = [
  ['ko', /^ko\b/i],
  ['ja', /^ja\b/i],
  ['es', /^es\b/i],
  ['zh', /^zh\b/i],
];

function detectBrowserLanguage(): SupportedLanguage {
  try {
    const nav = navigator.language;
    if (!nav) return 'en';
    for (const [lang, re] of LANGUAGE_PATTERNS) {
      if (re.test(nav)) return lang;
    }
    return 'en';
  } catch {
    return 'en';
  }
}

// ── Translations ─────────────────────────────────────────────────────────

type TranslationMap = Record<string, string>;

const KO: TranslationMap = {
  // ── Pane tabs ──
  Comments: '코멘트',
  'Cards & Colors': '카드 및 색상',
  Advanced: '고급',
  Translation: '번역',

  // ── Section titles ──
  'Text Outline': '텍스트 외곽선',
  'Safe Zone': '안전 영역',
  'Message Rate': '메시지 빈도',
  'Moderator and Owner': '관리자와 소유자',
  'Depth Layers': '깊이 레이어',
  Backlog: '백로그',
  'Rate Limiting': '속도 제한',
  Timing: '타이밍',
  Thresholds: '임계값',
  'Author Colors & Visibility': '작성자 색상 및 표시',
  Interface: '인터페이스',
  'Chat Translation': '채팅 번역',

  // ── Field labels ──
  'Danmaku Mode': '단마쿠 모드',
  'Font Size (px)': '글자 크기 (px)',
  'Text Opacity (%)': '텍스트 불투명도 (%)',
  'Scroll Speed (px/s)': '스크롤 속도 (px/s)',
  'Lane Gap (px)': '레인 간격 (px)',
  'Font Weight': '글자 두께',
  'Font Family': '글꼴',
  Enabled: '활성화',
  // Legacy key 'Width (px)' removed (replaced by 'Outline Width (px)')
  'Outline Width (px)': '외곽선 두께 (px)',
  'Outline Opacity (%)': '외곽선 불투명도 (%)',
  'SuperChat Opacity (%)': '슈퍼챗 불투명도 (%)',
  'SuperChat Max Lines': '슈퍼챗 최대 줄 수',
  'Membership Max Lines': '멤버십 최대 줄 수',
  'Preserve User Colors': '사용자 색상 유지',
  'Show SuperChat Amount': '슈퍼챗 금액 표시',
  'Top Clear Zone (%)': '상단 여백 (%)',
  'Bottom Clear Zone (%)': '하단 여백 (%)',
  'Ignore Min Length': '최소 길이 무시',
  'Min Length (chars)': '최소 길이 (글자)',
  'Backlog Mode': '백로그 모드',
  'Backlog Opacity (%)': '백로그 불투명도 (%)',
  'Author Rate Limit': '작성자 빈도 제한',
  Language: '언어',
  // ── Language names ──
  English: '영어',
  한국어: '한국어',
  日本語: '일본어',
  Español: '스페인어',
  中文: '중국어',
  'Duration Multiplier (×)': '표시 시간 배율 (×)',
  'Exit Padding (px)': '종료 여백 (px)',
  'Min Scroll Duration (ms)': '최소 스크롤 시간 (ms)',
  'Max Scroll Duration (ms)': '최대 스크롤 시간 (ms)',
  'Top/Bottom Duration (ms)': '상단/하단 표시 시간 (ms)',
  'Queue Max Size': '큐 최대 크기',
  'Background Queue Max': '백그라운드 큐 최대',
  'Max Message Age (ms)': '최대 메시지 수명 (ms)',
  'Headway Gap (%)': '메시지 간격 (%)',
  'Enable Translation': '번역 활성화',
  Service: '서비스',
  'Source Language': '소스 언어',
  'Target Language': '대상 언어',
  'Display Mode': '표시 방식',
  'Near Speed (%)': '가까운 속도 (%)',
  'Far Speed (%)': '먼 속도 (%)',
  'Far Opacity (%)': '먼 불투명도 (%)',

  // ── Select options ──
  'Scroll (RTL)': '스크롤 (오른쪽→왼쪽)',
  'Reverse (LTR)': '역방향 (왼쪽→오른쪽)',
  'Top Fixed': '상단 고정',
  'Bottom Fixed': '하단 고정',
  'Bold (700)': '볼드 (700)',
  'Normal (400)': '보통 (400)',
  'Playback-based (recommended)': '재생 기반 (권장)',
  'Recent only': '최근만',
  'Full (show all)': '전체 (모두 표시)',
  'None (skip backlog)': '없음 (백로그 건너뛰기)',
  Off: '끄기',
  'Normal (5 msg / 5s)': '보통 (5개 / 5초)',
  'Strict (2 msg / 5s)': '엄격 (2개 / 5초)',
  'Auto (Browser)': '자동 (브라우저)',
  'Auto (Chrome built-in)': '자동 (Chrome 내장)',
  'Dual (original + translation)': '이중 표시 (원문 + 번역)',
  'Replace (translation only)': '번역만 표시',

  // ── Tooltips ──
  'Vertical gap between comment rows (negative = overlap)': '댓글 행 사이 간격 (음수 = 겹침)',
  'Text weight: Bold is more readable, Normal uses less GPU memory':
    '글자 두께: 볼드는 더 읽기 쉽고, 보통은 GPU 메모리를 적게 사용합니다',
  'CSS font-family value, e.g. "Noto Sans KR", sans-serif. Falls back to system default if not found.':
    'CSS font-family 값. 예: "Noto Sans KR", sans-serif. 글꼴이 없으면 시스템 기본값을 사용합니다.',
  'Background opacity of Super Chat cards': '슈퍼챗 카드의 배경 불투명도',
  'Max body text lines before truncation (2-10)': '본문 텍스트 최대 줄 수, 초과 시 잘림 (2-10)',
  'Max body text lines for membership messages (1-5)': '멤버십 메시지 본문 최대 줄 수 (1-5)',
  'Display the purchase amount badge on Super Chat cards':
    '슈퍼챗 카드에 구매 금액 배지를 표시합니다',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'YouTube 채팅 작성자의 텍스트 색상을 오버레이 기본값 대신 사용',
  'Keep top N% of video free of comments': '영상 상단 N%를 댓글 없이 유지',
  'Keep bottom N% of video free of comments': '영상 하단 N%를 댓글 없이 유지',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length':
    '최소 글자 수에 관계없이 모든 메시지 표시',
  'Minimum character count': '최소 글자 수',
  'Opacity of past messages relative to real-time messages':
    '실시간 메시지 대비 과거 메시지의 불투명도',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    '관리자와 소유자의 메시지가 일반 메시지보다 얼마나 오래 표시될지 설정합니다 (1.0 = 동일, 2.0 = 2배)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    '실시간으로 채팅 메시지를 번역합니다 (Chrome 138+ 내장 번역 필요)',
  'Speed-based depth perception: fast messages appear near, slow messages appear far':
    '속도 기반 깊이감: 빠른 메시지는 가까이, 느린 메시지는 멀리 표시',
  'Speed boost for near-layer messages': '가까운 레이어 메시지 속도 증가',
  'Speed reduction for far-layer messages': '먼 레이어 메시지 속도 감소',
  'Opacity dimming for far-layer messages': '먼 레이어 메시지 불투명도 감소',
  'How fast comments scroll across the screen in pixels per second':
    '댓글이 화면을 가로지르는 속도(초당 픽셀)',
  'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)':
    '메시지가 화면 가장자리를 지나 제거되기까지 추가로 이동하는 픽셀 (20-400, 기본 100)',
  'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)':
    '최소 스크롤 애니메이션 시간 — 짧은 메시지가 너무 빠르게 지나가는 것을 방지 (1000-15000ms, 기본 5000)',
  'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)':
    '최대 스크롤 애니메이션 시간 — 긴 메시지가 너무 느리게 이동하는 것을 방지 (5-120초, 기본 30000ms)',
  'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)':
    '상단/하단 모드 메시지의 고정 표시 시간 (1000-30000ms, 기본 4000)',
  'Maximum pending queue depth before messages are dropped (50-1000, default 200)':
    '메시지가 드롭되기 전 최대 대기 큐 깊이 (50-1000, 기본 200)',
  'Target active message count when trimming background tab (10-500, default 50)':
    '백그라운드 탭 정리 시 목표 활성 메시지 수 (10-500, 기본 50)',
  'Maximum message age before fade-out removal (10-300s, default 60000ms)':
    '페이드아웃 제거 전 최대 메시지 수명 (10-300초, 기본 60000ms)',
  'Gap between consecutive messages as percentage of message width (2-30%, default 8)':
    '연속 메시지 사이의 간격을 메시지 너비의 백분율로 표시 (2-30%, 기본 8)',
  'Language of the incoming chat messages': '수신 채팅 메시지의 언어',
  'Language to translate chat messages into': '채팅 메시지를 번역할 대상 언어',
  'Limits how frequently messages from the same author appear':
    '동일 작성자의 메시지 표시 빈도를 제한',
  'Sets the overlay user interface language (does not filter comments by language)':
    '오버레이 UI 언어를 설정합니다 (댓글 언어 필터 아님)',

  // ── New Performance / Developer section titles ──
  Performance: '성능',
  Developer: '개발자',

  // ── New field labels ──
  'Max Messages': '최대 메시지 수',
  'Fade Duration (ms)': '페이드 시간 (ms)',
  'Min Poll Interval (ms)': '최소 폴링 간격 (ms)',
  'Max Poll Interval (ms)': '최대 폴링 간격 (ms)',
  'Max Rate (msg/s)': '최대 속도 (msg/s)',
  'Speed Multiplier': '속도 배율',
  'Window (min)': '시간 창 (분)',
  'Log Level': '로그 레벨',
  'Debug Overlay': '디버그 오버레이',

  // ── New select options ──
  'Warnings only': '경고만',
  Info: '정보',
  'Debug (verbose)': '디버그 (상세)',

  // ── New tooltips ──
  'Maximum number of messages visible on screen at once (30-300)':
    '화면에 동시 표시할 최대 메시지 수 (30-300)',
  'How long messages take to fade out (0 = instant, 50-1000)':
    '메시지가 사라지는 페이드아웃 시간 (0 = 즉시, 50-1000)',
  'Minimum chat polling interval in milliseconds (50-5000)':
    '채팅 폴링 최소 간격 (밀리초, 50-5000)',
  'Maximum chat polling interval in milliseconds (1000-30000)':
    '채팅 폴링 최대 간격 (밀리초, 1000-30000)',
  'Maximum backlog message injection rate per second (0-50)':
    '초당 백로그 메시지 주입 최대 속도 (0-50)',
  'Animation speed multiplier for backlog messages (1-5)':
    '백로그 메시지 애니메이션 속도 배율 (1-5)',
  'Time window in minutes for recent-only backlog mode (1-30)':
    '최근 전용 백로그 모드의 시간 창 (분, 1-30)',
  'Console diagnostic output verbosity': '콘솔 진단 출력 상세도',
  'Show performance debug overlay on the video player':
    '비디오 플레이어에 성능 디버그 오버레이 표시',

  // ── New tooltips (added 2026-05-28) ──
  'Text size in pixels (14-50)': '픽셀 단위 텍스트 크기 (14-50)',
  'Text outline stroke width in pixels (0-8)': '텍스트 외곽선 두께 (픽셀, 0-8)',
  'Text outline stroke opacity (0-100%)': '텍스트 외곽선 불투명도 (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'Globally enable or disable the chat overlay on YouTube live streams':
    'YouTube 라이브 스트림에서 채팅 오버레이를 켜거나 끕니다',
  'Comment display direction and behavior': '댓글 표시 방향과 동작 방식',
  'Overall opacity of comment text (50-100%)': '댓글 텍스트의 전체 불투명도 (50-100%)',
  'Add a dark outline stroke around text for better readability':
    '밝은 배경에서 텍스트 가독성을 높이기 위해 어두운 외곽선을 추가합니다',
  'How past chat messages are displayed relative to live playback':
    '과거 채팅 메시지를 라이브 재생 대비 어떻게 표시할지 설정합니다',
  'Dual shows original above translation, Replace shows translation only':
    '이중 표시는 원문 위에 번역을, 교체는 번역만 표시합니다',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'Emoji Cache (MB)': '이모지 캐시 (MB)',
  'Photo Cache (MB)': '사진 캐시 (MB)',
  'Sticker Cache (MB)': '스티커 캐시 (MB)',
  'Text Cache (MB)': '텍스트 캐시 (MB)',
  'Translation Batch Size': '번역 배치 크기',
  'Emoji Fetch Limit': '이모지 가져오기 제한',
  'Failed Emoji Retry (min)': '실패한 이모지 재시도 (분)',
  'Max memory for emoji image cache (1-20 MB, default 3)':
    '이모지 이미지 캐시 최대 메모리 (1-20 MB, 기본 3)',
  'Max memory for author photo cache (1-20 MB, default 2)':
    '작성자 사진 캐시 최대 메모리 (1-20 MB, 기본 2)',
  'Max memory for sticker image cache (1-20 MB, default 1)':
    '스티커 이미지 캐시 최대 메모리 (1-20 MB, 기본 1)',
  'Max memory for text bitmap cache (1-20 MB, default 4)':
    '텍스트 비트맵 캐시 최대 메모리 (1-20 MB, 기본 4)',
  'Max translations applied per frame to avoid spikes (1-20, default 5)':
    '프레임당 최대 번역 적용 수 (1-20, 기본 5)',
  'Max concurrent emoji fetch operations (1-20, default 6)':
    '최대 동시 이모지 가져오기 (1-20, 기본 6)',
  'How long to wait before retrying failed emoji fetches (1-60 min, default 5)':
    '실패한 이모지 재시도 대기 시간 (1-60분, 기본 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'Burst Sample Window': '버스트 샘플 창',
  'Elevated Burst (msg/s)': '상승 버스트 (msg/s)',
  'High Burst (msg/s)': '높은 버스트 (msg/s)',
  'Extreme Burst (msg/s)': '극심한 버스트 (msg/s)',
  'Backlog Injection Max': '백로그 주입 최대',
  'Backlog Density Ramp (ms)': '백로그 밀도 램프 (ms)',
  'Live Poll Fallback (ms)': '라이브 폴링 폴백 (ms)',
  'Poll Failure Limit': '폴링 실패 제한',
  'Speed Boost Threshold': '속도 부스트 임계값',
  'Backlog Pause (%)': '백로그 일시 중지 (%)',
  'Backlog Resume (%)': '백로그 재개 (%)',
  'Activity Timeout (ms)': '활동 시간 초과 (ms)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'Burst rate sample window size': '버스트 속도 샘플 창 크기',
  'Messages per second threshold for elevated burst level': '상승 버스트 수준의 초당 메시지 임계값',
  'Messages per second threshold for high burst level': '높은 버스트 수준의 초당 메시지 임계값',
  'Messages per second threshold for extreme burst level':
    '극심한 버스트 수준의 초당 메시지 임계값',
  'Maximum backlog injection rate cap': '최대 백로그 주입 속도 상한',
  'Density ramp duration for backlog injection in milliseconds':
    '백로그 주입의 밀도 램프 지속 시간 (밀리초)',
  'Live poll fallback delay in milliseconds': '라이브 폴링 폴백 지연 시간 (밀리초)',
  'Consecutive poll failures before circuit breaker trips':
    '차단기가 작동하기 전 연속 폴링 실패 횟수',
  'Pending messages to trigger speed boost': '속도 부스트를 트리거하는 대기 메시지 수',
  'Lane utilization ratio to pause backlog injection':
    '백로그 주입을 일시 중지하는 레인 사용률 비율',
  'Lane utilization ratio to resume backlog injection': '백로그 주입을 재개하는 레인 사용률 비율',
  'Chat activity timeout in milliseconds': '채팅 활동 시간 초과 (밀리초)',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'Stagger Max Delay (ms)': '최대 스태거 지연 (ms)',
  'Stagger Medium Delay (ms)': '중간 스태거 지연 (ms)',
  'Emoji Fetch Timeout (ms)': '이모지 가져오기 시간 초과 (ms)',
  'Backlog Density Ramp Max (ms)': '백로그 밀도 램프 최대 (ms)',
  'Backlog Injection Rate Min': '최소 백로그 주입 속도',
  'Speed Boost Max': '최대 속도 부스트',
  'Speed Boost Denom': '속도 부스트 분모',
  'Backlog Toggle Cooldown (ms)': '백로그 전환 쿨다운 (ms)',
  'Replay Prefetch Pages': '리플리 프리페치 페이지',
  'Replay Batch Limit': '리플리 배치 제한',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'Max stagger delay for messages in same batch': '동일 배치 메시지의 최대 스태거 지연 시간',
  'Medium stagger delay when queue depth is medium': '큐 깊이가 중간일 때 중간 스태거 지연 시간',
  'Timeout for emoji fetch operations': '이모지 가져오기 작업 시간 초과',
  'Max density ramp duration for backlog injection': '백로그 주입의 최대 밀도 램프 지속 시간',
  'Minimum backlog injection rate (msg/s)': '최소 백로그 주입 속도 (msg/s)',
  'Max speed boost factor for burst compensation': '버스트 보상을 위한 최대 속도 부스트 계수',
  'Speed boost denominator for EMA rate scaling': 'EMA 속도 스케일링을 위한 속도 부스트 분모',
  'Cooldown between backlog pause toggles': '백로그 일시 중지 전환 간 쿨다운',
  'Max pages to prefetch in replay mode': '리플리 모드에서 프리페치할 최대 페이지 수',
  'Max batches to fetch in replay initialization': '리플리 초기화에서 가져올 최대 배치 수',

  // ── Modal chrome ──
  'Chat Overlay': '채팅 오버레이',
  'Close settings': '설정 닫기',
  'Settings categories': '설정 카테고리',
  'Overlay Enabled': '오버레이 활성화',
  'Value adjusted to': '조정된 값: ',
  Reset: '초기화',
  Export: '내보내기',
  Import: '가져오기',
  Close: '닫기',
  'Reset all settings to defaults?': '모든 설정을 기본값으로 초기화할까요?',
  Cancel: '취소',
  'Import failed: invalid settings format': '가져오기 실패: 잘못된 설정 형식',
  'Settings imported successfully': '설정을 성공적으로 가져왔습니다',
  'Import failed: invalid JSON': '가져오기 실패: 잘못된 JSON 형식',
  'Chat overlay settings': '채팅 오버레이 설정',
  'Reset overlay settings': '오버레이 설정 초기화',

  // ── Author grid ──
  'Name Color': '이름 색상',
  'Show Name': '이름 표시',
  Normal: '일반',
  Member: '멤버',
  Moderator: '관리자',
  Owner: '소유자',
  Verified: '인증됨',
  SuperChat: '슈퍼챗',
};

const JA: TranslationMap = {
  // ── Pane tabs ──
  Comments: 'コメント',
  'Cards & Colors': 'カードと色',
  Advanced: '詳細',
  Translation: '翻訳',

  // ── Section titles ──
  'Text Outline': 'テキスト縁取り',
  'Safe Zone': '安全領域',
  'Message Rate': 'メッセージ頻度',
  'Moderator and Owner': 'モデレーターと所有者',
  'Depth Layers': '深度レイヤー',
  Backlog: 'バックログ',
  'Rate Limiting': 'レート制限',
  Timing: 'タイミング',
  Thresholds: 'しきい値',
  'Author Colors & Visibility': '投稿者の色と表示',
  Interface: 'インターフェース',
  'Chat Translation': 'チャット翻訳',

  // ── Field labels ──
  'Danmaku Mode': '弾幕モード',
  'Font Size (px)': 'フォントサイズ (px)',
  'Text Opacity (%)': 'テキスト不透明度 (%)',
  'Scroll Speed (px/s)': 'スクロール速度 (px/s)',
  'Lane Gap (px)': 'レーン間隔 (px)',
  'Font Weight': 'フォントの太さ',
  'Font Family': 'フォント',
  Enabled: '有効',
  // Legacy key 'Width (px)' removed (replaced by 'Outline Width (px)')
  'Outline Width (px)': '縁取りの太さ (px)',
  'Outline Opacity (%)': '縁取り不透明度 (%)',
  'SuperChat Opacity (%)': 'スパーチャット不透明度 (%)',
  'SuperChat Max Lines': 'スパーチャット最大行数',
  'Membership Max Lines': 'メンバーシップ最大行数',
  'Preserve User Colors': 'ユーザー色を保持',
  'Show SuperChat Amount': 'スパーチャット金額表示',
  'Top Clear Zone (%)': '上部余白 (%)',
  'Bottom Clear Zone (%)': '下部余白 (%)',
  'Ignore Min Length': '最小文字数を無視',
  'Min Length (chars)': '最小文字数',
  'Backlog Mode': 'バックログモード',
  'Backlog Opacity (%)': 'バックログ不透明度 (%)',
  'Author Rate Limit': '投稿者レート制限',
  Language: '言語',
  // ── Language names ──
  English: '英語',
  한국어: '韓国語',
  日本語: '日本語',
  Español: 'スペイン語',
  中文: '中国語',
  'Duration Multiplier (×)': '表示時間倍率 (×)',
  'Exit Padding (px)': '終了余白 (px)',
  'Min Scroll Duration (ms)': '最小スクロール時間 (ms)',
  'Max Scroll Duration (ms)': '最大スクロール時間 (ms)',
  'Top/Bottom Duration (ms)': '上部/下部表示時間 (ms)',
  'Queue Max Size': 'キュー最大サイズ',
  'Background Queue Max': 'バックグラウンドキュー最大',
  'Max Message Age (ms)': '最大メッセージ寿命 (ms)',
  'Headway Gap (%)': 'メッセージ間隔 (%)',
  'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)':
    'メッセージが画面端を通過して削除されるまでの追加ピクセル (20-400, デフォルト 100)',
  'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)':
    '最小スクロールアニメーション時間 — 短いメッセージが速すぎるのを防ぐ (1000-15000ms, デフォルト 5000)',
  'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)':
    '最大スクロールアニメーション時間 — 長いメッセージが遅すぎるのを防ぐ (5-120秒, デフォルト 30000ms)',
  'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)':
    '上部/下部モードメッセージの固定表示時間 (1000-30000ms, デフォルト 4000)',
  'Maximum pending queue depth before messages are dropped (50-1000, default 200)':
    'メッセージがドロップされる前の最大待機キュー深度 (50-1000, デフォルト 200)',
  'Target active message count when trimming background tab (10-500, default 50)':
    'バックグラウンドタブ整理時の目標アクティブメッセージ数 (10-500, デフォルト 50)',
  'Maximum message age before fade-out removal (10-300s, default 60000ms)':
    'フェードアウト除去前の最大メッセージ寿命 (10-300秒, デフォルト 60000ms)',
  'Gap between consecutive messages as percentage of message width (2-30%, default 8)':
    '連続メッセージ間の間隔（メッセージ幅のパーセント） (2-30%, デフォルト 8)',
  'Enable Translation': '翻訳を有効にする',
  Service: 'サービス',
  'Source Language': 'ソース言語',
  'Target Language': '対象言語',
  'Display Mode': '表示モード',
  'Near Speed (%)': '近接速度 (%)',
  'Far Speed (%)': '遠方速度 (%)',
  'Far Opacity (%)': '遠方不透明度 (%)',

  // ── Select options ──
  'Scroll (RTL)': 'スクロール (右→左)',
  'Reverse (LTR)': '逆方向 (左→右)',
  'Top Fixed': '上部固定',
  'Bottom Fixed': '下部固定',
  'Bold (700)': '太字 (700)',
  'Normal (400)': '標準 (400)',
  'Playback-based (recommended)': '再生ベース (推奨)',
  'Recent only': '最近のみ',
  'Full (show all)': 'すべて表示',
  'None (skip backlog)': 'なし (スキップ)',
  Off: 'オフ',
  'Normal (5 msg / 5s)': '標準 (5件 / 5秒)',
  'Strict (2 msg / 5s)': '厳格 (2件 / 5秒)',
  'Auto (Browser)': '自動 (ブラウザ)',
  'Auto (Chrome built-in)': '自動 (Chrome内蔵)',
  'Dual (original + translation)': '二重表示 (原文 + 翻訳)',
  'Replace (translation only)': '翻訳のみ表示',

  // ── Tooltips ──
  'Vertical gap between comment rows (negative = overlap)':
    'コメント行の間隔 (マイナス値 = 重なり)',
  'Text weight: Bold is more readable, Normal uses less GPU memory':
    '太字は読みやすく、標準はGPUメモリ消費が少なくなります',
  'CSS font-family value, e.g. "Noto Sans KR", sans-serif. Falls back to system default if not found.':
    'CSS font-family 値。例: "Noto Sans KR", sans-serif。フォントがなければシステム既定値。',
  'Background opacity of Super Chat cards': 'スパーチャットカードの背景不透明度',
  'Max body text lines before truncation (2-10)': '本文の最大行数、超過分は省略 (2-10)',
  'Max body text lines for membership messages (1-5)':
    'メンバーシップメッセージの本文最大行数 (1-5)',
  'Display the purchase amount badge on Super Chat cards':
    'スパーチャットカードに購入金額バッジを表示します',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'オーバーレイ既定色の代わりにYouTubeチャットの投稿者テキスト色を使用',
  'Keep top N% of video free of comments': '動画上部N%にコメントを表示しない',
  'Keep bottom N% of video free of comments': '動画下部N%にコメントを表示しない',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length':
    '最小文字数に関係なくすべてのメッセージを表示',
  'Minimum character count': '最小文字数',
  'Opacity of past messages relative to real-time messages':
    'リアルタイムメッセージに対する過去メッセージの不透明度',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'モデレーターと所有者のメッセージを通常より長く表示する倍率 (1.0 = 同じ, 2.0 = 2倍)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'チャットメッセージをリアルタイムで翻訳します (Chrome 138+の内蔵翻訳が必要)',
  'Speed-based depth perception: fast messages appear near, slow messages appear far':
    '速度ベースの遠近感: 速いメッセージは近く、遅いメッセージは遠くに表示',
  'Speed boost for near-layer messages': '近接レイヤーメッセージの速度ブースト',
  'Speed reduction for far-layer messages': '遠方レイヤーメッセージの速度低下',
  'Opacity dimming for far-layer messages': '遠方レイヤーメッセージの不透明度減衰',
  'How fast comments scroll across the screen in pixels per second':
    'コメントが画面を横切る速度(ピクセル/秒)',
  'Language of the incoming chat messages': '受信チャットメッセージの言語',
  'Language to translate chat messages into': 'チャットメッセージの翻訳先言語',
  'Limits how frequently messages from the same author appear':
    '同じ投稿者のメッセージ表示頻度を制限',
  'Sets the overlay user interface language (does not filter comments by language)':
    'オーバーレイUIの言語を設定します(コメントの言語フィルターではありません)',

  // ── New Performance / Developer section titles ──
  Performance: 'パフォーマンス',
  Developer: '開発者',

  // ── New field labels ──
  'Max Messages': '最大メッセージ数',
  'Fade Duration (ms)': 'フェード時間 (ms)',
  'Min Poll Interval (ms)': '最小ポーリング間隔 (ms)',
  'Max Poll Interval (ms)': '最大ポーリング間隔 (ms)',
  'Max Rate (msg/s)': '最大速度 (msg/s)',
  'Speed Multiplier': '速度倍率',
  'Window (min)': '時間枠 (分)',
  'Log Level': 'ログレベル',
  'Debug Overlay': 'デバッグオーバーレイ',

  // ── New select options ──
  'Warnings only': '警告のみ',
  Info: '情報',
  'Debug (verbose)': 'デバッグ (詳細)',

  // ── New tooltips ──
  'Maximum number of messages visible on screen at once (30-300)':
    '画面上に同時に表示できる最大メッセージ数 (30-300)',
  'How long messages take to fade out (0 = instant, 50-1000)':
    'メッセージのフェードアウト時間 (0 = 即時, 50-1000)',
  'Minimum chat polling interval in milliseconds (50-5000)':
    'チャットポーリングの最小間隔 (ミリ秒, 50-5000)',
  'Maximum chat polling interval in milliseconds (1000-30000)':
    'チャットポーリングの最大間隔 (ミリ秒, 1000-30000)',
  'Maximum backlog message injection rate per second (0-50)':
    '1秒あたりのバックログメッセージ注入最大速度 (0-50)',
  'Animation speed multiplier for backlog messages (1-5)':
    'バックログメッセージのアニメーション速度倍率 (1-5)',
  'Time window in minutes for recent-only backlog mode (1-30)':
    '最近のみバックログモードの時間枠 (分, 1-30)',
  'Console diagnostic output verbosity': 'コンソール診断出力の詳細度',
  'Show performance debug overlay on the video player':
    'ビデオプレイヤーにパフォーマンスデバッグオーバーレイを表示',

  // ── New tooltips (added 2026-05-28) ──
  'Text size in pixels (14-50)': 'ピクセル単位のテキストサイズ (14-50)',
  'Text outline stroke width in pixels (0-8)': 'テキスト縁取りの太さ (ピクセル, 0-8)',
  'Text outline stroke opacity (0-100%)': 'テキスト縁取りの不透明度 (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'Globally enable or disable the chat overlay on YouTube live streams':
    'YouTubeライブストリームでチャットオーバーレイをオン/オフします',
  'Comment display direction and behavior': 'コメントの表示方向と動作',
  'Overall opacity of comment text (50-100%)': 'コメントテキスト全体の不透明度 (50-100%)',
  'Add a dark outline stroke around text for better readability':
    '明るい背景でもテキストを読みやすくするために黒い縁取りを追加します',
  'How past chat messages are displayed relative to live playback':
    '過去のチャットメッセージをライブ再生に対してどう表示するか',
  'Dual shows original above translation, Replace shows translation only':
    '二重表示は原文の上に翻訳を、置換は翻訳のみ表示します',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'Emoji Cache (MB)': '絵文字キャッシュ (MB)',
  'Photo Cache (MB)': '写真キャッシュ (MB)',
  'Sticker Cache (MB)': 'ステッカーキャッシュ (MB)',
  'Text Cache (MB)': 'テキストキャッシュ (MB)',
  'Translation Batch Size': '翻訳バッチサイズ',
  'Emoji Fetch Limit': '絵文字取得制限',
  'Failed Emoji Retry (min)': '失敗した絵文字の再試行 (分)',
  'Max memory for emoji image cache (1-20 MB, default 3)':
    '絵文字画像キャッシュの最大メモリ (1-20 MB, デフォルト 3)',
  'Max memory for author photo cache (1-20 MB, default 2)':
    '投稿者写真キャッシュの最大メモリ (1-20 MB, デフォルト 2)',
  'Max memory for sticker image cache (1-20 MB, default 1)':
    'ステッカー画像キャッシュの最大メモリ (1-20 MB, デフォルト 1)',
  'Max memory for text bitmap cache (1-20 MB, default 4)':
    'テキストビットマップキャッシュの最大メモリ (1-20 MB, デフォルト 4)',
  'Max translations applied per frame to avoid spikes (1-20, default 5)':
    'フレームごとの最大翻訳適用数 (1-20, デフォルト 5)',
  'Max concurrent emoji fetch operations (1-20, default 6)':
    '最大同時絵文字取得数 (1-20, デフォルト 6)',
  'How long to wait before retrying failed emoji fetches (1-60 min, default 5)':
    '失敗した絵文字の再試行までの待機時間 (1-60分, デフォルト 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'Burst Sample Window': 'バーストサンプルウィンドウ',
  'Elevated Burst (msg/s)': '上昇バースト (msg/s)',
  'High Burst (msg/s)': '高バースト (msg/s)',
  'Extreme Burst (msg/s)': '極端なバースト (msg/s)',
  'Backlog Injection Max': 'バックログ注入最大',
  'Backlog Density Ramp (ms)': 'バックログ密度ランプ (ms)',
  'Live Poll Fallback (ms)': 'ライブポーリングフォールバック (ms)',
  'Poll Failure Limit': 'ポーリング失敗制限',
  'Speed Boost Threshold': 'スピードブーストしきい値',
  'Backlog Pause (%)': 'バックログ一時停止 (%)',
  'Backlog Resume (%)': 'バックログ再開 (%)',
  'Activity Timeout (ms)': 'アクティビティタイムアウト (ms)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'Burst rate sample window size': 'バーストレートのサンプルウィンドウサイズ',
  'Messages per second threshold for elevated burst level':
    '上昇バーストレベルの1秒あたりのメッセージしきい値',
  'Messages per second threshold for high burst level':
    '高バーストレベルの1秒あたりのメッセージしきい値',
  'Messages per second threshold for extreme burst level':
    '極端なバーストレベルの1秒あたりのメッセージしきい値',
  'Maximum backlog injection rate cap': 'バックログ注入レートの最大上限',
  'Density ramp duration for backlog injection in milliseconds':
    'バックログ注入の密度ランプ時間（ミリ秒）',
  'Live poll fallback delay in milliseconds': 'ライブポールフォールバック遅延（ミリ秒）',
  'Consecutive poll failures before circuit breaker trips':
    'サーキットブレーカー作動前の連続ポーリング失敗数',
  'Pending messages to trigger speed boost': 'スピードブーストをトリガーする保留メッセージ数',
  'Lane utilization ratio to pause backlog injection': 'バックログ注入を一時停止するレーン使用率',
  'Lane utilization ratio to resume backlog injection': 'バックログ注入を再開するレーン使用率',
  'Chat activity timeout in milliseconds': 'チャットアクティビティタイムアウト（ミリ秒）',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'Stagger Max Delay (ms)': '最大スタッガー遅延 (ms)',
  'Stagger Medium Delay (ms)': '中スタッガー遅延 (ms)',
  'Emoji Fetch Timeout (ms)': '絵文字取得タイムアウト (ms)',
  'Backlog Density Ramp Max (ms)': 'バックログ密度ランプ最大 (ms)',
  'Backlog Injection Rate Min': '最小バックログ注入レート',
  'Speed Boost Max': '最大スピードブースト',
  'Speed Boost Denom': 'スピードブースト分母',
  'Backlog Toggle Cooldown (ms)': 'バックログ切替クールダウン (ms)',
  'Replay Prefetch Pages': 'リプレイプリフェッチページ',
  'Replay Batch Limit': 'リプレイバッチ制限',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'Max stagger delay for messages in same batch': '同一バッチ内のメッセージの最大スタッガー遅延',
  'Medium stagger delay when queue depth is medium': 'キューの深さが中程度のときのスタッガー遅延',
  'Timeout for emoji fetch operations': '絵文字取得操作のタイムアウト',
  'Max density ramp duration for backlog injection': 'バックログ注入の最大密度ランプ時間',
  'Minimum backlog injection rate (msg/s)': '最小バックログ注入レート (msg/s)',
  'Max speed boost factor for burst compensation': 'バースト補償の最大スピードブースト係数',
  'Speed boost denominator for EMA rate scaling': 'EMAレートスケーリングのスピードブースト分母',
  'Cooldown between backlog pause toggles': 'バックログ一時停止切替間のクールダウン',
  'Max pages to prefetch in replay mode': 'リプレイモードでプリフェッチする最大ページ数',
  'Max batches to fetch in replay initialization': 'リプレイ初期化で取得する最大バッチ数',

  // ── Modal chrome ──
  'Chat Overlay': 'チャットオーバーレイ',
  'Close settings': '設定を閉じる',
  'Settings categories': '設定カテゴリ',
  'Overlay Enabled': 'オーバーレイ有効',
  'Value adjusted to': '調整後の値: ',
  Reset: 'リセット',
  Export: 'エクスポート',
  Import: 'インポート',
  Close: '閉じる',
  'Reset all settings to defaults?': 'すべての設定を初期値にリセットしますか？',
  Cancel: 'キャンセル',
  'Import failed: invalid settings format': 'インポート失敗: 設定形式が無効です',
  'Settings imported successfully': '設定を正常にインポートしました',
  'Import failed: invalid JSON': 'インポート失敗: 無効なJSON形式です',
  'Chat overlay settings': 'チャットオーバーレイ設定',
  'Reset overlay settings': 'オーバーレイ設定をリセット',

  // ── Author grid ──
  'Name Color': '名前の色',
  'Show Name': '名前を表示',
  Normal: '一般',
  Member: 'メンバー',
  Moderator: 'モデレーター',
  Owner: '所有者',
  Verified: '認証済み',
  SuperChat: 'スパーチャット',
};

const ES: TranslationMap = {
  // ── Pane tabs ──
  Comments: 'Comentarios',
  'Cards & Colors': 'Tarjetas y Colores',
  Advanced: 'Avanzado',
  Translation: 'Traducción',

  // ── Section titles ──
  'Text Outline': 'Contorno de texto',
  'Safe Zone': 'Zona segura',
  'Message Rate': 'Frecuencia de mensajes',
  'Moderator and Owner': 'Moderador y Propietario',
  'Depth Layers': 'Capas de profundidad',
  Backlog: 'Historial',
  'Rate Limiting': 'Límite de frecuencia',
  Timing: 'Temporización',
  Thresholds: 'Umbrales',
  'Author Colors & Visibility': 'Colores y visibilidad',
  Interface: 'Interfaz',
  'Chat Translation': 'Traducción de chat',

  // ── Field labels ──
  'Danmaku Mode': 'Modo Danmaku',
  'Font Size (px)': 'Tamaño de fuente (px)',
  'Text Opacity (%)': 'Opacidad del texto (%)',
  'Scroll Speed (px/s)': 'Velocidad (px/s)',
  'Lane Gap (px)': 'Espacio entre líneas (px)',
  'Font Weight': 'Peso de fuente',
  'Font Family': 'Familia tipográfica',
  Enabled: 'Activado',
  // Legacy key 'Width (px)' removed (replaced by 'Outline Width (px)')
  'Outline Width (px)': 'Ancho del contorno (px)',
  'Outline Opacity (%)': 'Opacidad del contorno (%)',
  'SuperChat Opacity (%)': 'Opacidad SuperChat (%)',
  'SuperChat Max Lines': 'Líneas máx. SuperChat',
  'Membership Max Lines': 'Líneas máx. membresía',
  'Preserve User Colors': 'Conservar colores de usuario',
  'Show SuperChat Amount': 'Mostrar monto SuperChat',
  'Top Clear Zone (%)': 'Margen superior (%)',
  'Bottom Clear Zone (%)': 'Margen inferior (%)',
  'Ignore Min Length': 'Ignorar long. mínima',
  'Min Length (chars)': 'Longitud mínima (caracteres)',
  'Backlog Mode': 'Modo de historial',
  'Backlog Opacity (%)': 'Opacidad historial (%)',
  'Author Rate Limit': 'Límite por autor',
  Language: 'Idioma',
  // ── Language names ──
  English: 'Inglés',
  한국어: 'Coreano',
  日本語: 'Japonés',
  Español: 'Español',
  中文: 'Chino',
  'Duration Multiplier (×)': 'Multiplicador de duración (×)',
  'Exit Padding (px)': 'Margen de salida (px)',
  'Min Scroll Duration (ms)': 'Duración mín. desplazamiento (ms)',
  'Max Scroll Duration (ms)': 'Duración máx. desplazamiento (ms)',
  'Top/Bottom Duration (ms)': 'Duración superior/inferior (ms)',
  'Queue Max Size': 'Tamaño máx. de cola',
  'Background Queue Max': 'Cola en segundo plano máx.',
  'Max Message Age (ms)': 'Edad máx. de mensaje (ms)',
  'Headway Gap (%)': 'Espacio entre mensajes (%)',
  'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)':
    'Píxeles extra que un mensaje se desplaza más allá del borde antes de eliminarse (20-400, predeterminado 100)',
  'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)':
    'Duración mínima de animación de desplazamiento — evita que mensajes cortos pasen demasiado rápido (1000-15000ms, predet. 5000)',
  'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)':
    'Duración máxima de animación de desplazamiento — evita que mensajes largos vayan muy lento (5-120s, predet. 30000ms)',
  'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)':
    'Duración fija de visualización para mensajes en modo superior/inferior (1000-30000ms, predet. 4000)',
  'Maximum pending queue depth before messages are dropped (50-1000, default 200)':
    'Profundidad máxima de cola pendiente antes de descartar mensajes (50-1000, predet. 200)',
  'Target active message count when trimming background tab (10-500, default 50)':
    'Objetivo de mensajes activos al recortar pestaña en segundo plano (10-500, predet. 50)',
  'Maximum message age before fade-out removal (10-300s, default 60000ms)':
    'Edad máxima del mensaje antes de eliminación por desvanecimiento (10-300s, predet. 60000ms)',
  'Gap between consecutive messages as percentage of message width (2-30%, default 8)':
    'Espacio entre mensajes consecutivos como porcentaje del ancho (2-30%, predet. 8)',
  'Enable Translation': 'Activar traducción',
  Service: 'Servicio',
  'Source Language': 'Idioma de origen',
  'Target Language': 'Idioma de destino',
  'Display Mode': 'Modo de visualización',
  'Near Speed (%)': 'Velocidad cerca (%)',
  'Far Speed (%)': 'Velocidad lejos (%)',
  'Far Opacity (%)': 'Opacidad lejos (%)',

  // ── Select options ──
  'Scroll (RTL)': 'Desplazar (der.→izq.)',
  'Reverse (LTR)': 'Inverso (izq.→der.)',
  'Top Fixed': 'Fijo arriba',
  'Bottom Fixed': 'Fijo abajo',
  'Bold (700)': 'Negrita (700)',
  'Normal (400)': 'Normal (400)',
  'Playback-based (recommended)': 'Basado en reproducción (recomendado)',
  'Recent only': 'Solo recientes',
  'Full (show all)': 'Completo (mostrar todo)',
  'None (skip backlog)': 'Ninguno (omitir historial)',
  Off: 'Apagado',
  'Normal (5 msg / 5s)': 'Normal (5 msg / 5s)',
  'Strict (2 msg / 5s)': 'Estricto (2 msg / 5s)',
  'Auto (Browser)': 'Automático (Navegador)',
  'Auto (Chrome built-in)': 'Automático (integrado en Chrome)',
  'Dual (original + translation)': 'Dual (original + traducción)',
  'Replace (translation only)': 'Reemplazar (solo traducción)',

  // ── Tooltips ──
  'Vertical gap between comment rows (negative = overlap)':
    'Espacio vertical entre filas (negativo = superposición)',
  'Text weight: Bold is more readable, Normal uses less GPU memory':
    'Negrita es más legible, Normal usa menos memoria de GPU',
  'CSS font-family value, e.g. "Noto Sans KR", sans-serif. Falls back to system default if not found.':
    'Valor CSS font-family, ej. "Noto Sans KR", sans-serif. Si no se encuentra, usa la fuente del sistema.',
  'Background opacity of Super Chat cards': 'Opacidad del fondo de tarjetas Super Chat',
  'Max body text lines before truncation (2-10)': 'Máximo de líneas antes de truncar (2-10)',
  'Max body text lines for membership messages (1-5)':
    'Máximo de líneas para mensajes de membresía (1-5)',
  'Display the purchase amount badge on Super Chat cards':
    'Mostrar la insignia de monto de compra en tarjetas Super Chat',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'Usar el color de texto del autor en lugar del predeterminado',
  'Keep top N% of video free of comments': 'Mantener el N% superior del video sin comentarios',
  'Keep bottom N% of video free of comments': 'Mantener el N% inferior del video sin comentarios',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length':
    'Mostrar todos los mensajes sin importar la longitud mínima',
  'Minimum character count': 'Cantidad mínima de caracteres',
  'Opacity of past messages relative to real-time messages':
    'Opacidad de mensajes pasados respecto a los actuales',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'Cuánto más tiempo permanecen visibles los mensajes de moderador y propietario (1.0 = igual, 2.0 = el doble)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'Traduce mensajes de chat en tiempo real (requiere Chrome 138+ con traducción integrada)',
  'Speed-based depth perception: fast messages appear near, slow messages appear far':
    'Percepción de profundidad por velocidad: mensajes rápidos cerca, lentos lejos',
  'Speed boost for near-layer messages': 'Aumento de velocidad para mensajes cercanos',
  'Speed reduction for far-layer messages': 'Reducción de velocidad para mensajes lejanos',
  'Opacity dimming for far-layer messages': 'Reducción de opacidad para mensajes lejanos',
  'How fast comments scroll across the screen in pixels per second':
    'Velocidad a la que los comentarios cruzan la pantalla (píxeles/segundo)',
  'Language of the incoming chat messages': 'Idioma de los mensajes de chat entrantes',
  'Language to translate chat messages into': 'Idioma al que traducir los mensajes',
  'Limits how frequently messages from the same author appear':
    'Limita la frecuencia con la que aparecen mensajes del mismo autor',
  'Sets the overlay user interface language (does not filter comments by language)':
    'Establece el idioma de la interfaz (no filtra comentarios por idioma)',

  // ── New Performance / Developer section titles ──
  Performance: 'Rendimiento',
  Developer: 'Desarrollador',

  // ── New field labels ──
  'Max Messages': 'Máx. mensajes',
  'Fade Duration (ms)': 'Duración fundido (ms)',
  'Min Poll Interval (ms)': 'Intervalo mín. sondeo (ms)',
  'Max Poll Interval (ms)': 'Intervalo máx. sondeo (ms)',
  'Max Rate (msg/s)': 'Velocidad máx. (msg/s)',
  'Speed Multiplier': 'Multiplicador velocidad',
  'Window (min)': 'Ventana (min)',
  'Log Level': 'Nivel de registro',
  'Debug Overlay': 'Superposición depuración',

  // ── New select options ──
  'Warnings only': 'Solo avisos',
  Info: 'Información',
  'Debug (verbose)': 'Depuración (detallado)',

  // ── New tooltips ──
  'Maximum number of messages visible on screen at once (30-300)':
    'Número máximo de mensajes visibles en pantalla a la vez (30-300)',
  'How long messages take to fade out (0 = instant, 50-1000)':
    'Tiempo de desvanecimiento de los mensajes (0 = instantáneo, 50-1000)',
  'Minimum chat polling interval in milliseconds (50-5000)':
    'Intervalo mínimo de sondeo del chat en milisegundos (50-5000)',
  'Maximum chat polling interval in milliseconds (1000-30000)':
    'Intervalo máximo de sondeo del chat en milisegundos (1000-30000)',
  'Maximum backlog message injection rate per second (0-50)':
    'Velocidad máxima de inyección de mensajes del historial por segundo (0-50)',
  'Animation speed multiplier for backlog messages (1-5)':
    'Multiplicador de velocidad de animación para mensajes del historial (1-5)',
  'Time window in minutes for recent-only backlog mode (1-30)':
    'Ventana de tiempo en minutos para el modo de solo recientes (1-30)',
  'Console diagnostic output verbosity': 'Verbosidad de la salida de diagnóstico',
  'Show performance debug overlay on the video player':
    'Mostrar superposición de depuración de rendimiento en el reproductor de video',

  // ── New tooltips (added 2026-05-28) ──
  'Text size in pixels (14-50)': 'Tamaño del texto en píxeles (14-50)',
  'Text outline stroke width in pixels (0-8)': 'Ancho del contorno de texto en píxeles (0-8)',
  'Text outline stroke opacity (0-100%)': 'Opacidad del contorno de texto (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'Globally enable or disable the chat overlay on YouTube live streams':
    'Activa o desactiva la superposición de chat en las transmisiones en vivo de YouTube',
  'Comment display direction and behavior': 'Dirección y comportamiento de los comentarios',
  'Overall opacity of comment text (50-100%)':
    'Opacidad general del texto de comentarios (50-100%)',
  'Add a dark outline stroke around text for better readability':
    'Añade un contorno oscuro alrededor del texto para mejorar la legibilidad',
  'How past chat messages are displayed relative to live playback':
    'Cómo se muestran los mensajes antiguos en relación con la reproducción en vivo',
  'Dual shows original above translation, Replace shows translation only':
    'Dual muestra el original encima de la traducción, Reemplazar muestra solo la traducción',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'Emoji Cache (MB)': 'Caché de emojis (MB)',
  'Photo Cache (MB)': 'Caché de fotos (MB)',
  'Sticker Cache (MB)': 'Caché de stickers (MB)',
  'Text Cache (MB)': 'Caché de texto (MB)',
  'Translation Batch Size': 'Tamaño de lote de traducción',
  'Emoji Fetch Limit': 'Límite de obtención de emojis',
  'Failed Emoji Retry (min)': 'Reintento de emoji fallido (min)',
  'Max memory for emoji image cache (1-20 MB, default 3)':
    'Memoria máxima para caché de emojis (1-20 MB, predet. 3)',
  'Max memory for author photo cache (1-20 MB, default 2)':
    'Memoria máxima para caché de fotos (1-20 MB, predet. 2)',
  'Max memory for sticker image cache (1-20 MB, default 1)':
    'Memoria máxima para caché de stickers (1-20 MB, predet. 1)',
  'Max memory for text bitmap cache (1-20 MB, default 4)':
    'Memoria máxima para caché de texto (1-20 MB, predet. 4)',
  'Max translations applied per frame to avoid spikes (1-20, default 5)':
    'Traducciones máximas por fotograma (1-20, predet. 5)',
  'Max concurrent emoji fetch operations (1-20, default 6)':
    'Operaciones simultáneas máximas de emojis (1-20, predet. 6)',
  'How long to wait before retrying failed emoji fetches (1-60 min, default 5)':
    'Tiempo de espera antes de reintentar emojis fallidos (1-60 min, predet. 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'Burst Sample Window': 'Ventana de muestra de ráfaga',
  'Elevated Burst (msg/s)': 'Ráfaga elevada (msg/s)',
  'High Burst (msg/s)': 'Ráfaga alta (msg/s)',
  'Extreme Burst (msg/s)': 'Ráfaga extrema (msg/s)',
  'Backlog Injection Max': 'Inyección máx. historial',
  'Backlog Density Ramp (ms)': 'Rampa de densidad historial (ms)',
  'Live Poll Fallback (ms)': 'Sondeo alternativo (ms)',
  'Poll Failure Limit': 'Límite fallos sondeo',
  'Speed Boost Threshold': 'Umbral aumento velocidad',
  'Backlog Pause (%)': 'Pausar historial (%)',
  'Backlog Resume (%)': 'Reanudar historial (%)',
  'Activity Timeout (ms)': 'Tiempo de espera (ms)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'Burst rate sample window size': 'Tamaño de la ventana de muestreo de la tasa de ráfaga',
  'Messages per second threshold for elevated burst level':
    'Umbral de mensajes por segundo para el nivel de ráfaga elevado',
  'Messages per second threshold for high burst level':
    'Umbral de mensajes por segundo para el nivel de ráfaga alto',
  'Messages per second threshold for extreme burst level':
    'Umbral de mensajes por segundo para el nivel de ráfaga extremo',
  'Maximum backlog injection rate cap': 'Límite máximo de velocidad de inyección del historial',
  'Density ramp duration for backlog injection in milliseconds':
    'Duración de la rampa de densidad para la inyección del historial en milisegundos',
  'Live poll fallback delay in milliseconds':
    'Retraso alternativo del sondeo en vivo en milisegundos',
  'Consecutive poll failures before circuit breaker trips':
    'Fallos consecutivos de sondeo antes de que se active el interruptor',
  'Pending messages to trigger speed boost':
    'Mensajes pendientes para activar el aumento de velocidad',
  'Lane utilization ratio to pause backlog injection':
    'Relación de uso de carril para pausar la inyección del historial',
  'Lane utilization ratio to resume backlog injection':
    'Relación de uso de carril para reanudar la inyección del historial',
  'Chat activity timeout in milliseconds': 'Tiempo de espera de actividad del chat en milisegundos',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'Stagger Max Delay (ms)': 'Retardo máx. escalonado (ms)',
  'Stagger Medium Delay (ms)': 'Retardo escalonado medio (ms)',
  'Emoji Fetch Timeout (ms)': 'Tiempo de espera de emoji (ms)',
  'Backlog Density Ramp Max (ms)': 'Rampa densidad historial máx. (ms)',
  'Backlog Injection Rate Min': 'Inyección historial mín.',
  'Speed Boost Max': 'Aumento velocidad máx.',
  'Speed Boost Denom': 'Denom. aumento velocidad',
  'Backlog Toggle Cooldown (ms)': 'Enfriamiento alternar historial (ms)',
  'Replay Prefetch Pages': 'Páginas precarga repetición',
  'Replay Batch Limit': 'Límite lotes repetición',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'Max stagger delay for messages in same batch':
    'Retardo máximo escalonado para mensajes en el mismo lote',
  'Medium stagger delay when queue depth is medium':
    'Retardo escalonado medio cuando la cola está a media capacidad',
  'Timeout for emoji fetch operations': 'Tiempo de espera para operaciones de obtención de emojis',
  'Max density ramp duration for backlog injection':
    'Duración máxima de la rampa de densidad para la inyección del historial',
  'Minimum backlog injection rate (msg/s)': 'Tasa mínima de inyección del historial (msg/s)',
  'Max speed boost factor for burst compensation':
    'Factor máximo de aumento de velocidad para compensación de ráfagas',
  'Speed boost denominator for EMA rate scaling':
    'Denominador de aumento de velocidad para escalado de tasa EMA',
  'Cooldown between backlog pause toggles': 'Enfriamiento entre cambios de pausa del historial',
  'Max pages to prefetch in replay mode': 'Máximo de páginas a precargar en modo repetición',
  'Max batches to fetch in replay initialization':
    'Máximo de lotes a obtener en la inicialización de repetición',

  // ── Modal chrome ──
  'Chat Overlay': 'Superposición de Chat',
  'Close settings': 'Cerrar configuración',
  'Settings categories': 'Categorías',
  'Overlay Enabled': 'Superposición activada',
  'Value adjusted to': 'Valor ajustado a ',
  Reset: 'Restablecer',
  Export: 'Exportar',
  Import: 'Importar',
  Close: 'Cerrar',
  'Reset all settings to defaults?':
    '¿Restablecer todas las opciones a los valores predeterminados?',
  Cancel: 'Cancelar',
  'Import failed: invalid settings format': 'Error de importación: formato no válido',
  'Settings imported successfully': 'Configuración importada correctamente',
  'Import failed: invalid JSON': 'Error de importación: JSON no válido',
  'Chat overlay settings': 'Configuración de superposición de chat',
  'Reset overlay settings': 'Restablecer superposición',

  // ── Author grid ──
  'Name Color': 'Color del nombre',
  'Show Name': 'Mostrar nombre',
  Normal: 'Normal',
  Member: 'Miembro',
  Moderator: 'Moderador',
  Owner: 'Propietario',
  Verified: 'Verificado',
  SuperChat: 'SuperChat',
};

const ZH: TranslationMap = {
  // ── Pane tabs ──
  Comments: '弹幕',
  'Cards & Colors': '卡片与颜色',
  Advanced: '高级',
  Translation: '翻译',

  // ── Section titles ──
  'Text Outline': '文字描边',
  'Safe Zone': '安全区域',
  'Message Rate': '消息频率',
  'Moderator and Owner': '版主与频道主',
  'Depth Layers': '深度图层',
  Backlog: '回放',
  'Rate Limiting': '频率限制',
  Timing: '时序',
  Thresholds: '阈值',
  'Author Colors & Visibility': '用户颜色与显示',
  Interface: '界面',
  'Chat Translation': '聊天翻译',

  // ── Field labels ──
  'Danmaku Mode': '弹幕模式',
  'Font Size (px)': '字体大小 (px)',
  'Text Opacity (%)': '文字不透明度 (%)',
  'Scroll Speed (px/s)': '滚动速度 (px/s)',
  'Lane Gap (px)': '行间距 (px)',
  'Font Weight': '字体粗细',
  'Font Family': '字体',
  Enabled: '启用',
  // Legacy key 'Width (px)' removed (replaced by 'Outline Width (px)')
  'Outline Width (px)': '描边宽度 (px)',
  'Outline Opacity (%)': '描边不透明度 (%)',
  'SuperChat Opacity (%)': '超级留言不透明度 (%)',
  'SuperChat Max Lines': '超级留言最大行数',
  'Membership Max Lines': '会员消息最大行数',
  'Preserve User Colors': '保留用户颜色',
  'Show SuperChat Amount': '显示超级留言金额',
  'Top Clear Zone (%)': '顶部留白 (%)',
  'Bottom Clear Zone (%)': '底部留白 (%)',
  'Ignore Min Length': '忽略最小长度',
  'Min Length (chars)': '最小长度 (字符)',
  'Backlog Mode': '回放模式',
  'Backlog Opacity (%)': '回放不透明度 (%)',
  'Author Rate Limit': '用户频率限制',
  Language: '语言',
  // ── Language names ──
  English: '英语',
  한국어: '韩语',
  日本語: '日语',
  Español: '西班牙语',
  中文: '中文',
  'Duration Multiplier (×)': '显示时长倍率 (×)',
  'Exit Padding (px)': '退出边距 (px)',
  'Min Scroll Duration (ms)': '最小滚动时间 (ms)',
  'Max Scroll Duration (ms)': '最大滚动时间 (ms)',
  'Top/Bottom Duration (ms)': '顶部/底部显示时间 (ms)',
  'Queue Max Size': '队列最大容量',
  'Background Queue Max': '后台队列最大容量',
  'Max Message Age (ms)': '最大消息寿命 (ms)',
  'Headway Gap (%)': '消息间距 (%)',
  'Extra pixels a message scrolls past the screen edge before being removed (20-400, default 100)':
    '消息滚动超过屏幕边缘后被移除的额外像素 (20-400, 默认 100)',
  'Minimum scroll animation duration — prevents very short messages from zipping across (1000-15000ms, default 5000)':
    '最小滚动动画时长 — 防止短消息飞过 (1000-15000ms, 默认 5000)',
  'Maximum scroll animation duration — prevents very long messages from crawling (5-120s, default 30000ms)':
    '最大滚动动画时长 — 防止长消息爬行 (5-120秒, 默认 30000ms)',
  'Fixed display duration for top/bottom mode messages (1000-30000ms, default 4000)':
    '顶部/底部模式消息的固定显示时长 (1000-30000ms, 默认 4000)',
  'Maximum pending queue depth before messages are dropped (50-1000, default 200)':
    '消息被丢弃前的最大待处理队列深度 (50-1000, 默认 200)',
  'Target active message count when trimming background tab (10-500, default 50)':
    '后台标签页整理时的目标活动消息数 (10-500, 默认 50)',
  'Maximum message age before fade-out removal (10-300s, default 60000ms)':
    '淡出移除前的最大消息寿命 (10-300秒, 默认 60000ms)',
  'Gap between consecutive messages as percentage of message width (2-30%, default 8)':
    '连续消息之间的间距（消息宽度的百分比） (2-30%, 默认 8)',
  'Enable Translation': '启用翻译',
  Service: '服务',
  'Source Language': '源语言',
  'Target Language': '目标语言',
  'Display Mode': '显示模式',
  'Near Speed (%)': '近处速度 (%)',
  'Far Speed (%)': '远处速度 (%)',
  'Far Opacity (%)': '远处不透明度 (%)',

  // ── Select options ──
  'Scroll (RTL)': '滚动 (右→左)',
  'Reverse (LTR)': '反向 (左→右)',
  'Top Fixed': '顶部固定',
  'Bottom Fixed': '底部固定',
  'Bold (700)': '粗体 (700)',
  'Normal (400)': '常规 (400)',
  'Playback-based (recommended)': '基于播放进度 (推荐)',
  'Recent only': '仅最近',
  'Full (show all)': '全部显示',
  'None (skip backlog)': '无 (跳过回放)',
  Off: '关闭',
  'Normal (5 msg / 5s)': '标准 (5条 / 5秒)',
  'Strict (2 msg / 5s)': '严格 (2条 / 5秒)',
  'Auto (Browser)': '自动 (浏览器)',
  'Auto (Chrome built-in)': '自动 (Chrome内置)',
  'Dual (original + translation)': '双语 (原文 + 翻译)',
  'Replace (translation only)': '仅翻译',

  // ── Tooltips ──
  'Vertical gap between comment rows (negative = overlap)': '弹幕行之间的垂直间距 (负值 = 重叠)',
  'Text weight: Bold is more readable, Normal uses less GPU memory':
    '粗体更易阅读，常规字体占用更少GPU内存',
  'CSS font-family value, e.g. "Noto Sans KR", sans-serif. Falls back to system default if not found.':
    'CSS font-family 值，例如 "Noto Sans KR", sans-serif。字体不存在时使用系统默认。',
  'Background opacity of Super Chat cards': '超级留言卡片的背景不透明度',
  'Max body text lines before truncation (2-10)': '正文最大行数，超出部分截断 (2-10)',
  'Max body text lines for membership messages (1-5)': '会员消息正文最大行数 (1-5)',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    '使用YouTube聊天中用户自选文字颜色，而非覆盖层默认颜色',
  'Display the purchase amount badge on Super Chat cards': '在超级留言卡片上显示购买金额徽章',
  'Keep top N% of video free of comments': '视频顶部N%区域不显示弹幕',
  'Keep bottom N% of video free of comments': '视频底部N%区域不显示弹幕',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length': '无论最小字符数如何，显示所有消息',
  'Minimum character count': '最小字符数',
  'Opacity of past messages relative to real-time messages': '历史消息相对于实时消息的不透明度',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    '版主和频道主的消息比普通消息多显示多长时间 (1.0 = 相同, 2.0 = 两倍)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    '实时翻译聊天消息 (需要 Chrome 138+ 内置翻译)',
  'Speed-based depth perception: fast messages appear near, slow messages appear far':
    '基于速度的深度感知：快速消息显示在近处，慢速消息显示在远处',
  'Speed boost for near-layer messages': '近处图层消息速度提升',
  'Speed reduction for far-layer messages': '远处图层消息速度降低',
  'Opacity dimming for far-layer messages': '远处图层消息不透明度降低',
  'How fast comments scroll across the screen in pixels per second': '弹幕滚过屏幕的速度(像素/秒)',
  'Language of the incoming chat messages': '传入聊天消息的语言',
  'Language to translate chat messages into': '将聊天消息翻译成的目标语言',
  'Limits how frequently messages from the same author appear': '限制同一用户消息的显示频率',
  'Sets the overlay user interface language (does not filter comments by language)':
    '设置覆盖层界面语言（不按语言过滤弹幕）',

  // ── New Performance / Developer section titles ──
  Performance: '性能',
  Developer: '开发者',

  // ── New field labels ──
  'Max Messages': '最大消息数',
  'Fade Duration (ms)': '淡出时间 (ms)',
  'Min Poll Interval (ms)': '最小轮询间隔 (ms)',
  'Max Poll Interval (ms)': '最大轮询间隔 (ms)',
  'Max Rate (msg/s)': '最大速率 (msg/s)',
  'Speed Multiplier': '速度倍率',
  'Window (min)': '时间窗口 (分)',
  'Log Level': '日志级别',
  'Debug Overlay': '调试覆盖层',

  // ── New select options ──
  'Warnings only': '仅警告',
  Info: '信息',
  'Debug (verbose)': '调试 (详细)',

  // ── New tooltips ──
  'Maximum number of messages visible on screen at once (30-300)':
    '屏幕上同时可见的最大消息数 (30-300)',
  'How long messages take to fade out (0 = instant, 50-1000)':
    '消息淡出所需时间 (0 = 立即, 50-1000)',
  'Minimum chat polling interval in milliseconds (50-5000)': '聊天轮询最小间隔（毫秒，50-5000）',
  'Maximum chat polling interval in milliseconds (1000-30000)':
    '聊天轮询最大间隔（毫秒，1000-30000）',
  'Maximum backlog message injection rate per second (0-50)': '每秒最大回放消息注入速率 (0-50)',
  'Animation speed multiplier for backlog messages (1-5)': '回放消息动画速度倍率 (1-5)',
  'Time window in minutes for recent-only backlog mode (1-30)':
    '仅最近回放模式的时间窗口（分钟，1-30）',
  'Console diagnostic output verbosity': '控制台诊断输出详细程度',
  'Show performance debug overlay on the video player': '在视频播放器上显示性能调试覆盖层',

  // ── New tooltips (added 2026-05-28) ──
  'Text size in pixels (14-50)': '像素文本大小 (14-50)',
  'Text outline stroke width in pixels (0-8)': '文本描边宽度（像素，0-8）',
  'Text outline stroke opacity (0-100%)': '文本描边不透明度 (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'Globally enable or disable the chat overlay on YouTube live streams':
    '在YouTube直播中打开或关闭弹幕显示',
  'Comment display direction and behavior': '弹幕显示方向和行为',
  'Overall opacity of comment text (50-100%)': '弹幕文字的整体不透明度 (50-100%)',
  'Add a dark outline stroke around text for better readability':
    '在文字周围添加深色描边，提高可读性',
  'How past chat messages are displayed relative to live playback':
    '历史聊天消息相对于直播播放的显示方式',
  'Dual shows original above translation, Replace shows translation only':
    '双语显示原文在上翻译在下，仅翻译只显示译文',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'Emoji Cache (MB)': '表情缓存 (MB)',
  'Photo Cache (MB)': '头像缓存 (MB)',
  'Sticker Cache (MB)': '贴纸缓存 (MB)',
  'Text Cache (MB)': '文本缓存 (MB)',
  'Translation Batch Size': '翻译批处理大小',
  'Emoji Fetch Limit': '表情获取限制',
  'Failed Emoji Retry (min)': '失败表情重试 (分钟)',
  'Max memory for emoji image cache (1-20 MB, default 3)': '表情图片缓存最大内存 (1-20 MB, 默认 3)',
  'Max memory for author photo cache (1-20 MB, default 2)':
    '作者头像缓存最大内存 (1-20 MB, 默认 2)',
  'Max memory for sticker image cache (1-20 MB, default 1)':
    '贴纸图片缓存最大内存 (1-20 MB, 默认 1)',
  'Max memory for text bitmap cache (1-20 MB, default 4)': '文本位图缓存最大内存 (1-20 MB, 默认 4)',
  'Max translations applied per frame to avoid spikes (1-20, default 5)':
    '每帧最大翻译数量 (1-20, 默认 5)',
  'Max concurrent emoji fetch operations (1-20, default 6)': '最大并发表情获取数 (1-20, 默认 6)',
  'How long to wait before retrying failed emoji fetches (1-60 min, default 5)':
    '失败表情重试前等待时间 (1-60分钟, 默认 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'Burst Sample Window': '突发采样窗口',
  'Elevated Burst (msg/s)': '上升突发 (msg/s)',
  'High Burst (msg/s)': '高突发 (msg/s)',
  'Extreme Burst (msg/s)': '极端突发 (msg/s)',
  'Backlog Injection Max': '回放注入上限',
  'Backlog Density Ramp (ms)': '回放密度斜坡 (ms)',
  'Live Poll Fallback (ms)': '实时轮询回退 (ms)',
  'Poll Failure Limit': '轮询失败限制',
  'Speed Boost Threshold': '速度提升阈值',
  'Backlog Pause (%)': '回放暂停 (%)',
  'Backlog Resume (%)': '回放恢复 (%)',
  'Activity Timeout (ms)': '活动超时 (ms)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'Burst rate sample window size': '突发速率采样窗口大小',
  'Messages per second threshold for elevated burst level': '上升突发级别的每秒消息数阈值',
  'Messages per second threshold for high burst level': '高突发级别的每秒消息数阈值',
  'Messages per second threshold for extreme burst level': '极端突发级别的每秒消息数阈值',
  'Maximum backlog injection rate cap': '回放注入速率上限',
  'Density ramp duration for backlog injection in milliseconds':
    '回放注入的密度斜坡持续时间（毫秒）',
  'Live poll fallback delay in milliseconds': '实时轮询回退延迟（毫秒）',
  'Consecutive poll failures before circuit breaker trips': '断路器跳闸前的连续轮询失败次数',
  'Pending messages to trigger speed boost': '触发速度提升的待处理消息数',
  'Lane utilization ratio to pause backlog injection': '暂停回放注入的通道利用率',
  'Lane utilization ratio to resume backlog injection': '恢复回放注入的通道利用率',
  'Chat activity timeout in milliseconds': '聊天活动超时时间（毫秒）',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'Stagger Max Delay (ms)': '最大交错延迟 (ms)',
  'Stagger Medium Delay (ms)': '中等交错延迟 (ms)',
  'Emoji Fetch Timeout (ms)': '表情获取超时 (ms)',
  'Backlog Density Ramp Max (ms)': '回放密度斜坡最大 (ms)',
  'Backlog Injection Rate Min': '最小回放注入速率',
  'Speed Boost Max': '最大速度提升',
  'Speed Boost Denom': '速度提升分母',
  'Backlog Toggle Cooldown (ms)': '回放切换冷却 (ms)',
  'Replay Prefetch Pages': '回放预取页数',
  'Replay Batch Limit': '回放批量限制',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'Max stagger delay for messages in same batch': '同一批次消息的最大交错延迟',
  'Medium stagger delay when queue depth is medium': '队列深度中等时的交错延迟',
  'Timeout for emoji fetch operations': '表情获取操作的超时时间',
  'Max density ramp duration for backlog injection': '回放注入的最大密度斜坡持续时间',
  'Minimum backlog injection rate (msg/s)': '最小回放注入速率 (msg/s)',
  'Max speed boost factor for burst compensation': '突发补偿的最大速度提升系数',
  'Speed boost denominator for EMA rate scaling': 'EMA速率缩放的速度提升分母',
  'Cooldown between backlog pause toggles': '回放暂停切换之间的冷却时间',
  'Max pages to prefetch in replay mode': '回放模式下预取的最大页数',
  'Max batches to fetch in replay initialization': '回放初始化时获取的最大批次数',

  // ── Modal chrome ──
  'Chat Overlay': '弹幕显示',
  'Close settings': '关闭设置',
  'Settings categories': '设置分类',
  'Overlay Enabled': '已启用覆盖层',
  'Value adjusted to': '已调整至 ',
  Reset: '重置',
  Export: '导出',
  Import: '导入',
  Close: '关闭',
  'Reset all settings to defaults?': '将所有设置重置为默认值？',
  Cancel: '取消',
  'Import failed: invalid settings format': '导入失败：设置格式无效',
  'Settings imported successfully': '设置导入成功',
  'Import failed: invalid JSON': '导入失败：JSON格式无效',
  'Chat overlay settings': '弹幕显示设置',
  'Reset overlay settings': '重置覆盖层设置',

  // ── Author grid ──
  'Name Color': '名称颜色',
  'Show Name': '显示名称',
  Normal: '普通',
  Member: '会员',
  Moderator: '版主',
  Owner: '频道主',
  Verified: '已认证',
  SuperChat: '超级留言',
};

const TRANSLATIONS: Record<SupportedLanguage, TranslationMap> = {
  en: {}, // English: no translation needed (strings are the keys)
  ko: KO,
  ja: JA,
  es: ES,
  zh: ZH,
};

// Export translation maps for consistency validation (test-only, not used at runtime)
export const TRANSLATION_MAPS: Record<string, TranslationMap> = {
  ko: KO,
  ja: JA,
  es: ES,
  zh: ZH,
};
