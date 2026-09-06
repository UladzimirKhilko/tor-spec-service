/*
 * pdfTemplate.js
 * Заполнение ПРОИЗВОЛЬНОГО PDF-шаблона (загруженного самим инженером), без
 * какой-либо заранее подготовленной "базы" шаблонов.
 *
 * Идея: обычный PDF, экспортированный из Visio/Word/AutoCAD и т.п., не
 * содержит настоящих полей формы (AcroForm) — это просто плоская страница.
 * Поэтому программа не может сама угадать, куда именно писать каждое
 * значение (у разных инженеров вёрстка отличается). Решение — мастер
 * разметки: при первой загрузке конкретного файла инженер один раз кликает
 * мышкой по странице, куда должно попасть каждое значение. Разметка
 * (координаты клика в долях ширины/высоты страницы — не зависят от масштаба
 * показа) сохраняется в localStorage браузера, привязанная к SHA-256 хэшу
 * самого файла шаблона — при повторной загрузке того же файла разметка
 * подставляется автоматически. Разметку также можно скачать/загрузить как
 * небольшой .json-файл, чтобы передать коллеге, размечавшему тот же шаблон.
 *
 * Заполнение — pdf-lib дорисовывает текст поверх исходной страницы (шаблон
 * остаётся как есть, со всеми картинками/диаграммами/фирменным бланком),
 * итог скачивается как обычный PDF.
 */

// Единый список полей — тот же физический набор данных и та же логика
// автозаполнения/конвертации единиц, что и во встроенном vsdx-шаблоне
// (js/fieldMap.js, TEMPLATES[0].fields) — только без shapeIds, потому что
// для PDF-шаблона место назначения — не "фигура по ID", а точка на
// странице, которую инженер указывает сам в мастере разметки.
const PDF_TEMPLATE_FIELDS = [
  { key: 'customer',        label: 'Заказчик',                         group: 'manual', notes: '' },
  { key: 'site',             label: 'Место установки',                  group: 'manual', notes: '' },
  { key: 'contact_person',   label: 'Фамилия И.О. (контактное лицо)',   group: 'manual', notes: '' },
  { key: 'contact_info',     label: 'Телефон, факс, E-mail',            group: 'manual', notes: '' },
  { key: 'calc_number',      label: 'Номер расчёта',                    group: 'manual', notes: 'Введите только номер, например 19234 — месяц и год подставятся автоматически по сегодняшней дате' },
  { key: 'price_unit',       label: 'Цена без НДС за единицу, руб',     group: 'manual', notes: '' },
  { key: 'price_total',      label: 'ИТОГО цена без НДС, руб',          group: 'manual', notes: '' },
  { key: 'executor',         label: 'Расчёт выполнил (ФИО)',            group: 'manual', notes: 'Дата проставляется автоматически текущим числом (дд/мм/гггг) — вводить не нужно' },

  { key: 'model',
    label: 'Марка теплообменника',
    group: 'auto',
    compute: (v) => (v.plates_count && v.channel_layout)
      ? `ТОР-15М/13-${Math.round(parseFloat(v.plates_count))}-1х(${v.channel_layout})`
      : null,
    sourceKeys: ['model'], sourceUnit: null, convert: null,
    notes: 'Собирается автоматически — проверьте совпадение с реальной маркой' },

  { key: 'heat_load', label: 'Тепловая нагрузка, Гкал/ч', group: 'auto',
    sourceKeys: ['heat_power'], sourceUnit: 'Гкал/ч', convert: null, notes: '' },

  { key: 'temp_graph', label: 'Температурный график сетевой воды, °C', group: 'auto',
    sourceKeys: ['temp_graph'], sourceUnit: '°C', convert: null,
    notes: 'Формат вида 95/70 — вход/выход' },

  { key: 'temp_hot', label: 'Температура вход-выход, греющий контур, °C', group: 'auto',
    sourceKeys: ['temp_in_hot_out_hot'], sourceUnit: '°C', convert: null, notes: '' },

  { key: 'temp_cold', label: 'Температура вход-выход, нагреваемый контур, °C', group: 'auto',
    sourceKeys: ['temp_in_cold_out_cold'], sourceUnit: '°C', convert: null, notes: '' },

  { key: 'flow_hot', label: 'Расход, греющий контур, т/ч', group: 'auto',
    sourceKeys: ['flow_hot'], sourceUnit: 'т/ч', convert: null, notes: '' },

  { key: 'flow_cold', label: 'Расход, нагреваемый контур, т/ч', group: 'auto',
    sourceKeys: ['flow_cold'], sourceUnit: 'т/ч', convert: null, notes: '' },

  { key: 'dp_hot', label: 'Потери давления, греющий контур, кг/см2', group: 'auto',
    sourceKeys: ['dp_hot'], sourceUnit: 'кПа', convert: 'kpaToKgfCm2', notes: '' },

  { key: 'dp_cold', label: 'Потери давления, нагреваемый контур, кг/см2', group: 'auto',
    sourceKeys: ['dp_cold'], sourceUnit: 'кПа', convert: 'kpaToKgfCm2', notes: '' },

  { key: 'plates_count', label: 'Количество пластин, шт', group: 'auto',
    sourceKeys: ['plates_count'], sourceUnit: 'шт', convert: null, notes: '' },

  { key: 'passes_count', label: 'Число ходов', group: 'auto',
    sourceKeys: ['passes_count'], sourceUnit: null, convert: null, notes: '' },

  { key: 'heat_transfer_coef', label: 'Коэффициент теплопередачи, Вт/м2°C', group: 'auto',
    sourceKeys: ['heat_transfer_coef_combined', 'heat_transfer_coef_actual'], sourceUnit: 'Вт/м2°K', convert: null,
    notes: 'Формат: фактический/необходимый' },

  { key: 'surface_margin', label: 'Запас по поверхности, %', group: 'auto',
    sourceKeys: ['surface_margin_pct', 'surface_margin'], sourceUnit: '%', convert: null, notes: '' },

  { key: 'heat_surface', label: 'Поверхность теплообмена, м2', group: 'auto',
    sourceKeys: ['heat_surface'], sourceUnit: 'м2', convert: null, notes: '' },

  { key: 'dn', label: 'Условный диаметр DN, мм', group: 'auto',
    sourceKeys: ['dn'], sourceUnit: 'мм', convert: null, notes: '' },

  { key: 'mass', label: 'Масса, кг', group: 'auto',
    sourceKeys: ['mass_filled', 'mass_empty'], sourceUnit: 'кг', convert: null, notes: '' },

  { key: 'dim_l', label: 'L, мм (длина по патрубкам)', group: 'manual', notes: '' },
  { key: 'dim_a', label: 'A, мм', group: 'manual', notes: '' },
];

async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pdfTplMapStorageKey(hash) {
  return `pdfTplMap:${hash}`;
}

function loadPdfTemplateMapping(hash) {
  try {
    const raw = localStorage.getItem(pdfTplMapStorageKey(hash));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Не удалось прочитать разметку шаблона из localStorage', e);
    return null;
  }
}

function savePdfTemplateMapping(mapping) {
  try {
    localStorage.setItem(pdfTplMapStorageKey(mapping.hash), JSON.stringify(mapping));
  } catch (e) {
    console.warn('Не удалось сохранить разметку шаблона в localStorage (место кончилось?)', e);
  }
}

function exportPdfTemplateMapping(mapping) {
  const blob = new Blob([JSON.stringify(mapping, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `razmetka-${(mapping.fileName || 'shablon').replace(/[^\w.-]+/g, '_')}-${mapping.hash.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function importPdfTemplateMappingFile(file) {
  const text = await file.text();
  let mapping;
  try {
    mapping = JSON.parse(text);
  } catch (e) {
    throw new Error('Файл разметки повреждён или не в формате JSON');
  }
  if (!mapping || typeof mapping !== 'object' || !mapping.hash || !mapping.fields) {
    throw new Error('Это не похоже на файл разметки шаблона (нет hash/fields)');
  }
  return mapping;
}

/* ---------------- Рендер страницы шаблона в canvas для мастера разметки ---------------- */

async function renderPdfTemplatePage(pdfBytes, canvas, maxWidth) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, maxWidth / baseViewport.width);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { pageWidth: baseViewport.width, pageHeight: baseViewport.height, renderScale: scale };
}

/* ---------------- Заполнение шаблона значениями и сохранение готового PDF ---------------- */

let cachedDejaVuFontBytes = null;
async function getDejaVuFontBytes() {
  if (!cachedDejaVuFontBytes) {
    const resp = await fetch('vendor/DejaVuSans.ttf');
    if (!resp.ok) throw new Error('Не удалось загрузить шрифт vendor/DejaVuSans.ttf');
    cachedDejaVuFontBytes = await resp.arrayBuffer();
  }
  return cachedDejaVuFontBytes;
}

/**
 * @param {ArrayBuffer} pdfBytes - исходный PDF-шаблон (пустой, либо с уже
 *   напечатанным "образцовым" содержимым — тогда для конкретных полей в
 *   mapping.fields[key].redact можно задать прямоугольник, который перед
 *   вписыванием текста будет закрашен белым (например поверх заводского
 *   плейсхолдера вроде "ТОР-15М/13-1х(LL+НН)" или "--/---2020").
 * @param {string[]} fieldKeys - какие ключи вообще пытаемся разместить (нужно
 *   отдельно от mapping.fields, чтобы корректно посчитать notPlaced — поля,
 *   для которых есть значение, но нет позиции в разметке)
 * @param {object} mapping - { hash, pageWidth, pageHeight, fields: { key: { xFrac, yFrac, redact? } } }
 * @param {object} values - { key: string } - что писать (уже отформатированные строки)
 * @returns {Promise<{bytes: Uint8Array, notPlaced: string[]}>} готовый PDF
 */
// Разбивает одну строку на несколько так, чтобы каждая укладывалась в
// maxWidth (в pt) при данном шрифте/размере — обычный word-wrap по словам.
function wrapTextToWidth(font, text, fontSize, maxWidth) {
  if (!text) return [''];
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  words.forEach((w) => {
    const test = cur ? `${cur} ${w}` : w;
    if (!cur || font.widthOfTextAtSize(test, fontSize) <= maxWidth) {
      cur = test;
    } else {
      lines.push(cur);
      cur = w;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

async function fillPdfTemplate(pdfBytes, fieldKeys, mapping, values) {
  const { PDFDocument, rgb } = PDFLib;
  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = await getDejaVuFontBytes();
  const font = await pdfDoc.embedFont(fontBytes, { subset: true });
  const page = pdfDoc.getPage(0);
  const { width: pageW, height: pageH } = page.getSize();

  const FONT_SIZE = 9;
  const notPlaced = [];
  fieldKeys.forEach((key) => {
    const pos = mapping.fields[key];
    const val = values[key];
    if (val === undefined || val === null || val === '') return;
    if (!pos) { notPlaced.push(key); return; }

    if (pos.redact) {
      // Закрываем белым прямоугольником заводской плейсхолдер (например
      // готовое "образцовое" значение из шаблона), прежде чем писать своё.
      const r = pos.redact;
      const rx = r.xFrac * pageW;
      const rw = r.wFrac * pageW;
      const rh = r.hFrac * pageH;
      const ryTop = r.yFrac * pageH;
      const ry = pageH - ryTop - rh;
      page.drawRectangle({ x: rx, y: ry, width: rw, height: rh, color: rgb(1, 1, 1) });
    }

    const text = String(val);

    if (pos.multiline) {
      // Многострочное поле (например блок с сертификатами): пользователь
      // сам решает, где переносить строку (Enter в textarea) — эти разрывы
      // сохраняем как есть, а внутри каждой такой строки ещё и переносим по
      // словам, если она не влезает в ширину ячейки maxWidthFrac.
      const fontSize = pos.fontSize || FONT_SIZE;
      const maxWidth = pos.maxWidthFrac * pageW;
      const lineHeight = pos.lineHeightFrac ? pos.lineHeightFrac * pageH : fontSize * 1.2;
      const x = pos.xFrac * pageW;
      let curYTop = pos.yFrac * pageH;
      text.split('\n').forEach((rawLine) => {
        wrapTextToWidth(font, rawLine.trim(), fontSize, maxWidth).forEach((ln) => {
          if (ln) {
            const y = pageH - curYTop - fontSize * 0.8;
            page.drawText(ln, { x, y, size: fontSize, font, color: rgb(0, 0, 0.55) });
          }
          curYTop += lineHeight;
        });
      });
      return;
    }

    // xFrac/yFrac — доли ширины/высоты страницы, отсчитанные от левого
    // верхнего угла (так удобнее было кликать на превью) — переводим в
    // систему координат PDF (ось Y снизу вверх).
    // Часть полей (например номер расчёта) задают свой fontSize меньше
    // общего FONT_SIZE — там мало места (например между напечатанным "№" и
    // краем листа).
    const fontSize = pos.fontSize || FONT_SIZE;
    let x;
    if (pos.align === 'center' && pos.centerXFrac !== undefined) {
      // Центрируем по горизонтали относительно centerXFrac (например —
      // середина узкой ячейки вроде "L, мм"/"A, мм") — ширина текста в
      // конкретном шрифте/размере известна только после embedFont, поэтому
      // подобрать x можно только здесь, а не заранее в разметке.
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      x = pos.centerXFrac * pageW - textWidth / 2;
    } else if (pos.align === 'right' && pos.rightXFrac !== undefined) {
      // Выравниваем по ПРАВОМУ краю относительно rightXFrac (например номер
      // расчёта — текст переменной длины: короткий номер и с длинным номером
      // "12345/09-2026" правый край всегда остаётся на одном месте с ровным
      // отступом от края листа, а не наезжает на границу при длинных числах).
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      x = pos.rightXFrac * pageW - textWidth;
    } else {
      x = pos.xFrac * pageW;
    }
    const yTop = pos.yFrac * pageH;
    const y = pageH - yTop - fontSize * 0.8;
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(0, 0, 0.55) });
  });

  const bytes = await pdfDoc.save();
  return { bytes, notPlaced };
}

function downloadPdfBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
