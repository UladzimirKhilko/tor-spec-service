/*
 * app.js — склейка UI: загрузка PDF-бланка + разбор спецификации,
 * форма полей, генерация Word-документа, запись в журнал.
 *
 * Приложение универсально: сотрудник ВСЕГДА сам загружает PDF фирменного
 * бланка нужной модели (шаг 1) — координаты полей и раскладка одни и те же
 * для всей линейки бланков БСИ этого вида (см. builtinPdfMapping.js), а
 * марка/исполнение теплообменника распознаются прямо из текста этого PDF
 * (modelExtract.js), без единого "зашитого" шаблона по умолчанию. Под
 * другой тип/линейку бланков в будущем потребуется отдельная настройка
 * координат — это вне рамок текущей версии.
 */

let currentTemplate = null;
let currentFieldValues = {}; // key -> string (то, что реально попадёт в документ)
let currentDebugMatches = [];

let customTplBytes = null;   // ArrayBuffer исходного PDF-бланка как есть
let customTplHash = null;
let customTplFileName = null;
let customTplOffsetXFrac = 0;
let customTplOffsetYFrac = 0;

const PT_PER_MM = 2.8346456693;
const mmToXFrac = (mm) => (Number(mm) || 0) * PT_PER_MM / LETTERHEAD_PAGE.width;
const mmToYFrac = (mm) => (Number(mm) || 0) * PT_PER_MM / LETTERHEAD_PAGE.height;
const xFracToMm = (frac) => (frac * LETTERHEAD_PAGE.width) / PT_PER_MM;
const yFracToMm = (frac) => (frac * LETTERHEAD_PAGE.height) / PT_PER_MM;

const el = (id) => document.getElementById(id);

// Блок "Примечание" (сертификаты и т.п.) заранее заполняется текстом из
// образца — чтобы пользователь мог его сразу проверить и, если нужно,
// поправить, а не начинать с пустого поля.
function applyDefaultFieldValues(fields) {
  currentFieldValues = {};
  if (fields.some((f) => f.key === 'certificates_note')) {
    currentFieldValues['certificates_note'] = DEFAULT_CERTIFICATES_TEXT;
  }
}

/* ---------------- Загрузка своего бланка (самообслуживание, без разметки) ---------------- */
//
// Раньше здесь был мастер разметки — инженер кликал мышкой по каждому из
// ~26 полей на КАЖДОМ новом файле. От этого отказались: у всей линейки
// фирменных бланков БСИ одна и та же табличная разметка, меняется только
// картинка теплообменника и марка/размеры в тексте — поэтому координаты,
// один раз снятые с образца (js/builtinPdfMapping.js, LETTERHEAD_FIELDS),
// применяются к любому новому бланку этого вида сразу, без единого клика.
//
// Подстраховка на случай, если у конкретного файла вёрстка всё же чуть-чуть
// отличается (другой экспорт из Word/CorelDraw, другие поля страницы и
// т.п.): кнопка "Проверить совмещение" формирует тестовый PDF с заметными
// значениями во всех полях, а два числа "сдвиг по X/Y" (в мм) позволяют
// один раз поправить общее смещение — оно запоминается в этом браузере по
// хэшу файла, как и раньше с разметкой.

function initCustomTemplateUpload() {
  el('customTplInput').addEventListener('change', () => {
    const file = el('customTplInput').files[0];
    if (file) handleCustomTplUpload(file);
  });
  el('offsetXInput').addEventListener('input', readOffsetInputs);
  el('offsetYInput').addEventListener('input', readOffsetInputs);
  el('btnCheckAlignment').addEventListener('click', handleUpdateDiagramPreview);
}

function readOffsetInputs() {
  customTplOffsetXFrac = mmToXFrac(el('offsetXInput').value);
  customTplOffsetYFrac = mmToYFrac(el('offsetYInput').value);
  if (customTplHash) {
    saveLetterheadOffset(customTplHash, customTplFileName, customTplOffsetXFrac, customTplOffsetYFrac);
  }
}

async function handleCustomTplUpload(file) {
  setStatus('customTplStatus', `Читаю файл ${file.name}...`);
  try {
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    customTplBytes = buf;
    customTplHash = hash;
    customTplFileName = file.name;

    currentTemplate = { id: 'custom-letterhead', title: file.name, fields: TEMPLATES[0].fields };
    applyDefaultFieldValues(currentTemplate.fields);
    renderForm();
    el('formSection').style.display = '';
    el('actionsSection').style.display = '';
    el('customTplActions').style.display = '';

    const existing = loadLetterheadOffset(hash);
    customTplOffsetXFrac = existing ? existing.offsetXFrac : 0;
    customTplOffsetYFrac = existing ? existing.offsetYFrac : 0;
    el('offsetXInput').value = xFracToMm(customTplOffsetXFrac).toFixed(1);
    el('offsetYInput').value = yFracToMm(customTplOffsetYFrac).toFixed(1);

    setStatus(
      'customTplStatus',
      existing
        ? `Бланк «${file.name}» уже открывали в этом браузере (сдвиг ${(existing.offsetXFrac || existing.offsetYFrac) ? 'сохранён' : 'не потребовался'}) — можно заполнять поля и генерировать Word.`
        : `Бланк «${file.name}» загружен — можно заполнять поля и генерировать Word. Ниже показано превью вырезанной картинки теплообменника — если она съехала, поправьте сдвиг.`,
      'ok'
    );
    await handleUpdateDiagramPreview();
  } catch (err) {
    console.error(err);
    setStatus('customTplStatus', 'Не удалось прочитать PDF: ' + err.message, 'err');
  }
}

// Показывает вырезанную из загруженного PDF картинку теплообменника прямо в
// форме (вместо старого способа — скачивать отдельный "тестовый PDF" и
// сверять руками) — это и есть самопроверка перед генерацией настоящего
// документа: если картинка на превью съехала (обрезаны патрубки/подписи),
// сотрудник сам поправит "сдвиг по X/Y" и нажмёт "Обновить превью" ещё раз.
async function handleUpdateDiagramPreview() {
  if (!customTplBytes) {
    setStatus('diagramPreviewStatus', 'Сначала загрузите бланк.', 'err');
    return;
  }
  readOffsetInputs();
  setStatus('diagramPreviewStatus', 'Вырезаю картинку из PDF...');
  try {
    const crop = await cropDiagramFromPdf(customTplBytes, customTplOffsetXFrac, customTplOffsetYFrac);
    const key = `custom:${customTplHash}:${customTplOffsetXFrac}:${customTplOffsetYFrac}`;
    cachedDiagramCrop = { key, crop };
    const blob = new Blob([crop.bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = el('diagramPreviewImg');
    if (img.dataset.prevUrl) URL.revokeObjectURL(img.dataset.prevUrl);
    img.src = url;
    img.dataset.prevUrl = url;
    img.style.display = '';
    setStatus('diagramPreviewStatus', 'Готово — сверьте с образцом. Если патрубки/подписи обрезаны, поправьте сдвиг и нажмите ещё раз.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus('diagramPreviewStatus', 'Ошибка вырезки картинки: ' + err.message, 'err');
  }
}

function setStatus(elId, text, kind) {
  const node = el(elId);
  node.textContent = text || '';
  node.className = 'status-line' + (kind ? ' ' + kind : '');
}

/* ---------------- Загрузка и разбор файла ---------------- */

function initDropzone() {
  const dz = el('dropzone');
  const input = el('fileInput');
  dz.addEventListener('click', () => input.click());
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); })
  );
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handleFile(input.files[0]);
  });
}

// Марка/исполнение теплообменника (например "ТОР-15М/13" + "1х") — берутся
// из текстового слоя PDF-бланка (см. modelExtract.js), а не хардкодятся,
// чтобы то же самое приложение правильно работало и со "своим бланком"
// другой модели. Кэшируем по источнику бланка, чтобы не парсить PDF заново
// при каждой загрузке спецификации, если бланк не менялся.
let cachedModelParts = null; // { key, parts }

async function getModelPartsForCurrentTemplate() {
  if (!customTplBytes) return null;
  try {
    const key = `custom:${customTplHash}`;
    if (cachedModelParts && cachedModelParts.key === key) return cachedModelParts.parts;
    const parts = await extractModelPartsFromPdf(customTplBytes);
    cachedModelParts = { key, parts };
    return parts;
  } catch (e) {
    console.warn('Не удалось определить марку/исполнение из бланка', e);
    return null;
  }
}

async function handleFile(file) {
  if (!customTplBytes) {
    setStatus('parseStatus', 'Сначала загрузите PDF бланка (шаг 1) — без него не из чего распознать марку/исполнение и картинку теплообменника.', 'err');
    return;
  }
  setStatus('parseStatus', `Обрабатываю файл: ${file.name}...`);
  el('debugDetails').style.display = 'none';
  try {
    const { text, method } = await extractTextFromFile(file, (msg) => setStatus('parseStatus', msg));
    const { values, debugMatches } = parseBeltoText(text);
    currentDebugMatches = debugMatches;

    // Марка (база) и исполнение — из PDF-бланка, а не из спецификации и не
    // из зашитого значения по умолчанию. Если строку не удалось распознать
    // (нестандартное форматирование бланка) — поля остаются пустыми, и
    // сотрудника явно предупреждаем ниже, чтобы он заполнил их вручную.
    const modelParts = await getModelPartsForCurrentTemplate();
    if (modelParts) {
      values.model_base = modelParts.base;
      values.model_execution = modelParts.execution;
      currentFieldValues['title_model'] = modelParts.base;
    } else {
      currentFieldValues['title_model'] = '';
    }

    applyParsedValues(values);
    renderForm();

    const methodLabel = method === 'html-table'
      ? 'разбор HTML-таблицы, точно, без OCR'
      : method === 'pdf-text'
        ? 'текстовый слой PDF'
        : 'OCR-распознавание';
    const checkHint = method === 'html-table' ? '' : ' — особенно после OCR';
    let statusMsg = `Готово (${methodLabel}). Проверьте поля ниже перед генерацией${checkHint}.`;
    if (!modelParts) {
      statusMsg += ' ⚠ Не удалось распознать марку и исполнение теплообменника в PDF-бланке — заполните поле «Марка теплообменника» и проверьте заголовок документа вручную.';
    }
    setStatus('parseStatus', statusMsg, modelParts ? 'ok' : 'err');
    el('debugDetails').style.display = '';
    el('debugBox').textContent = debugMatches.length
      ? debugMatches.map((m) => `[${m.keys.join(', ')}] <- "${m.line}"`).join('\n')
      : 'Не удалось распознать ни одной известной строки. Проверьте текст вручную или введите значения в форму сами.\n\n--- Сырой текст ---\n' + text.slice(0, 4000);

    el('formSection').style.display = '';
    el('actionsSection').style.display = '';
  } catch (err) {
    console.error(err);
    setStatus('parseStatus', 'Ошибка распознавания: ' + err.message, 'err');
  }
}

function applyParsedValues(sourceValues) {
  if (!currentTemplate) return;
  currentTemplate.fields.forEach((f) => {
    if (f.group !== 'auto') return;
    let raw = null;
    // Некоторые поля (например марка теплообменника) собираются из
    // нескольких source-ключей сразу, а не берутся напрямую — для этого
    // у поля может быть задана функция compute(sourceValues).
    if (typeof f.compute === 'function') {
      try {
        raw = f.compute(sourceValues);
      } catch (e) {
        console.warn('Ошибка compute() для поля', f.key, e);
        raw = null;
      }
    }
    if (raw === null || raw === undefined || raw === '') {
      for (const sk of f.sourceKeys) {
        if (sourceValues[sk] !== undefined && sourceValues[sk] !== null && sourceValues[sk] !== '') {
          raw = sourceValues[sk];
          break;
        }
      }
    }
    if (raw === null || raw === undefined || raw === '') return;
    let value;
    if (f.convert) {
      const converted = convertValue(raw, f.convert);
      value = converted === null ? String(raw) : formatNumber(converted, 3);
    } else if (typeof raw === 'number') {
      value = formatNumber(raw, 3);
    } else {
      value = String(raw);
    }
    currentFieldValues[f.key] = value;
  });
}

/* ---------------- Форма ---------------- */

function renderForm() {
  const autoWrap = el('autoFields');
  const manualWrap = el('manualFields');
  autoWrap.innerHTML = '';
  manualWrap.innerHTML = '';
  if (!currentTemplate) return;

  currentTemplate.fields.forEach((f) => {
    const wrap = document.createElement('div');
    wrap.className = 'field ' + f.group + (f.multiline ? ' field-wide' : '');

    const label = document.createElement('label');
    label.textContent = f.label;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = f.group === 'auto' ? 'авто · проверить' : 'вручную';
    label.appendChild(badge);
    wrap.appendChild(label);

    const input = document.createElement(f.multiline ? 'textarea' : 'input');
    if (!f.multiline) input.type = 'text';
    else input.rows = 10;
    input.value = currentFieldValues[f.key] || '';
    input.addEventListener('input', () => { currentFieldValues[f.key] = input.value; });
    wrap.appendChild(input);

    if (f.notes) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = f.notes;
      wrap.appendChild(hint);
    }

    (f.group === 'auto' ? autoWrap : manualWrap).appendChild(wrap);
  });
}

/* ---------------- Генерация Word-документа ---------------- */
//
// Общие значения: ФИО/дата в подписи (две
// разные точки на бланке) и номер расчёта с автоматически дописанным "№ " и
// "/MM-ГГГГ" (закрашиваем и перерисовываем весь "№ ..." целиком — см.
// комментарий у calc_number в builtinPdfMapping.js). Если номер не введён —
// ничего не рисуем и не трогаем исходный "№ --/---2020" с бланка.
// Все теги, которые ждёт Word-шаблон (templates/BSI-letterhead-template.docx) —
// см. полный список в js/docxTemplate.js. Явно перечисляем их здесь и берём
// каждое значение с фолбэком на '', чтобы в документ никогда не попадало
// "undefined" (ни от докстемплейтера, ни от case, когда поле есть в объекте,
// но со значением undefined) — сотрудник мог просто не тронуть необязательное
// поле, это нормально, тогда в ячейке должно остаться пусто.
const LETTERHEAD_VALUE_KEYS = [
  'site', 'customer', 'contact_person', 'contact_info',
  'heat_load', 'temp_graph', 'temp_hot', 'temp_cold', 'flow_hot', 'flow_cold',
  'dp_hot', 'dp_cold', 'plates_count', 'passes_count', 'heat_transfer_coef',
  'surface_margin', 'heat_surface', 'model', 'price_unit', 'price_total',
  'dim_a', 'dim_l', 'mass', 'certificates_note',
];

function buildLetterheadValues() {
  const formattedCalcNumber = formatCalcNumber(currentFieldValues['calc_number']);
  // DN (условный диаметр) в бланке напечатан у всех 4 патрубков сразу
  // (Т1/Т2/В1/Т3) — одно и то же значение дублируется в 4 "синтетических"
  // поля dn_1..dn_4 (см. LETTERHEAD_FIELDS в builtinPdfMapping.js), как и
  // shapeIds:[7,42,43,45] делают то же самое для .vsdx-варианта.
  const dnValue = currentFieldValues['dn'] || '';
  const values = {};
  LETTERHEAD_VALUE_KEYS.forEach((key) => { values[key] = currentFieldValues[key] || ''; });
  return {
    ...values,
    executor_name: (currentFieldValues['executor'] || '').trim(),
    // Дата всегда сегодняшняя на момент формирования документа — не
    // зависит от того, заполнено ли ФИО.
    executor_date: formatTodayDateDMY(),
    calc_number: formattedCalcNumber ? `№ ${formattedCalcNumber}` : '',
    dn_1: dnValue, dn_2: dnValue, dn_3: dnValue, dn_4: dnValue,
    title_model: currentFieldValues['title_model'] || '',
  };
}

// Кэш вырезанной картинки теплообменника — по ключу (файл бланка + сдвиг),
// чтобы не перевырезать её из PDF при каждом клике "Скачать", если ничего
// не поменялось с прошлого раза.
let cachedDiagramCrop = null; // { key, crop }

async function handleGenerateCustomDocx() {
  if (!customTplBytes) {
    setStatus('genStatus', 'Сначала загрузите PDF бланка (шаг 1).', 'err');
    return;
  }
  setStatus('genStatus', 'Формирую Word-документ...');
  try {
    readOffsetInputs();
    const values = buildLetterheadValues();
    const key = `custom:${customTplHash}:${customTplOffsetXFrac}:${customTplOffsetYFrac}`;
    let diagram;
    if (cachedDiagramCrop && cachedDiagramCrop.key === key) {
      diagram = cachedDiagramCrop.crop;
    } else {
      diagram = await cropDiagramFromPdf(customTplBytes, customTplOffsetXFrac, customTplOffsetYFrac);
      cachedDiagramCrop = { key, crop: diagram };
    }
    const templateBytes = await getDocxTemplateBytes();
    const bytes = await fillDocxTemplate(templateBytes, values, currentFieldValues['certificates_note'] || '', diagram);
    const filename = buildOutputFilename('docx');
    downloadDocxBytes(bytes, filename);
    setStatus('genStatus', `Скачан файл ${filename}`, 'ok');
    await logToSheet(buildLogEntry('docx-custom'));
  } catch (err) {
    console.error(err);
    setStatus('genStatus', 'Ошибка формирования Word-документа: ' + err.message, 'err');
  }
}

/* ---------------- Вспомогательное ---------------- */

// Пользователь вводит только сам номер расчёта (например "19234") — месяц и
// год дописываются автоматически по ТЕКУЩЕЙ дате в момент формирования
// документа (не запоминаются заранее), формат "19234/09-2026".
function formatCalcNumber(rawNumber) {
  const num = (rawNumber || '').trim();
  if (!num) return '';
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${num}/${mm}-${yyyy}`;
}

// Дата в правом нижнем углу документа ("Расчёт выполнил: ФИО ... дата") —
// всегда текущая на момент формирования документа, вводить вручную не нужно.
// Формат по просьбе пользователя — дд/мм/гггг (со слэшами).
function formatTodayDateDMY() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// Для .vsdx и "своего PDF-шаблона" ФИО и дата пишутся в одну и ту же ячейку
// одной строкой (как раньше, когда дату вводили руками) — просто дата теперь
// всегда сегодняшняя, а не то, что ввёл пользователь.
function formatExecutorCombined(rawName) {
  const name = (rawName || '').trim();
  const today = formatTodayDateDMY();
  return name ? `${name}, ${today}` : today;
}

function buildOutputFilename(ext) {
  const baseTitle = (currentTemplate.title || '').replace(/\.(pdf|vsdx)$/i, '');
  const model = (currentFieldValues['model'] || baseTitle).replace(/[^\wА-Яа-яЁё\-.]+/g, '_');
  const date = new Date().toISOString().slice(0, 10);
  return `${model}_${date}.${ext}`;
}

function buildLogEntry(format) {
  return {
    timestamp: new Date().toISOString(),
    template: currentTemplate ? currentTemplate.id : '',
    format,
    model: currentFieldValues['model'] || '',
    customer: currentFieldValues['customer'] || '',
    site: currentFieldValues['site'] || '',
    calc_number: formatCalcNumber(currentFieldValues['calc_number']),
    price_total: currentFieldValues['price_total'] || '',
  };
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  initCustomTemplateUpload();
  initDropzone();
  el('btnCustomDocx').addEventListener('click', handleGenerateCustomDocx);
});
