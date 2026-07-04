// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export const KO: Record<string, string> = {
  // ── Pane tabs ──
  Comments: '코멘트',
  Appearance: '카드 및 색상',
  Advanced: '고급',
  Translation: '번역',

  // ── Aria labels / misc ──
  'Live chat overlay': 'Live chat overlay',
  'Interface language changed to': '인터페이스 언어가 변경되었습니다: ',

  // ── Section titles ──
  Cards: '카드',
  'Text Outline': '텍스트 외곽선',
  'Safe Zone': '안전 영역',
  'Message Rate': '메시지 빈도',
  'Depth Layers': '깊이 레이어',
  Font: '글꼴',
  Backlog: '백로그',
  Timing: '타이밍',
  Tuning: '튜닝',
  'Burst Detection': '버스트 감지',
  Cache: '캐시',
  'Author Colors & Visibility': '작성자 색상 및 표시',
  Interface: '인터페이스',
  'Chat Translation': '채팅 번역',
  'Translation backend service for processing messages': '메시지 처리를 위한 번역 백엔드 서비스',

  // ── Field labels ──
  'Author Rate Limit': '작성자 빈도 제한',
  'Backlog Mode': '백로그 모드',
  'Backlog Opacity (%)': '백로그 불투명도 (%)',
  Bold: '볼드',
  'Bottom Clear Zone (%)': '하단 여백 (%)',
  'Custom font stack…': '사용자 지정 글꼴…',
  'Danmaku Mode': '단마쿠 모드',
  Enabled: '활성화',
  Family: '글꼴',
  'Ignore Min Length': '최소 길이 무시',
  'Lane Gap (px)': '레인 간격 (px)',
  Language: '언어',
  'Membership Max Lines': '멤버십 최대 줄 수',
  'Min Length (chars)': '최소 길이 (글자)',
  'Outline Opacity (%)': '외곽선 불투명도 (%)',
  'Outline Width (px)': '외곽선 두께 (px)',
  'Preserve User Colors': '사용자 색상 유지',
  Regular: '보통',
  'Scroll Speed (px/s)': '스크롤 속도 (px/s)',
  'Show SuperChat Amount': '슈퍼챗 금액 표시',
  'Size (px)': '크기 (px)',
  'SuperChat Max Lines': '슈퍼챗 최대 줄 수',
  'SuperChat Opacity (%)': '슈퍼챗 불투명도 (%)',
  'Text Opacity (%)': '텍스트 불투명도 (%)',
  'Top Clear Zone (%)': '상단 여백 (%)',
  Weight: '두께',
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
  'Max Queue Depth': '큐 최대 크기',
  'Tab Trim Target': '백그라운드 큐 최대',
  'Max Message Age (ms)': '최대 메시지 수명 (ms)',
  'Message Spacing (%)': '메시지 간격 (%)',
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
  'Playback-based (recommended)': '재생 기반 (권장)',
  'Recent only': '최근만',
  'Full (show all)': '전체 (모두 표시)',
  'None (skip backlog)': '없음 (백로그 건너뛰기)',
  Off: '끄기',
  'Normal (5 msg / 5s)': '보통 (5개 / 5초)',
  'Strict (2 msg / 5s)': '엄격 (2개 / 5초)',
  'Auto (Browser)': '자동 (브라우저)',
  'Auto-detect': '자동 감지',
  'Auto (Chrome built-in)': '자동 (Chrome 내장)',
  'Dual (original + translation)': '이중 표시 (원문 + 번역)',
  'Replace (translation only)': '번역만 표시',

  // ── Tooltips ──
  'Vertical gap between comment rows (negative = overlap)': '댓글 행 사이 간격 (음수 = 겹침)',
  'CSS font-family value. Type to filter suggestions, or enter a custom font stack.':
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
  "Language of the incoming chat messages. Auto-detect uses Chrome's built-in language detection.":
    '수신 채팅 메시지의 언어입니다. 자동 감지는 Chrome 내장 언어 감지를 사용합니다.',
  'Language to translate chat messages into. Auto detects from browser settings.':
    '채팅 메시지를 번역할 대상 언어. 자동은 브라우저 설정에서 감지합니다.',
  'Limits how frequently messages from the same author appear':
    '동일 작성자의 메시지 표시 빈도를 제한',
  'Sets the overlay user interface language (does not filter comments by language)':
    '오버레이 UI 언어를 설정합니다 (댓글 언어 필터 아님)',

  // ── New Performance / Developer section titles ──
  Performance: '성능',
  Developer: '개발자',

  // ── New field labels ──
  'Max Concurrent Messages': '최대 메시지 수',
  'Fade Duration (ms)': '페이드 시간 (ms)',
  'Min Poll Interval (ms)': '최소 폴링 간격 (ms)',
  'Max Poll Interval (ms)': '최대 폴링 간격 (ms)',
  'Max Injection Rate (msg/s)': '최대 속도 (msg/s)',
  'Backlog Speed (×)': '속도 배율',
  'Recent Window (min)': '시간 창 (분)',
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
  'Bold is more readable, Regular uses less GPU memory':
    '볼드는 더 읽기 쉽고, 보통은 GPU 메모리를 적게 사용합니다',
  'Font family for comment text': '댓글 텍스트 글꼴',
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
  'Backlog Injection Rate Min (msg/s)': '최소 백로그 주입 속도',
  'Speed Boost Max': '최대 속도 부스트',
  'Speed Boost Denominator': '속도 부스트 분모',
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
  'Reload overlay': '오버레이 새로고침',

  // ── Author grid ──
  Color: '색상',
  'Name Color': '이름 색상',
  Show: '표시',
  'Show Name': '이름 표시',
  Normal: '일반',
  Member: '멤버',
  Moderator: '관리자',
  Owner: '소유자',
  Verified: '인증됨',
  SuperChat: '슈퍼챗',
  'Loading chat history...': '채팅 기록을 불러오는 중...',
  'Short messages shown regardless of length': '길이에 관계없이 짧은 메시지 표시',

  // ── Toast / sync messages ──

  // ── Translation unsupported ──
  'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.':
    '번역 기능을 사용하려면 내장 AI가 있는 브라우저가 필요합니다. Chrome 138+ 또는 Edge 143+ Canary를 사용하세요.',
};
