declare module 'bidi-js' {
  export interface BidiParagraph {
    readonly start: number;
    readonly end: number;
    readonly level: number;
  }

  export interface BidiEmbeddingLevels {
    readonly levels: Uint8Array;
    readonly paragraphs: readonly BidiParagraph[];
  }

  export interface BidiApi {
    getBidiCharTypeName(character: string): string;
    getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl' | 'auto'): BidiEmbeddingLevels;
    getReorderSegments(
      text: string,
      embeddingLevels: BidiEmbeddingLevels,
      start?: number,
      end?: number
    ): Array<readonly [start: number, end: number]>;
    getReorderedIndices(
      text: string,
      embeddingLevels: BidiEmbeddingLevels,
      start?: number,
      end?: number
    ): number[];
  }

  export default function bidiFactory(): BidiApi;
}
