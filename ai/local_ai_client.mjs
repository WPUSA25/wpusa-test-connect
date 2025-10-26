export const BASE_URL = process.env.LOCAL_AI_URL || "http://localhost:1234";
export async function chat(prompt) {
  const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {"Content-Type":"application/json","Authorization":"Bearer lm-studio"},
    body: JSON.stringify({ model: "local-model", messages:[{role:"user",content:prompt}], temperature:0.2 })
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || "";
}
