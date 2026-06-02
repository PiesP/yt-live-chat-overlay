// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWorkerWebGL2 — OffscreenCanvas-based WebGL2 render loop running in a Web Worker.
 *
 * Offloads WebGL2 SDF rendering from the main thread. The main thread handles
 * DOM observation, API polling, and translation; the worker runs its own rAF
 * loop for rendering, lane allocation, and message lifecycle.
 *
 * ## Protocol
 *
 * Main → Worker:
 *   { type: 'init', canvas: OffscreenCanvas, config: WorkerConfig }
 *   { type: 'resize', width: number, height: number }
 *   { type: 'addMessages', messages: WorkerMessage[] }
 *   { type: 'updateConfig', config: Partial<WorkerConfig> }
 *   { type: 'setPaused', paused: boolean, videoPaused?: boolean }
 *   { type: 'addEmojiImages', images: Array<{ url: string, bitmap: ImageBitmap }> }
 *   { type: 'addAuthorPhotos', photos: Array<{ url: string, bitmap: ImageBitmap }> }
 *   { type: 'setTranslation', messageId: string, text: string }
 *   { type: 'destroy' }
 *
 * Worker → Main:
 *   { type: 'ready' }
 *   { type: 'stats', activeMessages: number, fps: number, drops: number, queueDepth: number }
 *   { type: 'atlasReady' }
 *   { type: 'atlasError', error: string }
 *   { type: 'requestImages', urls: string[] }
 *   { type: 'error', message: string }
 *
 * ## WorkerConfig
 *
 * A minimal subset of OverlaySettings needed by the render loop.
 * The main thread serializes relevant settings into this flat config shape.
 */

/// <reference lib="webworker" />

// Phase 1: no rendering imports — type-only interfaces defined inline

/** Minimal serializable message format for cross-thread transfer. */
interface WorkerMessage {
  id: string;
  author?: string;
  authorType: string;
  authorPhotoUrl?: string;
  kind: 'text' | 'superchat' | 'membership';
  content: Array<
    { type: 'text'; content: string } | { type: 'emoji'; emojiUrl: string; emojiAlt?: string }
  >;
  isBacklog: boolean;
}

/** Worker configuration subset (sent from main thread). */
interface WorkerConfig {
  fontSize: number;
  fontFamily: string;
  fontWeight: string | number;
  opacity: number;
  fadeDurationMs: number;
  maxMessageAgeMs: number;
  danmakuMode: string;
  scrollDurationMaxMs: number;
  queueMaxSize: number;
  backgroundQueueMax: number;
  outlineWidthPx: number;
  outlineOpacity: number;
  authorColors: Record<string, string>;
  laneSpacing: number;
  safeTop: number;
  safeBottom: number;
  headwayGapRatio: number;
  exitPaddingPx: number;
  speedPxPerSec: number;
  backlogSpeedMultiplier: number;
  depthLayersEnabled: boolean;
  depthFarOpacityMul: number;
  backlogOpacityMultiplier: number;
  showAuthor: boolean;
  superChatOpacity: number;
  translationMode?: string;
  [key: string]: unknown;
}

// ── State ──
let canvas: OffscreenCanvas | null = null;
let config: WorkerConfig | null = null;
const messages: WorkerMessage[] = [];
let animFrameId: number | null = null;
let atlasReady = false;
let isPaused = false;
let isVideoPaused = false;

// ── Message Handlers ──

function handleInit(payload: { canvas: OffscreenCanvas; config: WorkerConfig }): void {
  canvas = payload.canvas;
  config = payload.config;
  // WebGL2 context creation and rendering loop will be added in Phase 2
  self.postMessage({ type: 'ready' });
}

function handleResize(payload: { width: number; height: number }): void {
  if (canvas) {
    canvas.width = payload.width;
    canvas.height = payload.height;
  }
}

function handleAddMessages(payload: { messages: WorkerMessage[] }): void {
  if (!config) return;
  for (const msg of payload.messages) {
    messages.push(msg);
  }
  // Queue management and rendering will be added in Phase 2
}

function handleUpdateConfig(payload: { config: Partial<WorkerConfig> }): void {
  if (config) {
    Object.assign(config, payload.config);
  }
}

function handleSetPaused(payload: { paused: boolean; videoPaused?: boolean }): void {
  isPaused = payload.paused;
  if (payload.videoPaused !== undefined) isVideoPaused = payload.videoPaused;
}

function handleEmojiImages(_payload: {
  images: Array<{ url: string; bitmap: ImageBitmap }>;
}): void {
  void _payload;
  // Phase 3: upload ImageBitmaps to WebGL textures
}

function handleAuthorPhotos(_payload: {
  photos: Array<{ url: string; bitmap: ImageBitmap }>;
}): void {
  void _payload;
  // Phase 3: upload ImageBitmaps to WebGL textures
}

function handleTranslation(_payload: { messageId: string; text: string }): void {
  void _payload;
  // Phase 2: apply translation to matching message
}

function handleDestroy(): void {
  if (animFrameId !== null) cancelAnimationFrame(animFrameId);
  animFrameId = null;
  atlasReady = false;
  messages.length = 0;
  canvas = null;
  config = null;
}

// ── Main ──
self.onmessage = (e: MessageEvent) => {
  const { type, ...payload } = e.data;
  switch (type) {
    case 'init':
      handleInit(payload);
      break;
    case 'resize':
      handleResize(payload);
      break;
    case 'addMessages':
      handleAddMessages(payload);
      break;
    case 'updateConfig':
      handleUpdateConfig(payload);
      break;
    case 'setPaused':
      handleSetPaused(payload);
      break;
    case 'addEmojiImages':
      handleEmojiImages(payload);
      break;
    case 'addAuthorPhotos':
      handleAuthorPhotos(payload);
      break;
    case 'setTranslation':
      handleTranslation(payload);
      break;
    case 'destroy':
      handleDestroy();
      break;
  }
};

// Satisfy noUnusedLocals for Phase 1 skeleton — these will be consumed in Phase 2+
void canvas;
void config;
void messages;
void animFrameId;
void atlasReady;
void isPaused;
void isVideoPaused;
void handleEmojiImages;
void handleAuthorPhotos;
void handleTranslation;
