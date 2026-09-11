export interface PdfFixturePage {
  readonly text?: string;
  readonly visual?: boolean;
  readonly rotate?: 90 | 180 | 270;
}

export function buildPdfFixture(options: {
  pages?: readonly (string | null | PdfFixturePage)[];
  javascript?: boolean;
} = {}): Buffer {
  const pages = options.pages ?? ["Hola LocalBridge"];
  const pageIds = pages.map((_value, index) => 3 + index);
  const contentIds = pages.map((_value, index) => 3 + pages.length + index);
  const fontId = 3 + pages.length * 2;
  const actionId = fontId + 1;
  const objects = new Map<number, string>();
  objects.set(1, `<< /Type /Catalog /Pages 2 0 R${options.javascript ? ` /OpenAction ${actionId} 0 R` : ""} >>`);
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((pageValue, index) => {
    const page: PdfFixturePage = typeof pageValue === "object" && pageValue !== null
      ? pageValue
      : typeof pageValue === "string" ? { text: pageValue } : {};
    const textStream = page.text === undefined ? "" : `BT /F1 12 Tf 72 720 Td (${page.text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    const visualStream = page.visual === true ? "0.15 0.45 0.8 rg 72 500 220 120 re f" : "";
    const stream = [visualStream, textStream].filter(Boolean).join("\n");
    const rotation = page.rotate === undefined ? "" : ` /Rotate ${page.rotate}`;
    objects.set(pageIds[index]!, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${rotation} /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`);
    objects.set(contentIds[index]!, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  if (options.javascript) objects.set(actionId, "<< /S /JavaScript /JS (app.alert('ignored')) >>");

  const maxObjectId = Math.max(...objects.keys());
  let pdf = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (let id = 1; id <= maxObjectId; id += 1) {
    offsets.set(id, Buffer.byteLength(pdf));
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxObjectId; id += 1) pdf += `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}
