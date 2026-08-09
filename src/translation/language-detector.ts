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

import type { TranslationLanguage, TranslationSourceLanguage } from '@app-types';
import { createLogger } from '@util/logging';

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
  availability(): Promise<'available' | 'downloadable' | 'unavailable'>;
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
  ['ar', [0x0600, 0x06ff]], // Arabic
];

function detectByUnicodeRange(text: string): TranslationLanguage | null {
  const scores = new Map<TranslationLanguage, number>();
  // Sample first 100 chars — sufficient for language detection by Unicode range
  const sample = text.slice(0, 100);
  for (const ch of sample) {
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
  /** Incremented whenever this service lifecycle is invalidated. */
  private lifecycleGeneration = 0;

  /** Check if the browser supports the Language Detector API. */
  static isSupported(): boolean {
    return (
      typeof LanguageDetector !== 'undefined' && typeof LanguageDetector?.create === 'function'
    );
  }

  /** Initialize the detector instance. Safe to call multiple times — no-ops if already ready. */
  async initialize(): Promise<void> {
    if (!LanguageDetectorService.isSupported()) {
      log.info('translation.detector.api-unavailable');
      return;
    }
    if (this.detector) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    const generation = this.lifecycleGeneration;
    const initPromise = this.doInit(generation);
    this.initPromise = initPromise;
    try {
      await initPromise;
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
      }
    }
  }

  private async doInit(generation: number): Promise<void> {
    if (typeof LanguageDetector?.availability !== 'function') {
      log.info('translation.detector.api-mismatch');
      return;
    }
    try {
      const availability = await LanguageDetector.availability();
      if (availability === 'unavailable') {
        log.warn('translation.detector.device-unavailable');
        return;
      }
      if (typeof LanguageDetector.create === 'function') {
        const detector = await LanguageDetector.create();
        if (generation !== this.lifecycleGeneration) {
          // Creation is asynchronous and cannot always be cancelled. Make
          // sure a detector that finishes after destroy() is not retained.
          detector.destroy();
          return;
        }
        this.detector = detector;
      }
      log.info('translation.detector.ready');
    } catch (err: unknown) {
      log.warn('translation.detector.create-failed', { error: String(err) });
    }
  }

  /**
   * Detect the primary language of a text sample.
   * Returns the detected source language or 'en' as fallback.
   */
  async detect(text: string): Promise<TranslationSourceLanguage> {
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
        log.debug('translation.detector.detect-failed', { error: String(err) });
      }
    }

    return detectByUnicodeRange(text) ?? 'en';
  }

  /**
   * Detect language from multiple text samples using majority vote.
   */
  async detectFromSamples(samples: string[]): Promise<TranslationSourceLanguage> {
    const votes = new Map<TranslationSourceLanguage, number>();
    for (const sample of samples) {
      const lang = await this.detect(sample);
      votes.set(lang, (votes.get(lang) ?? 0) + 1);
    }
    if (votes.size === 0) return 'en';
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'en';
  }

  /** Map a BCP 47 language tag to a source language supported by Translator. */
  private mapBcp47(bcp47: string): TranslationSourceLanguage | null {
    const subtags = bcp47
      .trim()
      .replaceAll('_', '-')
      .split('-')
      .filter(Boolean)
      .map((subtag) => subtag.toLowerCase());
    const language = subtags[0];
    switch (language) {
      case 'en':
        return 'en';
      case 'ko':
        return 'ko';
      case 'ja':
        return 'ja';
      case 'es':
        return 'es';
      case 'zh':
        if (subtags.includes('hant')) return 'zh-Hant';
        if (subtags.includes('hans')) return 'zh-Hans';
        if (subtags.some((subtag) => ['tw', 'hk', 'mo'].includes(subtag))) return 'zh-Hant';
        if (subtags.some((subtag) => ['cn', 'sg'].includes(subtag))) return 'zh-Hans';
        return 'zh-CN';
      case 'ar':
        return 'ar';
      default:
        return null;
    }
  }

  destroy(): void {
    this.lifecycleGeneration++;
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
