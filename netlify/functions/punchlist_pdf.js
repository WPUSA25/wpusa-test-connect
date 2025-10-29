// netlify/functions/punchlist_pdf.js
// Branded Punchlist PDF (pdf-lib)
// - Pulls punchlist + items from Supabase
// - Draws a crisp header with company + client branding
// - Gracefully handles missing logos

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fetch = require("node-fetch");

// --- ENV (configure in Netlify -> Project -> Configuration -> Environment variables) ---
const SUPABASE_URL = process.env.SUPABASE_URL;                     // e.g. https://vczyzoopbpymjezavdhf.supabase.co
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role (server-side only)

// Optional branding env (safe to start blank; we also allow overrides by query string)
const COMPANY_NAME = process.env.COMPANY_NAME || "WPUSA";
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || "123 Main St, Anywhere, USA";
const COMPANY_PHONE = process.env.COMPANY_PHONE || "(555) 555-5555";
const COMPANY_LOGO_URL = process.env.COMPANY_LOGO_URL || ""; // https URL to a PNG/JPG
const CLIENT_LOGO_URL = process.env.CLIENT_LOGO_URL || "";   // optional default client logo

// Helpers
function q(obj, key, fallback = "") {
  const v = obj[key];
  return v === null || v === undefined ? fallback : v;
}
function supaHeaders(json = true) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

// Fetch PNG/JPG bytes (optional)
async function fetchImageBytes(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`img ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Load punchlist + rows
async function loadPunchlist(punchlist_id) {
  // punchlist
  const plRes = await fetch(
    `${SUPABASE_URL}/rest/v1/punchlists?id=eq.${encodeURIComponent(punchlist_id)}&select=id,work_order_id,status,created_at`,
    { headers: supaHeaders(false) }
  );
  const [pl] = await plRes.json();

  if (!pl) throw new Error("Punchlist not found");

  // work order
  let wo = null;
  if (pl.work_order_id) {
    const woRes = await fetch(
      `${SUPABASE_URL}/rest/v1/work_orders?id=eq.${encodeURIComponent(pl.work_order_id)}&select=id,code,project`,
      { headers: supaHeaders(false) }
    );
    [wo] = await woRes.json();
  }

  // items
  const itRes = await fetch(
    `${SUPABASE_URL}/rest/v1/punchlist_items?select=manufacturer,model,room,expected_qty,received_qty,missing_qty,damaged_qty,issue&punchlist_id=eq.${encodeURIComponent(
      punchlist_id
    )}`,
    { headers: supaHeaders(false) }
  );
  const items = await itRes.json();

  return { pl, wo, items };
}

// Draw a simple table
function drawTable(page, font, x, y, rows, widths, header) {
  const lineH = 16;
  const colX = [];
  let cur = x;
  for (const w of widths) {
    colX.push(cur);
    cur += w;
  }

  const headerY = y;
  page.drawText(header[0], { x: colX[0], y: headerY, font, size: 10, color: rgb(0.75, 0.82, 0.9) });
  page.drawText(header[1], { x: colX[1], y: headerY, font, size: 10, color: rgb(0.75, 0.82, 0.9) });
  page.drawText(header[2], { x: colX[2], y: headerY, font, size: 10, color: rgb(0.75, 0.82, 0.9) });
  page.drawText(header[3], { x: colX[3], y: headerY, font, size: 10, color: rgb(0.75, 0.82, 0.9) });
  page.drawText(header[4], { x: colX[4], y: headerY, font, size: 10, color: rgb(0.75, 0.82, 0.9) });
  page.drawText(header[5], { x: colX[5], y: headerY, font, size: 10, color: rgb(0.75, 0.82, 0.9) });

  let yy = headerY - lineH;
  for (const r of rows) {
    page.drawText(q(r, "manufacturer"), { x: colX[0], y: yy, font, size: 11 });
    page.drawText(q(r, "model"), { x: colX[1], y: yy, font, size: 11 });
    page.drawText(q(r, "room", ""), { x: colX[2], y: yy, font, size: 11 });
    page.drawText(String(q(r, "expected_qty", 0)), { x: colX[3], y: yy, font, size: 11 });
    page.drawText(String(q(r, "received_qty", 0)), { x: colX[4], y: yy, font, size: 11 });
    // Show either missing or damaged in the last slot if present; prefer missing
    const issueQty =
      (r.missing_qty ?? 0) > 0 ? r.missing_qty : (r.damaged_qty ?? 0) > 0 ? r.damaged_qty : 0;
    page.drawText(String(issueQty), { x: colX[5], y: yy, font, size: 11 });
    yy -= lineH;
  }
}

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }),
      };
    }

    const { punchlist_id, company_name, company_address, company_phone, company_logo, client_logo } =
      event.queryStringParameters || {};

    if (!punchlist_id) {
      return { statusCode: 400, body: JSON.stringify({ error: "punchlist_id is required" }) };
    }

    // Load data
    const { pl, wo, items } = await loadPunchlist(punchlist_id);

    // Create PDF
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]); // Letter
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    // Colors
    const textColor = rgb(0.12, 0.16, 0.22);
    const light = rgb(0.70, 0.76, 0.85);
    const brand = rgb(0.08, 0.38, 0.73);

    // Header box
    page.drawRectangle({ x: 36, y: 720, width: 540, height: 56, color: rgb(0.95, 0.97, 1) });

    // Logos (optional)
    const leftLogoBytes = await fetchImageBytes(company_logo || COMPANY_LOGO_URL);
    const rightLogoBytes = await fetchImageBytes(client_logo || CLIENT_LOGO_URL);

    if (leftLogoBytes) {
      const img =
        leftLogoBytes[0] === 0x89 ? await pdf.embedPng(leftLogoBytes) : await pdf.embedJpg(leftLogoBytes);
      const w = 120;
      const h = (img.height / img.width) * w;
      page.drawImage(img, { x: 44, y: 724, width: w, height: h });
    }

    if (rightLogoBytes) {
      const img =
        rightLogoBytes[0] === 0x89 ? await pdf.embedPng(rightLogoBytes) : await pdf.embedJpg(rightLogoBytes);
      const w = 120;
      const h = (img.height / img.width) * w;
      page.drawImage(img, { x: 456, y: 724, width: w, height: h });
    }

    // Company block
    const CNAME = company_name || COMPANY_NAME;
    const CADDR = company_address || COMPANY_ADDRESS;
    const CPHONE = company_phone || COMPANY_PHONE;

    page.drawText(CNAME, { x: 36, y: 690, font: bold, size: 16, color: brand });
    page.drawText(CADDR, { x: 36, y: 672, font, size: 10, color: textColor });
    page.drawText(CPHONE, { x: 36, y: 658, font, size: 10, color: textColor });

    // Title
    page.drawText("Punchlist", { x: 540 - 100, y: 690, font: bold, size: 16, color: textColor });

    // Meta row
    const metaY = 632;
    const meta = [
      `Punchlist ID: ${pl.id}`,
      `Work Order: ${q(wo || {}, "code", "—")}`,
      `Project: ${q(wo || {}, "project", "—")}`,
    ];
    page.drawText(meta[0], { x: 36, y: metaY, font, size: 11, color: textColor });
    page.drawText(meta[1], { x: 36, y: metaY - 14, font, size: 11, color: textColor });
    page.drawText(meta[2], { x: 36, y: metaY - 28, font, size: 11, color: textColor });

    // Divider
    page.drawLine({
      start: { x: 36, y: 585 },
      end: { x: 576, y: 585 },
      thickness: 1,
      color: light,
    });

    // Table
    const tableX = 36;
    const tableY = 560;
    const widths = [150, 140, 60, 50, 50, 50];
    const header = ["Manufacturer", "Model", "Room", "Exp", "Rec", "Miss/Dmg"];

    drawTable(page, font, tableX, tableY, items, widths, header);

    // Footer
    page.drawText("Generated by WPUSA", {
      x: 36,
      y: 36,
      font,
      size: 9,
      color: light,
    });

    const bytes = await pdf.save();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="punchlist-${pl.id}.pdf"`,
      },
      body: Buffer.from(bytes).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message) }) };
  }
};
