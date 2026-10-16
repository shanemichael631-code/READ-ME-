"""Side-view mockup: Nova Filters logo (36" wide) on a gray 2019 Mercedes-Benz Sprinter cargo van.

Van is drawn to approximate 2019 (VS30) Sprinter 144" wheelbase high-roof cargo proportions
(~233" long, ~108" tall). It is an illustration for size and placement, not a CAD template.
Run:  python3 sprinter_mockup.py   ->  Nova-Sprinter-Mockup.pdf
"""
import os
from reportlab.lib.colors import CMYKColor
import build_wrap as W

K = 10.0                      # points per inch
L, H = 233, 108
M = 14
GY = 22
PW, PH = (L + 2 * M) * K, (H + GY + 34) * K

LOGO_W = 36                   # logo width in inches
LOGO_X = 174.5               # left edge, inches from front bumper (centred on rear cargo panel)
LOGO_TOP = 86                 # top of drop, inches above ground

PAINT_TOP = CMYKColor(0, 0, 0, 0.30)
PAINT_BOT = CMYKColor(0.02, 0, 0, 0.52)
EDGE = CMYKColor(0, 0, 0, 0.75)
CREASE = CMYKColor(0, 0, 0, 0.62)
HILITE = CMYKColor(0, 0, 0, 0.18)
GLASS_T = CMYKColor(0.70, 0.50, 0.30, 0.65)
GLASS_B = CMYKColor(0.55, 0.35, 0.20, 0.35)
TRIM = CMYKColor(0, 0, 0, 0.88)
BG = CMYKColor(0.04, 0.01, 0, 0)


def P(x, y):
    return (M + x) * K, (GY + y) * K


def path(c, pts, close=True):
    p = c.beginPath()
    p.moveTo(*P(*pts[0]))
    for pt in pts[1:]:
        if len(pt) == 6:
            p.curveTo(*P(pt[0], pt[1]), *P(pt[2], pt[3]), *P(pt[4], pt[5]))
        else:
            p.lineTo(*P(*pt))
    if close:
        p.close()
    return p


def fill(c, pts, color):
    c.setFillColor(color)
    c.drawPath(path(c, pts), fill=1, stroke=0)


def line(c, pts, color, lw):
    c.setStrokeColor(color)
    c.setLineWidth(lw * K / 4)
    c.setLineCap(1)
    c.drawPath(path(c, pts, close=False), fill=0, stroke=1)


FW, RW = 39, 183              # wheel centres (144" wheelbase)
BODY = [(3, 12), (0.5, 20), (0, 27, 0.5, 33, 2, 37), (5, 44, 9, 47, 15, 49),
        (33, 56), (36, 58), (63, 94), (66, 99, 72, 104, 82, 106.5),
        (92, 108), (224, 108), (230, 108, 233, 106, 233, 100), (233, 15),
        (231, 12), (RW + 19, 12), (RW + 18, 26, RW + 9, 32, RW, 32), (RW - 9, 32, RW - 18, 26, RW - 19, 12),
        (FW + 19, 12), (FW + 18, 26, FW + 9, 32, FW, 32), (FW - 9, 32, FW - 18, 26, FW - 19, 12)]


def wheel(c, x):
    cx, cy = P(x, 14)
    c.setFillColor(CMYKColor(0, 0, 0, 0.93))
    c.circle(cx, cy, 14 * K, fill=1, stroke=0)
    c.setFillColor(CMYKColor(0, 0, 0, 0.45))
    c.circle(cx, cy, 8.3 * K, fill=1, stroke=0)
    c.setFillColor(CMYKColor(0, 0, 0, 0.25))
    c.circle(cx, cy, 7.2 * K, fill=1, stroke=0)
    c.setFillColor(CMYKColor(0, 0, 0, 0.55))
    for i in range(6):
        import math
        a = i * math.pi / 3
        c.circle(cx + 4.6 * K * math.cos(a), cy + 4.6 * K * math.sin(a), 0.9 * K, fill=1, stroke=0)
    c.setFillColor(CMYKColor(0, 0, 0, 0.7))
    c.circle(cx, cy, 2.2 * K, fill=1, stroke=0)


def van(c):
    # ground shadow
    c.setFillColor(CMYKColor(0, 0, 0, 0.20))
    c.ellipse(*P(2, -3), *P(235, 3), fill=1, stroke=0)
    # dark wheel wells
    for x in (FW, RW):
        c.setFillColor(CMYKColor(0, 0, 0, 0.85))
        c.circle(*P(x, 14), 18.5 * K, fill=1, stroke=0)

    # painted body with a metallic vertical gradient
    c.saveState()
    c.clipPath(path(c, BODY), stroke=0, fill=0)
    x0, y0 = P(0, 108)
    x1, y1 = P(0, 12)
    c.linearGradient(x0, y0, x1, y1, [PAINT_TOP, CMYKColor(0, 0, 0, 0.38), PAINT_BOT], positions=[0, 0.55, 1])
    # roof sheen
    fill(c, [(92, 107), (224, 107), (224, 103.5), (92, 104.5)], HILITE)
    c.restoreState()
    c.setStrokeColor(EDGE)
    c.setLineWidth(1.6 * K / 4)
    c.drawPath(path(c, BODY), fill=0, stroke=1)

    # front: black lower bumper, grille, swept headlight, mirror
    fill(c, [(3, 12), (0.5, 20), (0, 27), (16, 27), (17, 12)], TRIM)
    fill(c, [(0.4, 30), (1.5, 37), (6, 40), (6, 30)], CMYKColor(0, 0, 0, 0.8))
    fill(c, [(3, 41), (8, 46.5), (24, 52), (26, 49), (10, 42)], CMYKColor(0.05, 0.03, 0, 0.12))
    line(c, [(3, 41), (8, 46.5), (24, 52), (26, 49), (10, 42), (3, 41)], EDGE, 0.8)
    fill(c, [(55, 66), (62, 70), (62, 60), (55, 59)], TRIM)          # mirror
    # rear bumper + vertical tail light
    fill(c, [(214, 12), (214, 20), (233, 20), (233, 15), (231, 12)], TRIM)
    fill(c, [(230.5, 50), (233, 50), (233, 76), (230.5, 76)], CMYKColor(0, 0.95, 0.85, 0.15))

    # cab glass: windshield edge + door window
    win = [(39, 61), (40, 62), (63, 92), (66, 93), (66, 63)]
    c.saveState()
    c.clipPath(path(c, [(37, 60), (62, 94), (64, 95), (90, 95), (90, 63), (40, 60)]), stroke=0, fill=0)
    gx0, gy0 = P(0, 95)
    gx1, gy1 = P(0, 60)
    c.linearGradient(gx0, gy0, gx1, gy1, [GLASS_T, GLASS_B])
    c.restoreState()
    c.setFillColor(CMYKColor(0, 0, 0, 0.85))
    c.drawPath(path(c, [(64, 63), (64, 93), (67, 95), (67, 63)]), fill=1, stroke=0)   # B-pillar
    fill(c, [(48, 63), (66, 92), (66, 90), (52, 63)], CMYKColor(0.3, 0.15, 0.05, 0.10))  # glass glint

    # body character lines (Sprinter beltline + lower crease)
    line(c, [(24, 52), (60, 55), (233, 58)], CREASE, 0.9)
    line(c, [(26, 53.2), (60, 56.2), (233, 59.2)], HILITE, 0.6)
    line(c, [(17, 27), (21, 27)], CREASE, 0.7)
    line(c, [(58, 26), (163, 26)], CREASE, 0.7)
    line(c, [(203, 26), (230, 26)], CREASE, 0.7)

    # door seams: cab door, sliding door, sliding-door rail
    line(c, [(91, 104), (91, 14)], EDGE, 1.0)
    line(c, [(66, 95), (91, 98)], EDGE, 0.8)
    line(c, [(95, 14), (95, 100), (152, 100), (152, 14)], EDGE, 1.0)
    # handles
    fill(c, [(80, 57.8), (87, 57.8), (87, 56.2), (80, 56.2)], TRIM)
    fill(c, [(98, 54.8), (105, 54.8), (105, 53.2), (98, 53.2)], TRIM)
    # fuel door
    line(c, [(60, 40), (66, 40), (66, 45), (60, 45), (60, 40)], CREASE, 0.6)

    wheel(c, FW)
    wheel(c, RW)


def label(c, txt, y, size, k):
    W.draw_text(c, W.INTER_BOLD, txt, PW / 2, y * K, size * K, CMYKColor(0, 0, 0, k), align="center")


def main(out):
    c = W.NoFontCanvas(out, pagesize=(PW, PH))
    c.setTitle("Nova Filters logo on a gray 2019 Sprinter")
    c.setFillColor(BG)
    c.rect(0, 0, PW, PH, fill=1, stroke=0)
    van(c)
    lx, ltop = P(LOGO_X, LOGO_TOP)
    W.draw_logo(c, lx, ltop, LOGO_W * K)
    label(c, "Nova Filters logo, 36\" wide, on a gray 2019 Mercedes-Benz Sprinter (144\" WB high roof)", GY + H + 18, 3.6, 0.7)
    label(c, "Illustration for size and placement. Van proportions approximate; send a side photo for an exact mockup.",
          8, 2.6, 0.5)
    c.showPage()
    c.save()


if __name__ == "__main__":
    main(os.path.join(os.path.dirname(os.path.abspath(__file__)), "Nova-Sprinter-Mockup.pdf"))
