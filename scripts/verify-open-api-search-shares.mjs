const baseUrl = process.env.TESSERA_API_URL?.replace(/\/$/, "");
const key = process.env.TESSERA_API_KEY;
if (!baseUrl || !key)
  throw new Error("TESSERA_API_URL and TESSERA_API_KEY are required");
async function post(path, body = {}, dataRequired = true) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.success !== true || (dataRequired && !("data" in json)))
    throw new Error(`${path} failed (${res.status})`);
  return json.data;
}
const suffix = `share-test-${Date.now()}`;
let spaceId, shareId;
try {
  const space = await post("/spaces/create", { name: suffix, slug: suffix });
  spaceId = space.id;
  const page = await post("/pages/create", { spaceId, title: suffix });
  const search = await post("/search", { query: suffix, spaceId });
  if (!Array.isArray(search.items))
    throw new Error("Search response has no items");
  const suggest = await post("/search/suggest", {
    query: suffix,
    includePages: true,
  });
  if (!suggest) throw new Error("Suggestion response missing");
  const share = await post("/shares/create", {
    pageId: page.id,
    includeSubPages: false,
    searchIndexing: false,
  });
  shareId = share.id;
  await post("/shares/info", { shareId });
  await post("/shares/for-page", { pageId: page.id });
  await post("/shares/update", {
    shareId,
    pageId: page.id,
    includeSubPages: false,
    searchIndexing: false,
  });
  await post("/shares/delete", { shareId }, false);
  shareId = undefined;
  console.log("Open API search/shares smoke test completed successfully.");
} finally {
  if (shareId) await post("/shares/delete", { shareId }, false);
  if (spaceId) await post("/spaces/delete", { spaceId }, false);
}
