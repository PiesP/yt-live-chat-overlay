# YouTube Live Chat Overlay

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md)

YouTube 실시간 스트림, 최초 공개 및 다시보기 위에 실시간 채팅을 니코니코식
흐르는 댓글로 표시합니다. 사용자 스크립트, 압축을 푼 Chrome 확장 프로그램,
임시 Firefox 확장 프로그램으로 사용할 수 있습니다.

## 기능

- 오른쪽에서 왼쪽, 왼쪽에서 오른쪽, 위쪽 고정 및 아래쪽 고정 댓글 모드
- 텍스트, 이모지, Super Chat, 스티커, 멤버십 및 작성자 배지 렌더링
- 최근 메시지 또는 다시보기 메시지의 백로그 표시
- 속도, 글꼴, 불투명도, 외곽선, 안전 영역, 레인 및 깊이 설정
- 자동 또는 수동으로 선택할 수 있는 6개 인터페이스 언어
- 브라우저가 Translator API를 제공할 때 선택적으로 사용하는 브라우저 내 채팅 번역
- 설정 가져오기, 내보내기 및 탭 간 동기화
- OffscreenCanvas Worker를 사용할 수 있으면 함께 사용하는 메인 스레드 Canvas2D 렌더링

## 설치

### 사용자 스크립트

[Tampermonkey](https://www.tampermonkey.net/) 또는
[Violentmonkey](https://violentmonkey.github.io/)를 설치한 뒤
[최신 사용자 스크립트](https://github.com/PiesP/yt-live-chat-overlay/releases/latest/download/yt-live-chat-overlay.user.js)를
설치합니다.

사용자 스크립트 관리자는 스크립트에 포함된 메타데이터 URL을 통해 업데이트를
확인합니다.

### Chrome, Edge 또는 Brave 확장 프로그램

릴리스 압축 파일은 압축을 풀어 사용하는 개발자용 빌드입니다. 브라우저
스토어에서 설치되지 않으며 자동으로 업데이트되지 않습니다.

1. [최신 릴리스](https://github.com/PiesP/yt-live-chat-overlay/releases/latest)에서
   `yt-live-chat-overlay-chrome.zip`을 다운로드합니다.
2. 압축 파일을 영구적으로 유지할 디렉터리에 풉니다.
3. `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 선택하고 압축을 푼 디렉터리를
   지정합니다.

### Firefox 확장 프로그램

1. [최신 릴리스](https://github.com/PiesP/yt-live-chat-overlay/releases/latest)에서
   `yt-live-chat-overlay-firefox.zip`을 다운로드합니다.
2. `about:debugging#/runtime/this-firefox`를 엽니다.
3. **임시 부가 기능 로드**를 선택하고 ZIP 파일을 지정합니다.

이 개발자용 설치는 Firefox를 다시 시작하면 제거됩니다. 계속 설치해 두려면
사용자 스크립트를 사용하세요.

## 사용법

채팅이 있는 YouTube 실시간 스트림, 최초 공개 또는 다시보기를 엽니다. 오버레이는
자동으로 시작됩니다. 플레이어에 추가된 톱니바퀴 버튼을 눌러 표시, 백로그,
번역, 성능 및 접근성 옵션을 설정합니다.

## 브라우저 지원

| 배포 방식 | 지원 범위 |
| --- | --- |
| 사용자 스크립트 | Tampermonkey 또는 Violentmonkey가 지원하는 최신 데스크톱 브라우저 |
| Chromium 확장 프로그램 | Chrome/Chromium 116+ 개발자 모드 |
| Firefox 확장 프로그램 | Firefox 128+ 기술적 최소 버전, 임시 개발자 설치 |

번역 지원 여부는 실행 중에 감지되며 위 브라우저 최소 버전과는 별개입니다.
번역하려면 브라우저에 내장된 Translator API가 있고 선택한 언어 쌍을 지원해야
합니다. 자동 원문 언어 감지는 Language Detector API를 사용할 수 있으면 이를
사용하고, 없으면 브라우저 안에서 유니코드 기반 추정 방식으로 전환합니다.
브라우저가 필요한 언어 모델이나 언어 팩을 다운로드할 수 있습니다. Translator를
사용할 수 없어도 오버레이는 번역 없이 계속 작동합니다.

Firefox 128은 확장 프로그램의 기술적 호환성 최소 버전이며, Firefox 128이 현재
지원되는 ESR이라는 뜻은 아닙니다. 일반 사용과 릴리스 검증에는 현재 지원되는
Firefox 릴리스를 사용하세요.

## 개인정보 보호 및 보안

채팅 분석과 렌더링은 브라우저 안에서 이루어집니다. 프로젝트는 분석, 원격 측정,
번역 또는 채팅 처리 서버를 운영하지 않습니다. YouTube 및 Google의 일반적인
미디어 요청은 계속 발생합니다. 저장소와 네트워크 세부 정보는
[개인정보 보호](./PRIVACY.md), 취약점 신고 방법은
[보안 정책](./.github/SECURITY.md)을 참고하세요.

## 프로젝트 문서

이 프로젝트는 AI 도구의 도움을 받아 개발됩니다.

개발 설정과 검증은 [기여 안내](./CONTRIBUTING.md), 확장 프로그램 구조, 빌드 및
압축을 푼 확장 프로그램 로드 방법은 [확장 프로그램 안내](./extension/README.md)를
참고하세요.

## 지원

- 사용법 및 문제 해결: [지원](./SUPPORT.md)
- 버그 및 기능 요청: [GitHub Issues](https://github.com/PiesP/yt-live-chat-overlay/issues)
- 릴리스 기록: [변경 기록](./CHANGELOG.md)
- 취약점: [보안 정책](./.github/SECURITY.md)

## 라이선스

MIT. [LICENSE](./LICENSE)를 참고하세요.
