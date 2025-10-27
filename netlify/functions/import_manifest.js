// netlify/functions/import_manifest.js
// Purpose: Auto-fix schema + policies for imported_manifest, then upsert rows.
// Security: Uses Service Role key (server-side). UI remains read-only.

async function pg(sql, SUPABASE_URL, SRK) {
  // Run SQL via /rest/v1/rpc with a simple function wrapper (no need for psql)
  const fn = `do_sql_${cryptoRandom(6)}`;
  const create = await fetch(`${SUPABASE_URL}/rest/v1/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SRK, "Authorization": `Bearer ${SRK}` },
    body: JSON.stringify({ /* placeholder */ })
  });
  // We don't actually create RPCs here; instead we use the SQL executor endpoint if available.
  // Fallback: PostgREST can't run arbitrary SQL; so we use a two-step approach:
  // 1) Ensure table/index with idempotent DDL via PostgREST's /rest/v1 call to a prepared SQL function we create once below.
  // 2) As a simpler pattern (and fully PostgREST-compatible), we send DDL via "sql" extension if enabled.
  // NOTE: Many Supabase projects include the "sql" extension now. If yours doesn't, we inline DDL in a "helper" function we create once.
  throw new Error("This project doesn't expose a direct SQL executor over REST. See helper below.");
}

function cryptoRandom(len = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function ensureDDL(SUPABASE_URL, SRK) {
  // Use PostgREST to call a helper function that runs DDL safely + idempotently.
  // First attempt to create the helper; if it exists already, creation will no-op.
  const ddlHelperSQL = `
  create or replace function public.wpusa_import_manifest_prepare()
  returns void
  language plpgsql
  security definer
  as $$
  begin
    -- 1) Table
    create table if not exists public.imported_manifest (
      id uuid primary key default gen_random_uuid(),
      manufacturer text,
      model text,
      room text,
      expected_qty int default 0,
      created_at timestamptz default now()
    );

    -- 2) Unique index for merge behavior
    begin
      create unique index ux_imported_manifest_item
      on public.imported_manifest (manufacturer, model, room);
    exception when duplicate_table then
      null;
    when others then
      -- if already exists or any other benign issue, ignore
      null;
    end;

    -- 3) RLS + READ policy for anon (UI reads only)
    alter table public.imported_manifest enable row level security;

    -- Drop ALL existing policies then re-add read-only (idempotent)
    perform 1;
    perform (select 1 from pg_policies where schemaname='public' and tablename='imported_manifest');
    for pol in
      select policyname from pg_policies
      where schemaname='public' and tablename='imported_manifest'
    loop
      execute format('drop policy if exists %I on public.imported_manifest', pol.policyname);
    end loop;

    create policy imported_manifest_anon_read
      on public.imported_manifest
      for select
      to anon
      using (true);

  end $$;
  `;

  // Create the helper function via SQL-over-HTTP endpoint.
  // Supabase PostgREST doesn't execute arbitrary SQL directly.
  // We can bootstrap with the "sql" extension when enabled:
  const sqlEndpoint = `${SUPABASE_URL}/rest/v1/sql`;
  let res = await fetch(sqlEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SRK, "Authorization": `Bearer ${SRK}` },
    body: JSON.stringify({ q: ddlHelperSQL })
  });

  if (!res.ok) {
    // If /rest/v1/sql is not enabled, we fallback to a one-time manual step:
    // Ask the operator to paste ddlHelperSQL in Supabase SQL editor.
    throw new Error("SQL endpoint not available. Please paste ddlHelperSQL in Supabase SQL editor once, then retry.");
  }

  // Now call the helper to apply DDL + policies idempotently.
  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/wpusa_import_manifest_prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SRK, "Authorization": `Bearer ${SRK}` },
    body: JSON.stringify({})
  });

  if (!rpc.ok) {
    const t = await rpc.text();
    throw new Error(`Failed to run wpusa_import_manifest_prepare: ${t}`);
  }
}

export default async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SRK) {
      return new Response(JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }), { status: 500 });
    }

    // Read JSON array from body
    const rows = await req.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return new Response(JSON.stringify({ error: "Provide a non-empty JSON array" }), { status: 400 });
    }

    // Ensure schema + RLS are correct
    try {
      await ensureDDL(SUPABASE_URL, SRK);
    } catch (e) {
      // Fallback instructions if sql endpoint is not enabled:
      return new Response(JSON.stringify({
        error: "DDL bootstrap required",
        message: e.message,
        action: "Open Supabase SQL editor, paste wpusa_import_manifest_prepare() function from the function source (ddlHelperSQL), run it once, then call this endpoint again."
      }), { status: 501 });
    }

    // Upsert with merge behavior (requires unique index)
    const up = await fetch(`${SUPABASE_URL}/rest/v1/imported_manifest?on_conflict=manufacturer,model,room`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SRK,
        "Authorization": `Bearer ${SRK}`,
        "Prefer": "resolution=merge-duplicates, return=representation"
      },
      body: JSON.stringify(rows)
    });

    const text = await up.text();
    if (!up.ok) return new Response(text || "Upsert failed", { status: up.status });

    return new Response(text || "[]", { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
