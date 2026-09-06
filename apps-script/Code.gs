/**
 * Code.gs — принимает POST-запрос от сервиса и добавляет строку
 * в лист "Журнал" привязанной Google Таблицы.
 *
 * УСТАНОВКА (см. подробно README.md):
 * 1. Создайте Google Таблицу, назовите первый лист "Журнал".
 *    В первой строке сделайте заголовки (см. HEADERS ниже).
 * 2. В таблице: Расширения -> Apps Script.
 * 3. Вставьте этот код вместо содержимого Code.gs, сохраните.
 * 4. Деплой -> Новый деплой -> тип "Веб-приложение":
 *      - Выполнять от имени: "Я"
 *      - У кого есть доступ: "Все"
 * 5. Скопируйте URL веб-приложения и вставьте его в js/config.js
 *    как APPS_SCRIPT_URL.
 */

const SHEET_NAME = 'Журнал';
const HEADERS = ['Дата/время', 'Шаблон', 'Формат', 'Марка', 'Заказчик', 'Место установки', 'Номер расчёта', 'Итого цена без НДС'];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = getOrCreateSheet();
    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.template || '',
      data.format || '',
      data.model || '',
      data.customer || '',
      data.site || '',
      data.calc_number || '',
      data.price_total || '',
    ]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}
