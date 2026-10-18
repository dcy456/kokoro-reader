"""Write test/fixtures/sample-paper.pdf: a tiny two-page "paper" with a running
header, page numbers, citations and a References section, for the reader tests."""
import pathlib

HEADER = "Sample Paper for Kokoro Reader Tests"
PAGES = [
    [
        "1 Introduction",
        "Neural text to speech has improved quickly in recent years [1, 2].",
        "Small models now run on a laptop without a server.",
        "This paper studies reading scientific papers aloud.",
        "2 Method",
        "We select a sentence and start reading from that point.",
        "Reading continues across the page break without stopping.",
    ],
    [
        "The second page continues the method section here.",
        "Our results show that listening helps with long papers.",
        "3 Conclusion",
        "Reading aloud makes papers easier to review on the go.",
        "References",
        "[1] A. Author. A study of speech. 2020.",
        "[2] B. Author. Another study of speech. 2021.",
    ],
]


def page_stream(lines, number):
    ops = ["BT /F1 9 Tf 72 760 Td (%s) Tj ET" % HEADER]
    ops.append("BT /F1 12 Tf 72 700 Td 20 TL")
    for line in lines:
        ops.append("(%s) '" % line)
    ops.append("ET")
    ops.append("BT /F1 9 Tf 300 40 Td (%d) Tj ET" % number)
    return "\n".join(ops)


objs = ["<< /Type /Catalog /Pages 2 0 R >>"]
kids = []
body = []
font_id = 3 + 2 * len(PAGES)
for i, lines in enumerate(PAGES):
    page_id, content_id = 3 + 2 * i, 4 + 2 * i
    kids.append("%d 0 R" % page_id)
    stream = page_stream(lines, i + 1)
    body.append(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R "
        "/Resources << /Font << /F1 %d 0 R >> >> >>" % (content_id, font_id)
    )
    body.append("<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
objs.append("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(kids), len(PAGES)))
objs += body
objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

out = b"%PDF-1.4\n"
offsets = []
for n, obj in enumerate(objs, 1):
    offsets.append(len(out))
    out += ("%d 0 obj\n%s\nendobj\n" % (n, obj)).encode("latin-1")
xref = len(out)
out += ("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode()
out += b"".join(("%010d 00000 n \n" % o).encode() for o in offsets)
out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)).encode()
target = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures" / "sample-paper.pdf"
target.write_bytes(out)
print(target)
