// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const ZH_CN: Record<string, string> = {
  // ── Pane tabs ──
  Comments: '弹幕',
  Appearance: '卡片与颜色',
  Advanced: '高级',
  Translation: '翻译',

  // ── Aria labels / misc ──

  // ── Section titles ──
  'Text Outline': '文字描边',
  'Safe Zone': '安全区域',
  'Message Rate': '消息频率',
  'Depth Layers': '深度图层',
  Backlog: '回放',
  Timing: '时序',
  Tuning: '调优',
  'Burst Detection': '突发检测',
  Cache: '缓存',
  'Author Colors & Visibility': '用户颜色与显示',
  'Author colors and visibility': '用户颜色与显示',
  Interface: '界面',
  'Chat Translation': '聊天翻译',
  'Translation backend service for processing messages': '用于处理消息的翻译后端服务',

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
  العربية: '阿拉伯语',
  'Duration Multiplier (×)': '显示时长倍率 (×)',
  'Exit Padding (px)': '退出边距 (px)',
  'Min Scroll Duration (ms)': '最小滚动时间 (ms)',
  'Max Scroll Duration (ms)': '最大滚动时间 (ms)',
  'Top/Bottom Duration (ms)': '顶部/底部显示时间 (ms)',
  'Max Queue Depth': '队列最大容量',
  'Tab Trim Target': '后台队列最大容量',
  'Max Message Age (ms)': '最大消息寿命 (ms)',
  'Message Spacing (%)': '消息间距 (%)',
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
  'Auto-detect': '自动检测',
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
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    '传入聊天消息的语言。自动检测使用Chrome内置语言检测。',
  'Language to translate chat messages into. Auto detects from browser settings.':
    '将聊天消息翻译成的目标语言。自动从浏览器设置检测。',
  'Limits how frequently messages from the same author appear': '限制同一用户消息的显示频率',
  'Sets the overlay user interface language (does not filter comments by language)':
    '设置覆盖层界面语言（不按语言过滤弹幕）',

  // ── New Performance / Developer section titles ──
  Performance: '性能',
  Developer: '开发者',

  // ── New field labels ──
  'Max Concurrent Messages': '最大消息数',
  'Fade Duration (ms)': '淡出时间 (ms)',
  'Min Poll Interval (ms)': '最小轮询间隔 (ms)',
  'Max Poll Interval (ms)': '最大轮询间隔 (ms)',
  'Max Injection Rate (msg/s)': '最大速率 (msg/s)',
  'Backlog Speed (×)': '速度倍率',
  'Recent Window (min)': '时间窗口 (分)',
  'Log Level': '日志级别',
  'Debug Overlay': '调试叠加层',
  'Enable WebGL2': '启用 WebGL2',

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
  'Backlog Injection Rate Min (msg/s)': '最小回放注入速率',
  'Speed Boost Max': '最大速度提升',
  'Speed Boost Denominator': '速度提升分母',
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
  'WebGL2 Renderer': 'WebGL2渲染器',
  'Reload overlay': '重新加载覆盖层',

  // ── Author grid ──
  Color: '颜色',
  'Name Color': '名称颜色',
  Show: '显示',
  'Show Name': '显示名称',
  Normal: '普通',
  Member: '会员',
  Moderator: '版主',
  Owner: '频道主',
  Verified: '已认证',
  SuperChat: '超级留言',
  'Loading chat history...': '正在加载聊天记录...',
  'Short messages shown regardless of length': '显示短消息，无论长度如何',

  // ── Toast / sync messages ──
  'Settings updated from another tab': '已从其他标签页更新设置',
  'Settings exported successfully': '设置已导出成功',

  // ── Translation unsupported ──
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    '翻译功能需要内置 AI 的浏览器。请使用 Chrome 138+ 或 Edge 143+ Canary。',
};
