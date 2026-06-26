// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Chrome Language Detector API wrapper.
 *
 * Uses the built-in LanguageDetector API (Chrome 138+) to detect the
 * language of chat messages. Falls back to Unicode-range heuristics
 * when the API is unavailable.
 *
 * Design notes:
 * - One detector instance per LanguageDetectorService lifecycle.
 * - `detect()` is fast (~1-5ms on modern hardware) and runs per-sample.
 * - `detectFromSamples()` aggregates multiple calls with majority vote.
 * - Unicode fallback covers CJK, Hangul, Hiragana/Katakana, Latin-1 Supplement.
 */

import type { TranslationLanguage } from '@app-types';
import { createLogger } from '@core/logging';

const log = createLogger('LanguageDetector');

// ── Type declarations for Chrome Language Detector API ────────────────────

interface LanguageDetectionResult {
  detectedLanguage: string;
  confidence: number;
}

interface LanguageDetectorInstance {
  detect(text: string): Promise<LanguageDetectionResult[]>;
  destroy(): void;
}

interface LanguageDetectorStatic {
  create(options?: { monitor?: (monitor: EventTarget) => void }): Promise<LanguageDetectorInstance>;
  capabilities(): Promise<{
    available: 'readily' | 'after-download' | 'no';
  }>;
}

declare global {
  // eslint-disable-next-line no-var
  var LanguageDetector: LanguageDetectorStatic | undefined;
}

// ── Unicode-range heuristics ──────────────────────────────────────────────

/**
 * Ordered by specificity: Hiragana/Katakana reliably indicate Japanese,
 * Hangul reliably indicates Korean, CJK Unified is shared across CJK but
 * we treat it as Chinese (most likely in YouTube context when no kana present).
 */
const UNICODE_HINTS: ReadonlyArray<[TranslationLanguage, [number, number]]> = [
  ['ja', [0x3040, 0x309f]], // Hiragana
  ['ja', [0x30a0, 0x30ff]], // Katakana
  ['ko', [0xac00, 0xd7af]], // Hangul Syllables
  ['zh-CN', [0x4e00, 0x9fff]], // CJK Unified Ideographs
  ['es', [0x00c0, 0x00ff]], // Latin-1 Supplement (ñ, á, é, í, ó, ú, ü, ¿, ¡)
];

function detectByUnicodeRange(text: string): TranslationLanguage | null {
  const scores = new Map<TranslationLanguage, number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const [lang, [lo, hi]] of UNICODE_HINTS) {
      if (cp >= lo && cp <= hi) {
        scores.set(lang, (scores.get(lang) ?? 0) + 1);
      }
    }
  }
  if (scores.size === 0) return 'en'; // ASCII-only text → most likely English
  // Sort by score descending, take top
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'en';
}

// ── Service ───────────────────────────────────────────────────────────────

export class LanguageDetectorService {
  private detector: LanguageDetectorInstance | null = null;
  private initPromise: Promise<void> | null = null;

  /** Check if the browser supports the Language Detector API. */
  static isSupported(): boolean {
    return (
      typeof LanguageDetector !== 'undefined' && typeof LanguageDetector?.create === 'function'
    );
  }

  /** Initialize the detector instance. Safe to call multiple times — no-ops if already ready. */
  async initialize(): Promise<void> {
    if (!LanguageDetectorService.isSupported()) {
      log.info('Language Detector API not available — using Unicode heuristics');
      return;
    }
    if (this.detector) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInit(): Promise<void> {
    if (typeof LanguageDetector?.capabilities !== 'function') {
      log.info('Language Detector API shape mismatch — using Unicode heuristics');
      return;
    }
    try {
      const caps = await LanguageDetector.capabilities();
      if (!caps || caps.available === 'no') {
        log.warn('Language Detector not available on this device');
        return;
      }
      if (typeof LanguageDetector.create === 'function') {
        this.detector = await LanguageDetector.create();
      }
      log.info('Language Detector ready');
    } catch (err: unknown) {
      log.warn('Failed to create Language Detector:', err);
    }
  }

  /**
   * Detect the primary language of a text sample.
   * Returns the detected TranslationLanguage or 'en' as fallback.
   */
  async detect(text: string): Promise<TranslationLanguage> {
    if (!text.trim()) return 'en';

    if (this.detector) {
      try {
        const results = await this.detector.detect(text);
        const top = results[0];
        if (top && top.confidence >= 0.5) {
          const mapped = this.mapBcp47(top.detectedLanguage);
          if (mapped) return mapped;
        }
      } catch (err: unknown) {
        log.debug('LanguageDetector.detect failed, falling back to Unicode:', err);
      }
    }

    return detectByUnicodeRange(text) ?? 'en';
  }

  /**
   * Detect language from multiple text samples using majority vote.
   */
  async detectFromSamples(samples: string[]): Promise<TranslationLanguage> {
    const votes = new Map<TranslationLanguage, number>();
    for (const sample of samples) {
      const lang = await this.detect(sample);
      votes.set(lang, (votes.get(lang) ?? 0) + 1);
    }
    if (votes.size === 0) return 'en';
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'en';
  }

  /** Map a BCP 47 language tag to our supported TranslationLanguage set. */
  private mapBcp47(bcp47: string): TranslationLanguage | null {
    const lang = bcp47.split('-')[0]?.toLowerCase();
    switch (lang) {
      case 'en':
        return 'en';
      case 'ko':
        return 'ko';
      case 'ja':
        return 'ja';
      case 'es':
        return 'es';
      case 'zh-CN':
        return 'zh-CN';
      default:
        return null;
    }
  }

  destroy(): void {
    if (this.detector) {
      try {
        this.detector.destroy();
      } catch {
        /* ignore */
      }
      this.detector = null;
    }
    this.initPromise = null;
  }
}
