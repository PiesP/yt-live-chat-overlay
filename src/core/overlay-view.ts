/**
 * Minimal view interface for Overlay consumers.
 *
 * Segregates only the DOM container and dimension access needed by Renderer,
 * following the Interface Segregation Principle (ISP).
 */
import type { OverlayDimensions } from '@app-types';

export interface OverlayView {
  getContainer(): HTMLDivElement | null;
  getDimensions(): OverlayDimensions | null;
  onDimensionsChanged(callback: (dimensions: OverlayDimensions | null) => void): () => void;
}
