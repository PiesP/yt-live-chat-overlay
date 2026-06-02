// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * SDF Vertex Shader — GLSL 3.00 ES
 *
 * Renders instanced quads for each character glyph.
 * Per-instance attributes (divisor=1): offset, scale, glyphIndex, color, opacity
 * Per-vertex attributes (divisor=0): quad position and UV
 */
export const SDF_VERTEX_SHADER = `#version 300 es
precision highp float;

// Per-vertex (quad geometry)
layout(location = 0) in vec2 a_quadPos;   // (0,0)-(1,1) quad
layout(location = 1) in vec2 a_quadUV;    // (0,0)-(1,1) UV

// Per-instance (one per character)
layout(location = 2) in vec2  a_offset;     // screen position (CSS px)
layout(location = 3) in vec2  a_scale;      // glyph size (CSS px)
layout(location = 4) in float a_glyphIndex; // linear index in atlas grid
layout(location = 5) in vec3  a_color;      // RGB (0-1)
layout(location = 6) in float a_opacity;    // alpha (0-1)

uniform vec2 u_viewport;   // canvas CSS width/height
uniform float u_atlasSize; // atlas texture size (2048.0)
uniform float u_cellSize;  // glyph cell size in atlas (44.0)

out vec3 v_color;
out float v_opacity;
out vec2 v_glyphUV;

void main() {
  // Quad vertex position in CSS pixel space
  vec2 pos = a_quadPos * a_scale + a_offset;

  // Convert to NDC (-1 to 1)
  vec2 ndc = (pos / u_viewport) * 2.0 - 1.0;
  // Flip Y: CSS top-left origin → WebGL bottom-left origin
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);

  // Compute atlas UV from glyphIndex
  float gridSize = floor(u_atlasSize / u_cellSize);
  float col = mod(a_glyphIndex, gridSize);
  float row = floor(a_glyphIndex / gridSize);

  // Map quad UV to atlas cell
  v_glyphUV = (vec2(col, row) + a_quadUV) * (u_cellSize / u_atlasSize);

  v_color = a_color;
  v_opacity = a_opacity;
}
`;

/**
 * SDF Fragment Shader — GLSL 3.00 ES
 *
 * Samples the SDF atlas texture and computes per-pixel alpha.
 * Supports glyph body + outline in a single pass.
 */
export const SDF_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_opacity;
in vec2 v_glyphUV;

uniform sampler2D u_atlas;
uniform float u_distanceRange;   // SDF distance range (e.g. 12.0 for 6px*2)
uniform float u_outlineWidth;    // outline width in SDF units (0 = no outline)
uniform vec3  u_outlineColor;    // outline RGB
uniform float u_outlineOpacity;  // outline alpha

out vec4 fragColor;

void main() {
  float dist = texture(u_atlas, v_glyphUV).r;
  float signedDist = (dist - 0.5) * u_distanceRange * 2.0;

  // Glyph body alpha
  float glyphAlpha = smoothstep(-0.5, 0.5, signedDist);

  // Outline alpha (outer edge of glyph)
  float outlineAlpha = 0.0;
  if (u_outlineWidth > 0.0 && u_outlineOpacity > 0.0) {
    outlineAlpha = smoothstep(-0.5 - u_outlineWidth, -0.5, signedDist);
  }

  // Composite: outline behind glyph body
  float outlineContrib = outlineAlpha * (1.0 - glyphAlpha) * u_outlineOpacity;
  vec3 finalColor = mix(u_outlineColor, v_color, glyphAlpha);
  float finalAlpha = glyphAlpha * v_opacity + outlineContrib * v_opacity;

  fragColor = vec4(finalColor * finalAlpha, finalAlpha);
}
`;
