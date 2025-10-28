export default async () => {
  return new Response(JSON.stringify({ ok: true, msg: "hello from Netlify functions" }), {
    headers: { "Content-Type": "application/json" }
  });
};
