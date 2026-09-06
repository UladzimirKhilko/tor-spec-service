/*
 * builtinPdfMapping.js
 *
 * Раньше "готовый шаблон" рисовался заново из HTML/CSS (#printSheet в
 * index.html) — это была ручная реконструкция бланка "на глаз", и она
 * ощутимо отличалась от настоящего фирменного бланка: другой порядок строк,
 * не было логотипов ISO/EAC, блока "Примечание" с сертификатами и т.д.
 *
 * Теперь вместо реконструкции берётся НАСТОЯЩИЙ файл бланка и поверх него
 * pdf-lib (+ fontkit + DejaVu Sans, js/pdfTemplate.js) дорисовываются только
 * сами значения — результат совпадает с образцом один в один, отличаются
 * только вписанные цифры/текст.
 *
 * Координаты (xFrac/yFrac — доли ширины/высоты страницы от левого верхнего
 * угла) сняты один раз вручную из текстового слоя PDF (pdfplumber:
 * page.find_tables() + extract_words()) для самого первого бланка
 * (ТОР-15М/13-1х). У БСИ вся линейка бланков — это ОДИН И ТОТ ЖЕ фирменный
 * лист, меняется только картинка теплообменника и марка/размеры в тексте —
 * сама таблица (расположение строк и колонок) везде одинаковая. Поэтому эти
 * координаты (LETTERHEAD_FIELDS ниже) — общие для ВСЕЙ линейки бланков, а не
 * только для одного конкретного файла:
 *
 *  - BUILTIN_LETTERHEAD_TEMPLATES — бланки, которые уже проверены и лежат в
 *    самом сервисе (добавляются сюда после того, как кто-то — сейчас я —
 *    один раз сверил координаты на конкретном файле и убедился, что всё
 *    совпадает); показываются в выпадающем списке "Готовый шаблон".
 *  - "Свой бланк" (см. app.js, custom-letterhead режим) — самообслуживание:
 *    сотрудник загружает PDF нового бланка (той же линейки, просто с другой
 *    картинкой/маркой) САМ, без чьей-либо помощи — те же координаты
 *    применяются сразу, без разметки мышкой. Чтобы не полагаться вслепую на
 *    то, что верстка у нового файла и правда пиксель-в-пиксель совпадает,
 *    там есть кнопка "Проверить совмещение" (тестовый PDF с заметными
 *    значениями во всех полях) и, если что-то всё же съехало на пару
 *    миллиметров — два числа "сдвиг по X/Y" (buildLetterheadMapping ниже),
 *    а не полная разметка по 26 полям заново.
 *
 * У некоторых полей в оригинальном бланке уже напечатан образец значения
 * (например "Марка теплообменника: ТОР-15М/13-1х(LL+НН)", "Число ходов: 1",
 * имя и дата в подписи, "№ --/---2020") — такие места помечены redact:
 * прямоугольником, который закрашивается белым перед тем, как вписать
 * настоящее значение, чтобы старый и новый текст не накладывались друг на
 * друга.
 *
 * "executor" в форме — это поле ФИО, а в самом бланке подпись и дата — две
 * РАЗНЫЕ области (между ними ещё напечатаны телефон/факс/e-mail): ФИО пишется
 * в executor_name как есть, а дата (executor_date) всегда подставляется
 * текущая на момент формирования документа (см. buildLetterheadValues в
 * app.js) — пользователю вводить её не нужно.
 */

const LETTERHEAD_PAGE = { width: 594.75, height: 841.5 };

// Область картинки теплообменника (общий вид + размеры) на бланке — те же
// координаты общие для всей линейки (как и LETTERHEAD_FIELDS). Используется
// для автовырезки картинки из загружаемого PDF при формировании Word-
// документа (см. js/diagramCrop.js) — сотруднику не нужно готовить картинку
// отдельно, программа сама вырезает её из того же PDF, что и остальные данные.
const DIAGRAM_BOX = { xFrac0: 0.04767, xFrac1: 0.95323, yFrac0: 0.54497, yFrac1: 0.83983 };

const LETTERHEAD_FIELDS = {
  site:            { xFrac: 0.30265, yFrac: 0.13589 },
  customer:        { xFrac: 0.30265, yFrac: 0.15270 },
  contact_person:  { xFrac: 0.30265, yFrac: 0.16958 },
  contact_info:    { xFrac: 0.30265, yFrac: 0.18645 },

  // Значения в таблицах "Исходные данные"/"Расчёт" — по просьбе пользователя
  // размещены по центру своей ячейки (а не от левого края, как раньше).
  // centerXFrac снят с реальных границ ячеек (pdfplumber: page.rects) —
  // widthFrac ячейки общая для всей строки (одна ячейка на значение) или
  // разбита на "греющая среда"/"нагреваемая среда" (см. ниже).
  heat_load:       { xFrac: 0.39647, yFrac: 0.26221, align: 'center', centerXFrac: 0.50042 },
  temp_graph:      { xFrac: 0.39647, yFrac: 0.28746, align: 'center', centerXFrac: 0.50042 },
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

  // Строки с двумя значениями в одной строке (греющий/нагреваемый контур) —
  // у ячейки "Греющая среда" центр 0.42887, у "Нагреваемая среда" — 0.57185.
  temp_hot:        { xFrac: 0.39647, yFrac: 0.32959, align: 'center', centerXFrac: 0.42887 },
  temp_cold:       { xFrac: 0.50727, yFrac: 0.32959, align: 'center', centerXFrac: 0.57185 },
  flow_hot:        { xFrac: 0.39647, yFrac: 0.34641, align: 'center', centerXFrac: 0.42887 },
  flow_cold:       { xFrac: 0.50727, yFrac: 0.34641, align: 'center', centerXFrac: 0.57185 },
  dp_hot:          { xFrac: 0.39647, yFrac: 0.36328, align: 'center', centerXFrac: 0.42887 },
  dp_cold:         { xFrac: 0.50727, yFrac: 0.36328, align: 'center', centerXFrac: 0.57185 },
  plates_count:    { xFrac: 0.39647, yFrac: 0.38010, align: 'center', centerXFrac: 0.50042 },

  passes_count: {
    xFrac: 0.39647, yFrac: 0.39691, align: 'center', centerXFrac: 0.50042,
    redact: { xFrac: 0.39142, yFrac: 0.39441, wFrac: 0.25036, hFrac: 0.01450 },
  },

  heat_transfer_coef: { xFrac: 0.39647, yFrac: 0.41378, align: 'center', centerXFrac: 0.50042 },
  surface_margin:     { xFrac: 0.39647, yFrac: 0.43066, align: 'center', centerXFrac: 0.50042 },
  heat_surface:       { xFrac: 0.39647, yFrac: 0.44747, align: 'center', centerXFrac: 0.50042 },

  model: {
    xFrac: 0.30265, yFrac: 0.46429, align: 'center', centerXFrac: 0.47066,
    redact: { xFrac: 0.29760, yFrac: 0.46179, wFrac: 0.34418, hFrac: 0.01450 },
  },

  price_unit:  { xFrac: 0.39647, yFrac: 0.48116, align: 'center', centerXFrac: 0.50042 },
  price_total: { xFrac: 0.39647, yFrac: 0.49804, align: 'center', centerXFrac: 0.50042 },

  // Условный диаметр DN, мм — строка "DN, мм" в блоке "Габаритные размеры",
  // 4 патрубка (Т1/Т2/В1/Т3), в образце везде напечатано "50" — редактируем
  // (закрашиваем) каждую ячейку отдельно и пишем туда одно и то же значение
  // (см. dn auto-поле в fieldMap.js и buildLetterheadValues в app.js,
  // которая копирует values.dn в dn_1..dn_4). Координаты ячеек сняты с
  // pdfplumber (page.rects) для строки "DN, мм" в оригинале бланка.
  dn_1: {
    xFrac: 0.76610, yFrac: 0.24537, align: 'center', centerXFrac: 0.76610,
    redact: { xFrac: 0.73962, yFrac: 0.24290, wFrac: 0.05310, hFrac: 0.01445 },
  },
  dn_2: {
    xFrac: 0.81966, yFrac: 0.24537, align: 'center', centerXFrac: 0.81966,
    redact: { xFrac: 0.79440, yFrac: 0.24290, wFrac: 0.05075, hFrac: 0.01445 },
  },
  dn_3: {
    xFrac: 0.87225, yFrac: 0.24537, align: 'center', centerXFrac: 0.87225,
    redact: { xFrac: 0.84685, yFrac: 0.24290, wFrac: 0.05075, hFrac: 0.01445 },
  },
  dn_4: {
    xFrac: 0.92584, yFrac: 0.24537, align: 'center', centerXFrac: 0.92584,
    redact: { xFrac: 0.89923, yFrac: 0.24290, wFrac: 0.05313, hFrac: 0.01445 },
  },

  calc_number: {
    // Между напечатанным "№" и краем листа было слишком мало места для
    // номера переменной длины — решили не уменьшать шрифт, а вместо этого
    // закрасить и сам напечатанный значок "№", и написать всю надпись
    // "№ 19234/09-2026" заново целиком (см. buildLetterheadValues в app.js,
    // который подставляет сюда готовую строку с "№ " в начале) — сдвинутую
    // левее, во весь исходный размер шрифта. Выравнивание по правому краю
    // (rightXFrac) держит одинаковый отступ от кромки страницы независимо
    // от длины номера.
    xFrac: 0.83000, yFrac: 0.03951, align: 'right', rightXFrac: 0.97480,
    redact: { xFrac: 0.82500, yFrac: 0.03600, wFrac: 0.15500, hFrac: 0.01750 },
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
};

const BUILTIN_PDF_FIELD_KEYS = Object.keys(LETTERHEAD_FIELDS);

// Бланки, для которых координаты уже сверены и подтверждены (пиксель-в-
// пиксель совпадают с LETTERHEAD_FIELDS) — показываются в выпадающем списке
// "Готовый шаблон". Чтобы добавить новую модель сюда, нужно свериться на
// реальном PDF-образце (обычно достаточно сгенерировать тестовый PDF через
// buildLetterheadMapping(0,0) и визуально сравнить с образцом).
const BUILTIN_LETTERHEAD_TEMPLATES = [
  { id: 'tor-15m-13-1x', title: 'ТОР-15М/13-1х (LL+НН)', file: 'templates/TOR-15M_13-1x-original.pdf' },
];

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

// Байты PDF-файлов бланков — кэшируем по пути к файлу (не по одному общему
// файлу, как раньше), потому что бланков теперь несколько.
const letterheadBytesCache = new Map();
async function getLetterheadTemplateBytes(file) {
  if (!letterheadBytesCache.has(file)) {
    letterheadBytesCache.set(file, (async () => {
      const resp = await fetch(file);
      if (!resp.ok) throw new Error(`Не удалось загрузить бланк ${file}`);
      return resp.arrayBuffer();
    })());
  }
  return letterheadBytesCache.get(file);
}

// Сдвигает одну позицию поля на (dxFrac, dyFrac) — используется для "своего
// бланка" (самообслуживание), когда верстка нового файла на пару миллиметров
// отличается от эталонной и нужна общая поправка по X/Y для всех полей сразу.
function shiftFieldPos(pos, dxFrac, dyFrac) {
  const shifted = { ...pos };
  if (shifted.xFrac !== undefined) shifted.xFrac += dxFrac;
  if (shifted.yFrac !== undefined) shifted.yFrac += dyFrac;
  if (shifted.centerXFrac !== undefined) shifted.centerXFrac += dxFrac;
  if (shifted.rightXFrac !== undefined) shifted.rightXFrac += dxFrac;
  if (shifted.redact) {
    shifted.redact = { ...shifted.redact, xFrac: shifted.redact.xFrac + dxFrac, yFrac: shifted.redact.yFrac + dyFrac };
  }
  return shifted;
}

// Строит объект mapping (в формате, который принимает fillPdfTemplate) для
// линейки фирменных бланков БСИ, с необязательной общей поправкой
// смещения — для готовых, заранее сверенных бланков смещение всегда 0/0,
// для "своего бланка" оно берётся из того, что сотрудник подобрал в блоке
// проверки совмещения (см. app.js).
function buildLetterheadMapping(offsetXFrac, offsetYFrac) {
  const dx = offsetXFrac || 0;
  const dy = offsetYFrac || 0;
  const fields = {};
  BUILTIN_PDF_FIELD_KEYS.forEach((key) => {
    fields[key] = (dx || dy) ? shiftFieldPos(LETTERHEAD_FIELDS[key], dx, dy) : LETTERHEAD_FIELDS[key];
  });
  return { pageWidth: LETTERHEAD_PAGE.width, pageHeight: LETTERHEAD_PAGE.height, fields };
}
