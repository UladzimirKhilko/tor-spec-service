/*
 * app.js — склейка UI: выбор шаблона, загрузка/разбор спецификации,
 * форма полей, генерация .vsdx и PDF, запись в журнал.
 */

let currentTemplate = null;
let currentFieldValues = {}; // key -> string (то, что реально попадёт в документ)
let currentDebugMatches = [];

// "builtin" — готовый .vsdx-шаблон из фиксированного списка (js/fieldMap.js);
// "custom-pdf" — произвольный PDF, который инженер загрузил и разметил сам
// (см. js/pdfTemplate.js) — без какой-либо заранее подготовленной базы.
let templateMode = 'builtin';
let customTplBytes = null;   // ArrayBuffer исходного PDF-шаблона как есть
let customTplHash = null;
let customTplFileName = null;
let customTplMapping = null; // { hash, fileName, pageWidth, pageHeight, fields: { key: {xFrac,yFrac} } }

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

function setTemplate(id) {
  currentTemplate = getTemplateById(id);
  el('templateHint').textContent = currentTemplate
    ? `Файл шаблона: ${currentTemplate.file}`
    : '';
  currentFieldValues = {};
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

  // custom-pdf
  currentFieldValues = {};
  if (customTplFileName) {
    currentTemplate = { id: 'custom-pdf', title: customTplFileName, fields: PDF_TEMPLATE_FIELDS };
    el('formSection').style.display = '';
    el('actionsSection').style.display = '';
  } else {
    currentTemplate = null;
  }
  renderForm();
}

/* ---------------- Загрузка своего PDF-шаблона + мастер разметки ---------------- */

function initCustomTemplateUpload() {
  el('customTplInput').addEventListener('change', () => {
    const file = el('customTplInput').files[0];
    if (file) handleCustomTplUpload(file);
  });
  el('btnRemapTpl').addEventListener('click', () => {
    if (customTplBytes) startMappingWizard(customTplBytes, customTplHash, customTplFileName);
  });
  el('btnExportMapping').addEventListener('click', () => {
    if (customTplMapping) exportPdfTemplateMapping(customTplMapping);
  });
  el('importMappingInput').addEventListener('change', () => {
    const file = el('importMappingInput').files[0];
    if (file) handleImportMappingFile(file);
    el('importMappingInput').value = '';
  });
  el('btnWizardSkip').addEventListener('click', skipWizardField);
  el('btnWizardCancel').addEventListener('click', cancelWizard);
}

async function handleCustomTplUpload(file) {
  setStatus('customTplStatus', `Читаю файл ${file.name}...`);
  try {
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    customTplBytes = buf;
    customTplHash = hash;
    customTplFileName = file.name;

    currentTemplate = { id: 'custom-pdf', title: file.name, fields: PDF_TEMPLATE_FIELDS };
    currentFieldValues = {};
    renderForm();
    el('formSection').style.display = '';
    el('actionsSection').style.display = '';
    el('customTplActions').style.display = '';

    const existing = loadPdfTemplateMapping(hash);
    if (existing) {
      customTplMapping = existing;
      setStatus('customTplStatus', `Шаблон «${file.name}» уже был размечен ранее в этом браузере — можно сразу заполнять поля и генерировать PDF.`, 'ok');
    } else {
      customTplMapping = null;
      setStatus('customTplStatus', `Новый шаблон «${file.name}» — сейчас откроется разметка (один раз).`, '');
      await startMappingWizard(buf, hash, file.name);
    }
  } catch (err) {
    console.error(err);
    setStatus('customTplStatus', 'Не удалось прочитать PDF: ' + err.message, 'err');
  }
}

async function handleImportMappingFile(file) {
  try {
    const mapping = await importPdfTemplateMappingFile(file);
    if (customTplHash && mapping.hash !== customTplHash) {
      setStatus('customTplStatus', 'Этот файл разметки сделан для другого PDF (хэш не совпадает) — загрузите тот же PDF-шаблон, для которого делалась разметка.', 'err');
      return;
    }
    savePdfTemplateMapping(mapping);
    customTplMapping = mapping;
    setStatus('customTplStatus', `Разметка из файла применена для «${mapping.fileName || 'шаблона'}».`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus('customTplStatus', 'Ошибка загрузки файла разметки: ' + err.message, 'err');
  }
}

/* ---------------- Мастер разметки (клик по canvas) ---------------- */

let wizardState = null;

async function startMappingWizard(pdfBytes, hash, fileName) {
  const overlay = el('mappingWizard');
  const canvas = el('wizardCanvas');
  overlay.style.display = 'flex';
  setStatus('customTplStatus', 'Готовлю превью страницы...');

  const maxWidth = Math.max(320, Math.min(900, window.innerWidth - 120));
  const { pageWidth, pageHeight } = await renderPdfTemplatePage(pdfBytes, canvas, maxWidth);

  wizardState = {
    fields: PDF_TEMPLATE_FIELDS,
    index: 0,
    mapping: { hash, fileName, pageWidth, pageHeight, fields: {} },
  };

  canvas.onclick = (e) => {
    if (!wizardState) return;
    const rect = canvas.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const yFrac = (e.clientY - rect.top) / rect.height;
    const field = wizardState.fields[wizardState.index];
    wizardState.mapping.fields[field.key] = { xFrac, yFrac };
    advanceWizard();
  };

  updateWizardPrompt();
  setStatus('customTplStatus', 'Идёт разметка шаблона...');
}

function updateWizardPrompt() {
  const field = wizardState.fields[wizardState.index];
  el('wizardFieldLabel').textContent = `Куда писать: «${field.label}»?`;
  el('wizardProgress').textContent = `${wizardState.index + 1} / ${wizardState.fields.length}`;
}

function advanceWizard() {
  wizardState.index += 1;
  if (wizardState.index >= wizardState.fields.length) {
    finishWizard();
  } else {
    updateWizardPrompt();
  }
}

function skipWizardField() {
  if (!wizardState) return;
  advanceWizard();
}

function finishWizard() {
  savePdfTemplateMapping(wizardState.mapping);
  customTplMapping = wizardState.mapping;
  el('mappingWizard').style.display = 'none';
  setStatus('customTplStatus', `Шаблон «${wizardState.mapping.fileName}» размечен и сохранён в этом браузере — можно генерировать PDF.`, 'ok');
  wizardState = null;
}

function cancelWizard() {
  el('mappingWizard').style.display = 'none';
  wizardState = null;
  setStatus('customTplStatus', 'Разметка отменена. Нажмите «Разметить заново», когда будете готовы.', 'err');
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
    wrap.className = 'field ' + f.group;

    const label = document.createElement('label');
    label.textContent = f.label;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = f.group === 'auto' ? 'авто · проверить' : 'вручную';
    label.appendChild(badge);
    wrap.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
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
    const fills = currentTemplate.fields.map((f) => ({
      shapeIds: f.shapeIds,
      value: currentFieldValues[f.key] || '',
    }));
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

/* ---------------- Генерация PDF (через печать браузера) ---------------- */

function handleGeneratePdf() {
  if (!currentTemplate) return;
  document.querySelectorAll('#printSheet [data-print]').forEach((node) => {
    const key = node.getAttribute('data-print');
    node.textContent = currentFieldValues[key] || '';
  });
  window.print();
  logToSheet(buildLogEntry('pdf'));
}

/* ---------------- Генерация PDF по своему шаблону (pdf-lib поверх исходного файла) ---------------- */

async function handleGenerateCustomPdf() {
  if (!customTplBytes) {
    setStatus('genStatus', 'Сначала загрузите свой PDF-шаблон (шаг 1).', 'err');
    return;
  }
  if (!customTplMapping) {
    setStatus('genStatus', 'Шаблон ещё не размечен — нажмите «Разметить заново» на шаге 1.', 'err');
    return;
  }
  setStatus('genStatus', 'Формирую PDF по вашему шаблону...');
  try {
    const { bytes, notPlaced } = await fillPdfTemplate(customTplBytes, customTplMapping, currentFieldValues);
    const filename = buildOutputFilename('pdf');
    downloadPdfBytes(bytes, filename);
    if (notPlaced.length) {
      setStatus('genStatus', `Скачан файл ${filename}, но для полей без разметки текст не поставлен: ${notPlaced.join(', ')} — доразметьте шаблон, если они вам нужны.`, 'err');
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
    calc_number: currentFieldValues['calc_number'] || '',
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
