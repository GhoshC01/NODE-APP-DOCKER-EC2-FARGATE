const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 3000;
const DATA_DIR = "/app/data";
const VERSION = process.env.APP_VERSION || "local";
const STARTED_AT = new Date().toISOString();
const CONTAINER_ID = os.hostname();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error(`Could not create ${DATA_DIR}: ${err.message}`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function readEntry(name) {
  const full = path.join(DATA_DIR, name);
  let stat;
  let raw = "";
  try {
    stat = fs.statSync(full);
    if (!stat.isFile()) return null;
    raw = fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }

  let createdAt = stat.mtime.toISOString();
  let createdByContainer = null;
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (typeof data.createdAt === "string") createdAt = data.createdAt;
      if (typeof data.createdByContainer === "string") createdByContainer = data.createdByContainer;
    }
  } catch {
    const match = raw.match(/Created at ([^\r\n]+)/);
    if (match) createdAt = match[1].trim();
  }

  return {
    name,
    size: stat.size,
    createdAt,
    createdByContainer,
  };
}
// 
function listFiles() {
  return fs
    .readdirSync(DATA_DIR)
    .map(readEntry)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.name < b.name ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

function infoPayload() {
  return {
    containerId: os.hostname(),
    startedAt: STARTED_AT,
    version: VERSION,
    dataDir: DATA_DIR,
    fileCount: listFiles().length,
  };
}

let fileSeq = 0;

function createJsonFile() {
  fileSeq += 1;
  const createdAt = new Date().toISOString();
  const record = {
    createdAt,
    createdByContainer: os.hostname(),
    version: VERSION,
  };
  const name = `file-${Date.now()}-${fileSeq}.json`;
  const full = path.join(DATA_DIR, name);
  fs.writeFileSync(full, JSON.stringify(record, null, 2) + "\n");
  return {
    name,
    size: fs.statSync(full).size,
    createdAt,
    createdByContainer: record.createdByContainer,
  };
}

function deleteAllFiles() {
  let deleted = 0;
  for (const name of fs.readdirSync(DATA_DIR)) {
    const full = path.join(DATA_DIR, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    fs.unlinkSync(full);
    deleted += 1;
  }
  return deleted;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function renderRows(files) {
  if (files.length === 0) {
    return '<tr><td colspan="3" class="empty">No files yet. Click “Create file”.</td></tr>';
  }
  return files
    .map((file) => {
      const current = file.createdByContainer === CONTAINER_ID;
      const kind = current ? "current" : "older";
      const badge = current ? "this container" : "older container";
      const who = file.createdByContainer || "unknown";
      return (
        `<tr class="${kind}">` +
        `<td>${escapeHtml(file.name)}</td>` +
        `<td>${escapeHtml(formatTime(file.createdAt))}</td>` +
        `<td><span class="who">${escapeHtml(who)}</span> ` +
        `<span class="badge ${kind}">${badge}</span></td>` +
        `</tr>`
      );
    })
    .join("");
}

const CLIENT_SCRIPT = `
(function () {
  var containerId = "";

  function formatTime(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso);
    var text = date.toISOString();
    var dot = text.indexOf(".");
    if (dot !== -1) text = text.slice(0, dot);
    return text.replace("T", " ") + " UTC";
  }

  function setStatus(message) {
    document.getElementById("status").textContent = message || "";
  }

  function setBusy(busy) {
    ["create", "refresh", "delete", "confirm-yes", "confirm-no"].forEach(function (id) {
      document.getElementById(id).disabled = busy;
    });
  }

  function renderFiles(files) {
    var tbody = document.getElementById("file-rows");
    tbody.textContent = "";
    if (!files.length) {
      var empty = document.createElement("tr");
      var cell = document.createElement("td");
      cell.colSpan = 3;
      cell.className = "empty";
      cell.textContent = "No files yet. Click “Create file”.";
      empty.appendChild(cell);
      tbody.appendChild(empty);
      return;
    }
    files.forEach(function (file) {
      var current = file.createdByContainer === containerId;
      var kind = current ? "current" : "older";
      var row = document.createElement("tr");
      row.className = kind;

      var nameCell = document.createElement("td");
      nameCell.textContent = file.name;

      var whenCell = document.createElement("td");
      whenCell.textContent = formatTime(file.createdAt);

      var whoCell = document.createElement("td");
      var who = document.createElement("span");
      who.className = "who";
      who.textContent = file.createdByContainer || "unknown";
      var badge = document.createElement("span");
      badge.className = "badge " + kind;
      badge.textContent = current ? "this container" : "older container";
      whoCell.appendChild(who);
      whoCell.appendChild(document.createTextNode(" "));
      whoCell.appendChild(badge);

      row.appendChild(nameCell);
      row.appendChild(whenCell);
      row.appendChild(whoCell);
      tbody.appendChild(row);
    });
  }

  function refresh() {
    setBusy(true);
    setStatus("Loading…");
    return Promise.all([
      fetch("/api/info").then(function (response) {
        if (!response.ok) throw new Error("Could not load container info");
        return response.json();
      }),
      fetch("/api/files").then(function (response) {
        if (!response.ok) throw new Error("Could not load files");
        return response.json();
      })
    ]).then(function (results) {
      var info = results[0];
      var files = results[1];
      containerId = info.containerId;
      document.getElementById("container-id").textContent = info.containerId;
      document.getElementById("started-at").textContent = formatTime(info.startedAt);
      document.getElementById("version").textContent = info.version;
      document.getElementById("data-dir").textContent = info.dataDir;
      document.getElementById("file-count").textContent = String(info.fileCount);
      renderFiles(files);
      setStatus("");
    }).catch(function (error) {
      setStatus(error.message || "Something went wrong");
    }).then(function () {
      setBusy(false);
    });
  }

  document.getElementById("create").addEventListener("click", function () {
    setBusy(true);
    setStatus("Creating a file…");
    fetch("/api/files", { method: "POST" })
      .then(function (response) {
        if (!response.ok) throw new Error("Could not create file");
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message || "Could not create file");
        setBusy(false);
      });
  });

  document.getElementById("refresh").addEventListener("click", function () {
    refresh();
  });

  document.getElementById("delete").addEventListener("click", function () {
    document.getElementById("confirm").hidden = false;
  });

  document.getElementById("confirm-no").addEventListener("click", function () {
    document.getElementById("confirm").hidden = true;
  });

  document.getElementById("confirm-yes").addEventListener("click", function () {
    document.getElementById("confirm").hidden = true;
    setBusy(true);
    setStatus("Deleting files…");
    fetch("/api/files", { method: "DELETE" })
      .then(function (response) {
        if (!response.ok) throw new Error("Could not delete files");
        return refresh();
      })
      .catch(function (error) {
        setStatus(error.message || "Could not delete files");
        setBusy(false);
      });
  });

  refresh();
})();
`;

function renderPage() {
  let files = [];
  let count = 0;
  try {
    files = listFiles();
    count = files.length;
  } catch {
    files = [];
    count = 0;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docker volumes</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f3f5f7;
    --card: #ffffff;
    --text: #1c2128;
    --muted: #5c6770;
    --border: #d8dee4;
    --accent: #0b6e4f;
    --accent-text: #ffffff;
    --danger: #9f2c22;
    --current-bg: #e5f6ec;
    --current-badge: #b7e4c7;
    --current-fg: #0d5c3d;
    --older-bg: #fff6e8;
    --older-badge: #ffe0b2;
    --older-fg: #8a4b08;
    --temp: #b42318;
    --perm: #0b6e4f;
    --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121417;
      --card: #1c2128;
      --text: #e8edf2;
      --muted: #9aa6b2;
      --border: #303842;
      --accent: #3dd68c;
      --accent-text: #06281a;
      --danger: #ffb4ab;
      --current-bg: #143328;
      --current-badge: #1d6b48;
      --current-fg: #b7f0d2;
      --older-bg: #332818;
      --older-badge: #6d5018;
      --older-fg: #ffe0a8;
      --temp: #ffb4ab;
      --perm: #7dcea0;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 16px 48px; }
  h1 { font-size: 1.7rem; font-weight: 650; margin: 0 0 8px; letter-spacing: -0.02em; }
  h2 { font-size: 1.05rem; margin: 0 0 6px; }
  .lede { margin: 0 0 20px; color: var(--muted); max-width: 42rem; }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.3fr);
    gap: 16px;
    align-items: start;
  }
  @media (max-width: 800px) {
    .grid { grid-template-columns: 1fr; }
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    box-shadow: var(--shadow);
    min-width: 0;
  }
  .card.temp { border-top: 4px solid var(--temp); }
  .card.perm { border-top: 4px solid var(--perm); }
  .hint { margin: 0 0 14px; color: var(--muted); font-size: 0.92rem; }
  dl { margin: 0; }
  dt {
    font-size: 0.72rem;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  dd {
    margin: 2px 0 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92rem;
    word-break: break-word;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 12px; }
  button {
    font: inherit;
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    cursor: pointer;
  }
  button:disabled { opacity: 0.55; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); color: var(--accent-text); border-color: transparent; }
  button.danger { color: var(--danger); }
  .confirm {
    margin: 0 0 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--older-bg);
  }
  .confirm p { margin: 0 0 8px; }
  .confirm[hidden] { display: none; }
  .legend { margin: 0 0 8px; color: var(--muted); font-size: 0.85rem; }
  .swatch {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 3px;
    vertical-align: -1px;
    margin: 0 4px 0 10px;
  }
  .swatch.current { background: var(--current-badge); }
  .swatch.older { background: var(--older-badge); margin-left: 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  tr.current td { background: var(--current-bg); }
  tr.older td { background: var(--older-bg); }
  .who { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; word-break: break-all; }
  .badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 650;
    white-space: nowrap;
    vertical-align: middle;
  }
  .badge.current { background: var(--current-badge); color: var(--current-fg); }
  .badge.older { background: var(--older-badge); color: var(--older-fg); }
  .empty { color: var(--muted); }
  .howto {
    margin-top: 16px;
    padding: 16px;
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: var(--card);
  }
  .howto ol { margin: 8px 0 0; padding-left: 1.25rem; }
  .howto li + li { margin-top: 6px; }
  #status { min-height: 1.4em; margin: 12px 0 0; color: var(--muted); }
</style>
</head>
<body>
<main class="wrap">
  <h1>Docker volumes</h1>
  <p class="lede">A container is temporary. Files saved in a volume stay when that container is removed and a new one starts.</p>
  <div class="grid">
    <section class="card temp">
      <h2>Container (temporary)</h2>
      <p class="hint">The next deploy removes this container. The new one gets a new ID and a new start time.</p>
      <dl>
        <dt>Container ID</dt>
        <dd id="container-id">${escapeHtml(CONTAINER_ID)}</dd>
        <dt>Started at</dt>
        <dd id="started-at">${escapeHtml(formatTime(STARTED_AT))}</dd>
        <dt>App version</dt>
        <dd id="version">${escapeHtml(VERSION)}</dd>
      </dl>
    </section>
    <section class="card perm">
      <h2>Volume (permanent)</h2>
      <p class="hint">Files in this folder are the Docker volume. On EC2 the host folder /opt/app/data is mounted here, so they survive a new container.</p>
      <dl>
        <dt>Data folder</dt>
        <dd id="data-dir">${escapeHtml(DATA_DIR)}</dd>
        <dt>File count</dt>
        <dd id="file-count">${escapeHtml(String(count))}</dd>
      </dl>
      <div class="actions">
        <button type="button" id="create" class="primary">Create file</button>
        <button type="button" id="refresh">Refresh</button>
        <button type="button" id="delete" class="danger">Delete all files</button>
      </div>
      <div id="confirm" class="confirm" hidden>
        <p>Delete all files in the volume? This cannot be undone.</p>
        <div class="actions">
          <button type="button" id="confirm-yes" class="danger">Yes, delete all</button>
          <button type="button" id="confirm-no">Cancel</button>
        </div>
      </div>
      <p class="legend"><span class="swatch current"></span>this container <span class="swatch older"></span>older container</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created at</th>
              <th>Created by container</th>
            </tr>
          </thead>
          <tbody id="file-rows">
            ${renderRows(files)}
          </tbody>
        </table>
      </div>
    </section>
  </div>
  <section class="howto">
    <h2>How to test</h2>
    <ol>
      <li>Click "Create file" a few times.</li>
      <li>Deploy a new version (git push). The container is removed and a new one starts.</li>
      <li>Open this page again: the container ID is new, but the old files are still here. That is the volume working.</li>
    </ol>
  </section>
  <p id="status" role="status"></p>
</main>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0];

  if (pathname === "/health") {
    return res.end("OK");
  }

  if (pathname === "/create") {
    const name = `file-${Date.now()}.txt`;
    fs.writeFileSync(path.join(DATA_DIR, name), `Created at ${new Date().toISOString()}\n`);
    return res.end(`Created: ${name}\n`);
  }

  if (pathname === "/files") {
    return res.end(fs.readdirSync(DATA_DIR).join("\n") + "\n");
  }

  try {
    if (pathname === "/api/info" && req.method === "GET") {
      return sendJson(res, 200, infoPayload());
    }
    if (pathname === "/api/files" && req.method === "GET") {
      return sendJson(res, 200, listFiles());
    }
    if (pathname === "/api/files" && req.method === "POST") {
      return sendJson(res, 200, createJsonFile());
    }
    if (pathname === "/api/files" && req.method === "DELETE") {
      return sendJson(res, 200, { deleted: deleteAllFiles() });
    }
    if (pathname === "/" && req.method === "GET") {
      const html = renderPage();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(html);
    }
  } catch {
    return sendJson(res, 500, { error: "Could not use the data folder" });
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

server.listen(PORT, () => {
  console.log(`Running on port ${PORT}, version ${VERSION}`);
});
