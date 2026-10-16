# Nova Filters van wrap panel, 36" W x 48" H

| File | Use |
|---|---|
| `Nova-Van-Wrap_36x48_PRINT.pdf` | **Send this to the wrap shop.** |
| `Nova-Van-Wrap_36x48_PROOF.pdf` | Shows the trim line, safe zone and bleed. For review only, never print it. |
| `Nova-Van-Wrap_36x48_preview.png` | Low-res picture for texting or approval. |
| `Nova-Filters-Logo.pdf` | Logo, vector, CMYK, transparent background. Best file for printers and sign shops. |
| `Nova-Filters-Logo.svg` | Logo, vector, transparent. For Canva, websites and cutting machines. |
| `Nova-Filters-Logo.eps` | Logo, vector, transparent. For shops that ask for EPS or Illustrator files. |
| `Nova-Filters-Logo_transparent_8000px.png` | Logo, 8000 px transparent PNG. For apps that won't take vector files (Amazon, social media, CapCut). |
| `Nova-Phone-Logo_white.pdf` / `.svg` / `.eps` | Phone number 352.566.2649 in white, with realistic blue drops for the dots. Vector, transparent. For dark backgrounds. |
| `Nova-Phone-Logo_white_transparent_8000px.png` | Same, as an 8000 px transparent PNG |
| `Nova-Phone-Logo_white-1color.pdf` / `.svg` / `.eps` / `_8000px.png` | All-white version (solid white drops). For cut vinyl, screen printing and embroidery |
| `Nova-Phone-Logo_preview-on-navy.png` | Preview only. The white logo is hard to see on a white screen |
| `build_wrap.py` | Generator. Edit `PHONE`, `WEBSITE` and the text lists at the top, then run `python3 build_wrap.py`. |

## Print file specs (put these in the email to the shop)

- Finished (trim) size: 36" wide x 48" tall, portrait, at 1:1 full scale
- Bleed: 2" on every side, so the page is 40" x 52". TrimBox and BleedBox are set in the PDF
- Color: CMYK only. No RGB, no spot colors
- Artwork: 100% vector, so it has no resolution limit at any size
- Fonts: none. All text is converted to outlines, so no fonts can go missing
- Safe zone: all text and logo sit at least 1.5" inside the trim
- Brand colors (CMYK): Navy C100 M88 Y0 K22 · Blue C85 M30 Y0 K0 · Sky C55 M5 Y0 K0

## Before you submit

- [ ] Replace the placeholder website, then re-run the script (the phone number is now 352.566.2649)
- [ ] Confirm the service list and the "Serving Central Florida" line
- [ ] Approve the rebuilt logo, or send the shop your original vector logo (AI, EPS, SVG or PDF) if you have one
- [ ] Ask the shop: their bleed requirement (2" is common, some want 3–4"), whether they want 1:1 or 1:10 scale, and if the panel crosses a door seam, handle or body line
- [ ] Ask them for a cast wrap vinyl with matching laminate (e.g. 3M IJ180Cv3 + 8518, or Avery MPI 1105 + DOL 1460) and a printed proof before they run it
