// offscreen.js — здесь реально захватываются потоки и работает MediaRecorder.
// Service worker не имеет доступа к getUserMedia/MediaRecorder, поэтому вся
// «тяжёлая» работа делается в этом скрытом документе.

let recorder = null;
let chunks = [];
let tabStream = null;   // видео + аудио вкладки
let micStream = null;   // микрофон (опционально)
let audioContext = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  (async () => {
    try {
      if (message.type === 'start-recording') {
        await start(message.streamId, message.includeMic);
        sendResponse({ ok: true });
      } else if (message.type === 'stop-recording') {
        stop();
        sendResponse({ ok: true });
      }
    } catch (err) {
      console.error('[offscreen]', err);
      sendResponse({ error: err.message || String(err) });
    }
  })();

  return true; // асинхронный ответ
});

async function start(streamId, includeMic) {
  if (recorder && recorder.state !== 'inactive') {
    throw new Error('Запись уже идёт.');
  }

  // 1. Поток вкладки (видео + аудио) по streamId из tabCapture.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  // 2. Микрофон (по желанию). Разрешение должно быть уже выдано из popup —
  //    offscreen того же origin использует его без повторного запроса.
  if (includeMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
    } catch (err) {
      // Не срываем запись, если микрофон недоступен — пишем без него.
      console.warn('[offscreen] микрофон недоступен, пишем без него:', err);
      micStream = null;
    }
  }

  // 3. Смешиваем аудио вкладки и микрофон в один трек через AudioContext.
  audioContext = new AudioContext();
  // В offscreen нет пользовательского жеста — контекст может быть suspended,
  // тогда звук не пойдёт. Явно возобновляем.
  try { await audioContext.resume(); } catch {}
  const mixDestination = audioContext.createMediaStreamDestination();

  const tabAudio = audioContext.createMediaStreamSource(tabStream);
  tabAudio.connect(mixDestination);         // -> в запись
  tabAudio.connect(audioContext.destination); // -> обратно в динамики (чтобы слышать встречу)

  if (micStream && micStream.getAudioTracks().length) {
    const micAudio = audioContext.createMediaStreamSource(micStream);
    micAudio.connect(mixDestination);       // -> только в запись (без возврата в динамики: иначе эхо)
  }

  // 4. Итоговый поток: видео вкладки + смешанный аудиотрек.
  const combined = new MediaStream();
  tabStream.getVideoTracks().forEach((t) => combined.addTrack(t));
  mixDestination.stream.getAudioTracks().forEach((t) => combined.addTrack(t));

  chunks = [];
  const mimeType = pickMimeType();
  recorder = new MediaRecorder(combined, {
    mimeType,
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 128_000
  });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      // Останавливаем дорожки, но НЕ закрываем offscreen и НЕ отзываем URL:
      // blob должен жить, пока background не скачает файл на диск.
      stopMedia();
      chrome.runtime.sendMessage({
        type: 'save-recording',
        target: 'background',
        url,
        filename: makeName()
      });
    } catch (err) {
      console.error('[offscreen] не удалось подготовить файл', err);
      chrome.runtime.sendMessage({ type: 'recording-error', error: err.message || String(err) });
    }
  };

  // Если поток вкладки прервётся (вкладка закрыта) — корректно останавливаем.
  tabStream.getVideoTracks()[0]?.addEventListener('ended', () => stop());

  recorder.start(1000); // чанк раз в секунду — устойчивость к сбоям
}

function stop() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}

// Останавливаем медиапотоки и аудио-контекст. Blob/URL при этом НЕ трогаем —
// они нужны background для скачивания.
function stopMedia() {
  [tabStream, micStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  tabStream = null;
  micStream = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  recorder = null;
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

function makeName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `google-meet-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.webm`
  );
}
