# Changelog

All notable changes to this project will be documented in this file.

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
