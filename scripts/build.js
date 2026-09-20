// Вставляет data/masters.json внутрь index.html, в <script id="masters-data">.
// Запускать после npm run scrape. index.html после этого снова самодостаточный
// файл — его можно открыть двойным кликом, отдельный фетч JSON не нужен.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const MASTERS_PATH = path.join(ROOT, "data", "masters.json");

const masters = JSON.parse(fs.readFileSync(MASTERS_PATH, "utf-8"));
const html = fs.readFileSync(INDEX_PATH, "utf-8");

const re = /(<script type="application\/json" id="masters-data">)([\s\S]*?)(<\/script>)/;
if (!re.test(html)) {
  console.error('Не нашёл <script type="application/json" id="masters-data"> в index.html — сначала добавь его вручную.');
  process.exit(1);
}

const updated = html.replace(re, (_, open, _old, close) => open + JSON.stringify(masters) + close);
fs.writeFileSync(INDEX_PATH, updated, "utf-8");

console.log(`Вставил ${masters.length} мастеров в index.html.`);
