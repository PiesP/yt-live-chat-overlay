// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const JA: Record<string, string> = {
  // ── Pane tabs ──
  Comments: 'コメント',
  Appearance: 'カードと色',
  Advanced: '詳細',
  Translation: '翻訳',

  // ── Aria labels / misc ──
  'app.name': 'ライブチャットオーバーレイ',
  Paused: '一時停止',
  'app.langChanged': 'インターフェース言語が変更されました: ',

  // ── Canvas connection status ──
  'status.connecting': '接続中…',
  'status.unstable': '接続が不安定です',
  'status.disconnected': '切断されました — クリックして再読み込み',
  'status.waiting': 'ライブストリームを待機中…',

  // ── Section titles ──
  Cards: 'カード',
  'appearance.outline': 'テキスト縁取り',
  'danmaku.safeZone': '安全領域',
  'advanced.messageRate': 'メッセージ頻度',
  'advanced.depthLayers': '深度レイヤー',
  Font: 'フォント',
  Backlog: 'バックログ',
  Timing: 'タイミング',
  Cache: 'キャッシュ',
  'advanced.burst': 'バースト検出',
  Tuning: 'チューニング',
  'appearance.authors': '投稿者の色と表示',
  Interface: 'インターフェース',
  'translation.chat': 'チャット翻訳',
  'translation.serviceDesc': 'メッセージ処理用の翻訳バックエンドサービス',

  // ── Field labels ──
  'advanced.authorRateLimit': '投稿者レート制限',
  'advanced.backlogMode': 'バックログモード',
  'advanced.backlogOpacity': 'バックログ不透明度 (%)',
  Bold: 'ボールド',
  'danmaku.bottomClearZone': '下部余白 (%)',
  'danmaku.fontCustom': 'カスタムフォント…',
  'danmaku.mode': '弾幕モード',
  Enabled: '有効',
  Family: 'ファミリー',
  'advanced.ignoreMinLength': '最小文字数を無視',
  'danmaku.laneGap': 'レーン間隔 (px)',
  Language: '言語',
  'appearance.membershipMaxLines': 'メンバーシップ最大行数',
  'advanced.minLength': '最小文字数',
  'appearance.outlineOpacity': '縁取り不透明度 (%)',
  'appearance.outlineWidth': '縁取りの太さ (px)',
  'appearance.preserveUserColors': 'ユーザー色を保持',
  Regular: 'レギュラー',
  'danmaku.scrollSpeed': 'スクロール速度 (px/s)',
  'appearance.showSuperchatAmount': 'スパーチャット金額表示',
  'danmaku.fontSize': 'サイズ (px)',
  'appearance.superchatMaxLines': 'スパーチャット最大行数',
  'appearance.superchatOpacity': 'スパーチャット不透明度 (%)',
  'danmaku.textOpacity': 'テキスト不透明度 (%)',
  'danmaku.topClearZone': '上部余白 (%)',
  Weight: '太さ',
  // ── Language names ──
  English: '英語',
  한국어: '韓国語',
  日本語: '日本語',
  Español: 'スペイン語',
  中文: '中国語',
  العربية: 'アラビア語',
  'danmaku.durationMul': '表示時間倍率 (×)',
  'danmaku.exitPadding': '終了余白 (px)',
  'danmaku.minScrollDuration': '最小スクロール時間 (ms)',
  'danmaku.maxScrollDuration': '最大スクロール時間 (ms)',
  'danmaku.topBottomDuration': '上部/下部表示時間 (ms)',
  'advanced.maxQueueDepth': 'キュー最大サイズ',
  'advanced.tabTrimTarget': 'バックグラウンドキュー最大',
  'advanced.maxMessageAge': '最大メッセージ寿命 (ms)',
  'danmaku.messageSpacing': 'メッセージ間隔 (%)',
  'danmaku.exitPaddingDesc':
    'メッセージが画面端を通過して削除されるまでの追加ピクセル (20-400, デフォルト 100)',
  'danmaku.minScrollDurationDesc':
    '最小スクロールアニメーション時間 — 短いメッセージが速すぎるのを防ぐ (1000-15000ms, デフォルト 5000)',
  'danmaku.maxScrollDurationDesc':
    '最大スクロールアニメーション時間 — 長いメッセージが遅すぎるのを防ぐ (5-120秒, デフォルト 30000ms)',
  'danmaku.topBottomDurationDesc':
    '上部/下部モードメッセージの固定表示時間 (1000-30000ms, デフォルト 4000)',
  'advanced.maxQueueDepthDesc':
    'メッセージがドロップされる前の最大待機キュー深度 (50-1000, デフォルト 200)',
  'advanced.tabTrimTargetDesc':
    'バックグラウンドタブ整理時の目標アクティブメッセージ数 (10-500, デフォルト 50)',
  'advanced.maxMessageAgeDesc':
    'フェードアウト除去前の最大メッセージ寿命 (10-300秒, デフォルト 60000ms)',
  'danmaku.messageSpacingDesc':
    '連続メッセージ間の間隔（メッセージ幅のパーセント） (2-30%, デフォルト 8)',
  'translation.enable': '翻訳を有効にする',
  Service: 'サービス',
  'translation.source': 'ソース言語',
  'translation.target': '対象言語',
  'translation.displayMode': '表示モード',
  'advanced.depthNearSpeed': '近接速度 (%)',
  'advanced.depthFarSpeed': '遠方速度 (%)',
  'advanced.depthFarOpacity': '遠方不透明度 (%)',

  // ── Select options ──
  'danmaku.scroll': 'スクロール (右→左)',
  'danmaku.reverse': '逆方向 (左→右)',
  'danmaku.top': '上部固定',
  'danmaku.bottom': '下部固定',
  'advanced.backlogPlayback': '再生ベース (推奨)',
  'advanced.backlogRecent': '最近のみ',
  'advanced.backlogFull': 'すべて表示',
  'advanced.backlogNone': 'なし (スキップ)',
  Off: 'オフ',
  'advanced.authorRateLimitNormal': '標準 (5件 / 5秒)',
  'advanced.authorRateLimitStrict': '厳格 (2件 / 5秒)',
  'translation.languageAuto': '自動 (ブラウザ)',
  'translation.sourceAuto': '自動検出',
  'translation.serviceAuto': '自動 (Chrome内蔵)',
  'translation.displayModeDual': '二重表示 (原文 + 翻訳)',
  'translation.displayModeReplace': '翻訳のみ表示',

  // ── Tooltips ──
  'danmaku.laneGapDesc': 'コメント行の間隔 (0 = 行が隣接)',
  'danmaku.fontWeightDesc': 'ボールドはより読みやすく、レギュラーはGPUメモリ消費が少なくなります',
  'danmaku.fontFamilyDesc': 'コメントテキストのフォント',
  'danmaku.fontCustomDesc':
    'CSS font-family 値。例: "Noto Sans KR", sans-serif。フォントがなければシステム既定値。',
  'appearance.superchatOpacityDesc': 'スパーチャットカードの背景不透明度',
  'appearance.superchatMaxLinesDesc': '本文の最大行数、超過分は省略 (2-10)',
  'appearance.membershipMaxLinesDesc': 'メンバーシップメッセージの本文最大行数 (1-5)',
  'appearance.showSuperchatAmountDesc': 'スパーチャットカードに購入金額バッジを表示します',
  "Use author's chosen text color from YouTube chat instead of overlay defaults":
    'オーバーレイ既定色の代わりにYouTubeチャットの投稿者テキスト色を使用',
  'danmaku.topClearZoneDesc': '動画上部N%にコメントを表示しない',
  'danmaku.bottomClearZoneDesc': '動画下部N%にコメントを表示しない',
  // Legacy key removed (replaced by 'Show all messages regardless of minimum character length')
  'advanced.ignoreMinLengthDesc': '最小文字数に関係なくすべてのメッセージを表示',
  'advanced.minLengthDesc': '最小文字数',
  'advanced.backlogOpacityDesc': 'リアルタイムメッセージに対する過去メッセージの不透明度',
  'danmaku.durationMulDesc':
    'モデレーターと所有者のメッセージを通常より長く表示する倍率 (1.0 = 同じ, 2.0 = 2倍)',
  'translation.enableDesc':
    'チャットメッセージをリアルタイムで翻訳します (Chrome 138+の内蔵翻訳が必要)',
  'advanced.depthLayersDesc':
    '速度ベースの遠近感: 速いメッセージは近く、遅いメッセージは遠くに表示',
  'advanced.depthNearSpeedDesc': '近接レイヤーメッセージの速度ブースト',
  'advanced.depthFarSpeedDesc': '遠方レイヤーメッセージの速度低下',
  'advanced.depthFarOpacityDesc': '遠方レイヤーメッセージの不透明度減衰',
  'danmaku.scrollSpeedDesc': 'コメントが画面を横切る速度(ピクセル/秒)',
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    '受信チャットメッセージの言語。自動検出はChrome内蔵の言語検出を使用します。',
  'translation.sourceDesc': 'チャットメッセージの翻訳先言語。自動はブラウザ設定から検出します。',
  'advanced.authorRateLimitDesc': '同じ投稿者のメッセージ表示頻度を制限',
  'translation.languageDesc':
    'オーバーレイUIの言語を設定します(コメントの言語フィルターではありません)',

  // ── New Performance / Developer section titles ──
  Performance: 'パフォーマンス',
  Developer: '開発者',

  // ── New field labels ──
  'advanced.maxConcurrent': '最大メッセージ数',
  'advanced.fadeDuration': 'フェード時間 (ms)',
  'advanced.minPollInterval': '最小ポーリング間隔 (ms)',
  'advanced.maxPollInterval': '最大ポーリング間隔 (ms)',
  'advanced.backlogInjectionRate': '最大速度 (msg/s)',
  'advanced.backlogSpeed': '速度倍率',
  'advanced.backlogRecentWindow': '時間枠 (分)',
  'advanced.logLevel': 'ログレベル',
  'advanced.debugOverlay': 'デバッグオーバーレイ',

  // ── New select options ──
  'advanced.logLevelWarn': '警告のみ',
  Info: '情報',
  'advanced.logLevelDebug': 'デバッグ (詳細)',

  // ── New tooltips ──
  'advanced.maxConcurrentDesc': '画面上に同時に表示できる最大メッセージ数 (30-300)',
  'advanced.fadeDurationDesc': 'メッセージのフェードアウト時間 (0 = 即時, 50-1000)',
  'advanced.minPollIntervalDesc': 'チャットポーリングの最小間隔 (ミリ秒, 50-5000)',
  'advanced.maxPollIntervalDesc': 'チャットポーリングの最大間隔 (ミリ秒, 1000-30000)',
  'advanced.backlogInjectionRateDesc': '1秒あたりのバックログメッセージ注入最大速度 (0-50)',
  'advanced.backlogSpeedDesc': 'バックログメッセージのアニメーション速度倍率 (1-5)',
  'advanced.backlogRecentWindowDesc': '最近のみバックログモードの時間枠 (分, 1-30)',
  'advanced.logLevelDesc': 'コンソール診断出力の詳細度',
  'advanced.debugOverlayDesc': 'ビデオプレイヤーにパフォーマンスデバッグオーバーレイを表示',

  // ── New tooltips (added 2026-05-28) ──
  'danmaku.fontSizeDesc': 'ピクセル単位のテキストサイズ (14-50)',
  'appearance.outlineWidthDesc': 'テキスト縁取りの太さ (ピクセル, 0-8)',
  'appearance.outlineOpacityDesc': 'テキスト縁取りの不透明度 (0-100%)',

  // ── New tooltips (added 2026-05-29) ──
  'app.enabledDesc': 'YouTubeライブストリームでチャットオーバーレイをオン/オフします',
  'danmaku.modeDesc': 'コメントの表示方向と動作',
  'danmaku.textOpacityDesc': 'コメントテキスト全体の不透明度 (50-100%)',
  'appearance.outlineEnabledDesc':
    '明るい背景でもテキストを読みやすくするために黒い縁取りを追加します',
  'advanced.backlogModeDesc': '過去のチャットメッセージをライブ再生に対してどう表示するか',
  'translation.displayModeDesc': '二重表示は原文の上に翻訳を、置換は翻訳のみ表示します',

  // ── New cache/performance field labels (added 2026-06-01) ──
  'advanced.emojiCache': '絵文字キャッシュ (MB)',
  'advanced.photoCache': '写真キャッシュ (MB)',
  'advanced.stickerCache': 'ステッカーキャッシュ (MB)',
  'advanced.textCache': 'テキストキャッシュ (MB)',
  'advanced.translationBatchSize': '翻訳バッチサイズ',
  'advanced.emojiFetchLimit': '絵文字取得制限',
  'advanced.emojiRetryMin': '失敗した絵文字の再試行 (分)',
  'advanced.emojiCacheDesc': '絵文字画像キャッシュの最大メモリ (1-20 MB, デフォルト 3)',
  'advanced.photoCacheDesc': '投稿者写真キャッシュの最大メモリ (1-20 MB, デフォルト 2)',
  'advanced.stickerCacheDesc': 'ステッカー画像キャッシュの最大メモリ (1-20 MB, デフォルト 1)',
  'advanced.textCacheDesc': 'テキストビットマップキャッシュの最大メモリ (1-20 MB, デフォルト 4)',
  'advanced.translationBatchSizeDesc': 'フレームごとの最大翻訳適用数 (1-20, デフォルト 5)',
  'advanced.emojiFetchLimitDesc': '最大同時絵文字取得数 (1-20, デフォルト 6)',
  'advanced.emojiRetryMinDesc': '失敗した絵文字の再試行までの待機時間 (1-60分, デフォルト 5)',

  // ── New threshold field labels (added 2026-06-01) ──
  'advanced.burstSampleWindow': 'バーストサンプルウィンドウ',
  'advanced.burstElevated': '上昇バースト (msg/s)',
  'advanced.burstHigh': '高バースト (msg/s)',
  'advanced.burstExtreme': '極端なバースト (msg/s)',
  'advanced.tuningBacklogInjectionMax': 'バックログ注入最大',
  'advanced.tuningDensityRamp': 'バックログ密度ランプ (ms)',
  'advanced.tuningPollFallback': 'ライブポーリングフォールバック (ms)',
  'advanced.tuningPollFailureLimit': 'ポーリング失敗制限',
  'advanced.tuningSpeedBoostThreshold': 'スピードブーストしきい値',
  'advanced.tuningBacklogPause': 'バックログ一時停止 (%)',
  'advanced.tuningBacklogResume': 'バックログ再開 (%)',
  'advanced.tuningActivityTimeout': 'アクティビティタイムアウト (ms)',

  // ── New threshold tooltips (added 2026-06-01) ──
  'advanced.burstSampleWindowDesc': 'バーストレートのサンプルウィンドウサイズ',
  'advanced.burstElevatedDesc': '上昇バーストレベルの1秒あたりのメッセージしきい値',
  'advanced.burstHighDesc': '高バーストレベルの1秒あたりのメッセージしきい値',
  'advanced.burstExtremeDesc': '極端なバーストレベルの1秒あたりのメッセージしきい値',
  'advanced.tuningBacklogInjectionMaxDesc': 'バックログ注入レートの最大上限',
  'advanced.tuningDensityRampDesc': 'バックログ注入の密度ランプ時間（ミリ秒）',
  'advanced.tuningPollFallbackDesc': 'ライブポールフォールバック遅延（ミリ秒）',
  'advanced.tuningPollFailureLimitDesc': 'サーキットブレーカー作動前の連続ポーリング失敗数',
  'advanced.tuningSpeedBoostThresholdDesc': 'スピードブーストをトリガーする保留メッセージ数',
  'advanced.tuningBacklogPauseDesc': 'バックログ注入を一時停止するレーン使用率',
  'advanced.tuningBacklogResumeDesc': 'バックログ注入を再開するレーン使用率',
  'advanced.tuningActivityTimeoutDesc': 'チャットアクティビティタイムアウト（ミリ秒）',

  // ── New stagger/tuning field labels (added 2026-06-01) ──
  'advanced.tuningStaggerMax': '最大スタッガー遅延 (ms)',
  'advanced.tuningStaggerMedium': '中スタッガー遅延 (ms)',
  'advanced.tuningEmojiTimeout': '絵文字取得タイムアウト (ms)',
  'advanced.tuningDensityRampMax': 'バックログ密度ランプ最大 (ms)',
  'advanced.tuningInjectionRateMin': '最小バックログ注入レート',
  'advanced.tuningSpeedBoostMax': '最大スピードブースト',
  'advanced.tuningSpeedBoostDenom': 'スピードブースト分母',
  'advanced.tuningToggleCooldown': 'バックログ切替クールダウン (ms)',
  'advanced.replayPrefetchPages': 'リプレイプリフェッチページ',
  'advanced.replayBatchLimit': 'リプレイバッチ制限',

  // ── New stagger/tuning tooltips (added 2026-06-01) ──
  'advanced.tuningStaggerMaxDesc': '同一バッチ内のメッセージの最大スタッガー遅延',
  'advanced.tuningStaggerMediumDesc': 'キューの深さが中程度のときのスタッガー遅延',
  'advanced.tuningEmojiTimeoutDesc': '絵文字取得操作のタイムアウト',
  'advanced.tuningDensityRampMaxDesc': 'バックログ注入の最大密度ランプ時間',
  'advanced.tuningInjectionRateMinDesc': '最小バックログ注入レート (msg/s)',
  'advanced.tuningSpeedBoostMaxDesc': 'バースト補償の最大スピードブースト係数',
  'advanced.tuningSpeedBoostDenomDesc': 'EMAレートスケーリングのスピードブースト分母',
  'advanced.tuningToggleCooldownDesc': 'バックログ一時停止切替間のクールダウン',
  'advanced.replayPrefetchPagesDesc': 'リプレイモードでプリフェッチする最大ページ数',
  'advanced.replayBatchLimitDesc': 'リプレイ初期化で取得する最大バッチ数',

  // ── Modal chrome ──
  'app.title': 'チャットオーバーレイ',
  'app.close': '設定を閉じる',
  'app.settingsCategories': '設定カテゴリ',
  'app.enabled': 'オーバーレイ有効',
  'format.valueAdjusted': '調整後の値: ',
  Reset: 'リセット',
  Export: 'エクスポート',
  Import: 'インポート',
  Close: '閉じる',
  Done: '完了',
  'app.autoSave': '変更は自動的に保存されます',
  'reset.confirm': 'すべての設定を初期値にリセットしますか？',
  Cancel: 'キャンセル',
  'import.invalidFormat': 'インポート失敗: 設定形式が無効です',
  'import.success': '設定を正常にインポートしました',
  'actions.export': 'エクスポート',
  'actions.import': 'インポート',
  'actions.reset': 'リセット',
  'import.invalidJson': 'インポート失敗: 無効なJSON形式です',
  'app.settings': 'チャットオーバーレイ設定',
  'reset.confirmDesc': 'オーバーレイ設定をリセット',
  'app.reload': 'オーバレイを再読み込み',

  // ── Author grid ──
  Color: '色',
  'appearance.authorsNameColor': '名前の色',
  Show: '表示',
  'appearance.authorsShowName': '名前を表示',
  Normal: '一般',
  Member: 'メンバー',
  Moderator: 'モデレーター',
  Owner: '所有者',
  Verified: '認証済み',
  SuperChat: 'スパーチャット',
  'indicator.loading': 'チャット履歴を読み込み中...',
  'format.shortMessagesShown': '長さに関係なく短いメッセージを表示',

  // ── Toast / sync messages ──

  // ── Translation unsupported ──
  'translation.unsupported':
    '翻訳機能には内蔵AIが必要です。Chrome 138+またはEdge 143+ Canaryをご利用ください。',

  // ── Added 2026-07-04 ──
  'chat.messages': 'チャットメッセージ',
  'advanced.ignoreReducedMotion': 'モーション低減を無視',
  'advanced.ignoreReducedMotionDesc':
    'OSのモーション低減設定が有効でもスクロールアニメーションを強制します（ページ再読み込みが必要）',
  'pane.comments': 'コメント',
  'pane.appearance': '外観',
  'pane.advanced': '詳細設定',
  'pane.translation': '翻訳',
  'appearance.cards': 'カード',
  'danmaku.font': 'フォント',
  'danmaku.timing': 'タイミング',
  'advanced.backlog': 'バックログ',
  'advanced.cache': 'キャッシュ',
  'advanced.tuning': 'チューニング',
  'advanced.developer': '開発者',
  'advanced.performance': 'パフォーマンス',
  'advanced.authorRateLimitOff': 'オフ',
  'appearance.authorsSuperchat': 'スーパーチャット',
  'translation.interface': 'インターフェース',
  'translation.service': 'サービス',
  'indicator.busy': 'チャット混雑',
  'indicator.heavy': 'チャット過多 — 一部省略',
  'indicator.overload': 'チャット過負荷 — スキップ中',
  'advanced.logLevelInfo': '情報',
  'app.cancel': 'キャンセル',
  'app.done': '完了',
  'translation.language': '言語',
  'appearance.outlineEnabled': '有効',
};
