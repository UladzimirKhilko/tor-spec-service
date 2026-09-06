/*
 * beltoParser.js
 * Разбор текста отчёта "Спецификация" программы BelTO / ТеплоХИТ
 * (см. пример: скриншот из папки пользователя) в плоский словарь
 * source-ключей, которые затем маппятся в fieldMap.js.
 *
 * Работает как с "чистым" текстом из PDF (pdf.js), так и с текстом
 * после OCR (tesseract.js) — во втором случае распознавание менее
 * точное, поэтому все результаты обязательно показываются
 * пользователю для проверки перед генерацией документа.
 *
 * ВАЖНО: это эвристический построчный разбор под конкретный формат
 * отчёта BelTO. Если формат исходника отличается — часть полей может
 * не распознаться, тогда их просто нужно ввести/поправить руками в форме.
 */

// Описание строк отчёта: label - паттерн подписи (regex, без учёта регистра),
// valuesCount - сколько чисел ожидаем на этой строке (1 = общее значение,
// 2 = отдельно "греющий"/"нагреваемый" контур),
// keys - соответствующие source-ключи (длина === valuesCount)
//
// Многие подписи начинаются с "Те..." (Температура, Тепловая, Теплообменник,
// Теплопередачи, Теплообмена) — на реальном тесте построчный OCR на строках
// с плотным мелким шрифтом регулярно путал заглавную "Т" с "П" (например
// "Температура на Выходе" распознавалась как "Пемпература на Выходе"), из-за
// чего вся строка переставала находиться и связанные поля (в т.ч. вычисляемые
// из неё температурный график и вход-выход) оставались пустыми. Поэтому для
// всех таких подписей первая буква ищется как [ТП], а не только "Т".
const BELTO_LINES = [
  { label: /[ТП]еплообменник\s+Пластинчат\S*\s+Разборн\S*\s*:?\s*(.+)/i, kind: 'model' },
  // "на" и словоформы — терпимость к типичным ошибкам OCR (пропуск короткого
  // предлога, окончания "Температуры"/"Температур" и т.п.)
  { label: /[ТП]емператур\S*\s+(?:на\s+)?Вход\S*/i, valuesCount: 2, keys: ['t_in_hot', 't_in_cold'] },
  { label: /[ТП]емператур\S*\s+(?:на\s+)?Выход\S*/i, valuesCount: 2, keys: ['t_out_hot', 't_out_cold'] },
  { label: /Массов\S*\s+Расход/i, valuesCount: 2, keys: ['flow_hot', 'flow_cold'] },
  // Потер[и]/Напор[а] — стеммингом переживаем окончания и мелкие опечатки OCR
  { label: /Потер\S*\s+Напор\S*/i, valuesCount: 2, keys: ['dp_hot', 'dp_cold'] },
  // Мо[щш]ность и (?:Кол\S*\s+)?Ходов — терпимость к типичным ошибкам OCR
  // (Tesseract на скриншотах нередко путает "щ"/"ш" и теряет первые буквы
  // короткого слова перед границей ячейки таблицы)
  { label: /[ТП]епловая\s+Мо[щш]ность/i, valuesCount: 1, keys: ['heat_power'] },
  { label: /Поверхность\s+[ТП]еплообмена/i, valuesCount: 1, keys: ['heat_surface'] },
  // "по/no" перед "Поверхности" нередко пропадает или сливается с соседним
  // словом при OCR — делаем его необязательным; "Поверхности" стеммингуем
  { label: /(?:Запас|Валас|Banac|3anac|3апас)\s*(?:по|no)?\s*Поверхн\S*/i, valuesCount: 1, keys: ['surface_margin'] },
  { label: /Коэф-?т\s+[ТП]еплопередачи\s+Факт\S*/i, valuesCount: 1, keys: ['heat_transfer_coef_actual'] },
  { label: /Коэф-?т\s+[ТП]еплопередачи\s+Необходим\S*/i, valuesCount: 1, keys: ['heat_transfer_coef_required'] },
  { label: /Количество\s+Пластин/i, valuesCount: 1, keys: ['plates_count'] },
  { label: /(?:Кол\S*\s+)?Ходов/i, valuesCount: 1, keys: ['passes_count'] },
  // "Диаметр" стеммингуем по началу/концу — OCR на этом слове нередко путает
  // среднюю "и" с "н" (в "Диаметр"), а в "Условный" — "л" с "п" ("Усповный")
  { label: /Ус[лп][оа]в\S*\s+Д\S*аметр/i, valuesCount: 2, keys: ['dn_hot', 'dn_cold'] },
  { label: /Вес\s+[ТП]еплообменника/i, valuesCount: 2, keys: ['mass_empty', 'mass_filled'] },
  // Раскладка каналов, например "27НН" / "27LL" — нужна для сборки марки
  // теплообменника вида ТОР-15М/13-<кол-во пластин>-1х(<раскладка>).
  // Захватываем первое число + 2-4 буквы после подписи строки.
  { label: /Раскладка\s+Канал\S*\D*(\d{1,3})\s*([A-Za-zА-Яа-я]{2,4})/i, kind: 'channel_layout' },
];

function extractNumbers(line) {
  const matches = line.match(/-?\d+(?:[.,]\d+)?/g);
  if (!matches) return [];
  return matches.map((m) => parseFloat(m.replace(',', '.')));
}

// На построчном OCR десятичная точка/запятая — самый мелкий и хрупкий
// элемент цифры — нередко либо пропадает целиком ("2.34" -> "234"), либо
// распознаётся как пробел ("2.34" -> "2 34"). Второй случай можно надёжно
// исправить: если "в лоб" на строке нашлось не столько чисел, сколько
// ожидается, пробуем слить пары "цифра(-ы) + пробел + 2 цифры" в одно
// дробное число и повторить извлечение — часто это и даёт нужное количество.
function extractValuesForRule(line, valuesCount) {
  const raw = extractNumbers(line);
  const merged = line.replace(/(\d)\s+(\d{2})(?=\D|$)/g, '$1.$2');
  const mergedNums = merged !== line ? extractNumbers(merged) : raw;
  // Предпочитаем "склеенный" вариант, если он даёт ровно ожидаемое
  // количество чисел, или хотя бы уменьшает их количество по сравнению с
  // исходным (значит слияние действительно нашло разделённую точку и с
  // большей вероятностью восстановило потерянное дробное число, даже если
  // в строке остались посторонние цифры, например от артефакта OCR на
  // соседней колонке единиц измерения).
  if (mergedNums.length === valuesCount) return mergedNums;
  if (raw.length === valuesCount) return raw;
  if (mergedNums.length < raw.length) return mergedNums;
  return raw;
}

// Второй, более грубый защитный уровень — на случай, когда точка пропала
// БЕЗ пробела (например "7.43" -> "743", "2.31" -> "231") и предыдущий приём
// не помогает, потому что делить уже нечего. В отчёте BelTO такие поля
// практически всегда однозначное число с одним-двумя знаками после запятой
// (5-50 для больших единиц измерения) — если распознанное целое попало в
// диапазон 100-999, десятичная точка почти наверняка "потерялась" перед
// последними двумя цифрами.
function recoverLostDecimal(n) {
  if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n < 1000) {
    return n / 100;
  }
  return n;
}

function normalizeChannelLayoutLetters(raw) {
  // OCR/скан нередко путает похожие по начертанию латинские и кириллические
  // буквы ("H" <-> "Н", "N"/"L" и т.п.) — приводим к кириллице, как принято
  // в маркировке БСИ (например "27НН", а не "27HH").
  return raw
    .toUpperCase()
    .replace(/H/g, 'Н')
    .replace(/N/g, 'Н')
    .replace(/L/g, 'Л');
}

function parseBeltoText(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = {};
  const debugMatches = [];

  for (const line of lines) {
    for (const rule of BELTO_LINES) {
      if (!rule.label.test(line)) continue;

      if (rule.kind === 'model') {
        const m = line.match(rule.label);
        if (m && m[1]) {
          // отрезаем возможный "№" в конце строки модели
          result.model = m[1].split(/№/)[0].trim();
          debugMatches.push({ line, keys: ['model'] });
        }
        continue;
      }

      if (rule.kind === 'channel_layout') {
        const m = line.match(rule.label);
        if (m && m[1] && m[2]) {
          result.channel_layout = m[1] + normalizeChannelLayoutLetters(m[2]);
          debugMatches.push({ line, keys: ['channel_layout'], values: [result.channel_layout] });
        }
        continue;
      }

      const nums = extractValuesForRule(line, rule.valuesCount);
      if (nums.length >= rule.valuesCount) {
        // Берём последние N чисел в строке (на случай, если в начале
        // строки случайно попала цифра из названия)
        const vals = nums.slice(nums.length - rule.valuesCount);
        rule.keys.forEach((k, i) => {
          result[k] = vals[i];
        });
        debugMatches.push({ line, keys: rule.keys, values: vals });
      }
    }
  }

  // Защитный второй уровень восстановления потерянной точки — применяем
  // только к полям, где физически ожидаются некрупные дробные значения
  // (расход т/ч, потери давления кПа, поверхность теплообмена м2).
  ['flow_hot', 'flow_cold', 'dp_hot', 'dp_cold', 'heat_surface'].forEach((k) => {
    if (result[k] !== undefined) result[k] = recoverLostDecimal(result[k]);
  });

  // Производные поля для fieldMap.js
  // Температуры вход-выход по контуру — через тире, например "95-70"
  // (формат, принятый в фирменном листе БСИ).
  if (result.t_in_hot !== undefined && result.t_out_hot !== undefined) {
    result.temp_in_hot_out_hot = `${formatNumber(result.t_in_hot, 0)}-${formatNumber(result.t_out_hot, 0)}`;
  }
  if (result.t_in_cold !== undefined && result.t_out_cold !== undefined) {
    result.temp_in_cold_out_cold = `${formatNumber(result.t_in_cold, 0)}-${formatNumber(result.t_out_cold, 0)}`;
  }
  // Температурный график сетевой воды = вход/выход ГРЕЮЩЕЙ среды (не путать
  // с нагреваемой) — например "95/70".
  if (result.t_in_hot !== undefined && result.t_out_hot !== undefined) {
    result.temp_graph = `${formatNumber(result.t_in_hot, 0)}/${formatNumber(result.t_out_hot, 0)}`;
  }
  if (result.dn_hot !== undefined) {
    result.dn = result.dn_hot;
  }
  // Коэффициент теплопередачи в шаблоне — одна ячейка вида "фактический/необходимый"
  if (result.heat_transfer_coef_actual !== undefined && result.heat_transfer_coef_required !== undefined) {
    result.heat_transfer_coef_combined = `${formatNumber(result.heat_transfer_coef_actual, 0)}/${formatNumber(result.heat_transfer_coef_required, 0)}`;
  }
  // Запас по поверхности — с процентом и запятой как десятичным разделителем (рус. формат)
  if (result.surface_margin !== undefined) {
    let sm = result.surface_margin;
    // OCR иногда "съедает" десятичный разделитель (например точку/запятую
    // в "5.26" — она мелкая и сливается с фоном таблицы), и вместо 5.26
    // распознаётся целое "526". Запас по поверхности почти всегда однозначное
    // число с двумя знаками после запятой — если пришло трёхзначное целое,
    // это почти наверняка тот случай, восстанавливаем разделитель.
    sm = recoverLostDecimal(sm);
    result.surface_margin = sm;
    const s = formatNumber(sm, 2);
    if (s) result.surface_margin_pct = s.replace('.', ',') + '%';
  }

  return { values: result, debugMatches };
}
