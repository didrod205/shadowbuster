#!/usr/bin/env python3
"""Generate real sample files that demonstrate each leak ShadowBuster finds.

These are committed under fixtures/ so tests and the live demo never need any
toolchain to reproduce them. Every file is a genuine, openable document.
Pure stdlib (zlib, struct, zipfile) — no Pillow, no office libraries.
"""
import os
import struct
import zlib
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "fixtures"))
os.makedirs(OUT, exist_ok=True)


# --------------------------------------------------------------------------- #
# Minimal PNG encoder (solid colour) — no Pillow
# --------------------------------------------------------------------------- #
def png_bytes(w, h, rgb):
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    row = b"\x00" + bytes(rgb) * w
    raw = row * h
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


# --------------------------------------------------------------------------- #
# 1. Redacted PDF — black boxes over still-present text
# --------------------------------------------------------------------------- #
def make_pdf():
    content = b"""BT
/F1 14 Tf
1 0 0 1 72 700 Tm (Employee name:) Tj
1 0 0 1 200 700 Tm (Jane Doe) Tj
1 0 0 1 72 670 Tm (Social Security No:) Tj
1 0 0 1 200 670 Tm (123-45-6789) Tj
1 0 0 1 72 640 Tm (Annual salary:) Tj
1 0 0 1 200 640 Tm ($240,000) Tj
1 0 0 1 72 590 Tm (This document has been redacted for privacy.) Tj
ET
0 0 0 rg
198 696 110 18 re f
198 666 120 18 re f
198 636 90 18 re f
"""
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
    )
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")

    out = b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n"
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 %d\n" % (len(objs) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref_pos)
    open(os.path.join(OUT, "redacted-report.pdf"), "wb").write(out)


# --------------------------------------------------------------------------- #
# OOXML helpers
# --------------------------------------------------------------------------- #
def write_zip(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data if isinstance(data, bytes) else data.encode("utf-8"))


CORE = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    ' xmlns:dc="http://purl.org/dc/elements/1.1/">'
    "<dc:creator>{creator}</dc:creator><cp:lastModifiedBy>{last}</cp:lastModifiedBy>"
    "</cp:coreProperties>"
)


# --------------------------------------------------------------------------- #
# 2. xlsx — a "very hidden" worksheet full of comp data
# --------------------------------------------------------------------------- #
def make_xlsx():
    def sheet(rows):
        cells = ""
        for r, cols in enumerate(rows, start=1):
            cs = ""
            for ci, val in enumerate(cols):
                ref = chr(ord("A") + ci) + str(r)
                cs += f'<c r="{ref}" t="inlineStr"><is><t>{val}</t></is></c>'
            cells += f'<row r="{r}">{cs}</row>'
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheetData>{cells}</sheetData></worksheet>"
        )

    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>",
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        "</Relationships>",
        "docProps/core.xml": CORE.format(creator="Finance Automation", last="r.chen@acme.example"),
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        "<sheets>"
        '<sheet name="Summary" sheetId="1" state="visible" r:id="rId1"/>'
        '<sheet name="Exec Comp (DO NOT SHIP)" sheetId="2" state="veryHidden" r:id="rId2"/>'
        "</sheets></workbook>",
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        "</Relationships>",
        "xl/worksheets/sheet1.xml": sheet([["Q3 Headcount Summary"], ["Total employees", "428"]]),
        "xl/worksheets/sheet2.xml": sheet(
            [
                ["Name", "Title", "Base", "Bonus"],
                ["Robert King", "CEO", "$1,200,000", "$3,400,000"],
                ["Dana Lewis", "CFO", "$780,000", "$1,100,000"],
                ["Priya Anand", "CTO", "$795,000", "$1,250,000"],
            ]
        ),
    }
    write_zip(os.path.join(OUT, "quarterly-figures.xlsx"), files)


# --------------------------------------------------------------------------- #
# 3. docx — tracked deletion + hidden text + comment
# --------------------------------------------------------------------------- #
def make_docx():
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        "<w:p><w:r><w:t>The settlement amount is </w:t></w:r>"
        '<w:del w:id="1" w:author="legal" w:date="2026-05-02T10:00:00Z">'
        "<w:r><w:delText>$5,000,000 (five million dollars)</w:delText></w:r></w:del>"
        "<w:r><w:t>redacted pending approval.</w:t></w:r></w:p>"
        "<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Internal note: client already verbally agreed to 5M.</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )
    comments = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:comment w:id="1" w:author="M. Powell" w:date="2026-05-02T10:05:00Z">'
        "<w:p><w:r><w:t>Do NOT let the other side see the real figure.</w:t></w:r></w:p></w:comment>"
        "</w:comments>"
    )
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
        "</Types>",
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        "</Relationships>",
        "docProps/core.xml": CORE.format(creator="paralegal-template", last="M. Powell"),
        "word/document.xml": document,
        "word/comments.xml": comments,
    }
    write_zip(os.path.join(OUT, "settlement-draft.docx"), files)


# --------------------------------------------------------------------------- #
# 4. pptx — a cropped image whose full original is embedded + speaker notes
# --------------------------------------------------------------------------- #
def make_pptx():
    slide = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        "<p:cSld><p:spTree>"
        "<p:pic><p:nvPicPr><p:cNvPr id='4' name='Chart'/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>"
        '<p:blipFill><a:blip r:embed="rId2"/>'
        '<a:srcRect l="0" t="0" r="50000" b="40000"/>'
        "<a:stretch><a:fillRect/></a:stretch></p:blipFill>"
        "<p:spPr/></p:pic>"
        "</p:spTree></p:cSld></p:sld>"
    )
    notes = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        "<p:cSld><p:spTree><p:sp><p:txBody>"
        "<a:p><a:r><a:t>Don't mention the layoffs until after the funding closes.</a:t></a:r></a:p>"
        "</p:txBody></p:sp></p:spTree></p:cSld></p:notes>"
    )
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>'
        "</Types>",
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        "</Relationships>",
        "ppt/presentation.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
        "ppt/_rels/presentation.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
        "</Relationships>",
        "ppt/slides/slide1.xml": slide,
        "ppt/slides/_rels/slide1.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>'
        "</Relationships>",
        "ppt/notesSlides/notesSlide1.xml": notes,
        # The embedded image is the FULL original; the slide only shows a crop of it.
        "ppt/media/image1.png": png_bytes(48, 48, (200, 40, 40)),
    }
    write_zip(os.path.join(OUT, "investor-deck.pptx"), files)


# --------------------------------------------------------------------------- #
# 5. PNG with a whole second image appended after IEND (acropalypse-style)
# --------------------------------------------------------------------------- #
def make_png():
    visible = png_bytes(16, 16, (60, 60, 60))       # the "cropped" thumbnail
    original = png_bytes(64, 48, (240, 70, 70))      # the full original, still there
    open(os.path.join(OUT, "cropped-screenshot.png"), "wb").write(visible + original)


if __name__ == "__main__":
    make_pdf()
    make_xlsx()
    make_docx()
    make_pptx()
    make_png()
    for f in sorted(os.listdir(OUT)):
        print(f"  fixtures/{f}  ({os.path.getsize(os.path.join(OUT, f))} bytes)")
    print("done.")
