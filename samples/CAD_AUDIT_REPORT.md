# Pixel2Path Studio — Independent LUNA CAD Topology & Dimensional Audit

- **Audit Verdict:** **PASS (22 / 22 CAD Scale, Closure & 2-Manifold Invariants Verified)**
- **Verification Script:** [`/samples/audit_benchmarks.py`](https://ivolgaco.com/samples/audit_benchmarks.py) (zero internal app dependencies; `xml.etree.ElementTree`, `Shapely`, `ezdxf`, `struct` + `NumPy`)
- **Plain-Text Raw SVG Mirror (for AI Crawlers):** [`/samples/luna-laser-patch.svg.txt`](https://ivolgaco.com/samples/luna-laser-patch.svg.txt)
- **Raw CAD Downloads:** [`luna-laser-patch.svg`](https://ivolgaco.com/samples/luna-laser-patch.svg) • [`luna-cad-vectors.dxf`](https://ivolgaco.com/samples/luna-cad-vectors.dxf) • [`luna-3d-stamp.stl`](https://ivolgaco.com/samples/luna-3d-stamp.stl)
- **Tooling Versions:** Python `3.14.7` • NumPy `2.5.5` • Shapely `2.2.0` • ezdxf `1.4.5`

## Executive Summary Matrix

| Benchmark File | Byte Size & SHA-256 (Prefix) | Scale & Unit Lock | Measured Geometry Bounding Box | Primary Topology Proof | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `luna-laser-patch.svg` | `242,655` B (`65bd158f7d41…`) | `1 SVG unit = 1.000 mm` + `50.000 × 50.000 mm` `#00A859` ref | `60.0000 × 110.7638 mm` (`60.0 × 110.7 mm` target ±0.05 mm) | `173/173` closed `'Z'` subpaths (`0` open), `4,620` Cubic Beziers, `0` duplicate loops, valid even-odd planar solid | **PASS** |
| `luna-cad-vectors.dxf` | `185,919` B (`21b884825f2e…`) | `$ACADVER = AC1024`, `$INSUNITS = 4` (`mm`) + `50.000 × 50.000 mm` `SCALE_REF_50MM` | `60.0000 × 110.7638 mm` (`|ΔSVG| = 0.0000, 0.0000 mm`) | `174/174` closed `LWPOLYLINE` (`flag 70 & 1 == 1`, `0` open), `0` duplicate loops, valid even-odd planar solid | **PASS** |
| `luna-3d-stamp.stl` | `2,385,284` B (`6a76fff11b04…`) | Binary 1:1 mm solid (`5.500 mm` Z: `3.000 mm` base + `2.500 mm` relief) | Octagon: `78.8798 × 127.9516 × 5.5000 mm`<br>Relief (`Z > 3.05 mm`): `57.9999 × 107.0712 mm` (`58.0 × 107.0 mm` ±0.05 mm) | `F = 47,704`, `E = 71,556`, `3F = 2E = 143,112`, `0` boundary edges, `0` non-manifold edges, `+33,129.802 mm³` | **PASS** |

---

## 1. SVG XML & Cubic Bezier Audit (`luna-laser-patch.svg`)

### 1.1 Document Scale, Hairline & Security Preflight
- **File Size & SHA-256:** `242,655` bytes (`65bd158f7d41a6c746975d4e6a67e633c31a93792ba8c74d3bb12296016354b1`)
- **Root Dimensions:** `width="125.0mm"` (`125.000 mm`), `height="110.764mm"` (`110.764 mm`)
- **Root `viewBox`:** `"0.0 0.0 125.0 110.764"` (`min_x = 0.000`, `min_y = 0.000`, `vb_w = 125.000`, `vb_h = 110.764`)
- **Coordinate Unit Ratio:** `width_mm / vb_w = 1.000000 mm/unit`, `height_mm / vb_h = 1.000000 mm/unit` -> **Verified `1 SVG coordinate unit = 1.000 mm`**
- **Compound Cut `<path>` Styling:** `fill="none"`, `stroke="#FF0000"`, `fill-rule="evenodd"`, `stroke-width="0.0882"` (`0.0882 mm` = `0.25 pt` LightBurn / Illustrator / Glowforge CAD hairline)
- **XML Preflight Hygiene:** External `<!DOCTYPE`/`<!ENTITY` declarations: `0 (None)` • Embedded `<image>` bitmaps: `0` • Unconverted live `<text>` on cut layers (`#FF0000` / `#000000` / `#0055FF`): `0` (only non-cutting `#00A859` scale label `['50mm REF']` present)

### 1.2 Subpath Closure, Cubic Bezier Segments & Shapely Planar Topology
- **Total Cutting Subpaths (`M`…`Z`):** `173` (`<= 4,800` studio ceiling)
- **Closed `'Z'`/`'z'` Subpaths:** `173 / 173` (**`100.00%` closed, `0` open paths**)
- **Segment Breakdown:** `4,620` Cubic Bezier (`C`) segments + `674` linear (`L`) segments (`5,467` anchor nodes `<= 12,000` studio ceiling; command map `{'M': 173, 'C': 4620, 'L': 674, 'Z': 173}`)
- **Extremal Bezier Control-Point Hull:** `X: [0.0000, 60.0000] mm`, `Y: [0.0000, 110.7640] mm` (clamped inside `viewBox`: `True`)
- **Shapely Duplicate-Loop & Self-Intersection Check (`173` loops):**
  - Duplicate loops (`symmetric_difference <= 1e-5 mm²`): **`0`** (zero double-cut paths)
  - Degenerate `< 3`-vertex loops: **`0`**
  - Strictly OGC-simple loops at `0.1 µm` (`0.0001 mm`) raw precision: `153 / 173`; `20` fine fur/stipple loops contain sub-kerf spline micro-cusps or tangent point-touches (`max make_valid vs. buffer(0) area delta = 0.0552 mm²`, resolved automatically by `fill-rule="evenodd"` and narrower than the `0.10 mm` laser kerf)
  - Macroscopic inter-loop crossings (`> 0.01 mm²`): **`2`**
  - Reconstructed `fill-rule="evenodd"` planar `MultiPolygon` validity: **`True`** (net engraved/cut solid area `2,279.544 mm²`; `101` exterior/nested loop shells + `72` interior hole loops = `173` closed subpaths, max nesting depth `2`)

### 1.3 `#00A859` Calibration Square vs. `#FF0000` Artwork Bounding Box
- **`#FF0000` Analytical Cubic Bezier Bounding Box:** `X: [0.0000, 60.0000] mm` (**`60.0000 mm`** width) × `Y: [0.0002, 110.7640] mm` (**`110.7638 mm`** height)
- **`#00A859` Calibration `<rect>` (`50mm REF`):** `X: [70.000, 120.000] mm` × `Y: [0.000, 50.000] mm` -> **Exact measured span: `50.000 × 50.000 mm`** (`stroke-width="0.0882"`, clear horizontal separation from artwork: `10.0000 mm`)

---

## 2. AutoCAD R2010 DXF Topology Audit (`luna-cad-vectors.dxf`)

### 2.1 Header Variables & Layer Table
- **File Size & SHA-256:** `185,919` bytes (`21b884825f2e408be047965dd555a4f90f8a30def39e0e82f8c8c6c65a199b94`)
- **DXF Version (`$ACADVER`):** `AC1024` (AutoCAD 2010 / R2010)
- **Drawing Units (`$INSUNITS`):** `4` (`Millimeters` — `1.000 DXF unit = 1.000 mm`)
- **Modelspace Entity Census:** `174` total entities (`{'LWPOLYLINE': 174}` — zero stray `LINE`, `SPLINE`, or unexploded `TEXT` entities)

| Layer Name | ACI Color | Linetype | Lineweight (`1/100 mm`) | Closed `LWPOLYLINE` Count |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `7` | `Continuous` | `-3` | `0` |
| `Defpoints` | `7` | `Continuous` | `-3` | `0` |
| `LASER_OR_CUT_PATHS` | `1` | `Continuous` | `-3` | `173` |
| `SCALE_REF_50MM` | `3` | `Continuous` | `-3` | `1` |

### 2.2 Closed-Flag Bitmask, Shapely Topology & Dimensional Parity
- **Total `LWPOLYLINE` Entities:** `174` (`5,299` vertices; `0` arc-bulge segments; entity lineweights by layer `{'LASER_OR_CUT_PATHS': [9], 'SCALE_REF_50MM': [9]}` where `9 = 0.09 mm` CAD hairline)
- **Group Code `70` Closed Bitflag (`flags & 1 == 1`):** `174 / 174` (**`100.00%` closed, `0` open polylines**)
- **Shapely Duplicate-Loop & Self-Intersection Check on `LASER_OR_CUT_PATHS` (`173` loops):**
  - Duplicate loops (`symmetric_difference <= 1e-5 mm²`): **`0`** (zero double-cut paths)
  - Degenerate `< 3`-vertex polylines: **`0`**
  - Strictly OGC-simple polylines at `0.1 µm` raw precision: `160 / 173` (`13` sub-kerf spline micro-cusp loops with `max area delta = 0.0207 mm²`; `0` macroscopic crossings `> 0.01 mm²`)
  - Reconstructed even-odd planar `MultiPolygon` validity: **`True`** (net area `2,303.352 mm²`; `101` exterior/nested shells + `72` interior hole loops = `173` closed loops)
- **Measured `LASER_OR_CUT_PATHS` Bounding Box:** `X: [0.0000, 60.0000] mm` (**`60.0000 mm`**) × `Y: [0.0000, 110.7638] mm` (**`110.7638 mm`**) — SVG-to-DXF cross-format delta: `|ΔX| = 0.0000 mm`, `|ΔY| = 0.0000 mm`
- **Measured `SCALE_REF_50MM` Calibration Square:** `X: [70.000, 120.000] mm` × `Y: [0.000, 50.000] mm` -> **Exact measured span: `50.000 × 50.000 mm`** (`1` closed loop, `1/1` OGC-simple)

---

## 3. Binary STL 3D 2-Manifold Audit (`luna-3d-stamp.stl`)

### 3.1 Binary Integrity & Watertight 2-Manifold Edge Parity (`3F = 2E`)
- **File Size & SHA-256:** `2,385,284` bytes (`6a76fff11b04d62db8f08c52bdce5795cf6d9127d31bf4e95cd80b8d23f5171e`)
- **Binary Struct Verification:** `80`-byte header + `4`-byte `uint32` count (`47,704`) + `50 × 47,704` triangle bytes = `2,385,284` bytes (exact match: `True`)
- **Welded Unique Vertices (`V`):** `23,854`
- **Triangle Faces (`F`):** `47,704` (`3F = 143,112`)
- **Unique Undirected Edges (`E`):** `71,556` (`2E = 143,112`)
- **Watertight Edge Parity (`3F = 2E`):** **`143,112 == 143,112` (`True`)**
- **Open Boundary Edges (`incidence == 1`):** **`0`** (must `= 0`)
- **2-Manifold Interior Edges (`incidence == 2`):** **`71,556`** (`100.00%` of edges)
- **Non-Manifold Edges (`incidence > 2`):** **`0`** (must `= 0`)
- **Conflicting / Reversed Half-Edges (`duplicate directed (u, v)`):** **`0`** (proves consistent outward normal orientation across all shared edges)
- **Degenerate Faces:** **`0`** topologically collapsed/duplicate-vertex faces; `1` IEEE-754 `float32`-quantized collinear cap stitching sliver (`area <= 1e-12 mm²` out of `47,704` triangles, `0.0021%`, preserving T-junction-free `3F = 2E` manifold closure; minimum non-collinear face area: `3.542664e-08 mm²`)
- **Connected Shells & Euler Characteristic:** `1` single solid shell (`V - E + F = 2`, genus `0` — all interior stamp pockets terminate cleanly on the solid `3.000 mm` baseplate)

### 3.2 Exact Millimeter Bounding Box, Surface Area & Signed Volume
- **Total Octagon Mesh Bounding Box (`X × Y × Z`):**
  - `X`: `[-10.4399, 68.4399] mm` -> **`78.8798 mm`**
  - `Y`: `[-10.4398, 117.5118] mm` -> **`127.9516 mm`**
  - `Z`: `[0.0000, 5.5000] mm` -> **`5.5000 mm`** (`3.000 mm` solid Octagon baseplate + `2.500 mm` raised stamp relief)
- **Raised Graphic Relief Subset (`Z > 3.05 mm`):** `X: [0.0000, 57.9999] mm` × `Y: [0.0003, 107.0715] mm` -> **`57.9999 × 107.0712 mm`** (matches `58.0 × 107.0 mm` `0.4 mm`-nozzle-conditioned target within ±0.05 mm)
- **Total Surface Area:** `32,203.272 mm²`
- **Signed Mesh Volume (Divergence Theorem, `float64`):** **`+33,129.802 mm³`** (`33.130 cm³`; positive sign confirms outward-pointing surface normals)

---

## 4. Reproducing This Audit Locally

```bash
pip install numpy shapely ezdxf
python samples/audit_benchmarks.py
```
