# Tau — Zig WebGL Renderer Implementation Plan

## Architecture

Two WASM modules in the renderer process:

```
┌─ Renderer Process ────────────────────────────────────────┐
│                                                           │
│  ghostty-vt.wasm (Zig, existing, ~400KB)                  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  bytes → GhosttyCell[] grid (cols × rows)           │  │
│  │  Dirty row tracking, scrollback, cursor state       │  │
│  │  Exports: getViewport(), isRowDirty(), etc.         │  │
│  └─────────────────────────────────────────────────────┘  │
│                         │                                  │
│                         │ GhosttyCell[] (WASM memory)      │
│                         ▼                                  │
│  tau-gl.wasm (Zig, NEW, ~30KB)                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Input:  GhosttyCell[] pointer + count              │  │
│  │  Output: Float32Array vertex buffer (positions,     │  │
│  │          texcoords, fg colors, bg colors)           │  │
│  │                                                     │  │
│  │  For each cell:                                     │  │
│  │    codepoint → atlas slot lookup (hash map)         │  │
│  │    compute (x, y) on screen from (col, row)         │  │
│  │    compute (u, v) in atlas from slot (col, row)     │  │
│  │    pack 4 vertices × 10 floats = 40 floats/cell    │  │
│  │    handle missing glyphs → request atlas update     │  │
│  └─────────────────────────────────────────────────────┘  │
│                         │                                  │
│                         │ Float32Array (shared memory)     │
│                         ▼                                  │
│  WebGL Renderer (TypeScript, ~200 lines)                  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  1. gl.bindTexture(atlas)                           │  │
│  │  2. gl.bufferSubData(vertexBuffer, 0, verts)        │  │
│  │  3. gl.drawElements(TRIANGLES, cellCount * 6, ...)  │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  Atlas Manager (TypeScript, ~150 lines)                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Offscreen canvas rasterizes new glyphs             │  │
│  │  Uploads to WebGL texture when atlas grows           │  │
│  │  Reports atlas layout to tau-gl.wasm                 │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

---

## Phase 0: Baseline Benchmark (Day 0)

Before writing any code, capture the current Canvas 2D performance.

### What to measure

| Metric | How to measure | Current value |
|---|---|---|
| Frame time (idle) | rAF timestamp diff | ~0.5ms |
| Frame time (cat 10MB) | rAF timestamp diff during benchmark data | ~16ms (target 60fps) |
| Frame time (cat 100MB) | Same, larger file | ~30-50ms (drops frames) |
| JS heap (idle) | `performance.memory.usedJSHeapSize` | ~20MB |
| JS heap (after cat 100MB) | Same | ~50MB+ (GC pressure) |
| Cell processing time | Time inside renderLine() | ~0.3ms/row |
| Full redraw time | render() with forceAll=true | ~5ms |
| IPC batching efficiency | Messages/sec during cat | ~60/sec |

### Benchmark script

Add to `bench/renderer-benchmark.ts`:

```typescript
// 1. Inject ghostty-web Terminal into a hidden container
// 2. Write generated terminal data (cat sim, compiler sim, burst sim)
// 3. Measure frame times via rAF instrumentation
// 4. Measure heap before/after
// 5. Output comparison table
```

Run this to capture baseline numbers. Store in `bench/baseline-canvas2d.txt`.

---

## Phase 1: Zig WASM Vertex Packer (Day 1-2)

### What it does

A single exported function:

```zig
// tau-gl/src/main.zig

const std = @import("std");
const Atlas = @import("atlas.zig");
const Vertices = @import("vertices.zig");

var atlas: Atlas = undefined;
var vertex_buffer: Vertices.Buffer = undefined;

// Called once at init — receives atlas dimensions
export fn tau_gl_init(
    atlas_cols: u32,
    atlas_rows: u32,
    atlas_cell_w: u32,
    atlas_cell_h: u32,
    screen_cols: u32,
    screen_rows: u32,
    cell_w: f32,
    cell_h: f32,
) void {
    atlas = Atlas.init(atlas_cols, atlas_rows);
    vertex_buffer = Vertices.Buffer.init(screen_cols, screen_rows);
}

// Called each frame with dirty cell data
// cells_ptr: pointer to GhosttyCell array in WASM memory
// cells_len: number of cells to render
// out_ptr: pointer to Float32Array in shared memory for output vertices
// out_capacity: max number of floats available in output
// Returns: number of floats written (0 if error)
export fn tau_gl_pack_vertices(
    cells_ptr: [*]const GhosttyCell,
    cells_len: u32,
    out_ptr: [*]f32,
    out_capacity: u32,
) u32 {
    return vertex_buffer.pack(cells_ptr[0..cells_len], &atlas, out_ptr, out_capacity);
}

// Add a glyph to the atlas (called when new codepoint appears)
export fn tau_gl_atlas_add(codepoint: u21) bool {
    return atlas.add(codepoint);
}
```

### What the vertex packer does per cell

For each cell (16 bytes, defined by Ghostty):

```
struct GhosttyCell {
    codepoint: u21,    // Unicode codepoint
    fg_r: u8, fg_g: u8, fg_b: u8,  // Foreground RGB
    bg_r: u8, bg_g: u8, bg_b: u8,  // Background RGB
    flags: u8,         // bold, italic, underline, etc.
    width: u8,         // 1 = normal, 2 = wide (CJK)
    hyperlink_id: u32,
    grapheme_len: u8,  // for complex scripts
}
```

Produces 4 vertices (one quad) * 10 floats = 40 floats per cell:

```
Vertex layout:
  float[0..1]: screen_x, screen_y         (position)
  float[2..3]: atlas_u, atlas_v           (texture coordinate)
  float[4..6]: fg_r, fg_g, fg_b          (foreground color, 0-1)
  float[7..9]: bg_r, bg_g, bg_b          (background color, 0-1)
```

4 vertices for a cell at (col, row) with glyph at (atlas_col, atlas_row):

```
Vertex 0 (top-left):     x=col*cellW,        y=row*cellH,        u=atlas_col*cellW/atlasW, v=atlas_row*cellH/atlasH
Vertex 1 (top-right):    x=(col+1)*cellW,    y=row*cellH,        u=(atlas_col+1)*cellW/atlasW, v=atlas_row*cellH/atlasH
Vertex 2 (bottom-right): x=(col+1)*cellW,    y=(row+1)*cellH,    u=(atlas_col+1)*cellW/atlasW, v=(atlas_row+1)*cellH/atlasH
Vertex 3 (bottom-left):  x=col*cellW,        y=(row+1)*cellH,    u=atlas_col*cellW/atlasW, v=(atlas_row+1)*cellH/atlasH
```

All 4 vertices share the same fg_color and bg_color.

### Special cell handling

- **width=2 (CJK)**: Quad spans 2 columns (x extends by 2*cellW). Atlas glyph is also wide.
- **flags & BOLD**: Duplicate the quad shifted 1px right (or use bold glyph variant).
- **flags & ITALIC**: Shear the quad vertices (x += y * 0.2).
- **flags & INVISIBLE**: Skip this cell entirely (don't write vertices).
- **flags & INVERSE**: Swap fg_color and bg_color.
- **flags & UNDERLINE**: Write a second quad (thin rect) below the cell.

### Build system

```bash
# tau-gl/build.zig
# Builds the vertex packer as a standalone WASM module

zig build-exe src/main.zig \
  -target wasm32-freestanding \
  -O ReleaseSmall \
  --export=tau_gl_init \
  --export=tau_gl_pack_vertices \
  --export=tau_gl_atlas_add \
  -fno-entry
```

Output: `tau-gl.wasm` (~30KB)

---

## Phase 2: WebGL Renderer Shell (Day 2-3)

### TypeScript glue (~200 lines)

```typescript
// src/renderer/webgl-renderer.ts

class WebGLRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vertexBuffer: WebGLBuffer
  private indexBuffer: WebGLBuffer
  private atlasTexture: WebGLTexture
  private tauGL: TauGLWasm  // wrapper around tau-gl.wasm

  constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })!

    this.compileShaders()
    this.createBuffers()

    // Load Zig WASM module
    this.tauGL = await TauGLWasm.load('/tau-gl.wasm')
    this.tauGL.init(atlasCols, atlasRows, cellW, cellH, cols, rows, cellW, cellH)
  }

  render(buffer: IRenderable, forceAll: boolean, viewportY: number) {
    const { cols, rows } = buffer.getDimensions()
    const cells = buffer.getViewport() // GhosttyCell[] from WASM memory

    // 1. Pack vertices (Zig WASM — the hot loop)
    const vertexCount = this.tauGL.packVertices(
      cells.buffer,           // pointer to WASM memory
      cells.length,
      this.vertexData.buffer, // Float32Array output
      this.vertexData.length,
    )

    // 2. Upload to GPU (TypeScript)
    if (vertexCount > 0) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer)
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0,
        this.vertexData.subarray(0, vertexCount))
      this.gl.drawElements(this.gl.TRIANGLES,
        (vertexCount / 10) * 6,  // 4 verts × 10 floats → 6 indices per cell
        this.gl.UNSIGNED_SHORT, 0)
    }

    buffer.clearDirty()
  }
}
```

### Shaders

Vertex shader:
```glsl
#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
in vec3 a_fgColor;
in vec3 a_bgColor;

out vec2 v_texCoord;
out vec3 v_fgColor;
out vec3 v_bgColor;

uniform vec2 u_resolution;

void main() {
  vec2 pos = a_position / u_resolution * 2.0 - 1.0;
  pos.y = -pos.y;
  gl_Position = vec4(pos, 0.0, 1.0);
  v_texCoord = a_texCoord;
  v_fgColor = a_fgColor;
  v_bgColor = a_bgColor;
}
```

Fragment shader:
```glsl
#version 300 es
precision highp float;

in vec2 v_texCoord;
in vec3 v_fgColor;
in vec3 v_bgColor;

uniform sampler2D u_atlas;

out vec4 outColor;

void main() {
  float alpha = texture(u_atlas, v_texCoord).r;
  vec3 color = mix(v_bgColor, v_fgColor, alpha);
  outColor = vec4(color, 1.0);
}
```

### Atlas Manager (TypeScript)

```typescript
class AtlasManager {
  private canvas: HTMLCanvasElement  // offscreen
  private ctx: CanvasRenderingContext2D
  private texture: WebGLTexture
  private slots: Map<number, number>  // codepoint → slot index
  private cols: number
  private rows: number
  private cellW: number
  private cellH: number

  constructor(gl: WebGL2RenderingContext, font: string, fontSize: number) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 2048
    this.canvas.height = 2048
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.font = `${fontSize}px ${font}`
    
    // Pre-rasterize ASCII + box-drawing
    this.populateInitialGlyphs()
    this.upload(gl)
  }

  // Called when Zig requests a new glyph
  addGlyph(codepoint: number): boolean {
    if (this.slots.has(codepoint)) return true
    
    const slot = this.findFreeSlot()
    if (slot < 0) return false  // atlas full
    
    const char = String.fromCodePoint(codepoint)
    const col = slot % this.cols
    const row = Math.floor(slot / this.cols)
    this.ctx.fillText(char, col * this.cellW, row * this.cellH + baseline)
    this.slots.set(codepoint, slot)
    return true
  }

  upload(gl: WebGL2RenderingContext) {
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.R8, gl.UNSIGNED_BYTE, this.canvas)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  }
}
```

---

## Phase 3: Integration (Day 3-4)

### Replace ghostty-web's CanvasRenderer

In `terminal.ts`, change:

```typescript
// Before (implicit — ghostty-web creates CanvasRenderer internally)
term.open(container)

// After (explicit — we inject our WebGL renderer)
term.open(container)
term.renderer = new WebGLRenderer(
  term.canvas!,
  { fontSize, fontFamily, theme, cursorStyle }
)
```

ghostty-web's `Terminal` has a `renderer` property that can be replaced. The `CanvasRenderer` and our `WebGLRenderer` implement the same interface.

### Shared memory for vertex buffer

The Zig WASM module writes vertices into a `Float32Array` backed by a `SharedArrayBuffer`. This allows:

1. JavaScript allocates a 256KB `SharedArrayBuffer` (enough for 6,400 floats ≈ 1,600 cells)
2. Passes the buffer to the Zig WASM module
3. Zig writes vertices directly into the JS-visible buffer
4. JavaScript uploads to GPU via `gl.bufferSubData`

No copies, no serialization. The Zig module writes into memory that JavaScript reads directly.

---

## Phase 4: Benchmark (Day 4)

### Run the same benchmark from Phase 0

Compare:

| Metric | Canvas 2D (before) | WebGL + Zig (after) | Improvement |
|---|---|---|---|
| Frame time (idle) | ~0.5ms | ~0.1ms | 5× |
| Frame time (cat 10MB) | ~16ms | ~3ms | 5× |
| Frame time (cat 100MB) | ~30-50ms | ~5-8ms | 5-6× |
| Full redraw | ~5ms | ~1ms | 5× |
| JS heap (idle) | ~20MB | ~15MB | 25% less |
| GC pauses | occasional | none | eliminated |
| Cell processing | JS loop, 0.3ms/row | Zig loop, ~0.05ms/row | 6× |

Expected overall: **3-5× frame time reduction** for common workloads, **elimination of GC pauses** during heavy output.

---

## Phase 5: Polish (Day 5-6)

- Cursor rendering (block/bar/underline)
- Selection highlighting
- Scrollbar
- Bold/italic/underline/strikethrough
- CJK wide character support
- Complex grapheme clusters (via `getGrapheme()`)
- Hyperlink underlines
- Smooth scrolling

---

## Directory Structure

```
tau/
├── tau-gl/                    # Zig WASM module
│   ├── build.zig
│   ├── src/
│   │   ├── main.zig           # Exports: init, pack_vertices, atlas_add
│   │   ├── atlas.zig          # Glyph → atlas slot lookup
│   │   ├── vertices.zig       # GhosttyCell → vertex buffer packing
│   │   └── types.zig          # GhosttyCell struct definition
│   └── README.md
├── src/renderer/
│   ├── webgl-renderer.ts      # WebGL renderer (replaces CanvasRenderer)
│   ├── atlas-manager.ts       # Offscreen canvas → GPU texture
│   ├── shaders.ts             # GLSL source strings
│   └── tau-gl-bridge.ts       # JS ↔ Zig WASM bridge
├── bench/
│   ├── renderer-benchmark.ts  # BEFORE/AFTER benchmark script
│   └── baseline-canvas2d.txt  # Captured baseline numbers
└── docs/
    └── WEBGL_RENDERER_PLAN.md # This document
```

---

## Zig Setup (first time)

```bash
# Install Zig (if not already)
brew install zig

# Verify
zig version  # Should be 0.14.x or later

# Build the WASM module
cd tau-gl
zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall

# Output: zig-out/bin/tau-gl.wasm (~30KB)
```
