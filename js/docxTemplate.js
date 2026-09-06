/*
 * docxTemplate.js
 *
 * Заполнение бланка через мастер-шаблон Word (templates/BSI-letterhead-
 * template.docx) — пришло на смену пиксельному оверлею на PDF
 * (js/pdfTemplate.js, js/builtinPdfMapping.js): тот подход держался на
 * допущении, что заводской плейсхолдер в исходном PDF всегда стоит
 * пиксель-в-пиксель на одном месте — на практике разные экспорты/сканы
 * бланка чуть-чуть отличались, и redact-прямоугольник либо промахивался,
 * либо старый текст проступал из-под нового (см. обсуждение в чате).
 *
 * Здесь вместо оверлея — свой собственный Word-документ (templates/BSI-
 * letterhead-template.docx, тот же шрифт/разметка таблицы, что и у
 * настоящего бланка, см. историю чата), с плейсхолдерами {tag} — их
 * заполняет docxtemplater (vendor/docxtemplater.min.js + vendor/pizzip.min.js).
 * Картинка теплообменника ({%diagram_image}) подставляется отдельным
 * образом (docxtemplater-image-module-free) — байты картинки вырезаются
 * на лету из загруженного PDF-бланка через pdf.js (см. cropDiagramFromPdf
 * в app.js), без готовых картинок под каждую модель.
 *
 * Блок "Примечание" ({@certificates_note}) — это RAW XML тег (встроенный
 * в docxtemplater rawxml-модуль, префикс "@", отдельный пакет не нужен):
 * подставляем не обычный текст, а несколько <w:r>...</w:r> с <w:br/> между
 * ними — по одной строке пользовательского текста на разрыв, иначе перевод
 * строки внутри обычного {tag} потерялся бы.
 */

let cachedDocxTemplateBytes = null;
async function getDocxTemplateBytes(file) {
  const key = file || 'templates/BSI-letterhead-template.docx';
  if (!cachedDocxTemplateBytes || cachedDocxTemplateBytes.file !== key) {
    const resp = await fetch(key);
    if (!resp.ok) throw new Error(`Не удалось загрузить Word-шаблон ${key}`);
    cachedDocxTemplateBytes = { file: key, bytes: await resp.arrayBuffer() };
  }
  return cachedDocxTemplateBytes.bytes;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Собирает RAW XML для блока "Примечание": одна строка текста -> один
// <w:r> с текстом, между строками — <w:br/> (перенос строки БЕЗ начала
// нового абзаца — абзац в шаблоне уже один, только он должен остаться
// единственным содержимым, как того требует rawxml-модуль докстемплейтера).
//
// ВАЖНО: rawxml-модуль докстемплейтера подставляет эту строку ВМЕСТО всего
// абзаца {@tag} целиком (включая сам <w:p>), а не только вместо текста
// внутри него — если не обернуть содержимое в свой <w:p>, получившиеся
// <w:r> окажутся прямыми детьми <w:tc> (вне какого-либо абзаца), что
// невалидно по схеме OOXML: Word/LibreOffice такие "осиротевшие" runs
// молча отбрасывают при рендере (именно так пропадал текст блока
// "Примечание" — сырой XML в document.xml был, а в PDF ничего не было).
function buildCertificatesRawXml(text, { fontSize = 7.5, colorHex = '00008C', font = 'Times New Roman' } = {}) {
  const lines = String(text || '').split('\n');
  const szHalfPoints = Math.round(fontSize * 2); // OOXML w:sz — в половинах пункта
  const rPr = `<w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}"/><w:color w:val="${colorHex}"/><w:sz w:val="${szHalfPoints}"/><w:szCs w:val="${szHalfPoints}"/></w:rPr>`;
  const runs = lines
    .map((line) => `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`)
    .join('<w:br/>');
  return `<w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="left"/></w:pPr>${runs}</w:p>`;
}

/**
 * @param {ArrayBuffer} templateBytes - байты мастер-шаблона (.docx)
 * @param {object} values - { tag: string } - обычные текстовые поля
 * @param {string} certificatesNoteText - сырой текст блока "Примечание" (с \n)
 * @param {{bytes: Uint8Array, widthPx: number, heightPx: number}|null} diagramImage -
 *   картинка теплообменника (уже вырезанная в PNG) + её пиксельные размеры;
 *   null — если картинки нет (тег в шаблоне тогда останется пустым/без фото)
 * @returns {Promise<Uint8Array>}
 */
async function fillDocxTemplate(templateBytes, values, certificatesNoteText, diagramImage) {
  if (!diagramImage || !diagramImage.bytes || !diagramImage.bytes.length) {
    throw new Error('Нет картинки теплообменника — сначала загрузите бланк с картинкой (см. шаг 1) или дождитесь автовырезки.');
  }
  const zip = new PizZip(templateBytes);

  // Целевая ширина картинки — вровень с шириной ячейки в шаблоне (538.58pt,
  // см. builtinPdfMapping.js LETTERHEAD_PAGE/константы верстки) переведённая
  // в пиксели при 96 dpi (стандарт OOXML: 1px = 9525 EMU = 1/96 дюйма).
  const TARGET_WIDTH_PT = 530;
  const TARGET_WIDTH_PX = Math.round((TARGET_WIDTH_PT / 72) * 96);

  // ВАЖНО: значение тега {%diagram_image} должно быть чем-то отличным от
  // "object" (docxtemplater-image-module-free трактует объект/массив в
  // значении тега как уже готовый {rId, sizePixel} — то есть считает, что
  // картинка уже вставлена, и падает на sizePixel[0]). Поэтому в данные
  // кладём просто маркер-строку, а сами байты картинки достаём из замыкания
  // (diagramImage) внутри getImage — тело tagValue игнорируем.
  const imageModule = new ImageModule({
    centered: true,
    fileType: 'docx',
    getImage() {
      return diagramImage.bytes;
    },
    getSize() {
      if (!diagramImage.widthPx) return [TARGET_WIDTH_PX, Math.round(TARGET_WIDTH_PX * 0.46)];
      const scale = TARGET_WIDTH_PX / diagramImage.widthPx;
      return [TARGET_WIDTH_PX, Math.round(diagramImage.heightPx * scale)];
    },
  });

  const doc = new docxtemplater(zip, { modules: [imageModule], paragraphLoop: true, linebreaks: false });

  const data = { ...values };
  data.certificates_note = buildCertificatesRawXml(certificatesNoteText);
  data.diagram_image = 'diagram';

  doc.render(data);

  return doc.getZip().generate({ type: 'uint8array', compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function downloadDocxBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
