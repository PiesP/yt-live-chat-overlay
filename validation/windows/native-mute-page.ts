// SPDX-License-Identifier: MIT

export type NativeMuteState = {
  decision: 'click-mute' | 'already-muted';
  muted: boolean;
  paused: boolean;
  readyState: number;
  currentTime: number | null;
};

/** Passed to the retained button handle; no page-global player identity is trusted. */
export function inspectBoundNativeMuteButton(
  button: HTMLButtonElement,
  {
    player,
    video,
    expectedVideoId,
    currentUrl,
  }: { player: unknown; video: unknown; expectedVideoId: string; currentUrl?: string }
): NativeMuteState {
  const players = document.querySelectorAll('#movie_player');
  const videos = player instanceof Element ? player.querySelectorAll('video') : null;
  const controls = document.querySelectorAll(
    '#movie_player .ytp-mute-button > button.ytp-volume-icon.ytp-button'
  );
  const parent = button?.parentElement;
  if (
    !(player instanceof Element) ||
    !(video instanceof HTMLVideoElement) ||
    !(button instanceof HTMLButtonElement) ||
    players.length !== 1 ||
    players[0] !== player ||
    videos?.length !== 1 ||
    videos[0] !== video ||
    controls.length !== 1 ||
    controls[0] !== button ||
    !player.contains(button) ||
    player.ownerDocument !== document ||
    video.ownerDocument !== document ||
    button.ownerDocument !== document ||
    !player.isConnected ||
    !video.isConnected ||
    !button.isConnected ||
    parent?.tagName !== 'DIV' ||
    !parent.classList.contains('ytp-mute-button') ||
    !button.classList.contains('ytp-volume-icon') ||
    !button.classList.contains('ytp-button')
  ) {
    throw new Error('Owned native mute control is absent, ambiguous, or replaced');
  }
  const playerWithData = player as Element & { getVideoData?: () => unknown };
  const playerData: unknown =
    typeof playerWithData.getVideoData === 'function' ? playerWithData.getVideoData() : null;
  const playerVideoId =
    playerData && typeof playerData === 'object' && 'video_id' in playerData
      ? playerData.video_id
      : null;
  const pageUrl = new URL(currentUrl ?? location.href);
  const currentVideoId =
    pageUrl.pathname === '/watch'
      ? pageUrl.searchParams.get('v')
      : /^\/live\/[A-Za-z0-9_-]{1,64}$/u.test(pageUrl.pathname)
        ? pageUrl.pathname.slice('/live/'.length)
        : null;
  if (
    pageUrl.origin !== 'https://www.youtube.com' ||
    currentVideoId !== expectedVideoId ||
    playerVideoId !== expectedVideoId ||
    player.classList.contains('ad-showing') ||
    video.error?.code != null ||
    !Number.isInteger(video.readyState) ||
    video.readyState < 1 ||
    video.readyState > 4 ||
    document.visibilityState !== 'visible'
  ) {
    throw new Error('Native mute precondition is unverified');
  }
  const errorSelectors = [
    '.ytp-error, .ytp-error-content-wrap, .ytp-error-content',
    '#player yt-playability-error-supported-renderers#error-screen',
  ];
  if (
    errorSelectors.some((selector) =>
      [...document.querySelectorAll(selector)].some((element) => {
        const style = getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        );
      })
    )
  )
    throw new Error('Player error is visible before native mute action');
  const rect = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  const parentStyle = getComputedStyle(parent);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (
    !(rect.width > 0 && rect.height > 0) ||
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    parentStyle.display === 'none' ||
    parentStyle.visibility === 'hidden' ||
    parentStyle.visibility === 'collapse' ||
    button.disabled ||
    button.getAttribute('aria-disabled') === 'true' ||
    button.getAttribute('aria-hidden') === 'true' ||
    parent.getAttribute('aria-hidden') === 'true' ||
    button.getAttribute('aria-keyshortcuts') !== 'm' ||
    !(hit === button || button.contains(hit))
  ) {
    throw new Error('Native mute control is not uniquely actionable');
  }
  const normalize = (value: string | null) =>
    typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : null;
  const kind = (value: string | null) =>
    value === 'Mute' || value === 'Mute (m)'
      ? 'mute'
      : value === 'Unmute' || value === 'Unmute (m)' || value === 'Unmute keyboard shortcut m'
        ? 'unmute'
        : null;
  const labelKind = kind(normalize(button.getAttribute('aria-label')));
  const title = normalize(button.getAttribute('title'));
  if (
    labelKind === null ||
    (title !== null && title !== '' && kind(title) !== labelKind) ||
    (labelKind === 'mute' && video.muted !== false) ||
    (labelKind === 'unmute' && video.muted !== true)
  ) {
    throw new Error('Native mute label and retained video state conflict');
  }
  return {
    decision: labelKind === 'mute' ? 'click-mute' : 'already-muted',
    muted: video.muted,
    paused: video.paused,
    readyState: video.readyState,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
  };
}

export function playOwnedMutedVideo(
  video: HTMLVideoElement,
  {
    player,
    expectedVideoId,
    currentUrl,
  }: { player: unknown; expectedVideoId: string; currentUrl?: string }
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
  const playerWithData = player as Element & { getVideoData?: () => unknown };
  const playerData: unknown =
    typeof playerWithData.getVideoData === 'function' ? playerWithData.getVideoData() : null;
  const playerVideoId =
    playerData && typeof playerData === 'object' && 'video_id' in playerData
      ? playerData.video_id
      : null;
  const pageUrl = new URL(currentUrl ?? location.href);
  const currentVideoId =
    pageUrl.pathname === '/watch'
      ? pageUrl.searchParams.get('v')
      : /^\/live\/[A-Za-z0-9_-]{1,64}$/u.test(pageUrl.pathname)
        ? pageUrl.pathname.slice('/live/'.length)
        : null;
  if (
    pageUrl.origin !== 'https://www.youtube.com' ||
    currentVideoId !== expectedVideoId ||
    playerVideoId !== expectedVideoId ||
    player.classList.contains('ad-showing') ||
    video.error?.code != null ||
    video.muted !== true ||
    document.visibilityState !== 'visible'
  ) {
    throw new Error('Owned public player video lost verified mute before play');
  }
  const state = () => ({
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
    errorCode: video.error?.code ?? null,
    muted: video.muted,
    paused: video.paused,
    readyState: video.readyState,
  });
  const before = state();
  void video.play().catch(() => {});
  return { action: 'play', before, after: state() };
}
