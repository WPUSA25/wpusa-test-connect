// netlify/functions/punchlist_pdf.js
// Pro punchlist PDF (branding: dynamic from Supabase work_orders, fallback to Netlify env)
// Requires: pdf-lib in package.json (you already added it)

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// Optional branding fallbacks (configure in Netlify → Site settings → Environment variables)
const FALLBACK_BRAND = {
  companyName: process.env.BRAND_COMPANY_NAME || "WPUSA",
  companyTagline: process.env.BRAND_COMPANY_TAGLINE || "Field Delivery • Receiving • Punchlist",
  companyAddress:
    process.env.BRAND_COMPANY_ADDRESS ||
    "123 Any Street • Orlando, FL 32801 • (555) 123-4567",
  companyLogo: process.env.BRAND_LOGO_URL || "", // PNG/JPG URL (optional)
};

const supaFetch = async (path, init = {}) => {
  const url = `${SUPABASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase error ${res.status}: ${t}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
};

async function getPunchlistWithItems(punchlistId) {
  // punchlist
  const [pl] = await supaFetch(
    `/rest/v1/punchlists?select=id,work_order_id,created_at,status&id=eq.${punchlistId}`
  );
  if (!pl) throw new Error("Punchlist not found");

  // items
  const items = await supaFetch(
    `/rest/v1/punchlist_items?select=manufacturer,model,room,expected_qty,received_qty,missing_qty,damaged_qty,issue&punchlist_id=eq.${pl.id}&order=manufacturer.asc,model.asc,room.asc`
  );

  return { pl, items };
}

async function getWorkOrderBrand(work_order_id) {
  // Adjust these column names to match your table (safe defaults used below)
  // Add these columns if you want dynamic branding per job:
  //   client_name text
  //   project_name text
  //   client_logo_url text
  //   company_display_name text
  //   company_logo_url text
  const [wo] = await supaFetch(
    `/rest/v1/work_orders?select=code,project_name,client_name,client_logo_url,company_display_name,company_logo_url&id=eq.${work_order_id}`
  );

  return {
    workOrderCode: wo?.code || "",
    projectName: wo?.project_name || "Demo job",
    clientName: wo?.client_name || "",
    clientLogo: wo?.client_logo_url || "",
    companyDisplayName: wo?.company_display_name || FALLBACK_BRAND.companyName,
    companyLogo: wo?.company_logo_url || FALLBACK_BRAND.companyLogo,
  };
}

async function embedRemoteImage(pdfDoc, url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("png")) return pdfDoc.embedPng(buf);
    // default try jpeg
    return pdfDoc.embedJpg(buf);
  } catch {
    return null;
  }
}

function drawText(page, text, x, y, opts) {
  const {
    font,
    size = 10,
    color = rgb(0, 0, 0),
    maxWidth = null,
    align = "left",
  } = opts || {};
  if (!maxWidth) {
    page.drawText(text, { x, y, size, font, color });
    return;
  }
  // simple single-line clamp
  let t = text;
  while (font.widthOfTextAtSize(t, size) > maxWidth && t.length > 0) {
    t = t.slice(0, -1);
  }
  page.drawText(t, { x, y, size, font, color });
}

function drawTableHeader(page, x, y, w, h, fontBold) {
  page.drawRectangle({ x, y, width: w, height: h, color: rgb(0.95, 0.95, 0.95) });
  const cols = [
    { key: "manufacturer", title: "Manufacturer", width: 130 },
    { key: "model", title: "Model", width: 110 },
    { key: "room", title: "Room", width: 70 },
    { key: "expected_qty", title: "Exp", width: 45 },
    { key: "received_qty", title: "Rec", width: 45 },
    { key: "missing_qty", title: "Miss", width: 45 },
    { key: "damaged_qty", title: "Dmg", width: 45 },
    { key: "issue", title: "Issue", width: 140 },
  ];
  let cx = x + 8;
  cols.forEach((c) => {
    drawText(page, c.title, cx, y + h - 14, { font: fontBold, size: 10 });
    cx += c.width;
  });
  // borders
  page.drawRectangle({ x, y, width: w, height: h, borderWidth: 0.5, color: undefined, borderColor: rgb(0.7, 0.7, 0.7) });
  return cols;
}

function drawTableRow(page, cols, row, x, y, h, font, zebra) {
  if (zebra) {
    page.drawRectangle({ x, y, width: cols.reduce((a, c) => a + c.width, 0), height: h, color: rgb(0.985, 0.985, 0.985) });
  }
  let cx = x + 8;
  const map = {
    manufacturer: row.manufacturer ?? "",
    model: row.model ?? "",
    room: String(row.room ?? ""),
    expected_qty: String(row.expected_qty ?? ""),
    received_qty: String(row.received_qty ?? ""),
    missing_qty: String(row.missing_qty ?? ""),
    damaged_qty: String(row.damaged_qty ?? ""),
    issue: row.issue ?? "",
  };
  cols.forEach((c) => {
    drawText(page, map[c.key], cx, y + 6, { font, size: 10, maxWidth: c.width - 12 });
    cx += c.width;
  });
}

function drawFooter(page, font, pageNumber, pageCount) {
  const footerY = 36;
  drawText(page, `Generated by WPUSA • ${new Date().toLocaleString()}`, 50, footerY, {
    font,
    size: 9,
    color: rgb(0.45, 0.45, 0.45),
  });
  const pn = `Page ${pageNumber} of ${pageCount}`;
  const width = font.widthOfTextAtSize(pn, 9);
  const pageWidth = page.getWidth();
  drawText(page, pn, pageWidth - 50 - width, footerY, { font, size: 9, color: rgb(0.45, 0.45, 0.45) });
}

async function buildPdf({ branding, punchlist, items }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // paginate
  const pageMargin = 50;
  const tableRowHeight = 22;
  const headerHeight = 24;
  const tableWidth = 650;
  let rowsPerPage;

  // compute rows per page dynamically
  const measureRowsPerPage = (page) => {
    const usable = page.getHeight() - pageMargin * 2 - 180; // space for header + footer
    return Math.floor((usable - headerHeight) / tableRowHeight);
  };

  // slice items into pages
  let startIdx = 0;
  let pageIndex = 0;
  const pages = [];

  while (startIdx < items.length || pageIndex === 0) {
    const page = pdfDoc.addPage([792, 612]); // landscape letter
    rowsPerPage = measureRowsPerPage(page);
    const endIdx = Math.min(startIdx + rowsPerPage, items.length);
    const pageItems = items.slice(startIdx, endIdx);
    pages.push({ page, pageItems });
    startIdx = endIdx;
    pageIndex += 1;
    if (items.length === 0 && pageIndex === 1) break;
  }

  // Pre-embed logos
  const companyLogoImg = await embedRemoteImage(pdfDoc, branding.companyLogo);
  const clientLogoImg = await embedRemoteImage(pdfDoc, branding.clientLogo);

  // Draw each page
  pages.forEach(({ page, pageItems }, idx) => {
    const pageW = page.getWidth();
    const topY = page.getHeight() - pageMargin;

    // Header: Company logo & title
    const leftX = pageMargin;
    const rightX = pageW - pageMargin;

    // Company logo
    let logoX = leftX;
    let logoY = topY - 40;
    if (companyLogoImg) {
      const dim = companyLogoImg.scale(0.25);
      page.drawImage(companyLogoImg, { x: logoX, y: logoY, width: dim.width, height: dim.height });
      logoX += dim.width + 10;
    }

    // Company name + tagline
    drawText(page, branding.companyDisplayName || FALLBACK_BRAND.companyName, logoX, topY - 10, {
      font: fontBold,
      size: 20,
    });
    drawText(page, FALLBACK_BRAND.companyTagline, logoX, topY - 28, {
      font,
      size: 10,
      color: rgb(0.35, 0.35, 0.35),
    });
    drawText(page, FALLBACK_BRAND.companyAddress, logoX, topY - 42, {
      font,
      size: 9,
      color: rgb(0.35, 0.35, 0.35),
    });

    // Client logo (top-right)
    if (clientLogoImg) {
      const dimR = clientLogoImg.scale(0.22);
      page.drawImage(clientLogoImg, {
        x: rightX - dimR.width,
        y: topY - dimR.height,
        width: dimR.width,
        height: dimR.height,
      });
    }

    // Big title
    drawText(page, "WPUSA — Punchlist", leftX, topY - 70, { font: fontBold, size: 22 });

    // Meta
    const metaY = topY - 90;
    drawText(page, `Punchlist ID: ${punchlist.pl.id}`, leftX, metaY, { font, size: 10 });
    drawText(page, `Work Order: ${branding.workOrderCode}`, leftX, metaY - 14, { font, size: 10 });
    drawText(page, `Project: ${branding.projectName}`, leftX, metaY - 28, { font, size: 10 });

    // Table
    const tableX = leftX;
    let tableY = topY - 140;
    const cols = drawTableHeader(page, tableX, tableY, tableWidth, headerHeight, fontBold);
    tableY -= headerHeight;

    if (pageItems.length === 0) {
      drawText(page, "No items.", tableX + 8, tableY - 14, { font, size: 11, color: rgb(0.45, 0.45, 0.45) });
    } else {
      pageItems.forEach((row, i) => {
        drawTableRow(page, cols, row, tableX, tableY - tableRowHeight, tableRowHeight, font, i % 2 === 1);
        tableY -= tableRowHeight;
      });
    }

    // Signature block
    const sigTop = pageMargin + 90;
    page.drawLine({ start: { x: leftX, y: sigTop }, end: { x: leftX + 220, y: sigTop }, thickness: 0.5, color: rgb(0.2, 0.2, 0.2) });
    drawText(page, "Technician Signature / Date", leftX, sigTop - 12, { font, size: 9, color: rgb(0.35, 0.35, 0.35) });

    page.drawLine({ start: { x: leftX + 280, y: sigTop }, end: { x: leftX + 500, y: sigTop }, thickness: 0.5, color: rgb(0.2, 0.2, 0.2) });
    drawText(page, "Client Signature / Date", leftX + 280, sigTop - 12, { font, size: 9, color: rgb(0.35, 0.35, 0.35) });

    // Footer (added later with correct page counts)
  });

  // Footer with page numbers
  const pageCount = pdfDoc.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    drawFooter(pdfDoc.getPage(i), await pdfDoc.embedFont(StandardFonts.HelveticaOblique), i + 1, pageCount);
  }

  return pdfDoc.save();
}

export const handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return { statusCode: 500, body: "Missing Supabase env vars" };
    }
    const { punchlist_id } = event.queryStringParameters || {};
    if (!punchlist_id) {
      return { statusCode: 400, body: "Provide ?punchlist_id=..." };
    }

    const { pl, items } = await getPunchlistWithItems(punchlist_id);
    const branding = await getWorkOrderBrand(pl.work_order_id);

    const pdfBytes = await buildPdf({ branding, punchlist: { pl }, items });
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="punchlist-${pl.id}.pdf"`,
      },
      body: Buffer.from(pdfBytes).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: `Error: ${err.message}` };
  }
};
