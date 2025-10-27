// netlify/functions/generate_punchlist.js
export default async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SRK) {
      return new Response(JSON.stringify({ error: "Missing SUPABASE_URL or SERVICE ROLE KEY" }), { status: 500 });
    }

    // Body: { work_order_id?: string|null }
    const body = await req.json().catch(() => ({}));
    const work_order_id = body?.work_order_id ?? null;

    // 1) Pull the diff rows from the view
    const diffRes = await fetch(`${SUPABASE_URL}/rest/v1/v_manifest_vs_received?select=*`, {
      headers: { "apikey": SRK, "Authorization": `Bearer ${SRK}` }
    });
    if (!diffRes.ok) {
      const t = await diffRes.text();
      return new Response(JSON.stringify({ error: "Failed to read diff view", details: t }), { status: 500 });
    }
    const diff = await diffRes.json();

    // 2) Build punchlist items only where missing or damaged > 0
    const items = (diff || []).map(r => {
      const missing = Math.max((r.expected_qty ?? 0) - (r.total_received ?? 0), 0);
      const damaged = r.total_damaged ?? 0;
      return {
        manufacturer: r.manufacturer,
        model: r.model,
        room: r.room,
        expected_qty: r.expected_qty ?? 0,
        received_qty: r.total_received ?? 0,
        missing_qty: missing,
        damaged_qty: damaged
      };
    }).filter(i => i.missing_qty > 0 || i.damaged_qty > 0);

    // If nothing to report, we still create a punchlist (empty) for audit
    // 3) Create punchlist master row
    const plCreate = await fetch(`${SUPABASE_URL}/rest/v1/punchlists`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SRK,
        "Authorization": `Bearer ${SRK}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify([{ work_order_id, status: "draft" }])
    });
    if (!plCreate.ok) {
      const t = await plCreate.text();
      return new Response(JSON.stringify({ error: "Failed to create punchlist", details: t }), { status: 500 });
    }
    const [pl] = await plCreate.json();

    // 4) Insert line items (if any)
    if (items.length > 0) {
      const payload = items.map(i => ({ ...i, punchlist_id: pl.id }));
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/punchlist_items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SRK,
          "Authorization": `Bearer ${SRK}`,
          "Prefer": "return=representation"
        },
        body: JSON.stringify(payload)
      });
      if (!ins.ok) {
        const t = await ins.text();
        return new Response(JSON.stringify({ error: "Failed to insert punchlist items", details: t }), { status: 500 });
      }
      const itemsInserted = await ins.json();

      return new Response(JSON.stringify({
        punchlist_id: pl.id,
        work_order_id: work_order_id,
        items_count: itemsInserted.length,
        items: itemsInserted
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    } else {
      return new Response(JSON.stringify({
        punchlist_id: pl.id,
        work_order_id: work_order_id,
        items_count: 0,
        items: []
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
