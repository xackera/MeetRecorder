// background.js — service worker (Manifest V3)
// Оркестрирует запись: получает streamId вкладки и передаёт его в offscreen-документ,
// где реально работает MediaRecorder (в service worker нет доступа к DOM/MediaRecorder).

const OFFSCREEN_PATH = 'offscreen.html';

let recordingTabId = null;

// --- Управление offscreen-документом ---------------------------------------

async function hasOffscreenDocument() {
  // getContexts доступен в MV3 (Chrome 116+)
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  }
  // Фолбэк для старых версий
  const matchedClients = await clients.matchAll();
  return matchedClients.some((c) => c.url.endsWith(OFFSCREEN_PATH));
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Запись аудио и видео из вкладки через MediaRecorder.'
  });
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// --- Старт / стоп записи ----------------------------------------------------

async function startRecording(includeMic) {
  // Определяем активную вкладку
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Не найдена активная вкладка.');
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
    throw new Error('Нельзя записывать служебные страницы Chrome. Откройте вкладку с Google Meet.');
  }

  await ensureOffscreenDocument();

  // Получаем идентификатор медиапотока для целевой вкладки.
  // Важно: getMediaStreamId вызывается именно здесь (в контексте расширения),
  // а сам поток открывается уже в offscreen по этому streamId.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  recordingTabId = tab.id;

  // Передаём streamId в offscreen-документ
  const response = await chrome.runtime.sendMessage({
    type: 'start-recording',
    target: 'offscreen',
    streamId,
    includeMic: !!includeMic
  });

  if (response && response.error) {
    recordingTabId = null;
    throw new Error(response.error);
  }

  await chrome.storage.local.set({ isRecording: true });
  updateBadge(true);
}

async function stopRecording() {
  await chrome.runtime.sendMessage({
    type: 'stop-recording',
    target: 'offscreen'
  });
}

function updateBadge(isRecording) {
  chrome.action.setBadgeText({ text: isRecording ? 'REC' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

// Скачиваем готовый blob-URL из offscreen. Держим offscreen живым, пока
// загрузка не завершится, иначе blob уничтожится до записи на диск.
async function saveRecording(url, filename) {
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
  } catch (err) {
    console.error('[background] downloads.download не удался:', err);
    await finishRecording();
    throw err;
  }

  // Ждём завершения (или отмены) загрузки, затем чистим.
  await new Promise((resolve) => {
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      const s = delta.state.current;
      if (s === 'complete' || s === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });

  await finishRecording();
}

async function finishRecording() {
  await chrome.storage.local.set({ isRecording: false });
  updateBadge(false);
  recordingTabId = null;
  await closeOffscreenDocument();
}

// --- Обработка сообщений -----------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'popup-start':
          await startRecording(message.includeMic);
          sendResponse({ ok: true });
          break;

        case 'popup-stop':
          await stopRecording();
          sendResponse({ ok: true });
          break;

        case 'popup-status': {
          const { isRecording } = await chrome.storage.local.get('isRecording');
          sendResponse({ isRecording: !!isRecording });
          break;
        }

        // От offscreen: файл готов (blob URL) — скачиваем его здесь,
        // потому что chrome.downloads недоступен в offscreen-документе.
        case 'save-recording':
          await saveRecording(message.url, message.filename);
          sendResponse({ ok: true });
          break;

        // От offscreen: запись остановлена и файл сохранён
        case 'recording-stopped':
          await chrome.storage.local.set({ isRecording: false });
          updateBadge(false);
          recordingTabId = null;
          await closeOffscreenDocument();
          sendResponse({ ok: true });
          break;

        // От offscreen: ошибка во время записи
        case 'recording-error':
          await chrome.storage.local.set({ isRecording: false });
          updateBadge(false);
          recordingTabId = null;
          await closeOffscreenDocument();
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ error: 'Неизвестный тип сообщения: ' + message.type });
      }
    } catch (err) {
      console.error('[background]', err);
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true; // ответ асинхронный
});

// Если пользователь закрыл записываемую вкладку — останавливаем запись
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recordingTabId) {
    stopRecording().catch(() => {});
  }
});
