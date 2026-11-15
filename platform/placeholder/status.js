// Placeholder page: show whether the API answers, which run is live, and whether it is sample data.
// Inlined by scripts/build-site.ts (its sha256 goes into the page's Content-Security-Policy).
(function () {
  var box = document.getElementById("status");
  var text = document.getElementById("status-text");
  fetch("/api/health", { headers: { accept: "application/json" }, cache: "no-store" })
    .then(function (r) {
      return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status));
    })
    .then(function (h) {
      box.className = "status ok";
      text.textContent = "API live · " + h.run_id + (h.fixture ? " · sample" : "");
    })
    .catch(function () {
      box.className = "status down";
      text.textContent = "API unreachable";
    });
})();
