// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const JA: Record<string, string> = {
  // ── Pane tabs ──
  Comments: 'コメント',
  Appearance: 'カードと色',
  Advanced: '詳細',
  Translation: '翻訳',

  // ── Aria labels / misc ──
  'Live chat overlay': 'Live chat overlay',
  'Interface language changed to': 'インターフェース言語が変更されました: ',

  // ── Section titles ──
  Cards: 'カード',
  'Text Outline': 'テキスト縁取り',
  'Safe Zone': '安全領域',
  'Message Rate': 'メッセージ頻度',
  'Depth Layers': '深度レイヤー',
  Backlog: 'バックログ',
  Timing: 'タイミング',
  Cache: 'キャッシュ',
  'Burst Detection': 'バースト検出',
  Tuning: 'チューニング',
  'Author Colors & Visibility': '投稿者の色と表示',
  Interface: 'インターフェース',
  'Chat Translation': 'チャット翻訳',
  'Translation backend service for processing messages':
    'メッセージ処理用の翻訳バックエンドサービス',

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
  العربية: 'アラビア語',
  'Duration Multiplier (×)': '表示時間倍率 (×)',
  'Exit Padding (px)': '終了余白 (px)',
  'Min Scroll Duration (ms)': '最小スクロール時間 (ms)',
  'Max Scroll Duration (ms)': '最大スクロール時間 (ms)',
  'Top/Bottom Duration (ms)': '上部/下部表示時間 (ms)',
  'Max Queue Depth': 'キュー最大サイズ',
  'Tab Trim Target': 'バックグラウンドキュー最大',
  'Max Message Age (ms)': '最大メッセージ寿命 (ms)',
  'Message Spacing (%)': 'メッセージ間隔 (%)',
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
  'Auto-detect': '自動検出',
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
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    '受信チャットメッセージの言語。自動検出はChrome内蔵の言語検出を使用します。',
  'Language to translate chat messages into. Auto detects from browser settings.':
    'チャットメッセージの翻訳先言語。自動はブラウザ設定から検出します。',
  'Limits how frequently messages from the same author appear':
    '同じ投稿者のメッセージ表示頻度を制限',
  'Sets the overlay user interface language (does not filter comments by language)':
    'オーバーレイUIの言語を設定します(コメントの言語フィルターではありません)',

  // ── New Performance / Developer section titles ──
  Performance: 'パフォーマンス',
  Developer: '開発者',

  // ── New field labels ──
  'Max Concurrent Messages': '最大メッセージ数',
  'Fade Duration (ms)': 'フェード時間 (ms)',
  'Min Poll Interval (ms)': '最小ポーリング間隔 (ms)',
  'Max Poll Interval (ms)': '最大ポーリング間隔 (ms)',
  'Max Injection Rate (msg/s)': '最大速度 (msg/s)',
  'Backlog Speed (×)': '速度倍率',
  'Recent Window (min)': '時間枠 (分)',
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
  'Backlog Injection Rate Min (msg/s)': '最小バックログ注入レート',
  'Speed Boost Max': '最大スピードブースト',
  'Speed Boost Denominator': 'スピードブースト分母',
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
  'Reload overlay': 'オーバレイを再読み込み',

  // ── Author grid ──
  Color: '色',
  'Name Color': '名前の色',
  Show: '表示',
  'Show Name': '名前を表示',
  Normal: '一般',
  Member: 'メンバー',
  Moderator: 'モデレーター',
  Owner: '所有者',
  Verified: '認証済み',
  SuperChat: 'スパーチャット',
  'Loading chat history...': 'チャット履歴を読み込み中...',
  'Short messages shown regardless of length': '長さに関係なく短いメッセージを表示',

  // ── Toast / sync messages ──

  // ── Status bar messages ──
  'Connecting\u2026': '接続中\u2026',
  'Connection unstable': '接続が不安定です',
  'Disconnected \u2014 Click to reload': '切断されました \u2014 クリックして再読み込み',
  'Waiting for live stream\u2026': 'ライブ配信を待機中\u2026',

  // ── Translation unsupported ──
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    '翻訳機能には内蔵AIが必要です。Chrome 138+またはEdge 143+ Canaryをご利用ください。',
};
