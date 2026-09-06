/*
 * fieldMap.js
 * Описание шаблонов (.vsdx) и соответствия полей.
 *
 * Каждый шаблон описывается:
 *  - id, title, file (путь к .vsdx в /templates)
 *  - fields: массив логических полей формы
 *      key         - внутренний ключ
 *      label       - подпись в форме
 *      group       - "auto" (авто из распознавания, но редактируемое) | "manual" (всегда пустое, вводится вручную)
 *      shapeIds    - ID фигур в visio/pages/page1.xml, куда пишется значение (может быть несколько -
 *                    например если в шаблоне значение продублировано в двух визуально одинаковых ячейках)
 *      unit        - единица измерения, которая ожидается В ШАБЛОНЕ
 *      sourceKeys  - список ключей из распознанной спецификации BelTO, откуда берётся значение
 *                    (см. beltoParser.js), в порядке приоритета
 *      sourceUnit  - единица измерения поля-источника (для конвертации)
 *      convert     - имя функции конвертации из units.js (или null, если конвертация не нужна)
 *      notes       - пояснение для пользователя (показывается как подсказка)
 */

const TEMPLATES = [
  {
    id: 'tor-15m-13-1x',
    title: 'ТОР-15М/13-1х (LL+НН)',
    file: 'templates/TOR-15M_13-1x.vsdx',
    // Настоящий фирменный бланк (PDF) для этой модели — используется при
    // "Скачать PDF" (см. handleGeneratePdf в app.js). Координаты полей общие
    // для всей линейки бланков БСИ (js/builtinPdfMapping.js).
    pdfFile: 'templates/TOR-15M_13-1x-original.pdf',
    previewImage: 'templates/TOR-15M_13-1x-preview.png',
    fields: [
      // --- Ручной ввод (в спецификации BelTO этих данных нет) ---
      { key: 'customer',        label: 'Заказчик',                         group: 'manual', shapeIds: [12], unit: null, notes: '' },
      { key: 'site',             label: 'Место установки',                  group: 'manual', shapeIds: [27], unit: null, notes: '' },
      { key: 'contact_person',   label: 'Фамилия И.О. (контактное лицо)',   group: 'manual', shapeIds: [11], unit: null, notes: '' },
      { key: 'contact_info',     label: 'Телефон, факс, E-mail',            group: 'manual', shapeIds: [13], unit: null, notes: '' },
      { key: 'calc_number',      label: 'Номер расчёта',                    group: 'manual', shapeIds: [1797], unit: null, notes: 'Введите только номер, например 19234 — месяц и год подставятся автоматически по сегодняшней дате: получится "19234/09-2026"' },
      { key: 'price_unit',       label: 'Цена без НДС за единицу, руб',     group: 'manual', shapeIds: [31], unit: 'руб', notes: '' },
      { key: 'price_total',      label: 'ИТОГО цена без НДС, руб',          group: 'manual', shapeIds: [36, 1794], unit: 'руб', notes: '' },
      { key: 'executor',         label: 'Расчёт выполнил (ФИО)',            group: 'manual', shapeIds: [56], unit: null, notes: 'Дата проставляется автоматически текущим числом (дд/мм/гггг) — вводить не нужно' },

      // --- Автозаполнение из спецификации BelTO (можно поправить руками) ---
      { key: 'model',
        label: 'Марка теплообменника',
        group: 'auto', shapeIds: [339], unit: null,
        // Базовая марка (например "ТОР-15М/13") и код исполнения (например
        // "1х", "2хЦ", "3хБГВ") берутся из текстового слоя PDF-бланка
        // (app.js -> modelExtract.js, поля v.model_base/v.model_execution,
        // проставляются до вызова compute) — работает для любого загруженного
        // бланка этой линейки, без зашитого значения по умолчанию. Количество
        // пластин и раскладка каналов по-прежнему берутся из спецификации
        // BelTO — это надёжнее, чем строка "Теплообменник Пластинчатый..."
        // из спецификации, которая на OCR часто искажается. Если марку/
        // исполнение не удалось распознать в бланке — поле остаётся пустым
        // (compute вернёт null), сотрудник заполняет его вручную — статус
        // после разбора спецификации явно предупреждает об этом (см. app.js).
        compute: (v) => (v.plates_count && v.channel_layout && v.model_base && v.model_execution)
          ? `${v.model_base}-${Math.round(parseFloat(v.plates_count))}-${v.model_execution}(${v.channel_layout})`
          : null,
        sourceKeys: ['model'], sourceUnit: null, convert: null,
        notes: 'Собирается автоматически как <марка из бланка>-<кол-во пластин>-<исполнение из бланка>(<раскладка каналов>) — если марка/исполнение не распознались из PDF, заполните вручную' },

      { key: 'heat_load',
        label: 'Тепловая нагрузка, Гкал/ч',
        group: 'auto', shapeIds: [136], unit: 'Гкал/ч',
        sourceKeys: ['heat_power'], sourceUnit: 'Гкал/ч', convert: null, notes: '' },

      { key: 'temp_graph',
        label: 'Температурный график сетевой воды, °C',
        group: 'auto', shapeIds: [289], unit: '°C',
        sourceKeys: ['temp_graph'], sourceUnit: '°C', convert: null,
        notes: 'Формат вида 95/70 — вход/выход. Если в спецификации нет отдельного поля, соберите вручную из температур входа/выхода.' },

      { key: 'temp_hot',
        label: 'Температура вход-выход, греющий контур, °C',
        group: 'auto', shapeIds: [51], unit: '°C',
        sourceKeys: ['temp_in_hot_out_hot'], sourceUnit: '°C', convert: null,
        notes: 'Формат: вход-выход через тире, например 95-70' },

      { key: 'temp_cold',
        label: 'Температура вход-выход, нагреваемый контур, °C',
        group: 'auto', shapeIds: [746], unit: '°C',
        sourceKeys: ['temp_in_cold_out_cold'], sourceUnit: '°C', convert: null,
        notes: 'Формат: вход-выход через тире, например 65-90' },

      { key: 'flow_hot',
        label: 'Расход, греющий контур, т/ч',
        group: 'auto', shapeIds: [94], unit: 'т/ч',
        sourceKeys: ['flow_hot'], sourceUnit: 'т/ч', convert: null, notes: '' },

      { key: 'flow_cold',
        label: 'Расход, нагреваемый контур, т/ч',
        group: 'auto', shapeIds: [747, 350], unit: 'т/ч',
        sourceKeys: ['flow_cold'], sourceUnit: 'т/ч', convert: null,
        notes: 'В шаблоне обнаружены две наложенные ячейки (747 и 350) — значение пишется в обе на всякий случай' },

      { key: 'dp_hot',
        label: 'Потери давления, греющий контур, кг/см2',
        group: 'auto', shapeIds: [95], unit: 'кг/см2',
        sourceKeys: ['dp_hot'], sourceUnit: 'кПа', convert: 'kpaToKgfCm2',
        notes: 'В спецификации BelTO потери напора обычно в кПа — конвертируется автоматически в кгс/см2' },

      { key: 'dp_cold',
        label: 'Потери давления, нагреваемый контур, кг/см2',
        group: 'auto', shapeIds: [15], unit: 'кг/см2',
        sourceKeys: ['dp_cold'], sourceUnit: 'кПа', convert: 'kpaToKgfCm2',
        notes: 'В спецификации BelTO потери напора обычно в кПа — конвертируется автоматически в кгс/см2' },

      { key: 'plates_count',
        label: 'Количество пластин, шт',
        group: 'auto', shapeIds: [117], unit: 'шт',
        sourceKeys: ['plates_count'], sourceUnit: 'шт', convert: null, notes: '' },

      { key: 'passes_count',
        label: 'Число ходов',
        group: 'auto', shapeIds: [119], unit: null,
        sourceKeys: ['passes_count'], sourceUnit: null, convert: null,
        notes: 'В шаблоне по умолчанию стоит "1"' },

      { key: 'heat_transfer_coef',
        label: 'Коэффициент теплопередачи (факт./необходимый), Вт/м2°C',
        group: 'auto', shapeIds: [121], unit: 'Вт/м2°C',
        // В шаблоне одна ячейка — пишем "фактический/необходимый" (напр. 4431/4210)
        sourceKeys: ['heat_transfer_coef_combined', 'heat_transfer_coef_actual'], sourceUnit: 'Вт/м2°K', convert: null,
        notes: 'Вт/(м²·К) численно равно Вт/(м²·°C) — конвертация не требуется. Формат: фактический/необходимый' },

      { key: 'surface_margin',
        label: 'Запас по поверхности, %',
        group: 'auto', shapeIds: [123], unit: '%',
        sourceKeys: ['surface_margin_pct', 'surface_margin'], sourceUnit: '%', convert: null,
        notes: 'Формат: с запятой и знаком %, например 5,26%' },

      { key: 'heat_surface',
        label: 'Поверхность теплообмена, м2',
        group: 'auto', shapeIds: [126], unit: 'м2',
        sourceKeys: ['heat_surface'], sourceUnit: 'м2', convert: null, notes: '' },

      { key: 'dn',
        label: 'Условный диаметр DN, мм (все патрубки)',
        group: 'auto', shapeIds: [7, 42, 43, 45], unit: 'мм',
        sourceKeys: ['dn'], sourceUnit: 'мм', convert: null,
        notes: 'По умолчанию в шаблоне везде стоит 50 — значение подставляется во все 4 патрубка (Т1,Т2,В1,Т3)' },

      { key: 'mass',
        label: 'Масса, кг',
        group: 'auto', shapeIds: [111], unit: 'кг',
        sourceKeys: ['mass_filled', 'mass_empty'], sourceUnit: 'кг', convert: null,
        notes: 'Берётся вес заполненного теплообменника, если есть в спецификации, иначе — пустого' },

      { key: 'dim_l',
        label: 'L, мм (длина по патрубкам)',
        group: 'manual', shapeIds: [748], unit: 'мм',
        notes: 'В спецификации BelTO обычно отсутствует, зависит от исполнения рамы — проверьте по чертежу/каталогу' },

      { key: 'dim_a',
        label: 'A, мм',
        group: 'manual', shapeIds: [], unit: 'мм',
        notes: 'В спецификации BelTO обычно отсутствует, зависит от исполнения рамы — проверьте по чертежу/каталогу' },

      { key: 'certificates_note',
        label: 'Блок "Примечание" (сертификаты, ТР ТС, материалы)',
        group: 'manual', shapeIds: [], unit: null, multiline: true,
        notes: 'Заполнено текстом из образца — проверьте и поправьте при необходимости (например номер/дату сертификата)' },
    ],
  },
];

function getTemplateById(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}
