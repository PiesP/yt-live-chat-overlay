// SPDX-License-Identifier: MIT

export type VideoState = {
  currentTime: number | null;
  errorCode: number | null;
  muted: boolean;
  paused: boolean;
  readyState: number;
};
export type PublicVideoAction = 'read' | 'pause' | 'play';
export function observePublicVideo(
  video: HTMLVideoElement,
  { player, action }: { player: unknown; action: PublicVideoAction }
) {
  const players = document.querySelectorAll('#movie_player');
  const videos = player instanceof Element ? player.querySelectorAll('video') : null;
  if (
    !(video instanceof HTMLVideoElement) ||
    !(player instanceof Element) ||
    player.ownerDocument !== document ||
    !player.isConnected ||
    players.length !== 1 ||
    players[0] !== player ||
    video.ownerDocument !== document ||
    !video.isConnected ||
    videos?.length !== 1 ||
    videos[0] !== video
  ) {
    throw new Error('Owned public player video is absent, ambiguous, or replaced');
  }
  const state = (): VideoState => ({
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
    errorCode: video.error?.code ?? null,
    muted: video.muted,
    paused: video.paused,
    readyState: video.readyState,
  });
  const before = state();
  if (action === 'pause') {
    video.pause();
  } else if (action === 'play') {
    // Some public-player promises remain pending. Playback state is checked separately.
    void video.play().catch(() => {});
  }
  return { action, before, after: state() };
}

export function readPublicDurationPageState(owned?: { player: unknown; video: unknown }) {
  const players = document.querySelectorAll('#movie_player');
  const player = players.length === 1 ? players[0] : null;
  const videos = player?.querySelectorAll('video');
  const video = owned?.video ?? (videos?.length === 1 ? videos[0] : null);
  if (
    owned &&
    (!(owned.player instanceof Element) ||
      owned.player.ownerDocument !== document ||
      !owned.player.isConnected ||
      players.length !== 1 ||
      player !== owned.player ||
      !(owned.video instanceof HTMLVideoElement) ||
      owned.video.ownerDocument !== document ||
      !owned.video.isConnected ||
      !player?.isConnected ||
      videos?.length !== 1 ||
      videos[0] !== owned.video)
  ) {
    throw new Error('Owned public player video is absent, ambiguous, or replaced');
  }
  if (players.length > 1 || (videos?.length ?? 0) > 1) {
    throw new Error('Public player video is ambiguous');
  }
  const visibleError = [
    {
      marker: 'youtube-player-error-ui-visible',
      selector: '.ytp-error, .ytp-error-content-wrap, .ytp-error-content',
    },
    {
      marker: 'youtube-playability-error-ui-visible',
      selector: '#player yt-playability-error-supported-renderers#error-screen',
    },
  ].find(({ selector }) =>
    [...document.querySelectorAll(selector)].some((element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0
      );
    })
  );
  const playerWithData = player as
    | (Element & { getVideoData?: () => { video_id?: unknown } })
    | null;
  const playerData =
    typeof playerWithData?.getVideoData === 'function' ? playerWithData.getVideoData() : null;
  const bridge = window.__ytExtensionBridge;
  return {
    visibility: document.visibilityState,
    playerVideoId: typeof playerData?.video_id === 'string' ? playerData.video_id : null,
    adShowing: player ? player.classList.contains('ad-showing') : null,
    hud:
      document.querySelector('#yt-chat-overlay-debug')?.textContent?.replace(/\s+/gu, ' ').trim() ??
      null,
    canvasAttached: document.querySelectorAll('#yt-live-chat-overlay canvas').length === 1,
    accessibilityRenderedNodeCount: document.querySelectorAll(
      '.yt-live-chat-overlay-live-region > p'
    ).length,
    installedBridgeReady: Boolean(
      bridge?.workerSupported === true &&
      bridge?.storageType === 'chrome.storage.local' &&
      bridge?.workerUrl?.startsWith(`blob:${location.origin}/`)
    ),
    playerErrorUi: {
      visible: Boolean(visibleError),
      marker: visibleError?.marker ?? null,
    },
    video:
      video instanceof HTMLVideoElement
        ? {
            currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
            errorCode: video.error?.code ?? null,
            muted: video.muted,
            paused: video.paused,
            readyState: video.readyState,
          }
        : null,
  };
}

export function readFailurePlayerDomSnapshot(
  binding: { player: unknown; video: unknown } | undefined
) {
  const players = document.querySelectorAll('#movie_player');
  const player = players.length === 1 ? players[0] : null;
  const providerRoots = [
    ...document.querySelectorAll(
      'yt-playability-error-supported-renderers, ytd-player-error-message-renderer'
    ),
  ];
  const elements = [
    ...(player ? [player, ...player.querySelectorAll('*')] : []),
    ...providerRoots.flatMap((root) => [root, ...root.querySelectorAll('*')]),
  ];
  const markerPattern = /error|unavailable|playability|message|alert|status/iu;
  const textPattern =
    /video unavailable|live stream recording is not available|an error occurred/iu;
  const boundedAttribute = (value: string | null) =>
    value?.replace(/[^a-z0-9_-]/giu, '_').slice(0, 64) ?? null;
  const describe = (element: Element) => {
    const style = getComputedStyle(element);
    const rectangle = element.getBoundingClientRect();
    const rectCount = element.getClientRects().length;
    return {
      tag: element.tagName.toLowerCase(),
      id: boundedAttribute(element.id),
      classes: [...element.classList].slice(0, 8).map((value) => boundedAttribute(value)),
      role: boundedAttribute(element.getAttribute('role')),
      ariaHidden: element.getAttribute('aria-hidden')?.slice(0, 8) ?? null,
      hidden: element.hasAttribute('hidden'),
      display: style.display.slice(0, 32),
      visibility: style.visibility.slice(0, 32),
      rectCount: Math.min(rectCount, 999),
      width: Math.round(rectangle.width),
      height: Math.round(rectangle.height),
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rectCount > 0,
    };
  };
  const candidates = elements
    .filter((element) => {
      const structural = [
        element.tagName,
        element.id,
        ...element.classList,
        element.getAttribute('role') ?? '',
      ].some((value) => markerPattern.test(value));
      const leafText = element.children.length === 0 ? (element.textContent ?? '') : '';
      return structural || textPattern.test(leafText);
    })
    .map((element) => {
      const path = [];
      for (let current: Element | null = element; current && path.length < 6;) {
        path.push(describe(current));
        current = current.parentElement;
      }
      const leafText = element.children.length === 0 ? (element.textContent ?? '') : '';
      return {
        path,
        errorText: textPattern.test(leafText)
          ? leafText.replace(/\s+/gu, ' ').trim().slice(0, 160)
          : null,
      };
    })
    .sort((first, second) => Number(second.path[0]?.visible) - Number(first.path[0]?.visible))
    .slice(0, 24);
  const response = (
    globalThis as typeof globalThis & {
      ytInitialPlayerResponse?: {
        playabilityStatus?: { status?: unknown; reason?: unknown };
      };
    }
  ).ytInitialPlayerResponse;
  const status = response?.playabilityStatus?.status;
  const reason = response?.playabilityStatus?.reason;
  const playerVideos = player?.querySelectorAll('video');
  const media =
    binding &&
    binding.player === player &&
    binding.video instanceof HTMLVideoElement &&
    binding.video.ownerDocument === document &&
    binding.video.isConnected &&
    player?.isConnected &&
    playerVideos?.length === 1 &&
    playerVideos[0] === binding.video
      ? binding.video
      : null;
  return {
    playerFound: Boolean(player),
    playerAmbiguous: players.length > 1,
    providerStatusSource: 'ytInitialPlayerResponse-initial',
    mediaIdentity: media ? 'owned' : 'unavailable',
    providerStatus: typeof status === 'string' ? boundedAttribute(status) : null,
    providerReason: typeof reason === 'string' ? reason.slice(0, 160) : null,
    mediaNetworkState: media instanceof HTMLVideoElement ? media.networkState : null,
    mediaErrorCode: media instanceof HTMLVideoElement ? (media.error?.code ?? null) : null,
    candidates,
  };
}
