export default async () => {
  const ok = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  return new Response(JSON.stringify({
    ok,
    has_url: !!process.env.SUPABASE_URL,
    has_service_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY
  }), { headers: { "Content-Type": "application/json" } });
};
