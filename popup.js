// popup.js — интерфейс кнопок. Всю работу делает background/offscreen.

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const errorEl = document.getElementById('error');
const micToggle = document.getElementById('micToggle');

// Проверяем текущее состояние разрешения на микрофон для origin расширения.
// Возвращает 'granted' | 'prompt' | 'denied' | 'unknown'.
async function getMicPermissionState() {
  try {
    const res = await navigator.permissions.query({ name: 'microphone' });
    return res.state;
  } catch {
    return 'unknown';
  }
}

// Открываем отдельную вкладку расширения, где запрос разрешения показывается
// надёжно (в popup он отменяется из-за потери фокуса — там ничего не спрашивает).
async function openMicPermissionTab() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

function setUI(isRecording) {
  startBtn.style.display = isRecording ? 'none' : 'block';
  stopBtn.style.display = isRecording ? 'block' : 'none';
  statusDot.classList.toggle('rec', isRecording);
  statusText.textContent = isRecording ? 'Идёт запись…' : 'Готов к записи';
}

function showError(msg) {
  errorEl.textContent = msg || '';
}

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'popup-status' });
  setUI(res && res.isRecording);
}

startBtn.addEventListener('click', async () => {
  showError('');
  startBtn.disabled = true;
  const includeMic = micToggle.checked;
  try {
    // Если нужен микрофон, но разрешение ещё не выдано — открываем вкладку
    // разрешения и НЕ начинаем запись (чтобы вкладка Meet осталась активной
    // для захвата). Пользователь разрешает и жмёт «Начать запись» ещё раз.
    if (includeMic) {
      const state = await getMicPermissionState();
      if (state !== 'granted') {
        await openMicPermissionTab();
        showError('Разрешите доступ к микрофону в открывшейся вкладке, вернитесь на Meet и снова нажмите «Начать запись».');
        startBtn.disabled = false;
        return;
      }
    }

    const res = await chrome.runtime.sendMessage({ type: 'popup-start', includeMic });
    if (res && res.error) {
      showError(res.error);
    } else {
      setUI(true);
      // Закрываем popup, чтобы не мешать — запись продолжится в фоне
      window.close();
    }
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  showError('');
  stopBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'popup-stop' });
    if (res && res.error) showError(res.error);
    else setUI(false);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    stopBtn.disabled = false;
  }
});

refreshStatus();
