/*
 * modelExtract.js
 *
 * Извлекает "базовую" марку теплообменника (например "ТОР-15" или
 * "ТОР-15М/13") и код исполнения (например "1х", "2х", "2хЦ", "3хБГВ")
 * прямо из текстового слоя PDF-бланка — из строки вида:
 *   "Марка теплообменника ТОР-15М/13-1х(LL+НН) ..."
 *   "Марка теплообменника ТОР-15-1х(НН)"
 * Раскладка каналов (в скобках) и количество пластин по-прежнему берутся
 * из спецификации BelTO (beltoParser.js) — здесь не нужны и игнорируются.
 *
 * Работает и для готового бланка из списка, и для "своего бланка"
 * (загруженный PDF другой модели) — оба читаются через pdf.js
 * (page.getTextContent()), без привязки к конкретным координатам,
 * потому что строка "Марка теплообменника" ищется по тексту, а не по
 * позиции на странице.
 */

// Группирует текстовые фрагменты pdf.js в строки (по Y с допуском) и
// внутри строки — слева направо по X, добавляя пробел только если между
// соседними фрагментами есть заметный зазор (иначе слипшиеся слова вида
// "Марка теплообменника" превратились бы в один "слипшийся" кусок, а
// разорванные посреди слова числа/буквы — наоборот, обрастали бы лишними
// пробелами).
async function getPdfPageLines(pdfBytes) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();

  const items = content.items
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
    }));

  const yTol = 2;
  const lines = [];
  items.forEach((it) => {
    let line = lines.find((l) => Math.abs(l.y - it.y) < yTol);
    if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push(it);
  });
  lines.sort((a, b) => b.y - a.y);
  lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));

  return lines.map((l) => {
    let s = '';
    let prevEnd = null;
    l.items.forEach((it) => {
      if (prevEnd !== null && it.x - prevEnd > 1.5) s += ' ';
      s += it.str;
      prevEnd = it.x + it.w;
    });
    return s.trim();
  });
}

// Из строки вида "Марка теплообменника ТОР-15М/13-1х(LL+НН) ..." достаёт
// { base: "ТОР-15М/13", execution: "1х" }. Раскладка в скобках и всё
// после неё игнорируются — они берутся из спецификации.
function parseModelLine(line) {
  const m = line.match(/(ТОР[^()]*?)\(/i);
  if (!m) return null;
  const core = m[1].replace(/\s+/g, '');
  // Последний "-сегмент" перед скобкой, начинающийся с цифры и х/Х —
  // это исполнение (1х, 2х, 2хЦ, 3х, 3хБГВ и т.п.); всё что до него —
  // базовая марка (может сама содержать дефисы: "ТОР-15", "ТОР-15М/13").
  const exec = core.match(/^(.*)-(\d+[xXхХ][A-Za-zА-Яа-яЁё]*)$/);
  if (!exec) return null;
  const base = exec[1].trim();
  const execution = exec[2].trim();
  if (!base || !execution) return null;
  return { base, execution };
}

/**
 * @param {ArrayBuffer} pdfBytes - байты PDF-бланка (готовый или свой)
 * @returns {Promise<{base: string, execution: string} | null>}
 */
async function extractModelPartsFromPdf(pdfBytes) {
  try {
    const lines = await getPdfPageLines(pdfBytes);
    const markaLine = lines.find((l) => /марка\s+теплообменника/i.test(l));
    if (!markaLine) return null;
    return parseModelLine(markaLine);
  } catch (e) {
    console.warn('Не удалось извлечь марку теплообменника из PDF-бланка', e);
    return null;
  }
}
