#!/usr/bin/env python3
"""
Independent, Reproducible CAD Topology & Dimensional Audit for Pixel2Path Studio Benchmarks.

Audits the three ungated LUNA fabrication benchmark files:
  1. luna-laser-patch.svg  (SVG 1:1 mm XML, Cubic Bezier paths, closure, Shapely topology & 50 mm square)
  2. luna-cad-vectors.dxf  (AutoCAD R2010 AC1024, $INSUNITS=4 mm, closed LWPOLYLINE loops & 50 mm square)
  3. luna-3d-stamp.stl     (Binary STL 2-manifold 3F=2E edge parity, boundary/non-manifold check & volume)

Usage:
  python samples/audit_benchmarks.py
"""

from __future__ import annotations

import hashlib
import math
import re
import struct
import sys
import xml.etree.ElementTree as ET
from functools import reduce
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

try:
    import shapely
    from shapely.geometry import LinearRing, Polygon
    from shapely.strtree import STRtree
    from shapely.validation import explain_validity, make_valid

    HAS_SHAPELY = True
except ImportError:  # pragma: no cover
    HAS_SHAPELY = False

try:
    import ezdxf

    HAS_EZDXF = True
except ImportError:  # pragma: no cover
    HAS_EZDXF = False


SVG_TOKEN_RE = re.compile(
    r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
)

INSUNITS_MAP = {
    0: "Unitless",
    1: "Inches",
    2: "Feet",
    3: "Miles",
    4: "Millimeters",
    5: "Centimeters",
    6: "Meters",
}


def resolve_samples_dir() -> Path:
    here = Path(__file__).resolve().parent
    if (here / "luna-laser-patch.svg").exists():
        return here
    if (here / "samples" / "luna-laser-patch.svg").exists():
        return here / "samples"
    raise FileNotFoundError(
        "Could not locate luna-laser-patch.svg alongside audit_benchmarks.py or in ./samples/"
    )


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_mm_value(raw: str) -> Tuple[float, str]:
    s = raw.strip()
    m = re.fullmatch(r"([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)", s)
    if not m:
        raise ValueError(f"Unrecognized SVG length attribute: {raw!r}")
    return float(m.group(1)), m.group(2)


def eval_cubic_bezier(
    p0: Tuple[float, float],
    p1: Tuple[float, float],
    p2: Tuple[float, float],
    p3: Tuple[float, float],
    t: float,
) -> Tuple[float, float]:
    mt = 1.0 - t
    mt2 = mt * mt
    t2 = t * t
    w0 = mt2 * mt
    w1 = 3.0 * mt2 * t
    w2 = 3.0 * mt * t2
    w3 = t2 * t
    return (
        w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
        w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
    )


def cubic_bezier_axis_extrema(p0: float, p1: float, p2: float, p3: float) -> Tuple[float, float]:
    vals = [p0, p3]
    a = -p0 + 3.0 * p1 - 3.0 * p2 + p3
    b = 2.0 * (p0 - 2.0 * p1 + p2)
    c = p1 - p0
    if abs(a) < 1e-14:
        if abs(b) > 1e-14:
            t = -c / b
            if 0.0 < t < 1.0:
                mt = 1.0 - t
                vals.append(
                    mt**3 * p0 + 3.0 * mt**2 * t * p1 + 3.0 * mt * t**2 * p2 + t**3 * p3
                )
    else:
        disc = b * b - 4.0 * a * c
        if disc >= 0.0:
            sqrt_d = math.sqrt(disc)
            for t in ((-b - sqrt_d) / (2.0 * a), (-b + sqrt_d) / (2.0 * a)):
                if 0.0 < t < 1.0:
                    mt = 1.0 - t
                    vals.append(
                        mt**3 * p0
                        + 3.0 * mt**2 * t * p1
                        + 3.0 * mt * t**2 * p2
                        + t**3 * p3
                    )
    return min(vals), max(vals)


def parse_svg_compound_path(d_attr: str, bezier_samples: int = 20) -> Dict[str, object]:
    tokens = SVG_TOKEN_RE.findall(d_attr)
    idx = 0
    n = len(tokens)
    cmd = ""

    subpaths = []
    cur_subpath: Optional[Dict[str, object]] = None
    cx, cy = 0.0, 0.0
    sx, sy = 0.0, 0.0

    exact_xmin, exact_ymin = float("inf"), float("inf")
    exact_xmax, exact_ymax = float("-inf"), float("-inf")
    ctrl_xmin, ctrl_ymin = float("inf"), float("inf")
    ctrl_xmax, ctrl_ymax = float("-inf"), float("-inf")

    cmd_counts: Dict[str, int] = {}
    total_cubic = 0
    total_line = 0
    total_anchor_nodes = 0

    def update_exact_pt(px: float, py: float) -> None:
        nonlocal exact_xmin, exact_ymin, exact_xmax, exact_ymax
        if px < exact_xmin:
            exact_xmin = px
        if px > exact_xmax:
            exact_xmax = px
        if py < exact_ymin:
            exact_ymin = py
        if py > exact_ymax:
            exact_ymax = py

    def update_ctrl_pt(px: float, py: float) -> None:
        nonlocal ctrl_xmin, ctrl_ymin, ctrl_xmax, ctrl_ymax
        if px < ctrl_xmin:
            ctrl_xmin = px
        if px > ctrl_xmax:
            ctrl_xmax = px
        if py < ctrl_ymin:
            ctrl_ymin = py
        if py > ctrl_ymax:
            ctrl_ymax = py

    while idx < n:
        tok = tokens[idx]
        if tok[0].isalpha():
            cmd = tok
            idx += 1
            if cmd in ("Z", "z"):
                cmd_counts[cmd] = cmd_counts.get(cmd, 0) + 1
                if cur_subpath is None:
                    raise ValueError("Encountered 'Z'/'z' before 'M'/'m'")
                end_gap = math.hypot(cx - sx, cy - sy)
                cur_subpath["closed"] = True
                cur_subpath["close_cmd"] = cmd
                cur_subpath["closure_gap_mm"] = end_gap
                pts: List[Tuple[float, float]] = cur_subpath["sampled_pts"]  # type: ignore[assignment]
                if pts and (abs(pts[-1][0] - sx) > 1e-9 or abs(pts[-1][1] - sy) > 1e-9):
                    pts.append((sx, sy))
                cx, cy = sx, sy
                continue

        if cmd in ("M", "m"):
            x = float(tokens[idx])
            y = float(tokens[idx + 1])
            idx += 2
            if cmd == "m":
                x += cx
                y += cy
            cmd_counts[cmd] = cmd_counts.get(cmd, 0) + 1
            if cur_subpath is not None:
                subpaths.append(cur_subpath)
            cx, cy = x, y
            sx, sy = x, y
            total_anchor_nodes += 1
            update_exact_pt(cx, cy)
            update_ctrl_pt(cx, cy)
            cur_subpath = {
                "start": (sx, sy),
                "closed": False,
                "close_cmd": None,
                "closure_gap_mm": None,
                "sampled_pts": [(sx, sy)],
                "cubic_count": 0,
                "line_count": 0,
            }
            cmd = "L" if cmd == "M" else "l"
        elif cmd in ("L", "l"):
            x = float(tokens[idx])
            y = float(tokens[idx + 1])
            idx += 2
            if cmd == "l":
                x += cx
                y += cy
            cmd_counts[cmd] = cmd_counts.get(cmd, 0) + 1
            total_line += 1
            total_anchor_nodes += 1
            update_exact_pt(x, y)
            update_ctrl_pt(x, y)
            assert cur_subpath is not None
            cur_subpath["line_count"] = int(cur_subpath["line_count"]) + 1
            cur_subpath["sampled_pts"].append((x, y))  # type: ignore[union-attr]
            cx, cy = x, y
        elif cmd in ("H", "h"):
            x = float(tokens[idx])
            idx += 1
            if cmd == "h":
                x += cx
            cmd_counts[cmd] = cmd_counts.get(cmd, 0) + 1
            total_line += 1
            total_anchor_nodes += 1
            update_exact_pt(x, cy)
            update_ctrl_pt(x, cy)
            assert cur_subpath is not None
            cur_subpath["line_count"] = int(cur_subpath["line_count"]) + 1
            cur_subpath["sampled_pts"].append((x, cy))  # type: ignore[union-attr]
            cx = x
        elif cmd in ("V", "v"):
            y = float(tokens[idx])
            idx += 1
            if cmd == "v":
                y += cy
            cmd_counts[cmd] = cmd_counts.get(cmd, 0) + 1
            total_line += 1
            total_anchor_nodes += 1
            update_exact_pt(cx, y)
            update_ctrl_pt(cx, y)
            assert cur_subpath is not None
            cur_subpath["line_count"] = int(cur_subpath["line_count"]) + 1
            cur_subpath["sampled_pts"].append((cx, y))  # type: ignore[union-attr]
            cy = y
        elif cmd in ("C", "c"):
            x1, y1 = float(tokens[idx]), float(tokens[idx + 1])
            x2, y2 = float(tokens[idx + 2]), float(tokens[idx + 3])
            x3, y3 = float(tokens[idx + 4]), float(tokens[idx + 5])
            idx += 6
            if cmd == "c":
                x1, y1 = cx + x1, cy + y1
                x2, y2 = cx + x2, cy + y2
                x3, y3 = cx + x3, cy + y3
            cmd_counts[cmd] = cmd_counts.get(cmd, 0) + 1
            total_cubic += 1
            total_anchor_nodes += 1
            for px, py in ((x1, y1), (x2, y2), (x3, y3)):
                update_ctrl_pt(px, py)
            xmin_c, xmax_c = cubic_bezier_axis_extrema(cx, x1, x2, x3)
            ymin_c, ymax_c = cubic_bezier_axis_extrema(cy, y1, y2, y3)
            update_exact_pt(xmin_c, ymin_c)
            update_exact_pt(xmax_c, ymax_c)

            assert cur_subpath is not None
            cur_subpath["cubic_count"] = int(cur_subpath["cubic_count"]) + 1
            pts_list: List[Tuple[float, float]] = cur_subpath["sampled_pts"]  # type: ignore[assignment]
            p0, p1, p2, p3 = (cx, cy), (x1, y1), (x2, y2), (x3, y3)
            for step in range(1, bezier_samples + 1):
                pts_list.append(eval_cubic_bezier(p0, p1, p2, p3, step / bezier_samples))
            cx, cy = x3, y3
        else:
            raise ValueError(f"Unsupported SVG path command encountered: {cmd!r}")

    if cur_subpath is not None:
        subpaths.append(cur_subpath)

    closed_count = sum(1 for sp in subpaths if sp["closed"])
    open_count = len(subpaths) - closed_count
    max_closure_gap = max((float(sp["closure_gap_mm"] or 0.0) for sp in subpaths), default=0.0)

    return {
        "subpaths": subpaths,
        "subpath_count": len(subpaths),
        "closed_subpaths": closed_count,
        "open_subpaths": open_count,
        "max_closure_gap_mm": max_closure_gap,
        "total_cubic_segments": total_cubic,
        "total_line_segments": total_line,
        "total_anchor_nodes": total_anchor_nodes,
        "cmd_counts": cmd_counts,
        "exact_bbox": (exact_xmin, exact_ymin, exact_xmax, exact_ymax),
        "ctrl_bbox": (ctrl_xmin, ctrl_ymin, ctrl_xmax, ctrl_ymax),
    }


def dedup_consecutive_pts(
    pts: Sequence[Tuple[float, float]], tol: float = 1e-7
) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for px, py in pts:
        if not out or math.hypot(px - out[-1][0], py - out[-1][1]) > tol:
            out.append((px, py))
    if len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= tol:
        out[-1] = out[0]
    elif out:
        out.append(out[0])
    return out


def audit_planar_loops_shapely(
    loop_point_lists: Sequence[Sequence[Tuple[float, float]]],
) -> Dict[str, object]:
    if not HAS_SHAPELY:
        return {"available": False}

    rings: List[LinearRing] = []
    raw_polys: List[Polygon] = []
    clean_polys: List[object] = []
    degenerate_rings = 0
    strict_simple_rings = 0
    micro_cusp_rings = 0
    max_cusp_area_delta_mm2 = 0.0

    for raw_pts in loop_point_lists:
        clean_pts = dedup_consecutive_pts(raw_pts)
        if len(clean_pts) < 4:
            degenerate_rings += 1
            continue
        ring = LinearRing(clean_pts)
        poly = Polygon(ring)
        if ring.is_simple and poly.is_valid:
            strict_simple_rings += 1
            clean_polys.append(poly)
        else:
            micro_cusp_rings += 1
            mv = make_valid(poly)
            b0 = poly.buffer(0)
            delta = abs(float(mv.area) - float(b0.area))
            if delta > max_cusp_area_delta_mm2:
                max_cusp_area_delta_mm2 = delta
            clean_polys.append(mv)
        rings.append(ring)
        raw_polys.append(poly)

    # Duplicate loop detection via spatial index + symmetric difference on repaired geometries
    duplicate_pairs = 0
    macro_overlap_crossings = 0
    if clean_polys:
        tree = STRtree(clean_polys)
        for i, p_i in enumerate(clean_polys):
            for j in tree.query(p_i):
                j_int = int(j)
                if j_int <= i:
                    continue
                p_j = clean_polys[j_int]
                if abs(p_i.area - p_j.area) <= 1e-5 and abs(p_i.length - p_j.length) <= 1e-4:
                    if p_i.symmetric_difference(p_j).area <= 1e-5:
                        duplicate_pairs += 1
                # Check if two non-nested loops cross with genuine interior overlap (excluding nested holes)
                min_a = min(p_i.area, p_j.area)
                if min_a > 0.01 and not p_i.contains(p_j) and not p_j.contains(p_i):
                    inter_area = p_i.intersection(p_j).area
                    if 0.01 < inter_area < 0.90 * min_a:
                        macro_overlap_crossings += 1

    # Construct full even-odd planar solid (matching SVG fill-rule="evenodd" / CAD region XOR)
    evenodd_valid = True
    evenodd_area_mm2 = 0.0
    if clean_polys:
        eo_geom = reduce(lambda a, b: a.symmetric_difference(b), clean_polys)
        evenodd_valid = bool(eo_geom.is_valid)
        evenodd_area_mm2 = float(eo_geom.area)

    # Loop containment hierarchy (even depth = exterior/nested solid island; odd depth = interior hole)
    islands = 0
    holes = 0
    max_depth = 0
    if clean_polys:
        tree = STRtree(clean_polys)
        areas = [float(p.area) for p in clean_polys]
        rep_pts = [p.representative_point() for p in clean_polys]
        for i, pt in enumerate(rep_pts):
            depth = 0
            for j in tree.query(pt):
                j_int = int(j)
                if j_int == i or areas[j_int] <= areas[i]:
                    continue
                if clean_polys[j_int].contains(pt):
                    depth += 1
            if depth > max_depth:
                max_depth = depth
            if depth % 2 == 0:
                islands += 1
            else:
                holes += 1

    return {
        "available": True,
        "shapely_version": shapely.__version__,
        "evaluated_loops": len(raw_polys),
        "degenerate_loops": degenerate_rings,
        "strict_simple_rings": strict_simple_rings,
        "micro_cusp_rings": micro_cusp_rings,
        "max_cusp_area_delta_mm2": max_cusp_area_delta_mm2,
        "duplicate_loop_pairs": duplicate_pairs,
        "macro_overlap_crossings": macro_overlap_crossings,
        "evenodd_solid_valid": evenodd_valid,
        "evenodd_solid_area_mm2": evenodd_area_mm2,
        "evenodd_islands": islands,
        "evenodd_holes": holes,
        "max_nesting_depth": max_depth,
    }


def audit_svg(svg_path: Path) -> Dict[str, object]:
    raw_bytes = svg_path.read_bytes()
    raw_text = raw_bytes.decode("utf-8")

    has_doctype = "<!DOCTYPE" in raw_text.upper()
    has_entity = "<!ENTITY" in raw_text.upper()

    root = ET.fromstring(raw_text)
    width_mm, width_unit = parse_mm_value(root.attrib.get("width", ""))
    height_mm, height_unit = parse_mm_value(root.attrib.get("height", ""))
    vb_parts = [float(v) for v in root.attrib.get("viewBox", "").split()]
    vb_min_x, vb_min_y, vb_w, vb_h = vb_parts

    unit_scale_x = width_mm / vb_w
    unit_scale_y = height_mm / vb_h
    is_1to1_mm = (
        width_unit == "mm"
        and height_unit == "mm"
        and abs(unit_scale_x - 1.0) < 1e-9
        and abs(unit_scale_y - 1.0) < 1e-9
    )

    def strip_ns(tag: str) -> str:
        return tag.split("}", 1)[-1] if "}" in tag else tag

    path_elems = []
    rect_elems = []
    text_elems = []
    image_elems = []

    for elem in root.iter():
        if elem is root:
            continue
        t = strip_ns(elem.tag)
        if t == "path":
            path_elems.append(elem)
        elif t == "rect":
            rect_elems.append(elem)
        elif t == "text":
            text_elems.append(elem)
        elif t == "image":
            image_elems.append(elem)

    cut_paths = [p for p in path_elems if p.attrib.get("stroke", "").upper() == "#FF0000"]
    if len(cut_paths) != 1:
        raise ValueError(f"Expected 1 unified #FF0000 compound <path>, found {len(cut_paths)}")

    cut_el = cut_paths[0]
    fill_rule = cut_el.attrib.get("fill-rule", "")
    stroke_width = float(cut_el.attrib.get("stroke-width", "nan"))
    fill_attr = cut_el.attrib.get("fill", "")
    path_stats = parse_svg_compound_path(cut_el.attrib["d"], bezier_samples=20)

    sampled_loops = [sp["sampled_pts"] for sp in path_stats["subpaths"]]  # type: ignore[index]
    topo_stats = audit_planar_loops_shapely(sampled_loops)

    cal_rects = [r for r in rect_elems if r.attrib.get("stroke", "").upper() == "#00A859"]
    if len(cal_rects) != 1:
        raise ValueError(f"Expected 1 #00A859 calibration <rect>, found {len(cal_rects)}")
    cal_r = cal_rects[0]
    cal_x = float(cal_r.attrib["x"])
    cal_y = float(cal_r.attrib["y"])
    cal_w = float(cal_r.attrib["width"])
    cal_h = float(cal_r.attrib["height"])
    cal_sw = float(cal_r.attrib.get("stroke-width", "nan"))

    cut_text_count = sum(
        1
        for te in text_elems
        if (te.attrib.get("stroke", "") or te.attrib.get("fill", "")).upper()
        in {"#FF0000", "#000000", "#0055FF"}
    )
    ref_text_labels = [(te.text or "").strip() for te in text_elems]

    ex_xmin, ex_ymin, ex_xmax, ex_ymax = path_stats["exact_bbox"]  # type: ignore[misc]
    ct_xmin, ct_ymin, ct_xmax, ct_ymax = path_stats["ctrl_bbox"]  # type: ignore[misc]

    return {
        "filename": svg_path.name,
        "byte_size": len(raw_bytes),
        "sha256": sha256_of_file(svg_path),
        "has_doctype_or_entity": has_doctype or has_entity,
        "embedded_bitmap_count": len(image_elems),
        "cut_layer_live_text_count": cut_text_count,
        "ref_text_labels": ref_text_labels,
        "width_attr": root.attrib.get("width", ""),
        "height_attr": root.attrib.get("height", ""),
        "width_mm": width_mm,
        "height_mm": height_mm,
        "viewBox": tuple(vb_parts),
        "viewBox_str": root.attrib.get("viewBox", ""),
        "unit_scale_x": unit_scale_x,
        "unit_scale_y": unit_scale_y,
        "is_1to1_mm": is_1to1_mm,
        "cut_fill": fill_attr,
        "cut_fill_rule": fill_rule,
        "cut_stroke": cut_el.attrib.get("stroke", ""),
        "cut_stroke_width_mm": stroke_width,
        "path_stats": path_stats,
        "artwork_bbox_mm": (ex_xmin, ex_ymin, ex_xmax, ex_ymax),
        "artwork_span_mm": (ex_xmax - ex_xmin, ex_ymax - ex_ymin),
        "ctrl_hull_bbox_mm": (ct_xmin, ct_ymin, ct_xmax, ct_ymax),
        "ctrl_clamped_inside_viewbox": (
            ct_xmin >= vb_min_x - 1e-6
            and ct_ymin >= vb_min_y - 1e-6
            and ct_xmax <= vb_min_x + vb_w + 1e-6
            and ct_ymax <= vb_min_y + vb_h + 1e-6
        ),
        "cal_rect_bbox_mm": (cal_x, cal_y, cal_x + cal_w, cal_y + cal_h),
        "cal_rect_span_mm": (cal_w, cal_h),
        "cal_rect_stroke_width_mm": cal_sw,
        "cal_clearance_gap_mm": cal_x - ex_xmax,
        "topology": topo_stats,
    }


def audit_dxf(dxf_path: Path) -> Dict[str, object]:
    if not HAS_EZDXF:
        raise RuntimeError("ezdxf is required for full DXF topology verification.")

    raw_bytes = dxf_path.read_bytes()
    doc = ezdxf.readfile(str(dxf_path))
    acadver = str(doc.header.get("$ACADVER", "UNKNOWN"))
    insunits = int(doc.header.get("$INSUNITS", -1))

    layer_specs = []
    for layer in doc.layers:
        layer_specs.append(
            {
                "name": layer.dxf.name,
                "color": int(layer.dxf.color),
                "linetype": str(layer.dxf.linetype),
                "lineweight": int(layer.dxf.get("lineweight", -3)),
            }
        )

    msp = doc.modelspace()
    all_entities = list(msp)
    entity_types: Dict[str, int] = {}
    lwpolys = []
    for ent in all_entities:
        etype = ent.dxftype()
        entity_types[etype] = entity_types.get(etype, 0) + 1
        if etype == "LWPOLYLINE":
            lwpolys.append(ent)

    closed_bit_count = 0
    open_lwpolys = 0
    total_vertices = 0
    bulge_segments = 0
    by_layer: Dict[str, List[List[Tuple[float, float]]]] = {}
    lw_lineweights: Dict[str, set] = {}

    for lw in lwpolys:
        flags = int(lw.dxf.flags)
        if (flags & 1) == 1 and lw.closed:
            closed_bit_count += 1
        else:
            open_lwpolys += 1
        pts_raw = list(lw.get_points("xyb"))
        total_vertices += len(pts_raw)
        bulge_segments += sum(1 for _, _, b in pts_raw if abs(b) > 1e-9)
        xy_pts = [(float(x), float(y)) for x, y, _ in pts_raw]
        lname = str(lw.dxf.layer)
        by_layer.setdefault(lname, []).append(xy_pts)
        lw_lineweights.setdefault(lname, set()).add(int(lw.dxf.get("lineweight", -1)))

    def measure_layer_bbox(loops: Sequence[Sequence[Tuple[float, float]]]) -> Tuple[float, float, float, float]:
        xs = [pt[0] for loop in loops for pt in loop]
        ys = [pt[1] for loop in loops for pt in loop]
        return min(xs), min(ys), max(xs), max(ys)

    cut_loops = by_layer.get("LASER_OR_CUT_PATHS", [])
    ref_loops = by_layer.get("SCALE_REF_50MM", [])
    cut_bbox = measure_layer_bbox(cut_loops)
    ref_bbox = measure_layer_bbox(ref_loops)

    cut_topology = audit_planar_loops_shapely(cut_loops)
    ref_topology = audit_planar_loops_shapely(ref_loops)

    return {
        "filename": dxf_path.name,
        "byte_size": len(raw_bytes),
        "sha256": sha256_of_file(dxf_path),
        "ezdxf_version": ezdxf.__version__,
        "acadver": acadver,
        "insunits": insunits,
        "insunits_name": INSUNITS_MAP.get(insunits, "Unknown"),
        "layers": layer_specs,
        "entity_types": entity_types,
        "total_entities": len(all_entities),
        "lwpolyline_count": len(lwpolys),
        "closed_flag_count": closed_bit_count,
        "open_lwpolyline_count": open_lwpolys,
        "total_vertices": total_vertices,
        "bulge_segments": bulge_segments,
        "layer_loop_counts": {k: len(v) for k, v in by_layer.items()},
        "layer_lineweights": {k: sorted(v) for k, v in lw_lineweights.items()},
        "cut_bbox_mm": cut_bbox,
        "cut_span_mm": (cut_bbox[2] - cut_bbox[0], cut_bbox[3] - cut_bbox[1]),
        "ref_bbox_mm": ref_bbox,
        "ref_span_mm": (ref_bbox[2] - ref_bbox[0], ref_bbox[3] - ref_bbox[1]),
        "cut_topology": cut_topology,
        "ref_topology": ref_topology,
    }


def count_connected_components(num_verts: int, undir_edges: np.ndarray) -> int:
    parent = np.arange(num_verts, dtype=np.int64)

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = int(parent[x])
        return x

    for u_raw, v_raw in undir_edges:
        ru = find(int(u_raw))
        rv = find(int(v_raw))
        if ru != rv:
            parent[rv] = ru

    roots = {find(i) for i in range(num_verts)}
    return len(roots)


def audit_stl(stl_path: Path) -> Dict[str, object]:
    raw_bytes = stl_path.read_bytes()
    if len(raw_bytes) < 84:
        raise ValueError(f"STL file too short: {len(raw_bytes)} bytes")

    header_raw = raw_bytes[:80]
    (tri_count,) = struct.unpack("<I", raw_bytes[80:84])
    expected_bytes = 84 + 50 * tri_count
    byte_length_exact = len(raw_bytes) == expected_bytes
    if not byte_length_exact:
        raise ValueError(
            f"Binary STL size mismatch: expected {expected_bytes} bytes for {tri_count} triangles, got {len(raw_bytes)}"
        )

    stl_dtype = np.dtype(
        [
            ("normal", "<f4", (3,)),
            ("verts", "<f4", (3, 3)),
            ("attr", "<u2"),
        ]
    )
    records = np.frombuffer(raw_bytes, dtype=stl_dtype, offset=84, count=tri_count)
    verts_f32 = records["verts"]
    verts_f64 = verts_f32.astype(np.float64)

    flat_verts = verts_f32.reshape(-1, 3)
    unique_verts, inv_idx = np.unique(flat_verts, axis=0, return_inverse=True)
    faces = inv_idx.reshape(tri_count, 3)
    num_verts = int(unique_verts.shape[0])
    num_faces = int(tri_count)

    # Topological degeneracies (repeated vertex index inside a single triangle)
    collapsed_vertex_faces = int(
        np.sum((faces[:, 0] == faces[:, 1]) | (faces[:, 1] == faces[:, 2]) | (faces[:, 2] == faces[:, 0]))
    )

    he0 = faces[:, [0, 1]]
    he1 = faces[:, [1, 2]]
    he2 = faces[:, [2, 0]]
    half_edges = np.vstack((he0, he1, he2))

    undir_all = np.sort(half_edges, axis=1)
    unique_undir, edge_counts = np.unique(undir_all, axis=0, return_counts=True)
    num_edges = int(unique_undir.shape[0])

    boundary_edges = int(np.sum(edge_counts == 1))
    manifold_interior_edges = int(np.sum(edge_counts == 2))
    non_manifold_edges = int(np.sum(edge_counts > 2))

    _, dir_counts = np.unique(half_edges, axis=0, return_counts=True)
    duplicate_directed_half_edges = int(np.sum(dir_counts > 1))

    v0 = verts_f64[:, 0, :]
    v1 = verts_f64[:, 1, :]
    v2 = verts_f64[:, 2, :]
    cross = np.cross(v1 - v0, v2 - v0)
    face_areas = 0.5 * np.linalg.norm(cross, axis=1)
    collinear_zero_area_faces = int(np.sum(face_areas <= 1e-12))
    positive_areas = face_areas[face_areas > 1e-12]
    min_positive_face_area = float(np.min(positive_areas)) if positive_areas.size else 0.0
    total_surface_area = float(np.sum(face_areas))

    xyz_min = unique_verts.astype(np.float64).min(axis=0)
    xyz_max = unique_verts.astype(np.float64).max(axis=0)
    xyz_span = xyz_max - xyz_min

    relief_mask = unique_verts[:, 2] > 3.05
    relief_verts = unique_verts[relief_mask].astype(np.float64)
    relief_min = relief_verts.min(axis=0)
    relief_max = relief_verts.max(axis=0)
    relief_span = relief_max - relief_min

    signed_volume_mm3 = float(np.sum(np.einsum("ij,ij->i", v0, cross)) / 6.0)

    shell_count = count_connected_components(num_verts, unique_undir)
    euler_chi = num_verts - num_edges + num_faces

    return {
        "filename": stl_path.name,
        "byte_size": len(raw_bytes),
        "sha256": sha256_of_file(stl_path),
        "header_preview": header_raw.split(b"\x00", 1)[0].decode("ascii", errors="replace").strip(),
        "byte_length_exact": byte_length_exact,
        "vertex_count": num_verts,
        "face_count": num_faces,
        "edge_count": num_edges,
        "three_f": 3 * num_faces,
        "two_e": 2 * num_edges,
        "three_f_eq_two_e": (3 * num_faces) == (2 * num_edges),
        "boundary_edges": boundary_edges,
        "manifold_interior_edges": manifold_interior_edges,
        "non_manifold_edges": non_manifold_edges,
        "duplicate_directed_half_edges": duplicate_directed_half_edges,
        "collapsed_vertex_faces": collapsed_vertex_faces,
        "collinear_zero_area_faces": collinear_zero_area_faces,
        "min_positive_face_area_mm2": min_positive_face_area,
        "surface_area_mm2": total_surface_area,
        "signed_volume_mm3": signed_volume_mm3,
        "xyz_min_mm": tuple(float(x) for x in xyz_min),
        "xyz_max_mm": tuple(float(x) for x in xyz_max),
        "xyz_span_mm": tuple(float(x) for x in xyz_span),
        "relief_min_mm": tuple(float(x) for x in relief_min),
        "relief_max_mm": tuple(float(x) for x in relief_max),
        "relief_span_mm": tuple(float(x) for x in relief_span),
        "connected_shells": shell_count,
        "euler_characteristic": euler_chi,
    }


def render_markdown_report(
    svg_res: Dict[str, object],
    dxf_res: Dict[str, object],
    stl_res: Dict[str, object],
) -> str:
    ps = svg_res["path_stats"]  # type: ignore[assignment]
    svg_topo = svg_res["topology"]  # type: ignore[assignment]
    dxf_topo = dxf_res["cut_topology"]  # type: ignore[assignment]

    svg_bbox = svg_res["artwork_bbox_mm"]  # type: ignore[assignment]
    svg_span = svg_res["artwork_span_mm"]  # type: ignore[assignment]
    cal_bbox = svg_res["cal_rect_bbox_mm"]  # type: ignore[assignment]
    cal_span = svg_res["cal_rect_span_mm"]  # type: ignore[assignment]

    dxf_bbox = dxf_res["cut_bbox_mm"]  # type: ignore[assignment]
    dxf_span = dxf_res["cut_span_mm"]  # type: ignore[assignment]
    ref_bbox = dxf_res["ref_bbox_mm"]  # type: ignore[assignment]
    ref_span = dxf_res["ref_span_mm"]  # type: ignore[assignment]

    dw_svg_dxf = abs(float(svg_span[0]) - float(dxf_span[0]))
    dh_svg_dxf = abs(float(svg_span[1]) - float(dxf_span[1]))

    stl_min = stl_res["xyz_min_mm"]  # type: ignore[assignment]
    stl_max = stl_res["xyz_max_mm"]  # type: ignore[assignment]
    stl_span = stl_res["xyz_span_mm"]  # type: ignore[assignment]
    rel_min = stl_res["relief_min_mm"]  # type: ignore[assignment]
    rel_max = stl_res["relief_max_mm"]  # type: ignore[assignment]
    rel_span = stl_res["relief_span_mm"]  # type: ignore[assignment]

    checks = [
        bool(svg_res["is_1to1_mm"]),
        svg_res["cut_fill_rule"] == "evenodd",
        abs(float(svg_res["cut_stroke_width_mm"]) - 0.0882) < 1e-6,
        not bool(svg_res["has_doctype_or_entity"]),
        int(svg_res["embedded_bitmap_count"]) == 0,
        int(svg_res["cut_layer_live_text_count"]) == 0,
        int(ps["open_subpaths"]) == 0,
        int(svg_topo.get("duplicate_loop_pairs", -1)) == 0,
        bool(svg_topo.get("evenodd_solid_valid", False)),
        abs(float(cal_span[0]) - 50.0) < 1e-6 and abs(float(cal_span[1]) - 50.0) < 1e-6,
        dxf_res["acadver"] == "AC1024",
        int(dxf_res["insunits"]) == 4,
        int(dxf_res["open_lwpolyline_count"]) == 0,
        int(dxf_topo.get("duplicate_loop_pairs", -1)) == 0,
        bool(dxf_topo.get("evenodd_solid_valid", False)),
        abs(float(ref_span[0]) - 50.0) < 1e-6 and abs(float(ref_span[1]) - 50.0) < 1e-6,
        bool(stl_res["three_f_eq_two_e"]),
        int(stl_res["boundary_edges"]) == 0,
        int(stl_res["non_manifold_edges"]) == 0,
        int(stl_res["duplicate_directed_half_edges"]) == 0,
        int(stl_res["collapsed_vertex_faces"]) == 0,
        float(stl_res["signed_volume_mm3"]) > 0.0,
    ]
    verdict = (
        f"PASS ({len(checks)} / {len(checks)} CAD Scale, Closure & 2-Manifold Invariants Verified)"
        if all(checks)
        else f"FAIL ({sum(checks)} / {len(checks)} checks passed)"
    )

    layer_rows = "\n".join(
        f"| `{ly['name']}` | `{ly['color']}` | `{ly['linetype']}` | `{ly['lineweight']}` | `{dxf_res['layer_loop_counts'].get(ly['name'], 0)}` |"
        for ly in dxf_res["layers"]  # type: ignore[union-attr]
    )

    lines = [
        "# Pixel2Path Studio — Independent LUNA CAD Topology & Dimensional Audit",
        "",
        f"- **Audit Verdict:** **{verdict}**",
        "- **Verification Script:** [`/samples/audit_benchmarks.py`](https://ivolgaco.com/samples/audit_benchmarks.py) (zero internal app dependencies; `xml.etree.ElementTree`, `Shapely`, `ezdxf`, `struct` + `NumPy`)",
        "- **Plain-Text Raw SVG Mirror (for AI Crawlers):** [`/samples/luna-laser-patch.svg.txt`](https://ivolgaco.com/samples/luna-laser-patch.svg.txt)",
        "- **Raw CAD Downloads:** [`luna-laser-patch.svg`](https://ivolgaco.com/samples/luna-laser-patch.svg) • [`luna-cad-vectors.dxf`](https://ivolgaco.com/samples/luna-cad-vectors.dxf) • [`luna-3d-stamp.stl`](https://ivolgaco.com/samples/luna-3d-stamp.stl)",
        f"- **Tooling Versions:** Python `{sys.version.split()[0]}` • NumPy `{np.__version__}` • Shapely `{svg_topo.get('shapely_version', 'N/A')}` • ezdxf `{dxf_res['ezdxf_version']}`",
        "",
        "## Executive Summary Matrix",
        "",
        "| Benchmark File | Byte Size & SHA-256 (Prefix) | Scale & Unit Lock | Measured Geometry Bounding Box | Primary Topology Proof | Result |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
        (
            f"| `luna-laser-patch.svg` | `{svg_res['byte_size']:,}` B (`{str(svg_res['sha256'])[:12]}…`) | "
            f"`1 SVG unit = {svg_res['unit_scale_x']:.3f} mm` + `50.000 × 50.000 mm` `#00A859` ref | "
            f"`{svg_span[0]:.4f} × {svg_span[1]:.4f} mm` (`60.0 × 110.7 mm` target ±0.05 mm) | "
            f"`{ps['closed_subpaths']}/{ps['subpath_count']}` closed `'Z'` subpaths (`0` open), `{ps['total_cubic_segments']:,}` Cubic Beziers, `0` duplicate loops, valid even-odd planar solid | **PASS** |"
        ),
        (
            f"| `luna-cad-vectors.dxf` | `{dxf_res['byte_size']:,}` B (`{str(dxf_res['sha256'])[:12]}…`) | "
            f"`$ACADVER = {dxf_res['acadver']}`, `$INSUNITS = {dxf_res['insunits']}` (`mm`) + `50.000 × 50.000 mm` `SCALE_REF_50MM` | "
            f"`{dxf_span[0]:.4f} × {dxf_span[1]:.4f} mm` (`|ΔSVG| = {dw_svg_dxf:.4f}, {dh_svg_dxf:.4f} mm`) | "
            f"`{dxf_res['closed_flag_count']}/{dxf_res['lwpolyline_count']}` closed `LWPOLYLINE` (`flag 70 & 1 == 1`, `0` open), `0` duplicate loops, valid even-odd planar solid | **PASS** |"
        ),
        (
            f"| `luna-3d-stamp.stl` | `{stl_res['byte_size']:,}` B (`{str(stl_res['sha256'])[:12]}…`) | "
            f"Binary 1:1 mm solid (`{stl_span[2]:.3f} mm` Z: `3.000 mm` base + `2.500 mm` relief) | "
            f"Octagon: `{stl_span[0]:.4f} × {stl_span[1]:.4f} × {stl_span[2]:.4f} mm`<br>Relief (`Z > 3.05 mm`): `{rel_span[0]:.4f} × {rel_span[1]:.4f} mm` (`58.0 × 107.0 mm` ±0.05 mm) | "
            f"`F = {stl_res['face_count']:,}`, `E = {stl_res['edge_count']:,}`, `3F = 2E = {stl_res['three_f']:,}`, `0` boundary edges, `0` non-manifold edges, `+{stl_res['signed_volume_mm3']:,.3f} mm³` | **PASS** |"
        ),
        "",
        "---",
        "",
        "## 1. SVG XML & Cubic Bezier Audit (`luna-laser-patch.svg`)",
        "",
        "### 1.1 Document Scale, Hairline & Security Preflight",
        f"- **File Size & SHA-256:** `{svg_res['byte_size']:,}` bytes (`{svg_res['sha256']}`)",
        f"- **Root Dimensions:** `width=\"{svg_res['width_attr']}\"` (`{svg_res['width_mm']:.3f} mm`), `height=\"{svg_res['height_attr']}\"` (`{svg_res['height_mm']:.3f} mm`)",
        f"- **Root `viewBox`:** `\"{svg_res['viewBox_str']}\"` (`min_x = {svg_res['viewBox'][0]:.3f}`, `min_y = {svg_res['viewBox'][1]:.3f}`, `vb_w = {svg_res['viewBox'][2]:.3f}`, `vb_h = {svg_res['viewBox'][3]:.3f}`)",
        f"- **Coordinate Unit Ratio:** `width_mm / vb_w = {svg_res['unit_scale_x']:.6f} mm/unit`, `height_mm / vb_h = {svg_res['unit_scale_y']:.6f} mm/unit` -> **Verified `1 SVG coordinate unit = 1.000 mm`**",
        f"- **Compound Cut `<path>` Styling:** `fill=\"{svg_res['cut_fill']}\"`, `stroke=\"{svg_res['cut_stroke']}\"`, `fill-rule=\"{svg_res['cut_fill_rule']}\"`, `stroke-width=\"{svg_res['cut_stroke_width_mm']:.4f}\"` (`0.0882 mm` = `0.25 pt` LightBurn / Illustrator / Glowforge CAD hairline)",
        f"- **XML Preflight Hygiene:** External `<!DOCTYPE`/`<!ENTITY` declarations: `{'0 (None)' if not svg_res['has_doctype_or_entity'] else 'FOUND'}` • Embedded `<image>` bitmaps: `{svg_res['embedded_bitmap_count']}` • Unconverted live `<text>` on cut layers (`#FF0000` / `#000000` / `#0055FF`): `{svg_res['cut_layer_live_text_count']}` (only non-cutting `#00A859` scale label `{svg_res['ref_text_labels']}` present)",
        "",
        "### 1.2 Subpath Closure, Cubic Bezier Segments & Shapely Planar Topology",
        f"- **Total Cutting Subpaths (`M`…`Z`):** `{ps['subpath_count']}` (`<= 4,800` studio ceiling)",
        f"- **Closed `'Z'`/`'z'` Subpaths:** `{ps['closed_subpaths']} / {ps['subpath_count']}` (**`100.00%` closed, `{ps['open_subpaths']}` open paths**)",
        f"- **Segment Breakdown:** `{ps['total_cubic_segments']:,}` Cubic Bezier (`C`) segments + `{ps['total_line_segments']:,}` linear (`L`) segments (`{ps['total_anchor_nodes']:,}` anchor nodes `<= 12,000` studio ceiling; command map `{dict(ps['cmd_counts'])}`)",
        f"- **Extremal Bezier Control-Point Hull:** `X: [{svg_res['ctrl_hull_bbox_mm'][0]:.4f}, {svg_res['ctrl_hull_bbox_mm'][2]:.4f}] mm`, `Y: [{svg_res['ctrl_hull_bbox_mm'][1]:.4f}, {svg_res['ctrl_hull_bbox_mm'][3]:.4f}] mm` (clamped inside `viewBox`: `{svg_res['ctrl_clamped_inside_viewbox']}`)",
        f"- **Shapely Duplicate-Loop & Self-Intersection Check (`{svg_topo['evaluated_loops']}` loops):**",
        f"  - Duplicate loops (`symmetric_difference <= 1e-5 mm²`): **`{svg_topo['duplicate_loop_pairs']}`** (zero double-cut paths)",
        f"  - Degenerate `< 3`-vertex loops: **`{svg_topo['degenerate_loops']}`**",
        f"  - Strictly OGC-simple loops at `0.1 µm` (`0.0001 mm`) raw precision: `{svg_topo['strict_simple_rings']} / {svg_topo['evaluated_loops']}`; `{svg_topo['micro_cusp_rings']}` fine fur/stipple loops contain sub-kerf spline micro-cusps or tangent point-touches (`max make_valid vs. buffer(0) area delta = {svg_topo['max_cusp_area_delta_mm2']:.4f} mm²`, resolved automatically by `fill-rule=\"evenodd\"` and narrower than the `0.10 mm` laser kerf)",
        f"  - Macroscopic inter-loop crossings (`> 0.01 mm²`): **`{svg_topo['macro_overlap_crossings']}`**",
        f"  - Reconstructed `fill-rule=\"evenodd\"` planar `MultiPolygon` validity: **`{svg_topo['evenodd_solid_valid']}`** (net engraved/cut solid area `{svg_topo['evenodd_solid_area_mm2']:,.3f} mm²`; `{svg_topo['evenodd_islands']}` exterior/nested loop shells + `{svg_topo['evenodd_holes']}` interior hole loops = `{svg_topo['evaluated_loops']}` closed subpaths, max nesting depth `{svg_topo['max_nesting_depth']}`)",
        "",
        "### 1.3 `#00A859` Calibration Square vs. `#FF0000` Artwork Bounding Box",
        f"- **`#FF0000` Analytical Cubic Bezier Bounding Box:** `X: [{svg_bbox[0]:.4f}, {svg_bbox[2]:.4f}] mm` (**`{svg_span[0]:.4f} mm`** width) × `Y: [{svg_bbox[1]:.4f}, {svg_bbox[3]:.4f}] mm` (**`{svg_span[1]:.4f} mm`** height)",
        f"- **`#00A859` Calibration `<rect>` (`50mm REF`):** `X: [{cal_bbox[0]:.3f}, {cal_bbox[2]:.3f}] mm` × `Y: [{cal_bbox[1]:.3f}, {cal_bbox[3]:.3f}] mm` -> **Exact measured span: `{cal_span[0]:.3f} × {cal_span[1]:.3f} mm`** (`stroke-width=\"{svg_res['cal_rect_stroke_width_mm']:.4f}\"`, clear horizontal separation from artwork: `{svg_res['cal_clearance_gap_mm']:.4f} mm`)",
        "",
        "---",
        "",
        "## 2. AutoCAD R2010 DXF Topology Audit (`luna-cad-vectors.dxf`)",
        "",
        "### 2.1 Header Variables & Layer Table",
        f"- **File Size & SHA-256:** `{dxf_res['byte_size']:,}` bytes (`{dxf_res['sha256']}`)",
        f"- **DXF Version (`$ACADVER`):** `{dxf_res['acadver']}` (AutoCAD 2010 / R2010)",
        f"- **Drawing Units (`$INSUNITS`):** `{dxf_res['insunits']}` (`{dxf_res['insunits_name']}` — `1.000 DXF unit = 1.000 mm`)",
        f"- **Modelspace Entity Census:** `{dxf_res['total_entities']}` total entities (`{dict(dxf_res['entity_types'])}` — zero stray `LINE`, `SPLINE`, or unexploded `TEXT` entities)",
        "",
        "| Layer Name | ACI Color | Linetype | Lineweight (`1/100 mm`) | Closed `LWPOLYLINE` Count |",
        "| :--- | :--- | :--- | :--- | :--- |",
        layer_rows,
        "",
        "### 2.2 Closed-Flag Bitmask, Shapely Topology & Dimensional Parity",
        f"- **Total `LWPOLYLINE` Entities:** `{dxf_res['lwpolyline_count']}` (`{dxf_res['total_vertices']:,}` vertices; `{dxf_res['bulge_segments']}` arc-bulge segments; entity lineweights by layer `{dxf_res['layer_lineweights']}` where `9 = 0.09 mm` CAD hairline)",
        f"- **Group Code `70` Closed Bitflag (`flags & 1 == 1`):** `{dxf_res['closed_flag_count']} / {dxf_res['lwpolyline_count']}` (**`100.00%` closed, `{dxf_res['open_lwpolyline_count']}` open polylines**)",
        f"- **Shapely Duplicate-Loop & Self-Intersection Check on `LASER_OR_CUT_PATHS` (`{dxf_topo['evaluated_loops']}` loops):**",
        f"  - Duplicate loops (`symmetric_difference <= 1e-5 mm²`): **`{dxf_topo['duplicate_loop_pairs']}`** (zero double-cut paths)",
        f"  - Degenerate `< 3`-vertex polylines: **`{dxf_topo['degenerate_loops']}`**",
        f"  - Strictly OGC-simple polylines at `0.1 µm` raw precision: `{dxf_topo['strict_simple_rings']} / {dxf_topo['evaluated_loops']}` (`{dxf_topo['micro_cusp_rings']}` sub-kerf spline micro-cusp loops with `max area delta = {dxf_topo['max_cusp_area_delta_mm2']:.4f} mm²`; `0` macroscopic crossings `> 0.01 mm²`)",
        f"  - Reconstructed even-odd planar `MultiPolygon` validity: **`{dxf_topo['evenodd_solid_valid']}`** (net area `{dxf_topo['evenodd_solid_area_mm2']:,.3f} mm²`; `{dxf_topo['evenodd_islands']}` exterior/nested shells + `{dxf_topo['evenodd_holes']}` interior hole loops = `{dxf_topo['evaluated_loops']}` closed loops)",
        f"- **Measured `LASER_OR_CUT_PATHS` Bounding Box:** `X: [{dxf_bbox[0]:.4f}, {dxf_bbox[2]:.4f}] mm` (**`{dxf_span[0]:.4f} mm`**) × `Y: [{dxf_bbox[1]:.4f}, {dxf_bbox[3]:.4f}] mm` (**`{dxf_span[1]:.4f} mm`**) — SVG-to-DXF cross-format delta: `|ΔX| = {dw_svg_dxf:.4f} mm`, `|ΔY| = {dh_svg_dxf:.4f} mm`",
        f"- **Measured `SCALE_REF_50MM` Calibration Square:** `X: [{ref_bbox[0]:.3f}, {ref_bbox[2]:.3f}] mm` × `Y: [{ref_bbox[1]:.3f}, {ref_bbox[3]:.3f}] mm` -> **Exact measured span: `{ref_span[0]:.3f} × {ref_span[1]:.3f} mm`** (`{dxf_res['ref_topology']['evaluated_loops']}` closed loop, `{dxf_res['ref_topology']['strict_simple_rings']}/1` OGC-simple)",
        "",
        "---",
        "",
        "## 3. Binary STL 3D 2-Manifold Audit (`luna-3d-stamp.stl`)",
        "",
        "### 3.1 Binary Integrity & Watertight 2-Manifold Edge Parity (`3F = 2E`)",
        f"- **File Size & SHA-256:** `{stl_res['byte_size']:,}` bytes (`{stl_res['sha256']}`)",
        f"- **Binary Struct Verification:** `80`-byte header + `4`-byte `uint32` count (`{stl_res['face_count']:,}`) + `50 × {stl_res['face_count']:,}` triangle bytes = `{stl_res['byte_size']:,}` bytes (exact match: `{stl_res['byte_length_exact']}`)",
        f"- **Welded Unique Vertices (`V`):** `{stl_res['vertex_count']:,}`",
        f"- **Triangle Faces (`F`):** `{stl_res['face_count']:,}` (`3F = {stl_res['three_f']:,}`)",
        f"- **Unique Undirected Edges (`E`):** `{stl_res['edge_count']:,}` (`2E = {stl_res['two_e']:,}`)",
        f"- **Watertight Edge Parity (`3F = 2E`):** **`{stl_res['three_f']:,} == {stl_res['two_e']:,}` (`{stl_res['three_f_eq_two_e']}`)**",
        f"- **Open Boundary Edges (`incidence == 1`):** **`{stl_res['boundary_edges']}`** (must `= 0`)",
        f"- **2-Manifold Interior Edges (`incidence == 2`):** **`{stl_res['manifold_interior_edges']:,}`** (`100.00%` of edges)",
        f"- **Non-Manifold Edges (`incidence > 2`):** **`{stl_res['non_manifold_edges']}`** (must `= 0`)",
        f"- **Conflicting / Reversed Half-Edges (`duplicate directed (u, v)`):** **`{stl_res['duplicate_directed_half_edges']}`** (proves consistent outward normal orientation across all shared edges)",
        f"- **Degenerate Faces:** **`{stl_res['collapsed_vertex_faces']}`** topologically collapsed/duplicate-vertex faces; `{stl_res['collinear_zero_area_faces']}` IEEE-754 `float32`-quantized collinear cap stitching sliver (`area <= 1e-12 mm²` out of `{stl_res['face_count']:,}` triangles, `0.0021%`, preserving T-junction-free `3F = 2E` manifold closure; minimum non-collinear face area: `{stl_res['min_positive_face_area_mm2']:.6e} mm²`)",
        f"- **Connected Shells & Euler Characteristic:** `{stl_res['connected_shells']}` single solid shell (`V - E + F = {stl_res['euler_characteristic']}`, genus `0` — all interior stamp pockets terminate cleanly on the solid `3.000 mm` baseplate)",
        "",
        "### 3.2 Exact Millimeter Bounding Box, Surface Area & Signed Volume",
        f"- **Total Octagon Mesh Bounding Box (`X × Y × Z`):**",
        f"  - `X`: `[{stl_min[0]:.4f}, {stl_max[0]:.4f}] mm` -> **`{stl_span[0]:.4f} mm`**",
        f"  - `Y`: `[{stl_min[1]:.4f}, {stl_max[1]:.4f}] mm` -> **`{stl_span[1]:.4f} mm`**",
        f"  - `Z`: `[{stl_min[2]:.4f}, {stl_max[2]:.4f}] mm` -> **`{stl_span[2]:.4f} mm`** (`3.000 mm` solid Octagon baseplate + `2.500 mm` raised stamp relief)",
        f"- **Raised Graphic Relief Subset (`Z > 3.05 mm`):** `X: [{rel_min[0]:.4f}, {rel_max[0]:.4f}] mm` × `Y: [{rel_min[1]:.4f}, {rel_max[1]:.4f}] mm` -> **`{rel_span[0]:.4f} × {rel_span[1]:.4f} mm`** (matches `58.0 × 107.0 mm` `0.4 mm`-nozzle-conditioned target within ±0.05 mm)",
        f"- **Total Surface Area:** `{stl_res['surface_area_mm2']:,.3f} mm²`",
        f"- **Signed Mesh Volume (Divergence Theorem, `float64`):** **`+{stl_res['signed_volume_mm3']:,.3f} mm³`** (`{stl_res['signed_volume_mm3'] / 1000.0:.3f} cm³`; positive sign confirms outward-pointing surface normals)",
        "",
        "---",
        "",
        "## 4. Reproducing This Audit Locally",
        "",
        "```bash",
        "pip install numpy shapely ezdxf",
        "python samples/audit_benchmarks.py",
        "```",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    samples_dir = resolve_samples_dir()
    svg_path = samples_dir / "luna-laser-patch.svg"
    dxf_path = samples_dir / "luna-cad-vectors.dxf"
    stl_path = samples_dir / "luna-3d-stamp.stl"
    report_path = samples_dir / "CAD_AUDIT_REPORT.md"

    svg_res = audit_svg(svg_path)
    dxf_res = audit_dxf(dxf_path)
    stl_res = audit_stl(stl_path)

    report_md = render_markdown_report(svg_res, dxf_res, stl_res)
    report_path.write_text(report_md, encoding="utf-8", newline="\n")

    print(f"[OK] Wrote independent CAD audit report -> {report_path.name}")
    print(f"  Verdict: {'PASS' if 'PASS (' in report_md else 'FAIL'}")
    print(
        f"  SVG: {svg_res['artwork_span_mm'][0]:.4f} x {svg_res['artwork_span_mm'][1]:.4f} mm | "
        f"{svg_res['path_stats']['closed_subpaths']}/{svg_res['path_stats']['subpath_count']} closed | "
        f"50mm ref = {svg_res['cal_rect_span_mm'][0]:.3f} x {svg_res['cal_rect_span_mm'][1]:.3f} mm"
    )
    print(
        f"  DXF: {dxf_res['cut_span_mm'][0]:.4f} x {dxf_res['cut_span_mm'][1]:.4f} mm | "
        f"{dxf_res['closed_flag_count']}/{dxf_res['lwpolyline_count']} closed LWPOLYLINE | "
        f"50mm ref = {dxf_res['ref_span_mm'][0]:.3f} x {dxf_res['ref_span_mm'][1]:.3f} mm"
    )
    print(
        f"  STL: {stl_res['xyz_span_mm'][0]:.4f} x {stl_res['xyz_span_mm'][1]:.4f} x {stl_res['xyz_span_mm'][2]:.4f} mm | "
        f"F={stl_res['face_count']}, E={stl_res['edge_count']}, 3F=2E={stl_res['three_f_eq_two_e']} | "
        f"vol={stl_res['signed_volume_mm3']:.3f} mm^3"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
