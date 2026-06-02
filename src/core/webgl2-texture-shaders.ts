// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * WebGL2 texture shaders — simple textured quad rendering (no SDF).
 *
 * Used for emoji rendering and solid-color card backgrounds.
 * Shares the same VAO attribute layout as the SDF program so we can
 * reuse a single VAO across both draw passes.
 */

// GLSL 3.00 ES — simple textured quad, no SDF
export const TEXTURE_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_quadPos;
layout(location = 1) in vec2 a_quadUV;
layout(location = 2) in vec2 a_offset;
layout(location = 3) in vec2 a_scale;
layout(location = 4) in float a_texIndex;
layout(location = 5) in vec3 a_color;
layout(location = 6) in float a_opacity;
uniform vec2 u_viewport;
out vec2 v_uv;
out vec3 v_color;
out float v_opacity;
void main() {
  vec2 pos = a_quadPos * a_scale + a_offset;
  vec2 ndc = (pos / u_viewport) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_uv = a_quadUV;
  v_color = a_color;
  v_opacity = a_opacity;
}`;

export const TEXTURE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_color;
in float v_opacity;
uniform sampler2D u_texture;
out vec4 fragColor;
void main() {
  vec4 tex = texture(u_texture, v_uv);
  // Multiply texture color by instance color and opacity
  fragColor = vec4(tex.rgb * v_color * v_opacity, tex.a * v_opacity);
}`;
