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
  'Author Colors & Visibility': '작성자 색상 및 표시',

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
  'Outline Opacity (0–1)': '외곽선 불투명도 (0–1)',
  Opacity: '불투명도',
  'SuperChat Opacity (%)': '슈퍼챗 불투명도 (%)',
  'SuperChat Max Lines': '슈퍼챗 최대 줄 수',
  'Membership Max Lines': '멤버십 최대 줄 수',
  'Preserve User Colors': '사용자 색상 유지',
  'Top Clear Zone (%)': '상단 여백 (%)',
  'Bottom Clear Zone (%)': '하단 여백 (%)',
  'Ignore Min Length': '최소 길이 무시',
  'Min Length (chars)': '최소 길이 (글자)',
  'Backlog Mode': '백로그 모드',
  'Backlog Opacity (%)': '백로그 불투명도 (%)',
  'Author Rate Limit': '작성자 빈도 제한',
  Language: '언어',
  'Duration Multiplier (×)': '표시 시간 배율 (×)',
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
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'YouTube 채팅 작성자의 텍스트 색상을 오버레이 기본값 대신 사용',
  'Keep top N% of video free of comments': '영상 상단 N%를 댓글 없이 유지',
  'Keep bottom N% of video free of comments': '영상 하단 N%를 댓글 없이 유지',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length':
    '최소 글자 수에 관계없이 모든 메시지 표시',
  'Short messages shown regardless of length': '길이에 관계없이 짧은 메시지 표시',
  'Minimum character count': '최소 글자 수',
  'Opacity of past messages relative to real-time messages':
    '실시간 메시지 대비 과거 메시지의 불투명도',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    '관리자와 소유자의 메시지가 일반 메시지보다 얼마나 오래 표시될지 설정합니다 (1.0 = 동일, 2.0 = 2배)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    '실시간으로 채팅 메시지를 번역합니다 (Chrome 138+ 내장 번역 필요)',
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    '번역 기능은 내장 AI가 있는 브라우저가 필요합니다. Chrome 138+ 또는 Edge 143+ Canary를 사용하세요.',
  'Speed-based depth perception: fast messages appear near, slow messages appear far':
    '속도 기반 깊이감: 빠른 메시지는 가까이, 느린 메시지는 멀리 표시',
  'Speed boost for near-layer messages': '가까운 레이어 메시지 속도 증가',
  'Speed reduction for far-layer messages': '먼 레이어 메시지 속도 감소',
  'Opacity dimming for far-layer messages': '먼 레이어 메시지 불투명도 감소',
  'How fast comments scroll across the screen in pixels per second':
    '댓글이 화면을 가로지르는 속도(초당 픽셀)',
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

  // ── Modal chrome ──
  'Chat Overlay': '채팅 오버레이',
  'Close settings': '설정 닫기',
  'Settings categories': '설정 카테고리',
  'Overlay Enabled': '오버레이 활성화',
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
  Color: '색상',
  Show: '표시',
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
  'Author Colors & Visibility': '投稿者の色と表示',

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
  'Outline Opacity (0–1)': '縁取り不透明度 (0–1)',
  Opacity: '不透明度',
  'SuperChat Opacity (%)': 'スパーチャット不透明度 (%)',
  'SuperChat Max Lines': 'スパーチャット最大行数',
  'Membership Max Lines': 'メンバーシップ最大行数',
  'Preserve User Colors': 'ユーザー色を保持',
  'Top Clear Zone (%)': '上部余白 (%)',
  'Bottom Clear Zone (%)': '下部余白 (%)',
  'Ignore Min Length': '最小文字数を無視',
  'Min Length (chars)': '最小文字数',
  'Backlog Mode': 'バックログモード',
  'Backlog Opacity (%)': 'バックログ不透明度 (%)',
  'Author Rate Limit': '投稿者レート制限',
  Language: '言語',
  'Duration Multiplier (×)': '表示時間倍率 (×)',
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
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'オーバーレイ既定色の代わりにYouTubeチャットの投稿者テキスト色を使用',
  'Keep top N% of video free of comments': '動画上部N%にコメントを表示しない',
  'Keep bottom N% of video free of comments': '動画下部N%にコメントを表示しない',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length':
    '最小文字数に関係なくすべてのメッセージを表示',
  'Short messages shown regardless of length': '長さに関係なく短いメッセージを表示',
  'Minimum character count': '最小文字数',
  'Opacity of past messages relative to real-time messages':
    'リアルタイムメッセージに対する過去メッセージの不透明度',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'モデレーターと所有者のメッセージを通常より長く表示する倍率 (1.0 = 同じ, 2.0 = 2倍)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'チャットメッセージをリアルタイムで翻訳します (Chrome 138+の内蔵翻訳が必要)',
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    '翻訳機能にはAI内蔵ブラウザが必要です。Chrome 138+またはEdge 143+ Canaryをお使いください。',
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

  // ── Modal chrome ──
  'Chat Overlay': 'チャットオーバーレイ',
  'Close settings': '設定を閉じる',
  'Settings categories': '設定カテゴリ',
  'Overlay Enabled': 'オーバーレイ有効',
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
  Color: '色',
  Show: '表示',
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
  'Author Colors & Visibility': 'Colores y visibilidad',

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
  'Outline Opacity (0–1)': 'Opacidad del contorno (0–1)',
  Opacity: 'Opacidad',
  'SuperChat Opacity (%)': 'Opacidad SuperChat (%)',
  'SuperChat Max Lines': 'Líneas máx. SuperChat',
  'Membership Max Lines': 'Líneas máx. membresía',
  'Preserve User Colors': 'Conservar colores de usuario',
  'Top Clear Zone (%)': 'Margen superior (%)',
  'Bottom Clear Zone (%)': 'Margen inferior (%)',
  'Ignore Min Length': 'Ignorar long. mínima',
  'Min Length (chars)': 'Longitud mínima (caracteres)',
  'Backlog Mode': 'Modo de historial',
  'Backlog Opacity (%)': 'Opacidad historial (%)',
  'Author Rate Limit': 'Límite por autor',
  Language: 'Idioma',
  'Duration Multiplier (×)': 'Multiplicador de duración (×)',
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
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'Usar el color de texto del autor en lugar del predeterminado',
  'Keep top N% of video free of comments': 'Mantener el N% superior del video sin comentarios',
  'Keep bottom N% of video free of comments': 'Mantener el N% inferior del video sin comentarios',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length':
    'Mostrar todos los mensajes sin importar la longitud mínima',
  'Short messages shown regardless of length': 'Mensajes cortos mostrados sin importar la longitud',
  'Minimum character count': 'Cantidad mínima de caracteres',
  'Opacity of past messages relative to real-time messages':
    'Opacidad de mensajes pasados respecto a los actuales',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'Cuánto más tiempo permanecen visibles los mensajes de moderador y propietario (1.0 = igual, 2.0 = el doble)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'Traduce mensajes de chat en tiempo real (requiere Chrome 138+ con traducción integrada)',
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    'La traducción requiere un navegador con IA integrada. Use Chrome 138+ o Edge 143+ Canary.',
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

  // ── Modal chrome ──
  'Chat Overlay': 'Superposición de Chat',
  'Close settings': 'Cerrar configuración',
  'Settings categories': 'Categorías',
  'Overlay Enabled': 'Superposición activada',
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
  Color: 'Color',
  Show: 'Mostrar',
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
  'Author Colors & Visibility': '用户颜色与显示',

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
  'Outline Opacity (0–1)': '描边不透明度 (0–1)',
  Opacity: '不透明度',
  'SuperChat Opacity (%)': '超级留言不透明度 (%)',
  'SuperChat Max Lines': '超级留言最大行数',
  'Membership Max Lines': '会员消息最大行数',
  'Preserve User Colors': '保留用户颜色',
  'Top Clear Zone (%)': '顶部留白 (%)',
  'Bottom Clear Zone (%)': '底部留白 (%)',
  'Ignore Min Length': '忽略最小长度',
  'Min Length (chars)': '最小长度 (字符)',
  'Backlog Mode': '回放模式',
  'Backlog Opacity (%)': '回放不透明度 (%)',
  'Author Rate Limit': '用户频率限制',
  Language: '语言',
  'Duration Multiplier (×)': '显示时长倍率 (×)',
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
  'Keep top N% of video free of comments': '视频顶部N%区域不显示弹幕',
  'Keep bottom N% of video free of comments': '视频底部N%区域不显示弹幕',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'Show all messages regardless of minimum character length': '无论最小字符数如何，显示所有消息',
  'Short messages shown regardless of length': '无论长度如何都显示短消息',
  'Minimum character count': '最小字符数',
  'Opacity of past messages relative to real-time messages': '历史消息相对于实时消息的不透明度',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    '版主和频道主的消息比普通消息多显示多长时间 (1.0 = 相同, 2.0 = 两倍)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    '实时翻译聊天消息 (需要 Chrome 138+ 内置翻译)',
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    '翻译功能需要内置AI的浏览器。请使用 Chrome 138+ 或 Edge 143+ Canary。',
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

  // ── Modal chrome ──
  'Chat Overlay': '弹幕显示',
  'Close settings': '关闭设置',
  'Settings categories': '设置分类',
  'Overlay Enabled': '已启用覆盖层',
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
  Color: '颜色',
  Show: '显示',
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
