// netlify/functions/punchlist_pdf.js
// Generates a simple PDF punchlist for a given punchlist_id (or latest for a work_order_id)

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export default async (req) => {
  try {
    const { searchParams } = new URL(req.url);
    const method = req.method || "GET";
    const isJson = (req.headers.get("content-type") || "").includes("application/json");
    let body = {};
    if (method === "POST" && isJson) body = await req.json();

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return json({ error: "Missing Supabase env vars" }, 500);
    }

    // Inputs: punchlist_id OR work_order_id; if neither, error
    const punchlist_id = body.punchlist_id || searchParams.get("punchlist_id");
    const work_order_id = body.work_order_id || searchParams.get("work_order_id");
    if (!punchlist_id && !work_order_id) {
      return json({ error: "Provide punchlist_id or work_order_id" }, 400);
    }

    // Helper to call Supabase REST
    const sbase = async (path, opts = {}) => {
      const res = await fetch(`${SUPABASE_URL}${path}`, {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        ...opts,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`[Supabase ${res.status}] ${text}`);
      }
      return res.json();
    };

    // Resolve punchlist id (if only work_order_id provided)
    let plid = punchlist_id;
    if (!plid) {
      const pls = await sbase(`/rest/v1/punchlists?select=id,created_at&work_order_id=eq.${work_order_id}&order=created_at.desc&limit=1`);
      if (!pls.length) return json({ error: "No punchlist found for work_order_id" }, 404);
      plid = pls[0].id;
    }

    // Load header info
    const [pl] = await sbase(`/rest/v1/punchlists?select=id,work_order_id,status,created_at&id=eq.${plid}`);
    const [wo] = await sbase(`/rest/v1/work_orders?select=id,code,project_name&id=eq.${pl.work_order_id}`);

    // Load items
    const items = await sbase(
      `/rest/v1/punchlist_items?select=manufacturer,model,room,expected_qty,received_qty,missing_qty,damaged_qty,issue,notes&punchlist_id=eq.${plid}&order=manufacturer.asc`
    );

    // Build PDF
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]); // Letter portrait
    const margin = 40;
    let x = margin, y = 792 - margin;

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const text = (t, opts = {}) => {
      const { size = 12, bold = false, color = rgb(0, 0, 0) } = opts;
      const f = bold ? fontBold : font;
      page.drawText(String(t), { x, y, size, font: f, color });
      y -= size + 6;
    };

    // Header
    text("WPUSA — Punchlist", { size: 20, bold: true });
    text(`Punchlist ID: ${plid}`, { size: 10 });
    text(`Work Order: ${wo?.code || pl.work_order_id}`, { size: 10 });
    text(`Project: ${wo?.project_name || "-"}`, { size: 10 });
    y -= 6;

    // Table header
    const drawRow = (cols, widths, bold = false) => {
      x = margin;
      cols.forEach((col, i) => {
        const w = widths[i];
        page.drawText(String(col ?? ""), {
          x,
          y,
          size: 10,
          font: bold ? fontBold : font,
        });
        x += w;
      });
      y -= 16;
    };

    const widths = [90, 120, 80, 60, 60, 60, 60, 70]; // Mfr, Model, Room, Exp, Rec, Miss, Dmg, Issue
    drawRow(["Manufacturer", "Model", "Room", "Exp", "Rec", "Miss", "Dmg", "Issue"], widths, true);

    // Divider
    page.drawLine({ start: { x: margin, y: y + 6 }, end: { x: 612 - margin, y: y + 6 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });

    // Rows
    items.forEach((it) => {
      if (y < 80) { // new page if near bottom
        y = 792 - margin;
        pdfDoc.addPage(page);
      }
      drawRow(
        [
          it.manufacturer, it.model, it.room,
          it.expected_qty, it.received_qty, it.missing_qty, it.damaged_qty,
          it.issue ?? ""
        ],
        widths,
        false
      );
    });

    y -= 10;
    text("Tech Signature: _______________________________", { size: 12 });
    text("Customer Signature: ___________________________", { size: 12 });

    const pdfBytes = await pdfDoc.save();
    return new Response(pdfBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="punchlist-${plid}.pdf"`,
      },
    });
  } catch (err) {
    return json({ error: "PDF generation failed", details: String(err) }, 500);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
