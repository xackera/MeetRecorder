// permission.js — запрашивает доступ к микрофону на обычной вкладке расширения.
// В отличие от popup, здесь системный запрос показывается надёжно и не
// отменяется из-за потери фокуса. Разрешение выдаётся для origin расширения
// и затем действует в offscreen-документе, где идёт запись.

const askBtn = document.getElementById('askBtn');
const statusEl = document.getElementById('status');
const nextEl = document.getElementById('next');

async function requestMic() {
  statusEl.textContent = 'Запрашиваем доступ…';
  statusEl.className = 'status';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Разрешение получено — сам захват сделает offscreen во время записи.
    stream.getTracks().forEach((t) => t.stop());

    statusEl.textContent = 'Доступ к микрофону разрешён.';
    statusEl.className = 'status ok';
    nextEl.style.display = 'block';
    askBtn.style.display = 'none';
  } catch (err) {
    console.error('[permission]', err);
    statusEl.className = 'status err';
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      statusEl.textContent =
        'Доступ отклонён. Нажмите на значок 🔒/⚙ слева от адреса этой ' +
        'страницы → «Микрофон» → «Разрешить», затем повторите.';
    } else if (err.name === 'NotFoundError') {
      statusEl.textContent = 'Микрофон не найден. Проверьте, что он подключён.';
    } else {
      statusEl.textContent = 'Ошибка: ' + (err.message || err.name);
    }
  }
}

askBtn.addEventListener('click', requestMic);

// Пробуем сразу при открытии — чаще всего запрос появляется автоматически.
requestMic();
