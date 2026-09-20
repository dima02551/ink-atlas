// Тянет посты из публичного веб-превью Telegram-канала (t.me/s/<channel>),
// не требует логина/API-ключей — работает с обычными HTTP-запросами.
// Разбирает каждый пост эвристиками (цена / город / ссылка на мастера) и
// раскладывает результат на три файла в data/:
//   raw-posts.json     — все сырые посты как есть (для отладки)
//   masters.json        — посты, которые разобрались уверенно (цена+город+ссылка)
//   needs-review.json   — посты, которые не разобрались, с причиной
//
// Запуск: npm run scrape

import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";

const CHANNEL = "tattoo_prices";
const TARGET_COUNT = 450; // столько уникальных постов хотим набрать за один прогон
const MAX_PAGES = 140; // предохранитель от бесконечного цикла
const DELAY_MS = 450; // пауза между запросами, чтобы не долбить t.me слишком часто
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const OUT_DIR = path.resolve(import.meta.dirname, "..", "data");

// Известные города + их алиасы (сокращения, варианты написания), которые реально
// встречаются в постах. Ключ справа — тот же код города, что использует index.html
// для позиционирования точки на карте (см. CITIES в scripts/build-site-data.js).
const CITY_ALIASES = {
  "москва": "msk", "мск": "msk",
  "санкт-петербург": "spb", "спб": "spb", "петербург": "spb", "питер": "spb", "спб.": "spb",
  "казань": "kzn",
  "екатеринбург": "ekb", "екб": "ekb",
  "новосибирск": "nsk",
  "краснодар": "krd",
  "сочи": "sochi",
  "нижний новгород": "nnov",
  "ростов-на-дону": "rnd", "ростов": "rnd",
  "уфа": "ufa",
  "самара": "smr",
  "тюмень": "tmn",
  "красноярск": "krsk",
  "пермь": "perm",
  "воронеж": "vrn",
  "волгоград": "vlg",
  "челябинск": "chel",
  "омск": "omsk",
  "владивосток": "vld",
  "калининград": "knd",
  "иркутск": "irk",
  "саратов": "srt",
  "тольятти": "tlt",
  "ижевск": "izh",
  "барнаул": "brn",
  "ярославль": "yar",
  "хабаровск": "khb",
  "минск": "minsk",
  "астрахань": "ast",
  "псков": "pskov",
  "иваново": "ivn",
  "новокузнецк": "nvkz",
};

// Стили тату, которые умеет показывать index.html (см. STYLE_ICON там же).
// Ищем эти слова прямо в тексте поста — если совпало, вешаем тег.
const STYLE_KEYWORDS = {
  "блэкворк": "Блэкворк",
  "блек ворк": "Блэкворк",
  "олдскул": "Олдскул",
  "old school": "Олдскул",
  "треш-полька": "Треш-полька",
  "трэш-полька": "Треш-полька",
  "треш полька": "Треш-полька",
  "геометри": "Геометрия", // ловит "геометрия"/"геометрический"
  "минимализм": "Минимализм",
  "леттеринг": "Леттеринг",
  "реализм": "Реализм",
  "микрореализм": "Реализм",
  "акварел": "Акварель", // ловит "акварель"/"акварельный"
};

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(beforeId) {
  const url = `https://t.me/s/${CHANNEL}` + (beforeId ? `?before=${beforeId}` : "");
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ru,en;q=0.8" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  return res.text();
}

function parsePosts(html) {
  const $ = cheerio.load(html);
  const posts = [];
  $(".tgme_widget_message[data-post]").each((_, el) => {
    const $el = $(el);
    const dataPost = $el.attr("data-post"); // "tattoo_prices/20906"
    const id = Number(dataPost.split("/")[1]);
    if (!Number.isFinite(id)) return;

    const dateIso = $el.find(".tgme_widget_message_date time").first().attr("datetime") || null;

    // На постах с несколькими фото Telegram иногда вкладывает .tgme_widget_message_text
    // друг в друга (обёртка + сам текст) — берём последний (самый глубокий) блок.
    const textBlocks = $el.find(".tgme_widget_message_text");
    const $text = textBlocks.length ? $(textBlocks[textBlocks.length - 1]) : null;

    let text = "";
    const links = [];
    if ($text && $text.length) {
      const clone = $text.clone();
      clone.find("br").replaceWith("\n");
      text = clone.text().replace(/ /g, " ").trim();
      $text.find("a[href]").each((_, a) => {
        const href = $(a).attr("href");
        const label = $(a).text().trim();
        if (href) links.push({ href: decodeEntities(href), label });
      });
    }

    const hasPhoto = $el.find(".tgme_widget_message_photo_wrap, .tgme_widget_message_grouped").length > 0;

    posts.push({
      id,
      permalink: `https://t.me/${dataPost}`,
      dateIso,
      text,
      links,
      hasPhoto,
    });
  });
  return posts;
}

function parsePrice(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  const head = lines.slice(0, 3).join(" \n "); // цена почти всегда в первых 1-3 строках поста

  if (/бесплатно/i.test(firstLine)) return { price: 0, isFree: true };

  // "от 4.000₽", "от 4000 ₽", "от 4 000р."
  const fromMatch = head.match(/от\s*([\d][\d\s.,]{2,})\s*(?:₽|р\.?|руб)/i);
  if (fromMatch) {
    const n = Number(fromMatch[1].replace(/[.\s,]/g, ""));
    if (Number.isFinite(n) && n > 100) return { price: n, isFree: false };
  }

  // "Сеанс 30 000₽ | 4 сеанса" — самый частый шаблонный формат канала
  const seansMatch = head.match(/сеанс[а-я]*\s*[:\-]?\s*([\d][\d\s.]{2,})\s*(?:₽|р\.?|руб)/i);
  if (seansMatch) {
    const n = Number(seansMatch[1].replace(/[.\s]/g, ""));
    if (Number.isFinite(n) && n >= 500 && n <= 2000000) return { price: n, isFree: false };
  }

  // "30 000₽", "80 000₽", "12000" в начале первой строки
  const plainMatch = firstLine.match(/^([\d][\d\s.]{2,})\s*(?:₽|р\.?|руб)?/i);
  if (plainMatch) {
    const n = Number(plainMatch[1].replace(/[.\s]/g, ""));
    if (Number.isFinite(n) && n >= 500 && n <= 2000000) return { price: n, isFree: false };
  }

  // Последний шанс: любое "NNN NNN₽"/"NNNр." в первых трёх строках
  const anyMatch = head.match(/([\d][\d\s.]{3,})\s*(?:₽|руб)/i);
  if (anyMatch) {
    const n = Number(anyMatch[1].replace(/[.\s]/g, ""));
    if (Number.isFinite(n) && n >= 500 && n <= 2000000) return { price: n, isFree: false };
  }

  return null;
}

function parseCity(text) {
  // Строка после эмодзи 📍, до конца строки.
  const line = text.split("\n").find((l) => l.includes("📍"));
  if (!line) return null;
  const afterPin = line.split("📍")[1] || "";
  const cleaned = afterPin.trim().toLowerCase();
  for (const alias of Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length)) {
    if (cleaned.startsWith(alias) || cleaned.includes(` ${alias}`) || cleaned === alias) {
      return { cityKey: CITY_ALIASES[alias], note: afterPin.trim().replace(new RegExp(alias, "i"), "").replace(/^[,\s]+/, "").trim() };
    }
  }
  return { cityKey: null, note: afterPin.trim() };
}

function parseLink(links) {
  // Берём первую ссылку в посте, которая ведёт не на сам канал (это почти всегда
  // мастер: t.me/<handle>, instagram.com/<handle>, VK и т.п.)
  const external = links.find((l) => !/t\.me\/tattoo_prices\/?$/i.test(l.href));
  return external || links[0] || null;
}

function parseStyles(text) {
  const lower = text.toLowerCase();
  const found = new Set();
  for (const [kw, label] of Object.entries(STYLE_KEYWORDS)) {
    if (lower.includes(kw)) found.add(label);
  }
  return [...found];
}

function guessName(post, link) {
  if (link && link.label) {
    const cleaned = link.label.replace(/^@/, "").trim();
    if (cleaned && cleaned.length <= 40) return cleaned;
  }
  if (link && link.href) {
    const seg = link.href.split("/").filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
  }
  const firstLine = post.text.split("\n")[0].trim();
  if (firstLine && firstLine.length <= 40 && !/^\d/.test(firstLine)) return firstLine.replace(/[!.]+$/, "");
  return null;
}

// Детерминированная "случайная" точка в пределах города (0-1), чтобы у одного и
// того же мастера при повторном скрейпе координаты на карте не прыгали.
function seededPoint(id) {
  const s = Math.sin(id * 999) * 10000;
  const frac = s - Math.floor(s);
  const s2 = Math.sin(id * 137) * 10000;
  const frac2 = s2 - Math.floor(s2);
  return { x: 20 + frac * 60, y: 20 + frac2 * 60 };
}

async function main() {
  const seen = new Map();
  let before = null;
  let pages = 0;

  while (seen.size < TARGET_COUNT && pages < MAX_PAGES) {
    const html = await fetchPage(before);
    const posts = parsePosts(html);
    pages++;
    if (posts.length === 0) {
      console.log(`Страница ${pages}: пусто, останавливаюсь.`);
      break;
    }
    let added = 0;
    for (const p of posts) {
      if (!seen.has(p.id)) {
        seen.set(p.id, p);
        added++;
      }
    }
    const minId = Math.min(...posts.map((p) => p.id));
    console.log(`Страница ${pages}: +${added} новых, всего ${seen.size}, до id=${minId}`);
    if (added === 0) break; // дошли до начала истории / зациклились
    before = minId;
    await sleep(DELAY_MS);
  }

  const rawPosts = [...seen.values()].sort((a, b) => b.id - a.id);

  const masters = [];
  const needsReview = [];

  for (const post of rawPosts) {
    const priceInfo = parsePrice(post.text);
    const cityInfo = parseCity(post.text);
    const link = parseLink(post.links);
    const reasons = [];
    if (!priceInfo) reasons.push("цена не распознана");
    else if (priceInfo.isFree) reasons.push("бесплатный/модельный пост, не цена мастера");
    if (!cityInfo) reasons.push("нет метки города (📍)");
    else if (!cityInfo.cityKey) reasons.push(`город "${cityInfo.note}" не в известном списке`);
    if (!link) reasons.push("не найдена ссылка на мастера");

    if (reasons.length > 0) {
      needsReview.push({ ...post, reasons, guessedPrice: priceInfo, guessedCity: cityInfo, guessedLink: link });
      continue;
    }

    const point = seededPoint(post.id);
    masters.push({
      id: post.id,
      name: guessName(post, link) || `Мастер #${post.id}`,
      city: cityInfo.cityKey,
      district: cityInfo.note || "",
      styles: parseStyles(post.text),
      price: priceInfo.price,
      link: link.href,
      sourcePost: post.permalink,
      date: post.dateIso,
      hasPhoto: post.hasPhoto,
      x: point.x,
      y: point.y,
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "raw-posts.json"), JSON.stringify(rawPosts, null, 2), "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "masters.json"), JSON.stringify(masters, null, 2), "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "needs-review.json"), JSON.stringify(needsReview, null, 2), "utf-8");

  console.log("\n--- Готово ---");
  console.log(`Всего постов собрано: ${rawPosts.length}`);
  console.log(`Разобрано уверенно (masters.json): ${masters.length}`);
  console.log(`На ручную проверку (needs-review.json): ${needsReview.length}`);
}

main().catch((err) => {
  console.error("Скрейп упал с ошибкой:", err);
  process.exit(1);
});
