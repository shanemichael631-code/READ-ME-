"""Side-view mockup: the 36x48 wrap panel at true scale on a generic high-roof cargo van.

Van is a generic ~19 ft high-roof cargo van (Transit / ProMaster class), not a specific model.
Run:  python3 van_mockup.py   ->  Nova-Van-Mockup.pdf
"""
import os
from reportlab.lib.colors import CMYKColor
import build_wrap as W

K = 10.0                       # points per inch of van
VAN_L, VAN_H = 222, 100
M = 14                         # margin, inches
PW, PH = (VAN_L + 2 * M) * K, (VAN_H + M + 30) * K
GY = 22                        # ground line, inches from page bottom

BODY = CMYKColor(0, 0, 0, 0.02)
LINE = CMYKColor(0, 0, 0, 0.55)
GLASS = CMYKColor(0.75, 0.55, 0.35, 0.55)
TIRE = CMYKColor(0, 0, 0, 0.92)
RIM = CMYKColor(0, 0, 0, 0.35)
SHADOW = CMYKColor(0, 0, 0, 0.18)
BG = CMYKColor(0.04, 0.01, 0, 0)


def P(x, y):
    return (M + x) * K, (GY + y) * K


def poly(c, pts, fill, stroke=LINE, lw=1.6, close=True):
    p = c.beginPath()
    p.moveTo(*P(*pts[0]))
    for pt in pts[1:]:
        if len(pt) == 6:
            p.curveTo(*P(pt[0], pt[1]), *P(pt[2], pt[3]), *P(pt[4], pt[5]))
        else:
            p.lineTo(*P(*pt))
    if close:
        p.close()
    c.setLineWidth(lw * K / 4)
    if stroke is not None:
        c.setStrokeColor(stroke)
    if fill is not None:
        c.setFillColor(fill)
    c.drawPath(p, fill=fill is not None, stroke=stroke is not None)


def wheel(c, x):
    cx, cy = P(x, 15)
    c.setFillColor(TIRE)
    c.circle(cx, cy, 15 * K, fill=1, stroke=0)
    c.setFillColor(RIM)
    c.circle(cx, cy, 8.5 * K, fill=1, stroke=0)
    c.setFillColor(CMYKColor(0, 0, 0, 0.6))
    c.circle(cx, cy, 3 * K, fill=1, stroke=0)


def van(c):
    # shadow
    c.setFillColor(SHADOW)
    c.ellipse(*P(4, -3), *P(220, 3), fill=1, stroke=0)
    # wheel-well backing
    for x in (38, 178):
        c.setFillColor(CMYKColor(0, 0, 0, 0.75))
        c.circle(*P(x, 15), 18 * K, fill=1, stroke=0)
    # body (front faces left)
    body = [(1, 14), (0, 32), (1, 40, 6, 49, 16, 52), (32, 56), (36, 60), (56, 92),
            (58, 96, 62, 97, 66, 97), (212, 97), (217, 97, 219, 95, 219, 90), (219, 16),
            (217, 13), (197, 13), (196, 24, 188, 33, 178, 33), (168, 33, 160, 24, 159, 13),
            (57, 13), (56, 24, 48, 33, 38, 33), (28, 33, 20, 24, 19, 13)]
    poly(c, body, BODY)
    # windshield + cab door window
    poly(c, [(37, 61), (55, 89), (58, 90), (60, 89), (60, 62)], GLASS, None)
    poly(c, [(63, 62), (63, 88), (88, 88), (88, 62)], GLASS, None)
    # door seams: cab door, sliding door, rear
    for pts in ([(61, 15), (61, 92)], [(91, 15), (91, 92)], [(146, 15), (146, 92)], [(91, 92), (146, 92)]):
        poly(c, pts, None, LINE, 1.2, close=False)
    poly(c, [(91, 62), (146, 62)], None, CMYKColor(0, 0, 0, 0.25), 0.8, close=False)  # slider track
    # handles, mirror, lights, bumpers
    poly(c, [(80, 58), (86, 58), (86, 56.5), (80, 56.5)], LINE, None)
    poly(c, [(94, 52), (100, 52), (100, 50.5), (94, 50.5)], LINE, None)
    poly(c, [(54, 70), (60, 72), (60, 64), (54, 63)], CMYKColor(0, 0, 0, 0.8), None)
    poly(c, [(1.5, 40), (9, 48), (13, 47), (6, 38)], CMYKColor(0, 0.1, 0.3, 0.05), LINE, 0.8)
    poly(c, [(216, 60), (219, 60), (219, 80), (216, 80)], CMYKColor(0, 0.9, 0.9, 0.1), None)
    poly(c, [(0, 14), (0, 24), (14, 24), (16, 14)], CMYKColor(0, 0, 0, 0.7), None)
    poly(c, [(205, 13), (205, 21), (220, 21), (220, 13)], CMYKColor(0, 0, 0, 0.7), None)
    wheel(c, 38)
    wheel(c, 178)


def panel(c, x0, y0):
    """Draw the real wrap art (trim area only) at true scale: 36 x 48 in."""
    c.saveState()
    c.translate(*P(x0, y0))
    s = K / 72.0
    c.scale(s, s)
    p = c.beginPath()
    p.rect(0, 0, W.TRIM_W, W.TRIM_H)
    c.clipPath(p, stroke=0, fill=0)
    c.translate(-W.BLEED, -W.BLEED)
    W.build_art(c)
    c.restoreState()


def dim(c, x0, y0, x1, y1, label, horiz):
    c.setStrokeColor(CMYKColor(0, 1, 1, 0))
    c.setLineWidth(2)
    c.line(*P(x0, y0), *P(x1, y1))
    W.draw_text(c, W.INTER_BOLD, label, *(
        (P((x0 + x1) / 2, y0 - 4)) if horiz else P(x0 + 2, (y0 + y1) / 2)),
        3 * K, CMYKColor(0, 1, 1, 0), align="center" if horiz else "left")


def main(out):
    c = W.NoFontCanvas(out, pagesize=(PW, PH))
    c.setTitle("Nova Filters van mockup")
    c.setFillColor(BG)
    c.rect(0, 0, PW, PH, fill=1, stroke=0)
    van(c)
    x0, y0 = 100.5, 34          # panel sits inside the sliding door (91"-146")
    panel(c, x0, y0)
    c.setStrokeColor(LINE)
    c.setLineWidth(1)
    c.rect(*P(x0, y0), 36 * K, 48 * K, fill=0, stroke=1)
    dim(c, x0, y0 - 3, x0 + 36, y0 - 3, '36"', True)
    dim(c, x0 + 39, y0, x0 + 39, y0 + 48, '48"', False)
    W.draw_text(c, W.INTER_BOLD, "36\" x 48\" panel shown to scale on a typical high-roof cargo van (~19 ft long)",
                PW / 2, (GY + 106) * K, 3.6 * K, CMYKColor(0, 0, 0, 0.7), align="center")
    W.draw_text(c, W.INTER_BOLD, "Generic van for size reference only. Send a straight-on side photo of your van for an exact mockup.",
                PW / 2, 9 * K, 2.6 * K, CMYKColor(0, 0, 0, 0.5), align="center")
    c.showPage()
    c.save()


if __name__ == "__main__":
    main(os.path.join(os.path.dirname(os.path.abspath(__file__)), "Nova-Van-Mockup.pdf"))
