# Changelog

All notable changes to this project will be documented in this file.

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
