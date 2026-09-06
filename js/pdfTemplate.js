/*
 * pdfTemplate.js
 * Заполнение бланка (pdf-lib поверх исходного PDF-файла) — общий механизм
 * и для "готовых" бланков (js/builtinPdfMapping.js, координаты сверены
 * заранее), и для "своего бланка" (сотрудник сам загружает PDF того же вида
 * — другая картинка/марка, но та же табличная разметка).
 *
 * Раньше здесь ещё был мастер разметки (клик мышкой по каждому из ~26 полей)
 * — для случая, когда программа не может угадать, куда писать значения на
 * произвольном PDF. От него отказались: у линейки бланков БСИ всегда одна и
 * та же табличная разметка (см. комментарий в builtinPdfMapping.js), поэтому
 * координаты, снятые один раз с образца, годятся для любого бланка этой
 * линейки без разметки мышкой — см. buildLetterheadMapping и режим "Свой
 * бланк" в app.js (там же — необязательная поправка смещения по X/Y и
 * тестовый PDF "Проверить совмещение", на случай если у нового файла всё же
 * есть небольшой сдвиг вёрстки).
 */

async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Поправка смещения (offsetXFrac/offsetYFrac), подобранная для конкретного
// загруженного файла "своего бланка" — привязана к SHA-256 хэшу файла, чтобы
// при повторной загрузке того же файла ничего не нужно было подбирать заново.
// Само по себе это НЕ разметка полей (в отличие от старого мастера) — только
// два числа общей поправки, тот случай, когда координаты образца чуть-чуть
// не совпадают с новым файлом.
function letterheadOffsetStorageKey(hash) {
  return `letterheadOffset:${hash}`;
}

function loadLetterheadOffset(hash) {
  try {
    const raw = localStorage.getItem(letterheadOffsetStorageKey(hash));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Не удалось прочитать сохранённый сдвиг из localStorage', e);
    return null;
  }
}

function saveLetterheadOffset(hash, fileName, offsetXFrac, offsetYFrac) {
  try {
    localStorage.setItem(letterheadOffsetStorageKey(hash), JSON.stringify({
      hash, fileName, offsetXFrac, offsetYFrac, savedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.warn('Не удалось сохранить сдвиг в localStorage (место кончилось?)', e);
  }
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
