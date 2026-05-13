# Tau — WebGL Glyph Atlas Renderer Plan

## Part 1: How ghostty-web's CanvasRenderer Works Now

The current renderer (`CanvasRenderer` in ghostty-web) uses the HTML5 **Canvas 2D API**.
Every frame (60fps via `requestAnimationFrame`):

```
renderFrame():
  1. wasmTerm.update()          ← WASM tracks dirty rows
  2. For each dirty row:
     renderLine(cells, y, cols):
       a. ctx.clearRect(...)    ← clear this row
       b. ctx.fillRect(bg)      ← draw background for row
       c. PASS 1: for each cell:
            renderCellBackground(cell, x, y)
              → ctx.fillStyle = rgb(cell.bg_r, cell.bg_g, cell.bg_b)
              → ctx.fillRect(x * charW, y * charH, charW, charH)
       d. PASS 2: for each cell:
            renderCellText(cell, x, y)
              → ctx.font = "bold/italic Npx fontFamily"
              → ctx.fillStyle = rgb(cell.fg_r, cell.fg_g, cell.fg_b)
              → ctx.fillText(char, x * charW, y * charH + baseline)
              → if underline: ctx.fillRect(underline)
  3. renderCursor(x, y)
  4. renderScrollbar(...)
  5. wasmTerm.markClean()
```

### What's expensive about this

**Every frame, every visible cell, Chromium's Skia does:**

1. **Font shaping** — `ctx.font = "14px Menlo"` followed by `ctx.fillText("A", ...)` causes Skia to:
   - Look up the font in the system font cache
   - Shape the glyph (convert Unicode → glyph ID)
   - Rasterize the glyph at the current size (if not cached)
   - Upload the rasterized glyph to a GPU texture atlas (Skia maintains its own)
   - Draw the glyph

2. **State changes** — Every time `ctx.fillStyle` or `ctx.font` changes (potentially every cell), the GPU command buffer is flushed and a new draw call is issued.

3. **Per-glyph rasterization** — Even though Skia caches rasterized glyphs, the initial rasterization (first time a glyph is drawn at a given size) is CPU work. For a terminal with 2,400 cells (80×30), this happens for every unique glyph in the first few frames.

4. **No batching** — Each cell is drawn with an individual `fillRect` + `fillText` call. For 2,400 cells per frame (full redraw), that's ~4,800 Canvas 2D calls. Chromium batches these internally, but there's still overhead.

### Why it's still fast enough

- **Dirty-row tracking**: ghostty-web only redraws rows that changed. In practice, only 1-5 rows change per frame (cursor line, new output). That's ~100-500 cells per frame, not 2,400.
- **Chromium's Skia is well-optimized**: Skia caches glyph rasters, batches draw calls internally, and uses GPU texturing.
- **Canvas 2D is GPU-accelerated**: Chromium promotes the canvas to a GPU texture and composites it efficiently.

---

## Part 2: How Native Terminals Render

Native terminals (Alacritty, Kitty, Ghostty, WezTerm) all use the same pattern:

### The Glyph Atlas

```
┌─────────────────────────────────────┐
│  A  B  C  D  E  F  G  H  I  J  ... │  ← One big GPU texture (e.g., 2048×2048)
│  a  b  c  d  e  f  g  h  i  j  ... │     Each glyph is rasterized ONCE
│  0  1  2  3  4  5  6  7  8  9  ... │     at font-load time.
│  !  @  #  $  %  ^  &  *  (  ) ... │
│  ...                                │
└─────────────────────────────────────┘
```

The atlas is a **monospace grid**: each glyph occupies the same-sized rectangle (cellW × cellH). Glyph (row, col) is at position (col * cellW, row * cellH) in the atlas texture.

### Per-frame rendering

For a terminal of 80×24 = 1,920 cells, the GPU draws **1,920 textured quads**:

```
for each visible cell:
  glyph_id = cell.codepoint
  (atlas_col, atlas_row) = atlas.lookup(glyph_id)
  
  draw_quad(
    position:  (screen_x, screen_y, charW, charH),
    texcoords: (atlas_col * charW / atlasW, atlas_row * charH / atlasH, ...),
    color:     (fg_r / 255, fg_g / 255, fg_b / 255),
  )
```

All 1,920 quads are drawn in **one or two GPU draw calls** (instanced rendering).

### Why this is faster

| Canvas 2D (current) | WebGL Glyph Atlas (plan) |
|---|---|
| Per-cell `ctx.fillText()` call | Per-cell vertex in a single GPU buffer |
| Skia font shaping per cell per frame | Font shaping done ONCE at atlas build time |
| CPU rasterizes new glyphs on demand | All glyphs pre-rasterized on GPU |
| ~2 draw calls per cell (bg + text) | ~2 draw calls for ENTIRE FRAME |
| GPU state changes per cell | Single shader, single atlas texture |

The difference is moving from **immediate-mode drawing** (CPU tells GPU what to draw step by step) to **retained-mode drawing** (GPU already has all the data, CPU just says "draw these 1,920 quads from this texture").

---

## Part 3: How to Build a WebGL Glyph Atlas Renderer

### Step 1: Build the atlas

```typescript
class GlyphAtlas {
  private texture: WebGLTexture
  private glyphs: Map<number, { col: number; row: number }>
  private cols: number
  private rows: number
  private cellW: number
  private cellH: number

  constructor(gl: WebGLRenderingContext, font: string, fontSize: number) {
    // 1. Measure font metrics
    const metrics = measureFont(font, fontSize)
    this.cellW = metrics.width
    this.cellH = metrics.height

    // 2. Create an offscreen 2D canvas to rasterize glyphs
    const offscreen = document.createElement('canvas')
    offscreen.width = 2048
    offscreen.height = 2048
    const ctx = offscreen.getContext('2d')!
    ctx.font = `${fontSize}px ${font}`

    // 3. Rasterize every glyph we'll need
    // For a terminal, this is typically ASCII 32-126 + common Unicode
    this.cols = Math.floor(2048 / this.cellW)
    this.rows = Math.floor(2048 / this.cellH)
    this.glyphs = new Map()

    let col = 0, row = 0
    for (const codepoint of GLYPH_RANGE) {
      const char = String.fromCodePoint(codepoint)
      ctx.fillText(char, col * this.cellW, row * this.cellH + metrics.baseline)
      this.glyphs.set(codepoint, { col, row })
      col++
      if (col >= this.cols) { col = 0; row++ }
    }

    // 4. Upload the offscreen canvas as a WebGL texture
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreen)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  }

  // Look up a glyph's position in the atlas
  getGlyph(codepoint: number): { col: number; row: number } | null {
    return this.glyphs.get(codepoint) ?? null
  }
}
```

### Step 2: Build the vertex buffer

For each frame, we upload all visible cells as a vertex buffer. Each cell is **one textured quad** = **6 vertices** (2 triangles) = **4 unique vertices** with an index buffer.

```typescript
interface CellVertex {
  x: number      // screen position
  y: number
  u: number      // atlas texture coordinate
  v: number
  fgR: number    // foreground color (normalized 0-1)
  fgG: number
  fgB: number
  bgR: number    // background color
  bgG: number
  bgB: number
  flags: number  // bold, italic, underline, etc.
}
```

Each frame:
1. Get dirty cells from WASM (`wasmTerm.getViewport()`)
2. For each cell, write vertices into a `Float32Array`
3. Upload the buffer to the GPU with `gl.bufferSubData()`
4. One draw call: `gl.drawElements(gl.TRIANGLES, cellCount * 6, gl.UNSIGNED_SHORT, 0)`

### Step 3: The shaders

**Vertex shader:**
```glsl
attribute vec2 a_position;   // screen position
attribute vec2 a_texCoord;   // atlas texture coordinate
attribute vec3 a_fgColor;    // foreground RGB
attribute vec3 a_bgColor;    // background RGB
attribute float a_flags;     // style flags

varying vec2 v_texCoord;
varying vec3 v_fgColor;
varying vec3 v_bgColor;
varying float v_flags;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
  v_fgColor = a_fgColor;
  v_bgColor = a_bgColor;
  v_flags = a_flags;
}
```

**Fragment shader:**
```glsl
precision mediump float;

uniform sampler2D u_atlas;
varying vec2 v_texCoord;
varying vec3 v_fgColor;
varying vec3 v_bgColor;
varying float v_flags;

void main() {
  // Sample the glyph from the atlas
  float alpha = texture2D(u_atlas, v_texCoord).a;
  
  // Blend foreground color with glyph alpha
  vec3 color = mix(v_bgColor, v_fgColor, alpha);
  
  gl_FragColor = vec4(color, 1.0);
}
```

This shader does in **one GPU instruction** what Canvas 2D does with multiple CPU calls: it composites the glyph over the background color.

### Step 4: Handle bold, italic, underline

- **Bold**: Draw the glyph twice, offset by 1 pixel horizontally (or use a separate bold glyph in the atlas)
- **Italic**: Skew the quad's vertices horizontally
- **Underline**: Draw a thin quad below the glyph (separate vertex buffer or extra attribute)
- **Strikethrough**: Same as underline but through the middle
- **Inverse**: Swap foreground and background colors in the shader
- **Blink**: Toggle visibility every N frames
- **Faint/Dim**: Multiply foreground color by 0.5 in the shader

### Step 5: Atlas eviction for on-demand glyphs

The atlas can't hold every Unicode character (there are 150,000+). Strategy:
1. **Pre-load**: ASCII 32-126, common box-drawing chars (│─┌┐└┘), Powerline symbols
2. **On-demand**: When a new glyph appears, rasterize it into the next free atlas slot
3. **LRU eviction**: When the atlas is full, evict least-recently-used glyphs
4. **Multi-atlas**: If one 2048×2048 atlas fills up, allocate another

---

## Part 4: Implementation Plan (What We Build)

### Phase 1: Replace CanvasRenderer (Week 1)

1. **Create `src/renderer/webgl-renderer.ts`** — Implements the same interface as ghostty-web's `CanvasRenderer`:
   ```typescript
   interface IRenderer {
     render(buffer: IRenderable, forceAll?: boolean, viewportY?: number): void
     resize(cols: number, rows: number): void
     setTheme(theme: ITheme): void
     setFontSize(size: number): void
     setCursorStyle(style: 'block' | 'underline' | 'bar'): void
     dispose(): void
   }
   ```

2. **Initialize WebGL context** — Get a WebGL context from the canvas (instead of 2D)

3. **Build glyph atlas** — On font load, rasterize ASCII + box-drawing chars into a GPU texture

4. **Build vertex buffer** — Pre-allocate a ` Float32Array ` for the maximum grid (cols × rows × 4 vertices × 8 floats/vertex)

5. **Write shaders** — Simple textured quad shaders

6. **Per-frame render**:
   ```
   renderFrame():
     1. wasmTerm.update()
     2. Read dirty cells from WASM (getViewport)
     3. For each dirty cell:
        a. Look up glyph in atlas (on-demand if missing)
        b. Write vertices into Float32Array
     4. gl.bufferSubData(vertexBuffer, verts)
     5. gl.drawElements(TRIANGLES, cellCount * 6, ...)
     6. Repeat pass 2 for backgrounds (or combine in one pass)
     7. wasmTerm.markClean()
   ```

### Phase 2: Benchmark (Week 2)

Compare before/after:
- FPS during `cat 100MB-file`
- Frame time distribution (JS vertex building vs GPU draw)
- Memory for atlas texture vs Skia's internal caches
- First-render latency (atlas build time)

### Phase 3: Polish (Week 2-3)

- On-demand glyph rasterization
- Bold/italic/underline/strikethrough
- Cursor rendering (block/bar/underline)
- Selection highlighting
- Scrollbar
- Link underlines

---

## Part 5: Key WebGL Concepts You Need

### Context creation
```typescript
const gl = canvas.getContext('webgl', {
  alpha: false,        // Opaque background (faster)
  antialias: false,    // We do our own pixel-snapping
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,  // Don't keep a copy (faster)
})
```

### Buffer management
- **Vertex Buffer Object (VBO)**: Stores vertex data (positions, colors, texcoords) on GPU
- **Index Buffer Object (IBO)**: Stores triangle indices to reuse vertices (each quad = 4 vertices + 6 indices)
- **Dynamic draw**: `gl.bufferSubData()` updates only changed portions of the buffer each frame

### Shader compilation
```typescript
function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader)!)
  }
  return shader
}
```

### Drawing
```typescript
gl.useProgram(program)
gl.bindTexture(gl.TEXTURE_2D, atlas.texture)
gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
// Set up attributes...
gl.drawElements(gl.TRIANGLES, cellCount * 6, gl.UNSIGNED_SHORT, 0)
```

### The key insight

The Canvas 2D API is built on top of Skia, which is built on top of the same GPU APIs (Metal/OpenGL) we'd use directly with WebGL. The difference is:

- **Canvas 2D**: You describe WHAT to draw ("fillText 'A' at (10, 20) in red") and Skia translates that into GPU commands. Every call has interpretation overhead.
- **WebGL**: You describe HOW to draw ("here's 2,400 quads in this buffer, use this atlas texture, run this shader") and the GPU executes it directly. The CPU builds the buffer once, the GPU draws everything in one shot.

For a terminal with 1,920 cells, Canvas 2D makes ~3,800 API calls per frame. WebGL makes **~3 API calls** per frame (buffer upload, bind texture, draw elements). The GPU does the same work either way — the win is eliminating the CPU overhead of 3,800 API calls.
