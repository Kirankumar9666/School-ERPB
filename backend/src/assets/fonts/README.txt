DejaVu fonts (DejaVuSans.ttf, DejaVuSans-Bold.ttf, DejaVuSans-Oblique.ttf),
version 2.37 — downloaded from https://github.com/dejavu-fonts/dejavu-fonts

Used by the server-side payslip PDF generator (services/payslip.js). The PDF
standard's built-in Helvetica fonts are WinAnsi-encoded and have no glyph for
the Indian rupee sign (₹, U+20B9), so a Unicode font must be embedded for
currency amounts to render. DejaVu Sans includes it and is subsetted by
pdfkit on export, so only the used glyphs ship in each PDF.

License: Bitstream Vera license + public-domain additions (free to use,
redistribute and modify). Full text:
https://github.com/dejavu-fonts/dejavu-fonts/blob/master/LICENSE
