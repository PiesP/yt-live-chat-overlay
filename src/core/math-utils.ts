// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * General-purpose math utilities.
 */

/**
 * Sample from an exponential distribution with the given mean.
 * Uses the inverse-CDF method: -mean * ln(1 - U) where U ~ Uniform(0, 1).
 */
export function sampleExponential(mean: number): number {
  return -mean * Math.log(Math.max(Number.EPSILON, 1 - Math.random()));
}
