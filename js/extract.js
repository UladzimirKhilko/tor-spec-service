if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

/*
 * extract.js
 * Извлечение текста из загруженного файла спецификации:
 *  - PDF с текстовым слоем -> pdf.js (быстро и точно)
 *  - Изображение (jpg/png) или PDF-скан -> tesseract.js (OCR, медленнее и менее точно)
 */

async function extractTextFromHtml(file) {
  const raw = await file.text();
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const rows = Array.from(doc.querySelectorAll('tr'));
  const lines = [];
  rows.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td'))
      .map((td) => (td.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim())
      .filter((t) => t && t !== '№');
    if (cells.length) lines.push(cells.join(' '));
  });
  return lines.join('\n');
}

async function extractTextFromFile(file, onProgress) {
  const isHtml = file.type === 'text/html' || /\.html?$/i.test(file.name);
  if (isHtml) {
    onProgress && onProgress('Читаю HTML-отчёт BelTO (точный разбор таблицы, без OCR)...');
    const text = await extractTextFromHtml(file);
    return { text, method: 'html-table' };
  }

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const text = await extractTextFromPdf(file, onProgress);
    if (text && text.replace(/\s/g, '').length > 30) {
      return { text, method: 'pdf-text' };
    }
    // PDF без текстового слоя (скан) — гоним через OCR первой страницы
    onProgress && onProgress('В PDF нет текстового слоя, распознаём как скан (OCR)...');
    const imageDataUrl = await renderPdfPageToImage(file);
    const trimmedImageDataUrl = await trimBlackMargins(imageDataUrl);
    const ocrText = await extractTextFromImage(trimmedImageDataUrl, onProgress);
    return { text: ocrText, method: 'ocr-from-pdf' };
  }

  // Обычное изображение — экспериментально (реальный скриншот BelTO) масштабирование
  // и повышение контраста только ухудшали распознавание Tesseract (модель уже
  // натренирована на "обычных" фото/скринах) — поэтому передаём файл как есть.
  // Единственное преобразование, которое реально помогает: обрезка чёрных полей
  // по краям (частый случай для скриншотов с телефона) — см. trimBlackMargins.
  const dataUrl = await fileToDataUrl(file);
  const trimmedDataUrl = await trimBlackMargins(dataUrl);
  const ocrText = await extractTextFromImage(trimmedDataUrl, onProgress);
  return { text: ocrText, method: 'ocr-image' };
}

/*
 * Обрезает сплошные чёрные поля по краям изображения (typичный артефакт
 * скриншотов с телефона — например когда страница сфотографирована/
 * сэкранена с чёрными полосами сверху/снизу или по бокам). Эти поля сами
 * по себе не мешают человеку читать текст, но сильно портят автоматическую
 * сегментацию страницы в Tesseract — на реальном тесте с таким скриншотом
 * обрезка вернула распознавание сразу нескольких строк, которые пропадали
 * целиком (например "Потери Напора").
 *
 * Если чёрных полей не обнаружено — возвращает исходное изображение без
 * изменений (безопасно для обычных, уже плотно скадрированных фото).
 */
async function trimBlackMargins(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const W = img.width;
        const H = img.height;
        if (!W || !H) { resolve(dataUrl); return; }

        // Анализируем не полное изображение, а уменьшенную копию — быстрее
        // и достаточно точно для поиска границ сплошных чёрных полей.
        const THUMB_W = 200;
        const scale = THUMB_W / W;
        const thumbH = Math.max(1, Math.round(H * scale));
        const tcanvas = document.createElement('canvas');
        tcanvas.width = THUMB_W;
        tcanvas.height = thumbH;
        const tctx = tcanvas.getContext('2d');
        tctx.drawImage(img, 0, 0, THUMB_W, thumbH);
        const { data } = tctx.getImageData(0, 0, THUMB_W, thumbH);

        const colBright = new Float64Array(THUMB_W);
        const rowBright = new Float64Array(thumbH);
        for (let y = 0; y < thumbH; y++) {
          let rowSum = 0;
          for (let x = 0; x < THUMB_W; x++) {
            const idx = (y * THUMB_W + x) * 4;
            const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            colBright[x] += b;
            rowSum += b;
          }
          rowBright[y] = rowSum / THUMB_W;
        }
        for (let x = 0; x < THUMB_W; x++) colBright[x] /= thumbH;

        const THRESH = 60; // порог "почти чёрный фон"
        const firstAbove = (arr) => {
          for (let i = 0; i < arr.length; i++) if (arr[i] > THRESH) return i;
          return 0;
        };
        const lastAbove = (arr) => {
          for (let i = arr.length - 1; i >= 0; i--) if (arr[i] > THRESH) return i;
          return arr.length - 1;
        };

        const x0 = firstAbove(colBright);
        const x1 = lastAbove(colBright);
        const y0 = firstAbove(rowBright);
        const y1 = lastAbove(rowBright);

        // Поля не найдены (края и так светлые) — ничего не обрезаем
        const marginFound = x0 > 2 || x1 < THUMB_W - 3 || y0 > 2 || y1 < thumbH - 3;
        if (!marginFound) { resolve(dataUrl); return; }

        const pad = 5; // небольшой запас, чтобы не обрезать край текста впритык
        const fx0 = Math.max(0, Math.floor(x0 / scale) - pad);
        const fx1 = Math.min(W, Math.ceil((x1 + 1) / scale) + pad);
        const fy0 = Math.max(0, Math.floor(y0 / scale) - pad);
        const fy1 = Math.min(H, Math.ceil((y1 + 1) / scale) + pad);

        const cw = fx1 - fx0;
        const ch = fy1 - fy0;
        if (cw < 50 || ch < 50) { resolve(dataUrl); return; } // подстраховка от вырожденного кропа

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, fx0, fy0, cw, ch, 0, 0, cw, ch);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        console.warn('trimBlackMargins: не удалось обрезать поля, использую исходное изображение', e);
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function extractTextFromPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress && onProgress(`Читаю PDF, страница ${i}/${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Группируем по строкам через координату Y, чтобы сохранить построчную структуру таблицы
    const items = content.items.map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: Math.round(it.transform[5]),
    }));
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    let lastY = null;
    let line = [];
    const lines = [];
    for (const it of items) {
      if (lastY === null || Math.abs(it.y - lastY) > 2) {
        if (line.length) lines.push(line.map((l) => l.str).join(' '));
        line = [it];
        lastY = it.y;
      } else {
        line.push(it);
      }
    }
    if (line.length) lines.push(line.map((l) => l.str).join(' '));
    fullText += lines.join('\n') + '\n';
  }
  return fullText;
}

async function renderPdfPageToImage(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 3 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/png');
}

async function extractTextFromImage(dataUrl, onProgress) {
  // worker.min.js — локальный (vendor/), а wasm-ядро и языковые данные (rus/eng)
  // Tesseract.js по умолчанию подтягивает с CDN (jsdelivr) — для этого шага
  // браузеру нужен интернет, см. README.md.
  const worker = await Tesseract.createWorker('rus+eng', 1, {
    workerPath: 'vendor/worker.min.js',
    logger: (m) => {
      if (onProgress && m.status && m.progress !== undefined) {
        onProgress(`OCR: ${m.status} ${(m.progress * 100).toFixed(0)}%`);
      }
    },
  });
  try {
    // На отчёте BelTO (плотная таблица с большим количеством строк) единый
    // прогон Tesseract по всей странице систематически "терял" целиком
    // отдельные строки (например "Температура на Входе" и "Потери Напора")
    // — даже на идеально чистом, не сфотографированном скриншоте. Причина
    // оказалась не в качестве картинки, а в сегментации: соседняя с
    // границей ячейки цифра сливается с горизонтальной линией таблицы.
    // Поэтому сначала пробуем более надёжный путь — нарезать изображение
    // по обнаруженным горизонтальным линиям таблицы и распознавать каждую
    // строку отдельно (см. ocrByTableRows). Если чётких линий не нашлось
    // (например смазанное фото под углом) — используем прежний способ:
    // распознавание всего изображения одним проходом.
    onProgress && onProgress('Ищу структуру таблицы...');
    await worker.setParameters({
      tessedit_pageseg_mode: '6', // "единый однородный блок текста" — для одной строки/полосы
      preserve_interword_spaces: '1',
    });
    const rowText = await ocrByTableRows(dataUrl, worker, onProgress);
    if (rowText && rowText.replace(/\s/g, '').length > 50) {
      return rowText;
    }

    onProgress && onProgress('Чёткая сетка таблицы не найдена, распознаю целиком...');
    await worker.setParameters({
      // 4 = "Assume a single column of text of variable sizes" — на
      // тестовом отчёте BelTO дал заметно более чистый результат, чем
      // автоматическая сегментация (3), которая на такой плотной таблице
      // расползалась в мусор
      tessedit_pageseg_mode: '4',
      preserve_interword_spaces: '1',
    });
    const { data } = await worker.recognize(dataUrl);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

/*
 * Нарезает изображение отчёта на отдельные строки таблицы по обнаруженным
 * сплошным горизонтальным линиям (границам ячеек) и распознаёт каждую
 * строку отдельным проходом Tesseract, сильно увеличив её масштаб.
 *
 * Почему это нужно: на плотной таблице BelTO с ~50 строками единый прогон
 * OCR по всей странице нередко полностью терял отдельные строки (текст не
 * искажался, а исчезал целиком) — вероятно, из-за того, что автоматическая
 * сегментация страницы путает соседние строки/цифры с горизонтальными
 * линиями таблицы. Нарезка по строкам с небольшим отступом от самой линии
 * (чтобы линия не попадала в кадр и не "прилипала" к цифрам) и увеличение
 * масштаба перед распознаванием на практике даёт кардинально более чистый
 * результат для каждой отдельной строки.
 *
 * Возвращает null, если чётких горизонтальных линий недостаточно (например
 * смазанное или перекошенное фото без ровной сетки) — тогда вызывающий код
 * должен вернуться к распознаванию всего изображения одним проходом.
 */
async function ocrByTableRows(dataUrl, worker, onProgress) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const W = img.width;
        const H = img.height;
        if (!W || !H) { resolve(null); return; }

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, W, H);

        // Доля тёмных пикселей в каждой строке изображения
        const rowDark = new Float64Array(H);
        for (let y = 0; y < H; y++) {
          let dark = 0;
          const rowOffset = y * W * 4;
          for (let x = 0; x < W; x++) {
            const idx = rowOffset + x * 4;
            const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            if (b < 100) dark++;
          }
          rowDark[y] = dark / W;
        }

        // Строки-кандидаты на "сплошная горизонтальная линия таблицы"
        const LINE_THRESH = 0.5;
        const lineRows = [];
        for (let y = 0; y < H; y++) if (rowDark[y] > LINE_THRESH) lineRows.push(y);

        // Слишком мало линий — не похоже на чистую таблицу с ровной сеткой
        // (например перекошенное или смазанное фото) — сигнализируем об
        // этом вызывающему коду, чтобы он использовал распознавание целиком
        if (lineRows.length < 8) { resolve(null); return; }

        // Группируем соседние строки-пиксели в одну линию (толщиной 1-2px)
        const groups = [[lineRows[0]]];
        for (let i = 1; i < lineRows.length; i++) {
          const y = lineRows[i];
          const lastGroup = groups[groups.length - 1];
          if (y - lastGroup[lastGroup.length - 1] <= 2) {
            lastGroup.push(y);
          } else {
            groups.push([y]);
          }
        }
        const bounds = groups.map((g) => ({ start: g[0], end: g[g.length - 1] }));
        if (bounds.length < 8) { resolve(null); return; }

        const PAD = 2; // отступ внутрь от линии, чтобы сама линия не попала в кадр строки
        const SCALE = 4; // увеличение перед распознаванием — заметно повышает точность
        // Внешняя рамка таблицы (левая и правая границы) на тесте регулярно
        // распознавалась Tesseract'ом как лишняя цифра "1" на конце строки
        // (например "6.91  1" вместо "6.91"), что портило извлечение чисел.
        // Обрезаем немного по краям, чтобы сама рамка не попадала в кадр.
        const XPAD = Math.max(4, Math.round(W * 0.007));
        const cropX0 = XPAD;
        const cropW = Math.max(1, W - 2 * XPAD);
        const lines = [];
        for (let i = 0; i < bounds.length - 1; i++) {
          const y0 = bounds[i].end + PAD;
          const y1 = bounds[i + 1].start - PAD;
          const rh = y1 - y0;
          if (rh < 10) continue; // слишком тонкая полоса — не строка с текстом

          const rowCanvas = document.createElement('canvas');
          rowCanvas.width = cropW * SCALE;
          rowCanvas.height = rh * SCALE;
          const rctx = rowCanvas.getContext('2d');
          rctx.imageSmoothingEnabled = true;
          rctx.drawImage(canvas, cropX0, y0, cropW, rh, 0, 0, cropW * SCALE, rh * SCALE);

          onProgress && onProgress(`OCR построчно: строка ${i + 1}/${bounds.length - 1}...`);
          // eslint-disable-next-line no-await-in-loop
          const { data: res } = await worker.recognize(rowCanvas.toDataURL('image/png'));
          if (res.text && res.text.trim()) lines.push(res.text.trim());
        }
        resolve(lines.join('\n'));
      } catch (e) {
        console.warn('ocrByTableRows: не удалось распознать построчно, использую исходный способ', e);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
