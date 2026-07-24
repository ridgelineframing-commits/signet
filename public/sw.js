// Signet service worker.
// Two jobs: (1) make the app installable (a fetch handler is required for the install
// prompt on several platforms, which in turn unlocks the File Handling API "open with"),
// and (2) catch shared PDFs from the Web Share Target and hand them to the editor.
//
// Deliberately NOT a caching/offline worker — Signet is a live app behind a password and
// we never want to serve stale HTML/JS. The fetch handler is a pure network passthrough
// except for the share-target POST.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShare(event.request));
    return;
  }
  // Everything else: straight to the network (no offline cache — always fresh).
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const file = form.get("file") || form.get("files");
    if (file && typeof file !== "string") {
      const cache = await caches.open("signet-share");
      await cache.put(
        "shared-pdf",
        new Response(file, { headers: { "content-type": file.type || "application/octet-stream", "x-filename": file.name || "shared" } })
      );
    }
  } catch (e) {
    // fall through — the editor just opens empty if we couldn't stash the file
  }
  return Response.redirect("/?share=1", 303);
}
