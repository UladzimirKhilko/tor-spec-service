/*
 * builtinPdfMapping.js
 *
 * Раньше "готовый шаблон" рисовался заново из HTML/CSS (#printSheet в
 * index.html) — это была ручная реконструкция бланка "на глаз", и она
 * ощутимо отличалась от настоящего фирменного бланка: другой порядок строк,
 * не было логотипов ISO/EAC, блока "Примечание" с сертификатами и т.д.
 *
 * Теперь вместо реконструкции берётся НАСТОЯЩИЙ файл бланка
 * (templates/TOR-15M_13-1x-original.pdf — тот самый .pdf, который прислал
 * инженер как образец) и поверх него тем же самым механизмом, что и для
 * "своего PDF-шаблона" (js/pdfTemplate.js, pdf-lib + fontkit + DejaVu Sans),
 * дорисовываются только сами значения — результат совпадает с образцом
 * один в один, отличаются только вписанные цифры/текст.
 *
 * Координаты (xFrac/yFrac — доли ширины/высоты страницы от левого верхнего
 * угла) сняты один раз вручную из текстового слоя PDF (pdfplumber:
 * page.find_tables() + extract_words()) — то есть это ручная "разметка",
 * просто сделанная программно, а не кликами мышкой в мастере (мастер для
 * такого фиксированного, всегда одного и того же бланка не нужен).
 *
 * У некоторых полей в оригинальном бланке уже напечатан образец значения
 * (например "Марка теплообменника: ТОР-15М/13-1х(LL+НН)", "Число ходов: 1",
 * имя и дата в подписи, "№ --/---2020") — такие места помечены redact:
 * прямоугольником, который закрашивается белым перед тем, как вписать
 * настоящее значение, чтобы старый и новый текст не накладывались друг на
 * друга.
 *
 * "executor" в форме — одно поле "ФИО, дата", а в самом бланке это две
 * РАЗНЫЕ области (между ними ещё напечатаны телефон/факс/e-mail) — поэтому
 * при генерации (см. handleGeneratePdf в app.js) строка делится по последней
 * запятой на executor_name/executor_date и пишется в две точки отдельно.
 */

const BUILTIN_PDF_TEMPLATE_FILE = 'templates/TOR-15M_13-1x-original.pdf';

const BUILTIN_PDF_MAPPING = {
  fileName: 'TOR-15M_13-1x-original.pdf',
  pageWidth: 594.75,
  pageHeight: 841.5,
  fields: {
    site:            { xFrac: 0.30265, yFrac: 0.13589 },
    customer:        { xFrac: 0.30265, yFrac: 0.15270 },
    contact_person:  { xFrac: 0.30265, yFrac: 0.16958 },
    contact_info:    { xFrac: 0.30265, yFrac: 0.18645 },

    heat_load:       { xFrac: 0.39647, yFrac: 0.26221 },
    temp_graph:      { xFrac: 0.39647, yFrac: 0.28746 },
    // L и A — узкие ячейки в правом блоке "Габаритные размеры", значения в
    // них по просьбе пользователя пишутся по центру ячейки, а не от края.
    dim_l:           { xFrac: 0.74552, yFrac: 0.27908, align: 'center', centerXFrac: 0.84599 },
    dim_a: {
      xFrac: 0.74552, yFrac: 0.26221, align: 'center', centerXFrac: 0.84599,
      // В образце в этой ячейке уже напечатано "2,55*" — закрываем перед
      // вписыванием настоящего значения.
      redact: { xFrac: 0.74048, yFrac: 0.25977, wFrac: 0.21101, hFrac: 0.01438 },
    },
    mass:            { xFrac: 0.74552, yFrac: 0.29596, align: 'center', centerXFrac: 0.84599 },

    temp_hot:        { xFrac: 0.39647, yFrac: 0.32959 },
    temp_cold:       { xFrac: 0.50727, yFrac: 0.32959 },
    flow_hot:        { xFrac: 0.39647, yFrac: 0.34641 },
    flow_cold:       { xFrac: 0.50727, yFrac: 0.34641 },
    dp_hot:          { xFrac: 0.39647, yFrac: 0.36328 },
    dp_cold:         { xFrac: 0.50727, yFrac: 0.36328 },
    plates_count:    { xFrac: 0.39647, yFrac: 0.38010 },

    passes_count: {
      xFrac: 0.39647, yFrac: 0.39691,
      redact: { xFrac: 0.39142, yFrac: 0.39441, wFrac: 0.25036, hFrac: 0.01450 },
    },

    heat_transfer_coef: { xFrac: 0.39647, yFrac: 0.41378 },
    surface_margin:     { xFrac: 0.39647, yFrac: 0.43066 },
    heat_surface:       { xFrac: 0.39647, yFrac: 0.44747 },

    model: {
      xFrac: 0.30265, yFrac: 0.46429,
      redact: { xFrac: 0.29760, yFrac: 0.46179, wFrac: 0.34418, hFrac: 0.01450 },
    },

    price_unit:  { xFrac: 0.39647, yFrac: 0.48116 },
    price_total: { xFrac: 0.39647, yFrac: 0.49804 },

    calc_number: {
      xFrac: 0.87600, yFrac: 0.03951,
      redact: { xFrac: 0.87432, yFrac: 0.03743, wFrac: 0.07902, hFrac: 0.01367 },
    },
    // Синтетические поля — см. пояснение выше про разбор "executor".
    executor_name: {
      xFrac: 0.22867, yFrac: 0.90226,
      redact: { xFrac: 0.22699, yFrac: 0.89958, wFrac: 0.13283, hFrac: 0.01485 },
    },
    executor_date: {
      xFrac: 0.86927, yFrac: 0.90226,
      redact: { xFrac: 0.86759, yFrac: 0.89958, wFrac: 0.07902, hFrac: 0.01485 },
    },

    // Блок "Примечание" справа (сертификаты, ТР ТС, материал пластин,
    // рабочие параметры) — целиком закрашивается и перерисовывается по
    // содержимому текстового поля certificates_note (см. renderForm/app.js),
    // чтобы его можно было проверить и поправить (например обновить номер
    // или дату сертификата), а не только смотреть на заводской текст.
    certificates_note: {
      xFrac: 0.64901, yFrac: 0.32799,
      // Шрифт заметно уже, чем в оригинале (Times New Roman) — 7pt подобран
      // так, чтобы ни одна строка образца не переносилась по словам; 8.6pt
      // межстрочный интервал (вместо "родных" ~9.4) — оставляет запас на
      // случай, если пользователь впишет более длинный текст и появится
      // лишняя перенесённая строка, не вылезая за рамку ячейки.
      multiline: true, fontSize: 7, maxWidthFrac: 0.3008, lineHeightFrac: 0.01022,
      redact: { xFrac: 0.64515, yFrac: 0.32715, wFrac: 0.30635, hFrac: 0.18289 },
    },
  },
};

const BUILTIN_PDF_FIELD_KEYS = Object.keys(BUILTIN_PDF_MAPPING.fields);

// Исходный текст блока "Примечание" из образца — подставляется в форму по
// умолчанию, чтобы пользователь мог его проверить и при необходимости
// отредактировать (например обновить номер/дату сертификата).
const DEFAULT_CERTIFICATES_TEXT = [
  'Сертификат продукции собственного',
  'производства №53.1/303-1 от 23.01.2020',
  '',
  'ТР ТС 032/2013',
  '«О безопасности оборудования, работающего',
  'под избыточным давлением»',
  'ТС № RU Д-BY. МЮ62В.02576 от 28.10.2015',
  'ТР ТС 010/2011',
  '«О безопасности машин и оборудования»',
  'ТС № RU Д-BY. АЗ01.В.02514 от 11.07.2016',
  '',
  'Материал пластин AISI 304 0,5mm',
  'Резиновые уплотнения EPDM HT',
  '(термостойкая резиновая смесь)',
  'Рабочая температура - 150 °C',
  'Рабочее давление - 1,6 МПа',
].join('\n');

let cachedBuiltinPdfBytes = null;
async function getBuiltinPdfTemplateBytes() {
  if (!cachedBuiltinPdfBytes) {
    const resp = await fetch(BUILTIN_PDF_TEMPLATE_FILE);
    if (!resp.ok) throw new Error(`Не удалось загрузить бланк ${BUILTIN_PDF_TEMPLATE_FILE}`);
    cachedBuiltinPdfBytes = await resp.arrayBuffer();
  }
  return cachedBuiltinPdfBytes;
}

// currentFieldValues['executor'] — одна строка вида "Иванов И.И., 06.09.2026"
// (ФИО, дата) — делим по ПОСЛЕДНЕЙ запятой: всё после неё — дата, всё до —
// ФИО. Если запятой нет, дата не пишется (плейсхолдер в бланке остаётся
// как есть), а вся строка уходит в поле имени.
function splitExecutorValue(raw) {
  const value = (raw || '').trim();
  if (!value) return { executor_name: '', executor_date: '' };
  const idx = value.lastIndexOf(',');
  if (idx === -1) return { executor_name: value, executor_date: '' };
  return {
    executor_name: value.slice(0, idx).trim(),
    executor_date: value.slice(idx + 1).trim(),
  };
}
