const baseUrl = process.env.TESSERA_API_URL?.replace(/\/$/, "");
const key = process.env.TESSERA_API_KEY;
if (!baseUrl || !key)
  throw new Error("TESSERA_API_URL and TESSERA_API_KEY are required");
async function post(
  path,
  body = {},
  { raw = false, dataRequired = true } = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  if (raw) return res;
  const json = await res.json();
  if (json.success !== true || (dataRequired && !("data" in json)))
    throw new Error(`${path} invalid response`);
  return json.data;
}
async function uploadMarkdown(spaceId) {
  const form = new FormData();
  form.append("spaceId", spaceId);
  form.append(
    "file",
    new Blob(["# Imported API verification\n\nTemporary content."], {
      type: "text/markdown",
    }),
    "verification.md",
  );
  const res = await fetch(`${baseUrl}/pages/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`/pages/import failed (${res.status})`);
  const json = await res.json();
  return json.success === true ? json.data : json;
}
let spaceId;
try {
  const suffix = `import-export-${Date.now()}`;
  const space = await post("/spaces/create", { name: suffix, slug: suffix });
  spaceId = space.id;
  const page = await post("/pages/create", {
    spaceId,
    title: "Export verification",
    content: "# Export verification",
    format: "markdown",
  });
  const pageExport = await post(
    "/pages/export",
    {
      pageId: page.id,
      format: "markdown",
      includeChildren: false,
      includeAttachments: false,
    },
    { raw: true },
  );
  if (!(await pageExport.text()).includes("Export verification"))
    throw new Error("Page export content missing");
  const spaceExport = await post(
    "/spaces/export",
    { spaceId, format: "markdown", includeAttachments: false },
    { raw: true },
  );
  if ((await spaceExport.arrayBuffer()).byteLength === 0)
    throw new Error("Space export is empty");
  const imported = await uploadMarkdown(spaceId);
  if (!imported?.id) throw new Error("Markdown import did not create a page");
  const tasks = await post("/file-tasks", { limit: 20 });
  if (!Array.isArray(tasks?.items))
    throw new Error("File tasks are not paginated");
  console.log("Open API import/export smoke test completed successfully.");
} finally {
  if (spaceId)
    await post("/spaces/delete", { spaceId }, { dataRequired: false });
}
