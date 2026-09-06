/*
 * sheetsLog.js
 * Отправка строки журнала в Google Таблицу через Google Apps Script Web App.
 * Сам скрипт — см. apps-script/Code.gs и README.md.
 *
 * Используем "no-cors" fetch: Apps Script Web App не всегда отдаёт корректные
 * CORS-заголовки для чтения ответа из браузера, но сама запись при этом происходит.
 * Поэтому мы не читаем ответ, а просто фиксируем факт отправки.
 */
async function logToSheet(entry) {
  if (!APPS_SCRIPT_URL) {
    console.info('APPS_SCRIPT_URL не задан — запись в журнал пропущена');
    return { skipped: true };
  }
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(entry),
    });
    return { ok: true };
  } catch (e) {
    console.warn('Не удалось записать в журнал расчётов:', e);
    return { ok: false, error: e };
  }
}
