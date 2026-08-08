const baseUrl = process.env.TESSERA_API_URL?.replace(/\/api\/?$/, "");
const key = process.env.TESSERA_API_KEY;
if (!baseUrl || !key)
  throw new Error("TESSERA_API_URL and TESSERA_API_KEY are required");
async function post(path) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = await res.json();
  if (!res.ok || json.success !== true || !("data" in json))
    throw new Error(`${path} failed (${res.status})`);
  return json.data;
}
const health = await fetch(`${baseUrl}/api/health`);
if (!health.ok) throw new Error("Health endpoint failed");
const live = await fetch(`${baseUrl}/api/health/live`);
const livePayload = await live.json();
if (!live.ok || livePayload.data !== "ok")
  throw new Error("Live endpoint failed");
await post("/version");
await post("/workspace/entitlements");
console.log("Open API system smoke test completed successfully.");
