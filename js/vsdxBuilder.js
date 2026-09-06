/*
 * vsdxBuilder.js
 * Подстановка значений в шаблон .vsdx (это zip-архив с XML внутри,
 * формат OOXML) без использования Visio — правим напрямую
 * visio/pages/page1.xml через JSZip + DOMParser.
 *
 * fillValues: { shapeId: string, unit: {namespace} }
 */

const VISIO_NS = 'http://schemas.microsoft.com/office/visio/2012/main';

async function loadTemplateZip(templateUrl) {
  const resp = await fetch(templateUrl);
  if (!resp.ok) throw new Error(`Не удалось загрузить шаблон: ${templateUrl} (${resp.status})`);
  const buf = await resp.arrayBuffer();
  return JSZip.loadAsync(buf);
}

function findShapeById(doc, shapeId) {
  // Shape элементы могут быть вложены (группы) — ищем по всему документу
  const all = doc.getElementsByTagNameNS(VISIO_NS, 'Shape');
  for (let i = 0; i < all.length; i++) {
    if (all[i].getAttribute('ID') === String(shapeId)) return all[i];
  }
  return null;
}

function setShapeText(doc, shape, value) {
  let textEl = shape.getElementsByTagNameNS(VISIO_NS, 'Text')[0];
  if (!textEl) {
    textEl = doc.createElementNS(VISIO_NS, 'Text');
    shape.appendChild(textEl);
  }
  // Удаляем существующие текстовые узлы, сохраняя элементы форматирования (cp/pp/tp)
  const toRemove = [];
  textEl.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) toRemove.push(n);
  });
  toRemove.forEach((n) => textEl.removeChild(n));
  const textNode = doc.createTextNode(String(value ?? ''));
  textEl.appendChild(textNode);
}

/**
 * @param {string} templateUrl - путь к исходному .vsdx
 * @param {Array<{shapeIds: number[], value: string}>} fills - что и куда писать
 * @returns {Promise<Blob>} готовый .vsdx файл
 */
async function buildVsdx(templateUrl, fills) {
  const zip = await loadTemplateZip(templateUrl);
  const pageFile = zip.file('visio/pages/page1.xml');
  if (!pageFile) throw new Error('В архиве .vsdx не найден visio/pages/page1.xml — структура шаблона отличается от ожидаемой');

  const xmlText = await pageFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const errorNode = doc.querySelector('parsererror');
  if (errorNode) throw new Error('Ошибка разбора XML шаблона: ' + errorNode.textContent);

  const notFound = [];
  for (const fill of fills) {
    if (fill.value === undefined || fill.value === null || fill.value === '') continue;
    for (const shapeId of fill.shapeIds) {
      const shape = findShapeById(doc, shapeId);
      if (!shape) {
        notFound.push(shapeId);
        continue;
      }
      setShapeText(doc, shape, fill.value);
    }
  }

  const serializer = new XMLSerializer();
  const newXml = serializer.serializeToString(doc);
  zip.file('visio/pages/page1.xml', newXml);

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.ms-visio.drawing.main+xml' });
  return { blob, notFound };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
