/*
 * app.js — склейка UI: выбор шаблона, загрузка/разбор спецификации,
 * форма полей, генерация .vsdx и PDF, запись в журнал.
 */

let currentTemplate = null;
let currentFieldValues = {}; // key -> string (то, что реально попадёт в документ)
let currentDebugMatches = [];

// "builtin" — готовый бланк из проверенного списка (js/builtinPdfMapping.js,
// BUILTIN_LETTERHEAD_TEMPLATES); "custom-pdf" — сотрудник сам загружает PDF
// бланка того же вида (другая модель/картинка) — координаты полей общие для
// всей линейки бланков (см. комментарий в builtinPdfMapping.js), поэтому
// разметка мышкой не нужна — только необязательная поправка смещения по
// X/Y, если у конкретного файла вёрстка чуть-чуть отличается.
let templateMode = 'builtin';
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

function initTemplateSelect() {
  const select = el('templateSelect');
  select.innerHTML = '';
  TEMPLATES.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.title;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => setTemplate(select.value));
  setTemplate(TEMPLATES[0].id);
}

// Блок "Примечание" (сертификаты и т.п.) заранее заполняется текстом из
// образца — чтобы пользователь мог его сразу проверить и, если нужно,
// поправить, а не начинать с пустого поля. Общая логика для готового бланка
// и "своего бланка" — оба используют один и тот же набор полей.
function applyDefaultFieldValues(fields) {
  currentFieldValues = {};
  if (fields.some((f) => f.key === 'certificates_note')) {
    currentFieldValues['certificates_note'] = DEFAULT_CERTIFICATES_TEXT;
  }
}

function setTemplate(id) {
  currentTemplate = getTemplateById(id);
  el('templateHint').textContent = currentTemplate
    ? `Файл шаблона: ${currentTemplate.file}`
    : '';
  applyDefaultFieldValues(currentTemplate ? currentTemplate.fields : []);
  renderForm();
  el('formSection').style.display = '';
  el('actionsSection').style.display = '';
}

/* ---------------- Переключение "готовый шаблон" / "свой PDF" ---------------- */

function initTemplateModeToggle() {
  const rBuiltin = el('tplModeBuiltin');
  const rCustom = el('tplModeCustom');
  rBuiltin.addEventListener('change', () => { if (rBuiltin.checked) switchTemplateMode('builtin'); });
  rCustom.addEventListener('change', () => { if (rCustom.checked) switchTemplateMode('custom-pdf'); });
}

function switchTemplateMode(mode) {
  templateMode = mode;
  el('builtinTplBlock').style.display = mode === 'builtin' ? '' : 'none';
  el('customTplBlock').style.display = mode === 'custom-pdf' ? '' : 'none';
  el('builtinActions').style.display = mode === 'builtin' ? '' : 'none';
  el('customActions').style.display = mode === 'custom-pdf' ? '' : 'none';

  if (mode === 'builtin') {
    setTemplate(el('templateSelect').value);
    return;
  }

  // custom-pdf ("свой бланк") — те же поля, что и у готового бланка,
  // потому что вся линейка бланков БСИ использует одну и ту же табличную
  // разметку (см. builtinPdfMapping.js).
  if (customTplFileName) {
    currentTemplate = { id: 'custom-letterhead', title: customTplFileName, fields: TEMPLATES[0].fields };
    applyDefaultFieldValues(currentTemplate.fields);
    el('formSection').style.display = '';
    el('actionsSection').style.display = '';
  } else {
    currentTemplate = null;
    currentFieldValues = {};
  }
  renderForm();
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
  el('btnCheckAlignment').addEventListener('click', handleCheckAlignment);
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
        ? `Бланк «${file.name}» уже проверялся в этом браузере (сдвиг ${existing.offsetXFrac ? 'сохранён' : 'не потребовался'}) — можно заполнять поля и генерировать PDF, либо нажать «Проверить совмещение» ещё раз.`
        : `Бланк «${file.name}» загружен — координаты полей той же линейки бланков применяются сразу. Нажмите «Проверить совмещение», чтобы убедиться, что всё легло ровно, прежде чем формировать документ с реальными данными.`,
      'ok'
    );
  } catch (err) {
    console.error(err);
    setStatus('customTplStatus', 'Не удалось прочитать PDF: ' + err.message, 'err');
  }
}

// Тестовые значения — имя каждого ключа поля вместо реальных данных, чтобы
// на контрольном PDF сразу было видно, какое поле куда легло. Для
// многострочного блока сертификатов — образцовый текст (проверяет заодно и
// перенос строк).
function buildAlignmentTestValues() {
  const values = {};
  BUILTIN_PDF_FIELD_KEYS.forEach((key) => {
    values[key] = key === 'certificates_note' ? DEFAULT_CERTIFICATES_TEXT : key;
  });
  return values;
}

async function handleCheckAlignment() {
  if (!customTplBytes) {
    setStatus('customTplStatus', 'Сначала загрузите бланк.', 'err');
    return;
  }
  readOffsetInputs();
  setStatus('customTplStatus', 'Формирую тестовый PDF для проверки совмещения...');
  try {
    const mapping = buildLetterheadMapping(customTplOffsetXFrac, customTplOffsetYFrac);
    const { bytes } = await fillPdfTemplate(customTplBytes, BUILTIN_PDF_FIELD_KEYS, mapping, buildAlignmentTestValues());
    const filename = `проверка-${(customTplFileName || 'blank').replace(/\.(pdf)$/i, '')}.pdf`;
    downloadPdfBytes(bytes, filename);
    setStatus('customTplStatus', `Скачан ${filename} — откройте и сверьте с образцом. Если какое-то поле съехало, подправьте «сдвиг по X/Y» (в мм) и проверьте ещё раз.`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus('customTplStatus', 'Ошибка формирования тестового PDF: ' + err.message, 'err');
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

async function handleFile(file) {
  setStatus('parseStatus', `Обрабатываю файл: ${file.name}...`);
  el('debugDetails').style.display = 'none';
  try {
    const { text, method } = await extractTextFromFile(file, (msg) => setStatus('parseStatus', msg));
    const { values, debugMatches } = parseBeltoText(text);
    currentDebugMatches = debugMatches;

    applyParsedValues(values);
    renderForm();

    const methodLabel = method === 'html-table'
      ? 'разбор HTML-таблицы, точно, без OCR'
      : method === 'pdf-text'
        ? 'текстовый слой PDF'
        : 'OCR-распознавание';
    const checkHint = method === 'html-table' ? '' : ' — особенно после OCR';
    setStatus('parseStatus', `Готово (${methodLabel}). Проверьте поля ниже перед генерацией${checkHint}.`, 'ok');
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

/* ---------------- Генерация .vsdx ---------------- */

async function handleGenerateVsdx() {
  if (!currentTemplate) return;
  setStatus('genStatus', 'Собираю .vsdx...');
  try {
    const fills = currentTemplate.fields.map((f) => {
      let value = currentFieldValues[f.key] || '';
      if (f.key === 'calc_number') value = formatCalcNumber(value);
      else if (f.key === 'executor') value = formatExecutorCombined(value);
      return { shapeIds: f.shapeIds, value };
    });
    const { blob, notFound } = await buildVsdx(currentTemplate.file, fills);
    const filename = buildOutputFilename('vsdx');
    downloadBlob(blob, filename);
    if (notFound.length) {
      setStatus('genStatus', `Готово, но не найдены фигуры ID: ${notFound.join(', ')} — проверьте маппинг в fieldMap.js`, 'err');
    } else {
      setStatus('genStatus', `Скачан файл ${filename}`, 'ok');
    }
    await logToSheet(buildLogEntry('vsdx'));
  } catch (err) {
    console.error(err);
    setStatus('genStatus', 'Ошибка генерации .vsdx: ' + err.message, 'err');
  }
}

/* ---------------- Генерация PDF (готовый .vsdx-шаблон) — по НАСТОЯЩЕМУ бланку ---------------- */
//
// Раньше здесь были две последовательные попытки:
//  1) window.print() — пользователю приходилось самому выбирать "Сохранить
//     как PDF" в диалоге печати;
//  2) сборка PDF из HTML-реконструкции бланка (#printSheet) через
//     html2canvas — но сама эта реконструкция была лишь приблизительной
//     копией фирменного бланка "на глаз" и заметно отличалась от настоящего
//     файла (другой порядок строк, не было логотипов/сертификатов и т.д.).
//
// Теперь используется тот же pdf-lib-механизм, что и для "своего
// PDF-шаблона" (js/pdfTemplate.js), но с заранее подготовленной разметкой
// (js/builtinPdfMapping.js) поверх НАСТОЯЩЕГО файла бланка
// (templates/TOR-15M_13-1x-original.pdf) — результат совпадает с образцом
// один в один, дорисовываются только сами значения.

// Общие для готового и "своего" бланка значения: ФИО/дата в подписи (две
// разные точки на бланке) и номер расчёта с автоматически дописанным "№ " и
// "/MM-ГГГГ" (закрашиваем и перерисовываем весь "№ ..." целиком — см.
// комментарий у calc_number в builtinPdfMapping.js). Если номер не введён —
// ничего не рисуем и не трогаем исходный "№ --/---2020" с бланка.
function buildLetterheadValues() {
  const formattedCalcNumber = formatCalcNumber(currentFieldValues['calc_number']);
  // DN (условный диаметр) в бланке напечатан у всех 4 патрубков сразу
  // (Т1/Т2/В1/Т3) — одно и то же значение дублируется в 4 "синтетических"
  // поля dn_1..dn_4 (см. LETTERHEAD_FIELDS в builtinPdfMapping.js), как и
  // shapeIds:[7,42,43,45] делают то же самое для .vsdx-варианта.
  const dnValue = currentFieldValues['dn'];
  return {
    ...currentFieldValues,
    executor_name: (currentFieldValues['executor'] || '').trim(),
    // Дата всегда сегодняшняя на момент формирования документа — не
    // зависит от того, заполнено ли ФИО.
    executor_date: formatTodayDateDMY(),
    calc_number: formattedCalcNumber ? `№ ${formattedCalcNumber}` : '',
    dn_1: dnValue, dn_2: dnValue, dn_3: dnValue, dn_4: dnValue,
  };
}

async function handleGeneratePdf() {
  if (!currentTemplate) return;
  setStatus('genStatus', 'Формирую PDF...');
  try {
    const pdfFile = currentTemplate.pdfFile || BUILTIN_LETTERHEAD_TEMPLATES[0].file;
    const pdfBytes = await getLetterheadTemplateBytes(pdfFile);
    const values = buildLetterheadValues();
    const { bytes, notPlaced } = await fillPdfTemplate(pdfBytes, BUILTIN_PDF_FIELD_KEYS, buildLetterheadMapping(0, 0), values);
    const filename = buildOutputFilename('pdf');
    downloadPdfBytes(bytes, filename);
    if (notPlaced.length) {
      setStatus('genStatus', `Скачан файл ${filename}, но не удалось разместить: ${notPlaced.join(', ')}.`, 'err');
    } else {
      setStatus('genStatus', `Скачан файл ${filename}`, 'ok');
    }
  } catch (err) {
    console.error(err);
    setStatus('genStatus', 'Ошибка формирования PDF: ' + err.message, 'err');
  }
  // Журнал пишется отдельно и не блокирует скачивание — ошибка логирования
  // не должна мешать пользователю.
  logToSheet(buildLogEntry('pdf'));
}

/* ---------------- Генерация PDF по своему бланку (та же разметка, что и у готовых) ---------------- */

async function handleGenerateCustomPdf() {
  if (!customTplBytes) {
    setStatus('genStatus', 'Сначала загрузите свой бланк (шаг 1).', 'err');
    return;
  }
  setStatus('genStatus', 'Формирую PDF по вашему бланку...');
  try {
    readOffsetInputs();
    const values = buildLetterheadValues();
    const mapping = buildLetterheadMapping(customTplOffsetXFrac, customTplOffsetYFrac);
    const { bytes, notPlaced } = await fillPdfTemplate(customTplBytes, BUILTIN_PDF_FIELD_KEYS, mapping, values);
    const filename = buildOutputFilename('pdf');
    downloadPdfBytes(bytes, filename);
    if (notPlaced.length) {
      setStatus('genStatus', `Скачан файл ${filename}, но не удалось разместить: ${notPlaced.join(', ')}.`, 'err');
    } else {
      setStatus('genStatus', `Скачан файл ${filename}`, 'ok');
    }
    await logToSheet(buildLogEntry('pdf-custom'));
  } catch (err) {
    console.error(err);
    setStatus('genStatus', 'Ошибка формирования PDF: ' + err.message, 'err');
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
  initTemplateSelect();
  initTemplateModeToggle();
  initCustomTemplateUpload();
  initDropzone();
  el('btnVsdx').addEventListener('click', handleGenerateVsdx);
  el('btnPdf').addEventListener('click', handleGeneratePdf);
  el('btnCustomPdf').addEventListener('click', handleGenerateCustomPdf);
});
