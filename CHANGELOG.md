# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0] - 2026-04-12

### Added
- **백그라운드 탭 처리 개선 (Page Visibility API)**
  - 탭이 숨겨질 때 렌더러를 자동 일시정지하여 브라우저 타이머 스로틀링으로 인한 복귀 시 메시지 폭발 방지
  - 탭 복귀 시 비디오 재생 중인 경우에만 렌더러를 재개 (일시정지 상태 인식)
- **채팅 MutationObserver 감시 및 재연결**
  - 15초 주기로 옵저버 생존 여부를 확인하는 감시 루프 추가
  - YouTube가 채팅 `#items` 컨테이너를 언마운트한 경우 옵저버를 자동으로 재연결
- **탐색(Seek) 시 메시지 큐 초기화**
  - 비디오 탐색 이벤트 발생 시 대기 중인 메시지 큐를 비워 탐색 후 구 메시지 표시 방지

### Fixed
- **메시지 큐 무한 증가 방지**
  - 대기 큐 최대 크기를 150개로 제한하고, 초과 시 오래된 항목부터 제거
- **애니메이션 취소 시 레인 누수 방지**
  - `finish` 이벤트와 함께 `cancel` 이벤트도 처리하여 외부에서 애니메이션이 중단될 때 `activeMessages`에서 요소가 정리되지 않던 문제 수정

### Changed
- **설정 UI 탭 기반 재설계**
  - 설정 항목을 Display / Style / Authors / Filter 4개 탭으로 분류
  - 항목명을 직관적으로 개선 (예: "Safe top/bottom" → "Top/Bottom Clear Zone", "Speed (px/s)" → "Scroll Speed (px/s)")
  - 탭 재진입 시 마지막 활성 탭 유지
  - 숨겨진 탭 패널의 입력 요소가 포커스 트랩에 포함되지 않도록 개선

## [0.7.2] - 2026-04-01

### Fixed
- **SPA 내비게이션 재시작 안정성 개선**
  - 내비게이션 재시작 시 settle 대기 중 URL이 다시 바뀌면 stale 재시작을 건너뛰도록 보호 로직 추가
  - `startChatSource()`에서 세대(`startGeneration`) 기반 가드와 소유권 검사(`this.chatSource !== chatSource`)를 적용해 비동기 시작 경합 중 이전 인스턴스가 메시지를 주입하거나 상태를 오염시키는 문제 방지
  - 채팅 소스 시작 실패 시 `this.chatSource` 참조를 명시적으로 정리해 cleanup/재시작 경로의 일관성 향상

### Dependencies
- 개발 의존성 조정: `@biomejs/biome`, `@biomejs/cli-linux-x64`를 `2.4.9`로 하향 조정

## [0.7.1] - 2026-03-31

### Fixed
- **코멘트 대각선 배치 패턴 수정**
  - `findLanePlacement` 알고리즘을 결정론적 순차 선택에서 랜덤 선택 방식으로 교체: 채팅 폭발 시 메시지가 항상 위→아래 순서(레인 0→1→2→...)로 배정되어 발생하던 대각선 계단 패턴 수정
  - 즉시 사용 가능한 레인이 여러 개일 때 전체 후보 풀에서 무작위 선택하여 화면 전체에 균일하게 분산
  - 레인 딜레이를 레인 인덱스에 비례하는 결정론적 값(`(index % 3) × 15ms`)에서 0–45ms 범위의 랜덤 지터로 교체하여 동시 진입 메시지의 시각적 정렬 패턴 제거

## [0.7.0] - 2026-03-31

### Changed
- **메시지 표시 밀도 향상**
  - 레인 높이 승수(`BASE_LANE_HEIGHT_MULTIPLIER`) 1.3 → 1.2로 축소해 약 8% 더 많은 레인 확보
  - 수평 안전 거리(`SAFE_DISTANCE_SCALE`) 0.5 → 0.3, 최소값 10px → 6px으로 줄여 레인 내 메시지를 더 촘촘하게 배치
  - 수직 클리어 타임 40–160ms → 20–80ms로 단축해 레인 재사용 속도 향상
  - 메시지 요소에 `line-height: 1.1` 명시 적용 — 모든 지원 폰트 크기(18–40px)에서 단일 라인 메시지가 정확히 1 레인에 수용되도록 보장
- **기본 설정 조정**
  - `safeTop` 기본값 0.1 → 0 (상단 안전 영역 제거, 비디오 최상단부터 표시)
  - `safeBottom` 기본값 0.15 → 0.4 (하단 40%를 빈 영역으로 유지, 플레이어 컨트롤 완전 보호)
  - `maxConcurrentMessages` 기본값 30 → 40 (추가된 레인 수에 맞게 상향)
  - `maxMessagesPerSecond` 기본값 4 → 6 (밀도 향상에 맞춰 처리율 상향)
  - `safeBottom` 설정 상한 0.25 → 0.5 (설정 UI에서 최대 50%까지 조정 가능)

### Refactored
- **공통 유틸리티 중복 제거**
  - `parseRgbColor()` 함수를 `design-tokens.ts`로 추출 — `renderer.ts`·`chat-source.ts`의 인라인 RGB 파싱 중복 제거
  - `findPlayerContainerElement()`·`ensurePlayerPositioning()`을 `dom.ts`로 이동 — `overlay.ts`·`settings-ui.ts`의 중복 구현 일원화
  - `PLAYER_CONTAINER_SELECTORS`를 `dom.ts`로 통합 — `video-sync.ts`가 독자적으로 정의하던 2개 선택자를 4개 선택자 공유 배열로 교체
  - `STORAGE_KEY`를 `settings.ts`에서 export하고 `logging.ts`의 중복 상수 제거
- **기타 코드 품질 개선**
  - `debugLogChatElements()` 호출을 `logLevel === 'debug'`일 때만 실행하도록 조건 추가
  - `main.ts` 필드명 `_renderer` → `renderer` 정리, 빈 `handleVideoSeeking` 핸들러 제거
  - `renderer.ts`의 `@ts-expect-error` 제거
  - `design-tokens.ts`에서 미사용 `animation` 토큰 제거

### Dependencies
- 개발 의존성 최신화: knip ^6.1.0, Biome, Vite, TypeScript, @types/node 등

## [0.6.0] - 2026-03-06

### Added
- **레인 간격 설정 추가**
  - `laneSpacing` 옵션을 도입해 메시지 레인 간 세로 간격을 조절할 수 있도록 개선
  - 설정 UI에서 레인 간격을 직접 조정할 수 있도록 입력 항목과 범위 제한을 추가

### Changed
- **코어 전반 리팩토링으로 일관성 및 유지보수성 향상**
  - `chat-source`, `overlay`, `page-watcher`, `renderer`, `settings`, `settings-ui`, `video-sync`, `main`의 책임 분리를 강화하고 중복 로직을 헬퍼/상수 중심으로 정리
  - 앱 초기화·재시작·cleanup 플로우를 표준화하여 SPA 이동과 비동기 재초기화 시나리오를 더 안정적으로 처리
  - `types/index.ts`, `globals.d.ts`를 정리해 공용 타입, 기본 설정, 디버그 핸들 계약을 더 명확하게 표현
- **빌드/배포 메타데이터 생성 개선**
  - `tooling/userscript-header.ts`를 상수·포맷 헬퍼 기반으로 재구성해 userscript 헤더 생성 로직을 간결하게 정리

### Fixed
- **이미지/DOM/상태 관리 안정성 개선**
  - 이미지 URL 허용 호스트 검증을 강화해 프로필/이모지/스티커 처리 경로를 더 안전하게 정리
  - 비디오 재획득, overlay 재생성, 설정 병합, 요소 대기 로직의 타입/상태 처리 일관성을 개선
  - 기존 인스턴스 정리 및 전역 디버그 핸들 초기화 흐름을 보강해 재주입/재시작 시 충돌 가능성을 축소

### Tooling
- 품질 게이트(`pnpm quality`) 기준에 맞춰 타입/포맷/미사용 코드 정리를 수행하고 전체 워크스페이스 검증을 통과

## [0.5.1] - 2026-03-05

### Fixed
- **초기 페이지 로드 시 코멘트 2중 표시 버그 수정**
  - `ChatSource.start()`에 취소 플래그(`stopped`) 추가: `stop()` 호출 이후에도 비동기 루프가 계속 실행되며 MutationObserver를 재연결하던 문제 수정. 모든 `await` 이후 취소 여부를 확인하여 정리된 인스턴스가 상태를 오염시키지 않도록 보호
  - `App.start()`에 세대 기반 취소 토큰(`startGeneration`) 추가: `cleanup()` 실행 이후에도 완료되는 stale async task가 `isInitialized`·`lastStartedUrl` 등 앱 상태를 잘못 설정하던 경쟁 조건(race condition) 수정
  - `yt-navigate-finish` 이벤트 핸들러의 `forceNotify` 제거: YouTube가 초기 페이지 설정 중 동일 URL로 이벤트를 발생시킬 때 불필요한 cleanup+restart 사이클이 유발되던 문제 수정. URL 변경 감지는 기존 `pushState`/`replaceState` 패치와 `popstate` 리스너가 담당
  - `WeakSet` 기반 DOM 수준 메시지 중복 제거 추가: YouTube가 동일 DOM 노드를 `#items`에 두 번 삽입하는 경우(히스토리 리플레이, 채팅 패널 리셋 등)에도 같은 메시지가 중복 표시되지 않도록 방어
  - `initApp()`에서 기존 App 인스턴스 사전 정리: 이전 인스턴스가 존재하면 `.stop()`으로 리소스를 완전히 해제한 뒤 새 인스턴스를 생성하여 observer 중첩 방지

### Dependencies
- devDependencies 최신화: Node.js 24.14.0·pnpm 10.27.0 고정, `@types/node` ^25.3.3, `@biomejs/biome` ^2.4.4, `knip` ^5.85.0, `vite` ^7.3.1, `typescript` ^5.9.3

### CI
- Rollup 전이 의존성 보안 취약점 오버라이드 추가
- CI 보안 감사 게이트 및 OSV 스캔 조건 개선
- 워크플로 트리거·주석 정비

## [0.5.0] - 2026-02-20

### Added
- **설정 UI 확장**
  - 로그 레벨 선택(`warn`/`info`/`debug`) 옵션 추가
  - 짧은 일반 메시지 필터 옵션 추가 (`allowShortTextMessages`, `minTextLength`)
  - 작성자 타입별 표시 여부 및 색상 제어 옵션 강화
- **로그 제어 모듈 추가**: 오버레이 로그에 대해 레벨 기반 출력 필터링 지원
- **이미지 URL 검증 모듈 추가**: 작성자 프로필/이모지/스티커 이미지에 공통 도메인 검증 적용

### Changed
- **채팅 탐지 및 패널 오픈 안정성 개선**
  - iframe/in-page 채팅 컨테이너 탐색 및 검증 로직 강화
  - 채팅 패널이 닫혀 있는 경우 자동 오픈 시도 로직 개선
- **설정 UI 입력 검증/보정 강화**
  - 수치 입력을 범위 내로 clamp
  - 일부 퍼센트 기반 설정의 UI 입력 단위 일관화
- **렌더러 이미지 처리 공통화**
  - 이모지/스티커/작성자 이미지 생성 경로를 공통 헬퍼로 정리

### Fixed
- **설정 마이그레이션 개선**
  - 레거시 `debugLogging` 설정을 신규 `logLevel`로 안전하게 매핑
- **설정 모달 접근성 개선**
  - ESC 닫기, 포커스 트랩, 초기 포커스/포커스 복귀 처리 강화

### Dependencies
- Biome 및 Biome CLI를 `2.4.2`로 업데이트 (`@biomejs/biome`, `@biomejs/cli-linux-x64`)

## [0.4.2] - 2026-02-18

### Fixed
- **메시지 필터링 개선**: `parseMessage()`에서 메시지 종류(kind)를 태그명 기반으로 먼저 판별 후 콘텐츠를 파싱하도록 순서 변경
  - Super Sticker (이미지 전용, `yt-live-chat-paid-sticker-renderer`)를 명시적으로 필터링
  - 시스템 메시지 (`viewer-engagement`, `banner`, `placeholder` 등) 필터링 강화
  - 멤버십 아이템은 `#message`가 없어도 항상 표시 (메시지 없는 멤버십 이벤트 지원)
  - Super Chat은 텍스트 본문 유무와 관계없이 항상 표시
  - `ChatMessage.kind`에서 불필요한 `'other'` 타입 제거
- **렌더러 레인 배치 최적화**: 메시지 흐름 및 간격 개선
  - `LANE_DELAY_MS` 40ms → 15ms (처리량 향상)
  - `SAFE_DISTANCE_SCALE` 0.7 → 0.5, `SAFE_DISTANCE_MIN` 16px → 10px (더 촘촘한 수평 배치)
  - `VERTICAL_CLEAR_TIME` 120/320ms → 40/160ms (수평 준비 체크가 주된 조건이므로 단축)
  - `QUEUE_LOOKAHEAD_LIMIT` 14 → 20 (더 넓은 스케줄링 윈도우)
  - `findLanePlacement()`에 LRU 타이 브레이킹 추가: 대기 시간이 같을 때 가장 오래 사용되지 않은 블록 우선 → 화면 전체에 메시지가 고르게 분산

### Changed
- **기본 설정값 재조정**: 가독성·화면 점유 균형 개선
  - `speedPxPerSec`: 200 → 280 (더 빠른 스크롤로 화면 점유 시간 단축)
  - `fontSize`: 24 → 20 (메시지당 차지하는 영역 감소)
  - `opacity`: 0.95 → 0.85 (영상이 더 잘 보이게)
  - `superChatOpacity`: 0.4 → 0.35
  - `safeBottom`: 0.12 → 0.15 (컨트롤 바 가림 방지)
  - `maxConcurrentMessages`: 50 → 30
  - `maxMessagesPerSecond`: 10 → 4 (채팅 폭주 시 화면 가독성 보호)
- **DOM 정리 코드 간소화**: 불필요한 분기 제거, `element.remove()` 패턴 통일
- **로그 개선**: 채팅 모니터링 관련 로그 메시지 보강

### Dependencies
- Biome 및 Biome CLI를 안정 버전으로 다운그레이드 (`@biomejs/biome`, `@biomejs/cli-linux-x64`)

## [0.4.1] - 2026-02-16

### Fixed
- **메모리 누출 방지**: 모든 컴포넌트의 리소스 정리 개선
  - PageWatcher: history API 래퍼, 이벤트 리스너, interval 완전 정리
  - Overlay: fullscreenchange 이벤트 리스너 제거 추가
  - Renderer: overlay 참조 명시적 정리로 순환 참조 방지
  - ChatSource: MutationObserver 및 참조 정리 개선
  - SettingsUi: DOM 요소 및 스타일 완전 제거
- 페이지 이동 및 앱 재시작 시 리소스가 완전히 해제되도록 개선

### Changed
- **코드 일관성 개선**: 모든 destroy() 메서드를 표준화된 패턴으로 통일
  - 타이머/인터벌 → 이벤트 리스너 → Observer → DOM 요소 → 참조 순서로 정리
  - 섹션별 주석 추가로 가독성 향상
- **로깅 통일**: 클래스별 일관된 로그 접두사 적용 (`[App]`, `[Overlay]`, `[Renderer]` 등)
- **Main.ts 최적화**: cleanup() 플로우 간소화 및 불필요한 try-catch 제거
- Optional chaining을 활용한 null 체크 패턴 개선

### Dependencies
- `@types/node` 버전 25.2.3으로 업데이트
- 개발 의존성 (quality group) 업데이트

## [0.4.0] - 2026-02-14

### Added
- Super Chat 파싱/렌더링 지원 (동적 색상 매핑 및 그라디언트 배경 포함)
- 작성자 프로필 이미지 표시 및 작성자 타입별 표시 옵션
- 설정 UI에 Super Chat 전용 opacity 옵션 추가
- 렌더러/설정 UI 스타일 일관성을 위한 design tokens 모듈 추가

### Changed
- 멀티라인 메시지 처리 및 lane 배치 로직 리팩터링으로 충돌 감소
- lane 높이 계산과 메시지 요소 생성 흐름 최적화로 렌더링 안정성/성능 개선
- 기본 Super Chat opacity 값 조정으로 가독성 향상

### Fixed
- 일반 메시지와 Super Chat 간 글꼴 크기 및 애니메이션 시간 처리 일관성 개선

### CI/Tooling
- Knip 설정 추가 및 의존성 분석을 quality/CI 파이프라인에 통합
- CI, release, Dependabot, repository automation 워크플로 구성 개선

## [0.3.1] - 2026-02-10

### Changed
- 버전 관리 기준을 `package.json`으로 단일화

## [0.3.0] - 2026-02-09

### Added
- Video playback synchronization: animations pause when video pauses, resume when video plays
- Message queuing system: messages queue during pause and display when resumed
- Playback rate synchronization: animation speed matches video playback speed (0.25x - 2x)
- Video element replacement detection: auto-reinitialization during ad transitions
- System message filtering: blocks "실시간 채팅 다시보기" and other system notifications
- New VideoSync module for robust video element detection and monitoring

### Changed
- Refactored Renderer with forEachAnimation() helper method for cleaner code
- Extracted magic numbers to CONFIG constants in VideoSync
- Enhanced chat message parsing with isUserMessage() filtering logic

### Improved
- Periodic video detection with fallback strategy
- MutationObserver for handling dynamic video element changes
- Error handling for animation operations

## [0.2.0] - 2026-02-08

### Added
- Emoji support in chat messages with advanced rendering capabilities.
- Security validation for chat message content to prevent XSS and injection attacks.

### Fixed
- Regex pattern in meta.js generation for userscript header metadata.

### Changed
- Enhanced chat message processing with improved text sanitization.
- Updated Dependabot configuration and GitHub workflows for better automation.

## [0.1.1] - 2026-02-07

### Added
- Release distribution via release branch + jsDelivr with generated `.meta.js`.
- GitHub workflows and community health files for CI, security, and templates.

### Changed
- Comment lane spacing and timing to reduce overlap and ensure messages exit fully.
- README install links for stable and metadata update URLs.

### Fixed
- Prevent settings modal from opening during chat panel auto-open logic.

## [0.1.0] - 2026-02-06

### Added
- Nico-nico style live chat overlay for YouTube streams and premieres.
- Settings panel (⚙) to control speed, font size, opacity, safe zones, colors, and outline.
- Automatic handling of YouTube SPA navigation and chat panel detection.
- Collision-aware lane rendering to reduce comment overlap.
- Local-only processing with no chat data storage or transmission.
