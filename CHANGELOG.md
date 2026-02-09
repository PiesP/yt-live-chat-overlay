# Changelog

All notable changes to this project will be documented in this file.

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
