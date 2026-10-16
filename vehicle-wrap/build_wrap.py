"""Nova Filters van wrap panel, 36" W x 48" H trim.

Builds:
  Nova-Van-Wrap_36x48_PRINT.pdf  - print file: CMYK, all vector, text outlined, 2" bleed, Trim/Bleed boxes set
  Nova-Van-Wrap_36x48_PROOF.pdf  - same art with trim, safe-zone and dimension guides (do not print)
  Nova-Filters-Logo.pdf   - the rebuilt logo on its own

Edit CONTACT/SERVICES below and re-run:  python3 build_wrap.py
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen
from reportlab.pdfgen import canvas
from reportlab.lib.colors import CMYKColor

# ---------------- EDIT ME ----------------
PHONE = "(352) XXX-XXXX"
WEBSITE = "YOURWEBSITE.COM"
TAGLINE = "SALES  •  INSTALLATION  •  SERVICE"
LEFT_STACK = ["SERVING", "CENTRAL", "FLORIDA"]
RIGHT_STACK = ["WATER", "TREATMENT", "SPECIALISTS"]
SERVICES = ["REVERSE OSMOSIS", "WATER SOFTENERS", "WHOLE-HOUSE FILTRATION", "UV DISINFECTION"]
# -----------------------------------------

IN = 72.0
TRIM_W, TRIM_H = 36 * IN, 48 * IN
BLEED = 2 * IN
SAFE = 1.5 * IN
PAGE_W, PAGE_H = TRIM_W + 2 * BLEED, TRIM_H + 2 * BLEED

# Brand colors, CMYK 0-1 (sampled from logo, built as process values)
NAVY = CMYKColor(1.00, 0.88, 0.00, 0.22)
BLUE = CMYKColor(0.85, 0.30, 0.00, 0.00)
SKY = CMYKColor(0.55, 0.05, 0.00, 0.00)
ICE = CMYKColor(0.12, 0.00, 0.01, 0.00)
WHITE = CMYKColor(0, 0, 0, 0)
GRAY = CMYKColor(0, 0, 0, 0.80)
GUIDE = CMYKColor(0, 1, 1, 0)

ARIAL_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
INTER_BLACK = "/usr/share/fonts/opentype/inter/Inter-Black.otf"
INTER_BOLD = "/usr/share/fonts/opentype/inter/Inter-Bold.otf"
INTER_XB = "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"
_fonts = {}


def font(path):
    if path not in _fonts:
        _fonts[path] = TTFont(path)
    return _fonts[path]


class RLPen(BasePen):
    """fontTools pen -> reportlab path, with scale + offset."""

    def __init__(self, gs, path, s, dx, dy, sx=1.0):
        super().__init__(gs)
        self.p, self.s, self.dx, self.dy, self.sx = path, s, dx, dy, sx

    def _t(self, pt):
        return (self.dx + pt[0] * self.s * self.sx, self.dy + pt[1] * self.s)

    def _moveTo(self, pt):
        self.p.moveTo(*self._t(pt))

    def _lineTo(self, pt):
        self.p.lineTo(*self._t(pt))

    def _curveToOne(self, a, b, c):
        self.p.curveTo(*self._t(a), *self._t(b), *self._t(c))

    def _closePath(self):
        self.p.close()


def text_width(fpath, txt, size, track=0.0, sx=1.0):
    f = font(fpath)
    upm = f["head"].unitsPerEm
    cmap, hmtx = f.getBestCmap(), f["hmtx"]
    w = sum(hmtx[cmap[ord(ch)]][0] for ch in txt) * size / upm * sx
    return w + track * size * (len(txt) - 1)


def cap_height(fpath, size):
    f = font(fpath)
    return f["OS/2"].sCapHeight * size / f["head"].unitsPerEm


def text_path(c, fpath, txt, x, y, size, track=0.0, sx=1.0, align="left"):
    """Return a reportlab path of the outlined text (baseline at y)."""
    f = font(fpath)
    upm = f["head"].unitsPerEm
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f["hmtx"]
    w = text_width(fpath, txt, size, track, sx)
    if align == "center":
        x -= w / 2
    elif align == "right":
        x -= w
    s = size / upm
    p = c.beginPath()
    for ch in txt:
        g = cmap[ord(ch)]
        gs[g].draw(RLPen(gs, p, s, x, y, sx))
        x += hmtx[g][0] * s * sx + track * size
    return p


def draw_text(c, fpath, txt, x, y, size, color, **kw):
    c.setFillColor(color)
    c.drawPath(text_path(c, fpath, txt, x, y, size, **kw), fill=1, stroke=0, fillMode=0)


def fit_size(fpath, txt, max_w, max_cap, track=0.0):
    size = max_cap / (cap_height(fpath, 1000) / 1000)
    w = text_width(fpath, txt, size, track)
    return size * min(1.0, max_w / w)


def drop_path(c, cx, tip_y, bottom_y, half_w, point=1.0):
    """Water drop: point at top, round bottom. point=0 morphs it into a circle."""
    r = half_w
    cy = bottom_y + r
    k = 0.5523 * r
    lerp = lambda a, b: b + (a - b) * point
    ty = lerp(tip_y, cy + r)
    c1x, c1y = lerp(r * 0.25, k), lerp(tip_y - (tip_y - cy) * 0.35, cy + r)
    c2y = lerp(cy + r * 0.85, cy + k)
    p = c.beginPath()
    p.moveTo(cx, ty)
    p.curveTo(cx + c1x, c1y, cx + r, c2y, cx + r, cy)
    p.curveTo(cx + r, cy - k, cx + k, cy - r, cx, cy - r)
    p.curveTo(cx - k, cy - r, cx - r, cy - k, cx - r, cy)
    p.curveTo(cx - r, c2y, cx - c1x, c1y, cx, ty)
    p.close()
    return p


def _mix(c1, c2, t):
    return CMYKColor(*[x + (y - x) * t for x, y in zip(
        (c1.cyan, c1.magenta, c1.yellow, c1.black), (c2.cyan, c2.magenta, c2.yellow, c2.black))])


# drop body: rim (t=0) -> core (t=1). Dark edges and a bright core read as water refracting light
DROP_STOPS = [(0.00, CMYKColor(1.00, 0.72, 0.00, 0.30)),
              (0.10, CMYKColor(1.00, 0.58, 0.00, 0.08)),
              (0.40, CMYKColor(0.88, 0.32, 0.00, 0.00)),
              (0.75, CMYKColor(0.58, 0.06, 0.00, 0.00)),
              (1.00, CMYKColor(0.28, 0.00, 0.00, 0.00))]


def _drop_color(t):
    for (t0, c0), (t1, c1) in zip(DROP_STOPS, DROP_STOPS[1:]):
        if t <= t1:
            return _mix(c0, c1, (t - t0) / (t1 - t0))
    return DROP_STOPS[-1][1]


def draw_drop(c, cx, tip_y, bottom_y, half_w, steps=80):
    """Realistic water drop, all opaque CMYK vector (no transparency to flatten).

    The body is a stack of nested drop shapes shrinking toward a focal point in the
    lower half, so the color runs from a dark rim to a bright refracted core.
    """
    r = half_w
    fx, fy = cx + r * 0.10, bottom_y + r * 0.62  # where light collects
    c.saveState()
    c.clipPath(drop_path(c, cx, tip_y, bottom_y, half_w), stroke=0, fill=0)
    for i in range(steps):
        t = i / (steps - 1)
        k = 1 - t * 0.985
        c.setFillColor(_drop_color(t))
        c.drawPath(drop_path(c, fx + (cx - fx) * k, fy + (tip_y - fy) * k, fy + (bottom_y - fy) * k, r * k,
                             point=max(0.0, 1 - t * 1.6)), fill=1, stroke=0)

    # thin bright rim along the bottom edge (light bending through the curve)
    rim = drop_path(c, cx, tip_y, bottom_y, half_w)
    p2 = drop_path(c, cx - r * 0.025, tip_y + r * 0.03, bottom_y + r * 0.045, r * 0.975)
    c.setFillColor(CMYKColor(0.62, 0.10, 0.00, 0.00))
    path = c.beginPath()
    for sub in (rim, p2):
        path._code.extend(op for op in sub._code if op != "n")  # drop newpath so both subpaths survive
    c.drawPath(path, fill=1, stroke=0, fillMode=0)  # even-odd -> crescent

    white = CMYKColor(0, 0, 0, 0)
    # main specular highlight: curved streak on the upper left
    c.setFillColor(white)
    hp = c.beginPath()
    hx, hy = cx - r * 0.50, bottom_y + r * 1.05
    hp.moveTo(hx + r * 0.10, hy + r * 0.80)
    hp.curveTo(hx - r * 0.22, hy + r * 0.40, hx - r * 0.24, hy - r * 0.20, hx - r * 0.02, hy - r * 0.55)
    hp.curveTo(hx - r * 0.06, hy - r * 0.15, hx - r * 0.02, hy + r * 0.35, hx + r * 0.10, hy + r * 0.80)
    hp.close()
    c.drawPath(hp, fill=1, stroke=0)
    # small sparkle above the streak
    c.ellipse(cx - r * 0.40, bottom_y + r * 1.98, cx - r * 0.24, bottom_y + r * 2.20, fill=1, stroke=0)
    # soft secondary reflection, lower right
    c.setFillColor(CMYKColor(0.15, 0.00, 0.00, 0.00))
    sp = c.beginPath()
    sx, sy = cx + r * 0.55, bottom_y + r * 0.55
    sp.moveTo(sx + r * 0.22, sy + r * 0.38)
    sp.curveTo(sx + r * 0.26, sy + r * 0.05, sx + r * 0.10, sy - r * 0.25, sx - r * 0.20, sy - r * 0.36)
    sp.curveTo(sx + r * 0.02, sy - r * 0.18, sx + r * 0.14, sy + r * 0.05, sx + r * 0.22, sy + r * 0.38)
    sp.close()
    c.drawPath(sp, fill=1, stroke=0)
    c.restoreState()


def draw_logo(c, x, top, nova_w):
    """Nova Filters logo. x = left edge, top = top of drop tip. Returns (width, height)."""
    f = ARIAL_BOLD
    # size so that N + drop + va spans nova_w
    probe = 1000.0
    n_w = text_width(f, "N", probe)
    va_w = text_width(f, "va", probe)
    drop_w = 0.62 * probe
    gap = 0.02 * probe
    size = nova_w / (n_w + drop_w + va_w + 2 * gap) * probe
    k = size / probe
    capH = cap_height(f, size)
    base = top - capH * 1.12
    draw_text(c, f, "N", x, base, size, NAVY)
    dcx = x + (n_w + gap) * k + drop_w * k / 2
    draw_drop(c, dcx, top, base - capH * 0.07, drop_w * k / 2)
    draw_text(c, f, "va", x + (n_w + 2 * gap + drop_w) * k, base, size, NAVY)
    # FILTERS: vertical, reads bottom-to-top, outlined letters, centered under drop
    fl_len = nova_w * 0.66
    fl_cap = drop_w * k * 0.62
    fsz = fl_cap / (cap_height(INTER_BLACK, 1000) / 1000)
    sx = fl_len / text_width(INTER_BLACK, "FILTERS", fsz, track=0.04)
    fl_top = base - capH * 0.07 - capH * 0.10
    c.saveState()
    c.translate(dcx + fl_cap / 2, fl_top - fl_len)  # baseline on the right after rotation
    c.rotate(90)
    p = text_path(c, INTER_BLACK, "FILTERS", 0, 0, fsz, track=0.04, sx=sx)
    c.setFillColor(WHITE)
    c.setStrokeColor(GRAY)
    c.setLineWidth(fl_cap * 0.045)
    c.setLineJoin(1)
    c.drawPath(p, fill=1, stroke=1, fillMode=0)
    c.restoreState()
    return {"w": nova_w, "h": top - (fl_top - fl_len), "col_l": dcx - fl_cap * 0.6,
            "col_r": dcx + fl_cap * 0.6, "fl_top": fl_top, "bottom": fl_top - fl_len, "drop_x": dcx}


def wave(c, y, amp, color, phase=0.0, to_bottom=0):
    """Fill from a wavy line at height y down to to_bottom, across the whole page."""
    p = c.beginPath()
    p.moveTo(0, to_bottom)
    p.lineTo(0, y)
    seg = PAGE_W / 2
    for i in range(2):
        x0 = i * seg
        a = amp if (i + phase) % 2 == 0 else -amp
        p.curveTo(x0 + seg * 0.33, y + a, x0 + seg * 0.66, y - a, x0 + seg, y)
    p.lineTo(PAGE_W, to_bottom)
    p.close()
    c.setFillColor(color)
    c.drawPath(p, fill=1, stroke=0)


def build_art(c):
    # positions measured in inches from TOP of trim -> page y
    def Y(inch_from_top):
        return BLEED + TRIM_H - inch_from_top * IN

    L, R = BLEED + SAFE, BLEED + TRIM_W - SAFE
    CX = PAGE_W / 2
    safe_w = R - L

    # background
    c.setFillColor(WHITE)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # logo, top area: centre the "Nova" word
    nova_w = 22.5 * IN
    lg = draw_logo(c, CX - nova_w / 2, Y(1.7), nova_w)

    # stacked text either side of the FILTERS column
    def stack(lines, x0, x1, color, align):
        gap = 0.9 * IN
        w = (x1 - x0) - gap
        sz = min(fit_size(INTER_BLACK, t, w, 1.5 * IN, track=0.02) for t in lines)
        ch = cap_height(INTER_BLACK, sz)
        lead = ch * 1.55
        total = ch + lead * (len(lines) - 1)
        mid = (lg["fl_top"] + lg["bottom"]) / 2
        y = mid + total / 2 - ch
        x = x1 - gap if align == "right" else x0 + gap
        for t in lines:
            draw_text(c, INTER_BLACK, t, x, y, sz, color, track=0.02, align=align)
            y -= lead

    stack(LEFT_STACK, L, lg["col_l"], BLUE, "right")
    stack(RIGHT_STACK, lg["col_r"], R, NAVY, "left")

    # waves -> navy info area
    wave(c, Y(25.2), 0.9 * IN, SKY, phase=0)
    wave(c, Y(25.9), 0.8 * IN, BLUE, phase=1)
    wave(c, Y(26.7), 0.7 * IN, NAVY, phase=0)

    # tagline under logo, right of FILTERS column (white area)
    # services with drop bullets
    top = 28.6
    cap = 1.45
    pitch = 2.25
    bullet = 0.55 * IN
    longest = max(SERVICES, key=lambda s: text_width(INTER_XB, s, 100))
    sz = fit_size(INTER_XB, longest, safe_w - 2.2 * IN, cap * IN, track=0.02)
    block_w = text_width(INTER_XB, longest, sz, track=0.02) + 1.4 * IN
    bx = CX - block_w / 2
    for i, s in enumerate(SERVICES):
        base = Y(top + cap + i * pitch)
        capH = cap_height(INTER_XB, sz)
        draw_drop(c, bx + bullet / 2, base + capH * 1.05, base - capH * 0.05, bullet / 2)
        draw_text(c, INTER_XB, s, bx + 1.4 * IN, base, sz, WHITE, track=0.02)

    # phone band (bleeds edge to edge)
    band_top, band_bot = 38.0, 42.6
    c.setFillColor(SKY)
    c.rect(0, Y(band_bot), PAGE_W, (band_bot - band_top) * IN, fill=1, stroke=0)
    psz = fit_size(INTER_BLACK, PHONE, safe_w, 3.0 * IN, track=0.01)
    pc = cap_height(INTER_BLACK, psz)
    mid = (Y(band_top) + Y(band_bot)) / 2
    draw_text(c, INTER_BLACK, PHONE, CX, mid - pc / 2, psz, NAVY, track=0.01, align="center")

    # website + tagline
    wsz = fit_size(INTER_BLACK, WEBSITE, safe_w, 1.3 * IN, track=0.03)
    draw_text(c, INTER_BLACK, WEBSITE, CX, Y(43.4) - cap_height(INTER_BLACK, wsz), wsz, WHITE, track=0.03, align="center")
    tag = TAGLINE
    tsz = fit_size(INTER_BOLD, tag, safe_w, 0.75 * IN, track=0.06)
    draw_text(c, INTER_BOLD, tag, CX, Y(46.15), tsz, SKY, track=0.06, align="center")


class NoFontCanvas(canvas.Canvas):
    """reportlab normally declares an unused, unembedded Helvetica; RIP preflight flags that."""

    def _make_preamble(self):
        self._preamble = "1 0 0 1 0 0 cm"


def set_boxes(c):
    c.setTrimBox((BLEED, BLEED, BLEED + TRIM_W, BLEED + TRIM_H))
    c.setBleedBox((0, 0, PAGE_W, PAGE_H))
    c.setArtBox((BLEED, BLEED, BLEED + TRIM_W, BLEED + TRIM_H))


def guides(c):
    c.setStrokeColor(GUIDE)
    c.setLineWidth(4)
    c.rect(BLEED, BLEED, TRIM_W, TRIM_H, fill=0, stroke=1)
    c.setDash(24, 16)
    c.setStrokeColor(CMYKColor(1, 0, 1, 0))
    c.rect(BLEED + SAFE, BLEED + SAFE, TRIM_W - 2 * SAFE, TRIM_H - 2 * SAFE, fill=0, stroke=1)
    c.setDash()
    lab = lambda t, x, y, col=GUIDE: draw_text(c, INTER_BOLD, t, x, y, 0.5 * IN, col)
    lab("TRIM 36\" x 48\"", BLEED + 10, BLEED + TRIM_H + 14)
    lab("BLEED 2\" (art extends to page edge)", BLEED + 10, BLEED - 0.75 * IN)
    lab("SAFE ZONE 1.5\" inside trim", BLEED + SAFE + 10, BLEED + SAFE + 12, CMYKColor(1, 0, 1, 0))
    draw_text(c, INTER_BOLD, "PROOF - NOT FOR PRINT", PAGE_W - BLEED - 10, BLEED - 0.75 * IN, 0.5 * IN, GUIDE, align="right")


def make(path, with_guides):
    c = NoFontCanvas(path, pagesize=(PAGE_W, PAGE_H))
    c.setTitle("Nova Filters Van Wrap 36x48" + (" PROOF" if with_guides else ""))
    c.setAuthor("Nova Filters")
    set_boxes(c)
    build_art(c)
    if with_guides:
        guides(c)
    c.showPage()
    c.save()


def make_logo(path):
    """Logo only, transparent (no background), page cropped tight with a 0.25" margin."""
    w, m = 27 * IN, 0.25 * IN
    probe = NoFontCanvas(os.devnull)
    h = draw_logo(probe, 0, 0, w)["h"]
    c = NoFontCanvas(path, pagesize=(w + 2 * m, h + 2 * m))
    c.setTitle("Nova Filters Logo (vector rebuild)")
    draw_logo(c, m, h + m, w)
    c.showPage()
    c.save()


if __name__ == "__main__":
    out = os.path.dirname(os.path.abspath(__file__))
    make(os.path.join(out, "Nova-Van-Wrap_36x48_PRINT.pdf"), False)
    make(os.path.join(out, "Nova-Van-Wrap_36x48_PROOF.pdf"), True)
    make_logo(os.path.join(out, "Nova-Filters-Logo.pdf"))
    print("done")
