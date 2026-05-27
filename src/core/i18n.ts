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
  Colors: '색상',
  Advanced: '고급',
  Translation: '번역',

  // ── Section titles ──
  'Text Outline': '텍스트 외곽선',
  'Safe Zone': '안전 영역',
  'Message Rate': '메시지 빈도',
  'Moderator & Owner': '관리자 & 소유자',
  Backlog: '백로그',
  'Rate Limiting': '속도 제한',
  'Author Colors & Visibility': '작성자 색상 및 표시',

  // ── Field labels ──
  'Danmaku Mode': '단마쿠 모드',
  'Font Size (px)': '글자 크기 (px)',
  'Text Opacity': '텍스트 불투명도',
  'Scroll Speed (px/s)': '스크롤 속도 (px/s)',
  'Lane Gap (px)': '레인 간격 (px)',
  'Font Weight': '글자 두께',
  'Font Family': '글꼴',
  Enabled: '활성화',
  'Width (px)': '두께 (px)',
  Opacity: '불투명도',
  'SuperChat Opacity (%)': '슈퍼챗 불투명도 (%)',
  'SuperChat Max Lines': '슈퍼챗 최대 줄 수',
  'Membership Max Lines': '멤버십 최대 줄 수',
  'Preserve User Colors': '사용자 색상 유지',
  'Top Clear Zone (%)': '상단 여백 (%)',
  'Bottom Clear Zone (%)': '하단 여백 (%)',
  'Show Short Messages': '짧은 메시지 표시',
  'Min Length (chars)': '최소 길이 (글자)',
  'Backlog Mode': '백로그 모드',
  'Backlog Opacity (%)': '백로그 불투명도 (%)',
  'Author Rate Limit': '작성자 빈도 제한',
  Language: '언어',
  'Duration Multiplier (×)': '표시 시간 배율 (×)',
  'Enable Translation': '번역 활성화',
  Service: '서비스',
  'Target Language': '대상 언어',
  'Display Mode': '표시 방식',

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
  'Show messages shorter than Min Length': '최소 길이보다 짧은 메시지 표시',
  'Minimum character count': '최소 글자 수',
  'Opacity of past messages relative to real-time messages':
    '실시간 메시지 대비 과거 메시지의 불투명도',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    '관리자와 소유자의 메시지가 일반 메시지보다 얼마나 오래 표시될지 설정합니다 (1.0 = 동일, 2.0 = 2배)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    '실시간으로 채팅 메시지를 번역합니다 (Chrome 138+ 내장 번역 필요)',

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
  Colors: '色',
  Advanced: '詳細',
  Translation: '翻訳',

  // ── Section titles ──
  'Text Outline': 'テキスト縁取り',
  'Safe Zone': '安全領域',
  'Message Rate': 'メッセージ頻度',
  'Moderator & Owner': 'モデレーター & 所有者',
  Backlog: 'バックログ',
  'Rate Limiting': 'レート制限',
  'Author Colors & Visibility': '投稿者の色と表示',

  // ── Field labels ──
  'Danmaku Mode': '弾幕モード',
  'Font Size (px)': 'フォントサイズ (px)',
  'Text Opacity': 'テキスト不透明度',
  'Scroll Speed (px/s)': 'スクロール速度 (px/s)',
  'Lane Gap (px)': 'レーン間隔 (px)',
  'Font Weight': 'フォントの太さ',
  'Font Family': 'フォント',
  Enabled: '有効',
  'Width (px)': '太さ (px)',
  Opacity: '不透明度',
  'SuperChat Opacity (%)': 'スパーチャット不透明度 (%)',
  'SuperChat Max Lines': 'スパーチャット最大行数',
  'Membership Max Lines': 'メンバーシップ最大行数',
  'Preserve User Colors': 'ユーザー色を保持',
  'Top Clear Zone (%)': '上部余白 (%)',
  'Bottom Clear Zone (%)': '下部余白 (%)',
  'Show Short Messages': '短いメッセージを表示',
  'Min Length (chars)': '最小文字数',
  'Backlog Mode': 'バックログモード',
  'Backlog Opacity (%)': 'バックログ不透明度 (%)',
  'Author Rate Limit': '投稿者レート制限',
  Language: '言語',
  'Duration Multiplier (×)': '表示時間倍率 (×)',
  'Enable Translation': '翻訳を有効にする',
  Service: 'サービス',
  'Target Language': '対象言語',
  'Display Mode': '表示モード',

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
  'Show messages shorter than Min Length': '最小文字数より短いメッセージを表示',
  'Minimum character count': '最小文字数',
  'Opacity of past messages relative to real-time messages':
    'リアルタイムメッセージに対する過去メッセージの不透明度',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'モデレーターと所有者のメッセージを通常より長く表示する倍率 (1.0 = 同じ, 2.0 = 2倍)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'チャットメッセージをリアルタイムで翻訳します (Chrome 138+の内蔵翻訳が必要)',

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
  Colors: 'Colores',
  Advanced: 'Avanzado',
  Translation: 'Traducción',

  // ── Section titles ──
  'Text Outline': 'Contorno de texto',
  'Safe Zone': 'Zona segura',
  'Message Rate': 'Frecuencia de mensajes',
  'Moderator & Owner': 'Moderador y Propietario',
  Backlog: 'Historial',
  'Rate Limiting': 'Límite de frecuencia',
  'Author Colors & Visibility': 'Colores y visibilidad',

  // ── Field labels ──
  'Danmaku Mode': 'Modo Danmaku',
  'Font Size (px)': 'Tamaño de fuente (px)',
  'Text Opacity': 'Opacidad del texto',
  'Scroll Speed (px/s)': 'Velocidad (px/s)',
  'Lane Gap (px)': 'Espacio entre líneas (px)',
  'Font Weight': 'Peso de fuente',
  'Font Family': 'Familia tipográfica',
  Enabled: 'Activado',
  'Width (px)': 'Ancho (px)',
  Opacity: 'Opacidad',
  'SuperChat Opacity (%)': 'Opacidad SuperChat (%)',
  'SuperChat Max Lines': 'Líneas máx. SuperChat',
  'Membership Max Lines': 'Líneas máx. membresía',
  'Preserve User Colors': 'Conservar colores de usuario',
  'Top Clear Zone (%)': 'Margen superior (%)',
  'Bottom Clear Zone (%)': 'Margen inferior (%)',
  'Show Short Messages': 'Mostrar mensajes cortos',
  'Min Length (chars)': 'Longitud mínima (caracteres)',
  'Backlog Mode': 'Modo de historial',
  'Backlog Opacity (%)': 'Opacidad historial (%)',
  'Author Rate Limit': 'Límite por autor',
  Language: 'Idioma',
  'Duration Multiplier (×)': 'Multiplicador de duración (×)',
  'Enable Translation': 'Activar traducción',
  Service: 'Servicio',
  'Target Language': 'Idioma de destino',
  'Display Mode': 'Modo de visualización',

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
  'Show messages shorter than Min Length': 'Mostrar mensajes más cortos que la longitud mínima',
  'Minimum character count': 'Cantidad mínima de caracteres',
  'Opacity of past messages relative to real-time messages':
    'Opacidad de mensajes pasados respecto a los actuales',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    'Cuánto más tiempo permanecen visibles los mensajes de moderador y propietario (1.0 = igual, 2.0 = el doble)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    'Traduce mensajes de chat en tiempo real (requiere Chrome 138+ con traducción integrada)',

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
  Colors: '颜色',
  Advanced: '高级',
  Translation: '翻译',

  // ── Section titles ──
  'Text Outline': '文字描边',
  'Safe Zone': '安全区域',
  'Message Rate': '消息频率',
  'Moderator & Owner': '版主与频道主',
  Backlog: '回放',
  'Rate Limiting': '频率限制',
  'Author Colors & Visibility': '用户颜色与显示',

  // ── Field labels ──
  'Danmaku Mode': '弹幕模式',
  'Font Size (px)': '字体大小 (px)',
  'Text Opacity': '文字不透明度',
  'Scroll Speed (px/s)': '滚动速度 (px/s)',
  'Lane Gap (px)': '行间距 (px)',
  'Font Weight': '字体粗细',
  'Font Family': '字体',
  Enabled: '启用',
  'Width (px)': '宽度 (px)',
  Opacity: '不透明度',
  'SuperChat Opacity (%)': '超级留言不透明度 (%)',
  'SuperChat Max Lines': '超级留言最大行数',
  'Membership Max Lines': '会员消息最大行数',
  'Preserve User Colors': '保留用户颜色',
  'Top Clear Zone (%)': '顶部留白 (%)',
  'Bottom Clear Zone (%)': '底部留白 (%)',
  'Show Short Messages': '显示短消息',
  'Min Length (chars)': '最小长度 (字符)',
  'Backlog Mode': '回放模式',
  'Backlog Opacity (%)': '回放不透明度 (%)',
  'Author Rate Limit': '用户频率限制',
  Language: '语言',
  'Duration Multiplier (×)': '显示时长倍率 (×)',
  'Enable Translation': '启用翻译',
  Service: '服务',
  'Target Language': '目标语言',
  'Display Mode': '显示模式',

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
  'Show messages shorter than Min Length': '显示短于最小长度的消息',
  'Minimum character count': '最小字符数',
  'Opacity of past messages relative to real-time messages': '历史消息相对于实时消息的不透明度',
  'How much longer moderator and owner messages stay visible (1.0 = same as regular, 2.0 = twice as long)':
    '版主和频道主的消息比普通消息多显示多长时间 (1.0 = 相同, 2.0 = 两倍)',
  'Translate chat messages in real-time (requires Chrome 138+ for built-in translation)':
    '实时翻译聊天消息 (需要 Chrome 138+ 内置翻译)',

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
