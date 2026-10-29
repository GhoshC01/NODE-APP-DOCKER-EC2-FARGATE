const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const DATA_DIR = "/app/data";
const VERSION = process.env.APP_VERSION || "local";

fs.mkdirSync(DATA_DIR, { recursive: true });

http.createServer((req, res) => {
  if (req.url === "/health") {
    return res.end("OK");
  }
  if (req.url === "/create") {
    const name = `file-${Date.now()}.txt`;
    fs.writeFileSync(path.join(DATA_DIR, name), `Created at ${new Date().toISOString()}\n`);
    return res.end(`Created: ${name}\n`);
  }
  if (req.url === "/files") {
    return res.end(fs.readdirSync(DATA_DIR).join("\n") + "\n");
  }
  res.end(`Hello from Node app! Version: ${VERSION}\n`);
}).listen(PORT, () => console.log(`Running on port ${PORT}, version ${VERSION}`));