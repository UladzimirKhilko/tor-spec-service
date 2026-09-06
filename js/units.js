/*
 * units.js
 * Небольшой набор функций конвертации единиц измерения между
 * данными спецификации BelTO и полями фирменного шаблона БСИ.
 * Каждая функция принимает число (или строку с числом, через запятую/точку)
 * и возвращает число в целевых единицах.
 */

function parseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/\s+/g, '').replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  return parseFloat(m[0]);
}

function formatNumber(n, decimals) {
  if (n === null || n === undefined || isNaN(n)) return '';
  const d = decimals === undefined ? 2 : decimals;
  // Обрезаем лишние нули, но сохраняем читаемость
  const fixed = n.toFixed(d);
  return fixed.replace(/\.?0+$/, (match) => (match === '.' ? '' : match)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

const UNIT_CONVERTERS = {
  // 1 кгс/см² = 98.0665 кПа
  kpaToKgfCm2: (v) => {
    const n = parseNumber(v);
    if (n === null) return null;
    return n / 98.0665;
  },
  kgfCm2ToKpa: (v) => {
    const n = parseNumber(v);
    if (n === null) return null;
    return n * 98.0665;
  },
  // бар <-> кгс/см2 практически совпадают (1 бар = 1.0197 кгс/см2), но на всякий случай отдельная функция
  barToKgfCm2: (v) => {
    const n = parseNumber(v);
    if (n === null) return null;
    return n * 1.0197;
  },
  // Гкал/ч <-> кВт (на случай, если источник в кВт)
  gcalPerHourToKw: (v) => {
    const n = parseNumber(v);
    if (n === null) return null;
    return n * 1163;
  },
  kwToGcalPerHour: (v) => {
    const n = parseNumber(v);
    if (n === null) return null;
    return n / 1163;
  },
  identity: (v) => parseNumber(v),
};

function convertValue(value, converterName) {
  if (!converterName) return parseNumber(value);
  const fn = UNIT_CONVERTERS[converterName];
  if (!fn) {
    console.warn('Неизвестный конвертер единиц:', converterName);
    return parseNumber(value);
  }
  return fn(value);
}
