const api = typeof browser !== 'undefined' ? browser : chrome;

// Безопасные универсальные хелперы для storage (поддержка промисов и коллбэков)
function getStorage(keysWithDefaults) {
  return new Promise((resolve) => {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
        const p = browser.storage.local.get(keysWithDefaults);
        if (p && typeof p.then === 'function') {
          p.then(resolve).catch(() => resolve(keysWithDefaults));
          return;
        }
      }
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(keysWithDefaults, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(keysWithDefaults);
          } else {
            resolve(res || keysWithDefaults);
          }
        });
        return;
      }
      resolve(keysWithDefaults);
    } catch (_) {
      resolve(keysWithDefaults);
    }
  });
}

function setStorage(data) {
  return new Promise((resolve) => {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
        const p = browser.storage.local.set(data);
        if (p && typeof p.then === 'function') {
          p.then(resolve).catch(() => resolve());
          return;
        }
      }
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(data, () => resolve());
        return;
      }
      resolve();
    } catch (_) {
      resolve();
    }
  });
}

// Элементы навигации
const screensTrack = document.getElementById('screensTrack');
const tabLabel = document.getElementById('tabLabel');
const tabJumpBtn = document.getElementById('tabJumpBtn');
const tabJumpTitle = document.getElementById('tabJumpTitle');

// Элементы экрана Скорости
const speedSlider = document.getElementById('speedSlider');
const speedDisplay = document.getElementById('speedDisplay');
const presetButtons = document.querySelectorAll('.preset-btn');
const timeStatsRow = document.getElementById('timeStatsRow');
const timeSavedBlock = document.getElementById('timeSavedBlock');
const timeSavedVal = document.getElementById('timeSavedVal');
const timeRemainingBlock = document.getElementById('timeRemainingBlock');
const timeRemainingVal = document.getElementById('timeRemainingVal');
const statDivider = document.getElementById('statDivider');

// Элементы экрана Звука
const gainSlider = document.getElementById('gainSlider');
const gainDisplay = document.getElementById('gainDisplay');
const panSlider = document.getElementById('panSlider');
const panDisplay = document.getElementById('panDisplay');
const monoBtn = document.getElementById('monoBtn');
const flipBtn = document.getElementById('flipBtn');

let targetTabId = null;
let targetWindowId = null;
let currentScreen = 'speed'; // 'speed' | 'sound'

// Переменные для живого таймера сэкономленного времени
let currentTotalSecondsSaved = 0;
let isVideoCurrentlyPlaying = false;
let isCurrentTabLive = false;
let currentPlayingRate = 1.0;
let actualVideoPlaybackRate = 1.0;

// Переменные для расчета реального оставшегося времени
let targetVideoDuration = 0;
let targetVideoCurrentTime = 0;

// Текущие настройки звука (Gain не менее 1.0)
let soundSettings = {
  gain: 1.0,
  pan: 0.0,
  mono: false,
  flip: false
};

// ----------------------------------------------------
// НАВИГАЦИЯ МЕЖДУ ЭКРАНАМИ И ЗАПОМИНАНИЕ ВКЛАДКИ
// ----------------------------------------------------
function setScreen(screenName, save = true) {
  currentScreen = screenName;
  if (currentScreen === 'sound') {
    screensTrack.classList.add('show-sound');
    tabLabel.textContent = 'Медиа:';
  } else {
    screensTrack.classList.remove('show-sound');
    tabLabel.textContent = 'Ускоряется:';
  }

  if (save) {
    api.storage.local.set({ lastScreen: currentScreen }).catch(() => {});
  }
}

// ----------------------------------------------------
// ПОЭТАПНЫЙ ПЕРЕЛИСТ ВКЛАДОК КОЛЕСИКОМ МЫШИ
// ----------------------------------------------------
let isWheelBlocked = false;

window.addEventListener('wheel', (e) => {
  // Не переключаем экран во время активного перетаскивания ползунка
  if (e.buttons > 0) return;

  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (Math.abs(delta) < 15) return;

  if (isWheelBlocked) return;

  if (delta > 0 && currentScreen !== 'sound') {
    // Прокрутка вниз / вправо -> переход к экрану Звук
    setScreen('sound', true);
    isWheelBlocked = true;
    setTimeout(() => { isWheelBlocked = false; }, 260);
  } else if (delta < 0 && currentScreen !== 'speed') {
    // Прокрутка вверх / влево -> переход к экрану Скорость
    setScreen('speed', true);
    isWheelBlocked = true;
    setTimeout(() => { isWheelBlocked = false; }, 260);
  }
}, { passive: true });

// ----------------------------------------------------
// СЧЕТЧИК СЭКОНОМЛЕННОГО И ОСТАВШЕГОСЯ ВРЕМЕНИ
// ----------------------------------------------------
function formatTimeSaved(totalSec) {
  const sec = Math.floor(Math.max(0, totalSec || 0));
  const s = sec % 60;
  const totalMin = Math.floor(sec / 60);
  const m = totalMin % 60;
  const totalHours = Math.floor(totalMin / 60);
  const h = totalHours % 24;
  const d = Math.floor(totalHours / 24);

  if (d > 0) {
    return `${d}д ${h}ч ${m}м ${s}с`;
  } else if (h > 0) {
    return `${h}ч ${m}м ${s}с`;
  } else if (m > 0) {
    return `${m}м ${s}с`;
  } else {
    return `${s}с`;
  }
}

function updateTimeSavedUI(seconds) {
  if (timeSavedVal) {
    timeSavedVal.textContent = formatTimeSaved(seconds);
  }
}

function formatRemainingTime(totalSec) {
  const sec = Math.floor(Math.max(0, totalSec || 0));
  const s = sec % 60;
  const totalMin = Math.floor(sec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  if (h > 0) {
    return `${h}ч ${m}м`;
  } else if (m > 0) {
    return `${m}м ${s}с`;
  } else {
    return `${s}с`;
  }
}

function updateTimeRemainingUI(seconds) {
  if (!timeRemainingBlock || !timeRemainingVal || !statDivider) return;
  if (isCurrentTabLive) {
    timeRemainingBlock.style.display = 'none';
    statDivider.style.display = 'none';
    return;
  }
  timeRemainingVal.textContent = formatRemainingTime(seconds);
  timeRemainingBlock.style.display = 'flex';
  statDivider.style.display = 'inline';
}

function calculateAndDisplayRemaining() {
  if (isCurrentTabLive) {
    if (timeStatsRow) timeStatsRow.style.display = 'none';
    updateTimeRemainingUI(0);
    return;
  }

  // На обычном видео блок времени отображается ВСЕГДА (как при воспроизведении, так и на паузе)
  if (targetTabId !== null) {
    if (timeStatsRow) timeStatsRow.style.display = 'flex';
    if (targetVideoDuration > 0 && isFinite(targetVideoDuration)) {
      const rate = actualVideoPlaybackRate > 0 ? actualVideoPlaybackRate : (currentPlayingRate > 0 ? currentPlayingRate : 1.0);
      const remaining = Math.max(0, (targetVideoDuration - targetVideoCurrentTime) / rate);
      updateTimeRemainingUI(remaining);
    } else {
      updateTimeRemainingUI(0);
    }
  } else {
    // Вкладка без медиа: показываем общее сэкономленное время, скрывая оставшееся
    if (timeStatsRow) timeStatsRow.style.display = 'flex';
    if (timeRemainingBlock) timeRemainingBlock.style.display = 'none';
    if (statDivider) statDivider.style.display = 'none';
  }
}

// Универсальная функция инспекции состояния видео в контексте веб-страницы
function inspectVideoState() {
  function checkLive(video) {
    if (!video) return false;
    // 1. Стандарт HTML5: бесконечная продолжительность или NaN указывает на стрим
    if (video.duration === Infinity || (!isFinite(video.duration) && video.readyState > 0) || isNaN(video.duration)) {
      return true;
    }
    // Длительность более 24 часов - практически гарантированно стрим
    if (video.duration > 86400) {
      return true;
    }
    // 2. YouTube
    // На YouTube класс 'ytp-live' или 'ytp-live-broadcast' добавляется к плееру ТОЛЬКО на трансляциях.
    const ytPlayer = video.closest('.html5-video-player') || document.querySelector('.html5-video-player, #movie_player');
    if (ytPlayer && (ytPlayer.classList.contains('ytp-live') || ytPlayer.classList.contains('ytp-live-broadcast'))) {
      return true;
    }

    // Мета-тег прямого эфира YouTube (строго content="True", так как на обычных видео content="False")
    if (document.querySelector('meta[itemprop="isLiveBroadcast"][content="True"]')) {
      return true;
    }

    // Атрибут на watch-контейнере YouTube
    if (document.querySelector('ytd-watch-flexy[is-live], ytd-watch-grid[is-live]')) {
      return true;
    }

    // Прямой URL трансляции YouTube
    if (window.location && window.location.pathname && window.location.pathname.startsWith('/live/')) {
      return true;
    }

    // 3. Twitch: бейдж прямого эфира или URL канала
    const twitchPlayer = video.closest('[data-a-target="video-player"], .video-player');
    if (twitchPlayer) {
      const twitchLive = twitchPlayer.querySelector('[data-a-target="live-indicator"], [data-a-target="player-live-badge"], .live-indicator');
      if (twitchLive && (twitchLive.offsetWidth > 0 || twitchLive.offsetHeight > 0)) return true;
    } else if (window.location && window.location.hostname && window.location.hostname.includes('twitch.tv')) {
      const path = window.location.pathname || '';
      if (!path.startsWith('/videos/') && !path.includes('/clip/') && path.length > 1 && video.duration === Infinity) {
        return true;
      }
    }

    // 4. VK / VK Video: видимый индикатор прямого эфира
    const vkLive = document.querySelector('.videoplayer_live, .videoplayer-live, [data-live="1"], [data-is-live="true"], [class*="live_label"], [class*="LiveBadge"]');
    if (vkLive && (vkLive.offsetWidth > 0 || vkLive.offsetHeight > 0)) {
      return true;
    }

    // 5. Rutube: видимая плашка прямого эфира
    const rutubeLive = document.querySelector('.live-badge, [class*="LiveBadge"], [class*="live-stream"], [class*="live_badge"]');
    if (rutubeLive && (rutubeLive.offsetWidth > 0 || rutubeLive.offsetHeight > 0)) {
      return true;
    }

    // 6. Kick: видимый бейдж прямого эфира
    const kickLive = document.querySelector('.channel-live-tag, [data-chat-live="true"]');
    if (kickLive && (kickLive.offsetWidth > 0 || kickLive.offsetHeight > 0)) {
      return true;
    }

    return false;
  }

  const videos = [];
  function collect(node) {
    if (!node) return;
    if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') videos.push(node);
    if (node.shadowRoot) node.shadowRoot.querySelectorAll('*').forEach(collect);
  }
  document.querySelectorAll('*').forEach(collect);

  const ytMain = document.querySelector('video.html5-main-video');
  const playingVideo = videos.find(v => !v.paused && !v.ended && v.readyState > 1);
  const targetVid = (ytMain && (!ytMain.paused || !playingVideo)) ? ytMain : (playingVideo || ytMain || videos[0]);

  if (!targetVid) {
    return { isPlaying: false, hasVideo: false, playbackRate: 1.0, currentTime: 0, duration: 0, isLive: false };
  }

  const isLive = checkLive(targetVid);
  const duration = (!isLive && isFinite(targetVid.duration) && targetVid.duration > 0) ? targetVid.duration : 0;
  const currentTime = targetVid.currentTime || 0;
  const playbackRate = targetVid.playbackRate || 1.0;
  const isPlaying = !targetVid.paused && !targetVid.ended && targetVid.readyState > 1;
  const isSeeking = !!targetVid.seeking;

  return { isPlaying, hasVideo: true, duration, currentTime, playbackRate, isLive, isSeeking };
}

async function syncActiveVideoState() {
  if (!targetTabId) return;
  try {
    const results = await api.scripting.executeScript({
      target: { tabId: targetTabId, allFrames: true },
      func: inspectVideoState
    });

    if (results && results.length > 0) {
      const activeRes = results.find(r => r.result && r.result.isPlaying) || results.find(r => r.result && r.result.hasVideo);
      if (activeRes && activeRes.result && activeRes.result.hasVideo) {
        const res = activeRes.result;
        isVideoCurrentlyPlaying = !!res.isPlaying;
        isCurrentTabLive = !!res.isLive;

        if (res.playbackRate && res.playbackRate >= 1.0 && !res.isSeeking) {
          actualVideoPlaybackRate = res.playbackRate;
          // Синхронизируем UI расширения с реальной скоростью видео на странице (адаптация на лету)
          if (Math.abs(actualVideoPlaybackRate - currentPlayingRate) > 0.01) {
            updateSpeedUI(actualVideoPlaybackRate);
            try {
              api.storage.local.set({ speed: actualVideoPlaybackRate });
            } catch (_) {}
          }
        }

        if (!isCurrentTabLive) {
          if (res.duration > 0) {
            targetVideoDuration = res.duration;
          }
          targetVideoCurrentTime = res.currentTime;
        } else {
          targetVideoDuration = 0;
          targetVideoCurrentTime = 0;
        }
      } else {
        isVideoCurrentlyPlaying = false;
        isCurrentTabLive = false;
      }
    }
    calculateAndDisplayRemaining();
  } catch (_) {}
}

setInterval(() => {
  // Прибавляем сэкономленное время ТОЛЬКО если это не трансляция, видео реально играет и реальная скорость > 1.0x!
  if (!isCurrentTabLive && isVideoCurrentlyPlaying && actualVideoPlaybackRate > 1.0) {
    currentTotalSecondsSaved += (actualVideoPlaybackRate - 1.0);
    updateTimeSavedUI(currentTotalSecondsSaved);
  }

  if (!isCurrentTabLive && isVideoCurrentlyPlaying && targetVideoDuration > 0) {
    targetVideoCurrentTime += actualVideoPlaybackRate;
    calculateAndDisplayRemaining();
  }

  syncActiveVideoState();
}, 1000);

// ----------------------------------------------------
// УПРАВЛЕНИЕ СКОРОСТЬЮ
// ----------------------------------------------------
function updateSpeedUI(speed) {
  let numericSpeed = parseFloat(speed);
  if (isNaN(numericSpeed) || numericSpeed < 0.1) {
    numericSpeed = 1.0;
  }

  currentPlayingRate = numericSpeed;
  const formatted = numericSpeed.toFixed(2) + 'x';
  const sliderVal = Math.min(Math.max(numericSpeed, 1.0), 5.0);
  speedSlider.value = sliderVal;

  const badgeText = speedDisplay.querySelector('.badge-text');
  if (badgeText) {
    badgeText.textContent = formatted;
  } else {
    speedDisplay.textContent = formatted;
  }

  const min = 1.0;
  const max = 5.0;
  const percent = Math.min(Math.max(((sliderVal - min) / (max - min)) * 100, 0), 100);
  speedSlider.style.background = `linear-gradient(to right, #ffffff 0%, #ffffff ${percent}%, rgba(255, 255, 255, 0.14) ${percent}%, rgba(255, 255, 255, 0.14) 100%)`;

  presetButtons.forEach(btn => {
    const btnSpeed = parseFloat(btn.dataset.speed);
    if (Math.abs(btnSpeed - numericSpeed) < 0.01) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

async function applySpeed(speed) {
  let numericSpeed = parseFloat(speed);
  if (isNaN(numericSpeed) || numericSpeed < 1.0) {
    numericSpeed = 1.0;
  }

  updateSpeedUI(numericSpeed);
  calculateAndDisplayRemaining();

  try {
    await api.storage.local.set({ speed: numericSpeed });
  } catch (e) {}

  try {
    const allTabs = await api.tabs.query({});
    for (const tab of allTabs) {
      if (!tab.id || !tab.url) continue;
      if (tab.url.startsWith('about:') || tab.url.startsWith('moz-extension:') || tab.url.startsWith('chrome:')) continue;

      api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (rate) => {
          function apply(node) {
            if (!node) return;
            if (node.tagName === 'VIDEO') {
              try {
                if (Math.abs(node.playbackRate - rate) > 0.01) {
                  node.playbackRate = rate;
                  node.defaultPlaybackRate = rate;
                }
              } catch (_) {}
            }
            if (node.shadowRoot) {
              node.shadowRoot.querySelectorAll('*').forEach(apply);
            }
          }
          document.querySelectorAll('*').forEach(apply);
        },
        args: [numericSpeed]
      }).catch(() => {});
    }
  } catch (_) {}
}

// ----------------------------------------------------
// УПРАВЛЕНИЕ ЗВУКОМ (ПОЛНОСТЬЮ НА РУССКОМ)
// ----------------------------------------------------
function updateSoundUI() {
  let gainVal = parseFloat(soundSettings.gain);
  if (isNaN(gainVal) || gainVal < 1.0) {
    gainVal = 1.0;
    soundSettings.gain = 1.0;
  }
  gainSlider.value = gainVal;
  gainDisplay.textContent = gainVal.toFixed(1) + 'x';
  const gainMin = 1.0;
  const gainMax = 5.0;
  const gainPercent = Math.min(Math.max(((gainVal - gainMin) / (gainMax - gainMin)) * 100, 0), 100);
  gainSlider.style.background = `linear-gradient(to right, #ffffff 0%, #ffffff ${gainPercent}%, rgba(255, 255, 255, 0.14) ${gainPercent}%, rgba(255, 255, 255, 0.14) 100%)`;

  const panVal = parseFloat(soundSettings.pan) || 0.0;
  panSlider.value = panVal;
  if (panVal === 0) {
    panDisplay.textContent = '0';
  } else if (panVal < 0) {
    panDisplay.textContent = `Л ${Math.abs(panVal).toFixed(1)}`;
  } else {
    panDisplay.textContent = `П ${panVal.toFixed(1)}`;
  }
  const panPercent = ((panVal + 1.0) / 2.0) * 100;
  panSlider.style.background = `linear-gradient(to right, #ffffff 0%, #ffffff ${panPercent}%, rgba(255, 255, 255, 0.14) ${panPercent}%, rgba(255, 255, 255, 0.14) 100%)`;

  if (soundSettings.mono) {
    monoBtn.classList.add('active');
  } else {
    monoBtn.classList.remove('active');
  }

  if (soundSettings.flip) {
    flipBtn.classList.add('active');
  } else {
    flipBtn.classList.remove('active');
  }
}

async function applySound() {
  updateSoundUI();

  try {
    await api.storage.local.set({ soundSettings });
  } catch (e) {}
}

gainSlider.addEventListener('input', (e) => {
  let val = parseFloat(e.target.value);
  if (isNaN(val) || val < 1.0) val = 1.0;
  soundSettings.gain = val;
  applySound();
});

panSlider.addEventListener('input', (e) => {
  soundSettings.pan = parseFloat(e.target.value);
  applySound();
});

monoBtn.addEventListener('click', () => {
  soundSettings.mono = !soundSettings.mono;
  applySound();
});

flipBtn.addEventListener('click', () => {
  soundSettings.flip = !soundSettings.flip;
  applySound();
});

// ----------------------------------------------------
// ПОИСК ВКЛАДКИ С ВИДЕО
// ----------------------------------------------------
async function detectVideoTab() {
  tabJumpTitle.textContent = 'Поиск...';
  tabJumpBtn.disabled = true;

  try {
    // 1. Приоритет АКТИВНОЙ вкладке в текущем окне (где сейчас находится пользователь)
    const activeTabs = await api.tabs.query({ active: true, currentWindow: true });
    let activeTabWithVideo = null;
    let activeTabResult = null;

    if (activeTabs.length > 0 && activeTabs[0].id) {
      const tab = activeTabs[0];
      if (tab.url && !tab.url.startsWith('about:') && !tab.url.startsWith('moz-extension:') && !tab.url.startsWith('chrome:')) {
        try {
          const results = await api.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: inspectVideoState
          });
          if (results && results.length > 0) {
            const res = results.find(r => r.result && r.result.isPlaying) || results.find(r => r.result && r.result.hasVideo);
            if (res && res.result && res.result.hasVideo) {
              activeTabWithVideo = tab;
              activeTabResult = res.result;
            }
          }
        } catch (_) {}
      }
    }

    let target = activeTabWithVideo;
    let targetRes = activeTabResult;

    // 2. Если в активной вкладке НЕТ видео — ищем по остальным вкладкам браузера
    if (!target) {
      const allTabs = await api.tabs.query({});
      let foundPlayingTab = null;
      let foundPlayingRes = null;
      let foundAnyVideoTab = null;
      let foundAnyVideoRes = null;

      for (const tab of allTabs) {
        if (!tab.id || !tab.url) continue;
        if (activeTabs.length > 0 && tab.id === activeTabs[0].id) continue;
        if (tab.url.startsWith('about:') || tab.url.startsWith('moz-extension:') || tab.url.startsWith('chrome:')) continue;

        try {
          const results = await api.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: inspectVideoState
          });

          if (results && results.length > 0) {
            const playing = results.find(r => r.result && r.result.isPlaying);
            const anyVid = results.find(r => r.result && r.result.hasVideo);

            if (playing && playing.result) {
              foundPlayingTab = tab;
              foundPlayingRes = playing.result;
              break;
            } else if (anyVid && anyVid.result && !foundAnyVideoTab) {
              foundAnyVideoTab = tab;
              foundAnyVideoRes = anyVid.result;
            }
          }
        } catch (_) {}
      }

      target = foundPlayingTab || foundAnyVideoTab;
      targetRes = foundPlayingRes || foundAnyVideoRes;
    }

    if (target && targetRes) {
      targetTabId = target.id;
      targetWindowId = target.windowId;

      const title = target.title || 'Вкладка с медиа';
      tabJumpTitle.textContent = title;
      tabJumpBtn.disabled = false;

      isVideoCurrentlyPlaying = !!targetRes.isPlaying;
      isCurrentTabLive = !!targetRes.isLive;

      if (targetRes.playbackRate && targetRes.playbackRate >= 1.0 && !targetRes.isSeeking) {
        actualVideoPlaybackRate = targetRes.playbackRate;
        if (Math.abs(actualVideoPlaybackRate - currentPlayingRate) > 0.01) {
          updateSpeedUI(actualVideoPlaybackRate);
          try {
            api.storage.local.set({ speed: actualVideoPlaybackRate });
          } catch (_) {}
        }
      }

      if (!isCurrentTabLive) {
        targetVideoDuration = targetRes.duration || 0;
        targetVideoCurrentTime = targetRes.currentTime || 0;
      } else {
        targetVideoDuration = 0;
        targetVideoCurrentTime = 0;
      }
    } else {
      targetTabId = null;
      targetWindowId = null;
      tabJumpTitle.textContent = 'нет медиа';
      tabJumpBtn.disabled = true;
      isVideoCurrentlyPlaying = false;
      isCurrentTabLive = false;
      actualVideoPlaybackRate = 1.0;
      targetVideoDuration = 0;
      targetVideoCurrentTime = 0;
    }
    calculateAndDisplayRemaining();
  } catch (err) {
    targetTabId = null;
    targetWindowId = null;
    tabJumpTitle.textContent = 'нет медиа';
    tabJumpBtn.disabled = true;
    isVideoCurrentlyPlaying = false;
    isCurrentTabLive = false;
    actualVideoPlaybackRate = 1.0;
    targetVideoDuration = 0;
    targetVideoCurrentTime = 0;
    calculateAndDisplayRemaining();
  }
}

tabJumpBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  if (targetTabId !== null) {
    try {
      await api.tabs.update(targetTabId, { active: true });
      if (targetWindowId !== null) {
        await api.windows.update(targetWindowId, { focused: true });
      }
      window.close();
    } catch (err) {}
  }
});

// ----------------------------------------------------
// ИНИЦИАЛИЗАЦИЯ И ВОССТАНОВЛЕНИЕ ПОСЛЕДНЕГО ЭКРАНА
// ----------------------------------------------------
async function init() {
  try {
    const res = await api.storage.local.get({ 
      speed: 1.0, 
      soundSettings: null, 
      lastScreen: 'speed',
      totalSecondsSaved: 0
    });

    let currentSpeed = parseFloat(res.speed) || 1.0;
    if (currentSpeed < 1.0) currentSpeed = 1.0;
    updateSpeedUI(currentSpeed);

    if (res.soundSettings) {
      soundSettings = Object.assign({}, soundSettings, res.soundSettings);
      if (soundSettings.gain < 1.0) soundSettings.gain = 1.0;
    }
    updateSoundUI();

    currentTotalSecondsSaved = parseFloat(res.totalSecondsSaved) || 0;
    updateTimeSavedUI(currentTotalSecondsSaved);

    if (res.lastScreen === 'sound') {
      setScreen('sound', false);
    } else {
      setScreen('speed', false);
    }
  } catch (err) {
    updateSpeedUI(1.0);
    updateSoundUI();
    setScreen('speed', false);
  }

  detectVideoTab();
}

if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.totalSecondsSaved) {
        const persistedTotal = parseFloat(changes.totalSecondsSaved.newValue) || 0;
        if (Math.abs(persistedTotal - currentTotalSecondsSaved) > 0.5) {
          currentTotalSecondsSaved = persistedTotal;
          updateTimeSavedUI(currentTotalSecondsSaved);
        }
      }
      if (changes.speed) {
        const newSpeed = parseFloat(changes.speed.newValue) || 1.0;
        if (Math.abs(newSpeed - currentPlayingRate) > 0.01) {
          updateSpeedUI(newSpeed);
          calculateAndDisplayRemaining();
        }
      }
    }
  });
}

speedSlider.addEventListener('input', (e) => {
  applySpeed(e.target.value);
});

presetButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    applySpeed(btn.dataset.speed);
  });
});

init();
