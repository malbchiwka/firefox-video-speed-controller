(function() {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  let currentSpeed = 1.0;
  let isApplyingOurSpeed = false;

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

  // Настройки звука по умолчанию (Gain не менее 1.0)
  let soundSettings = {
    gain: 1.0,
    pan: 0.0,
    mono: false,
    flip: false
  };

  function setVideoSpeed(video, rate) {
    if (!video) return;
    if (Math.abs(video.playbackRate - rate) > 0.01) {
      isApplyingOurSpeed = true;
      try {
        video.playbackRate = rate;
        video.defaultPlaybackRate = rate;
      } catch (e) {}
      Promise.resolve().then(() => {
        isApplyingOurSpeed = false;
      });
    }
  }

  function applySpeedToAll(rate) {
    function process(node) {
      if (!node) return;
      if (node.tagName === 'VIDEO') {
        setVideoSpeed(node, rate);
      }
      if (node.shadowRoot) {
        node.shadowRoot.querySelectorAll('*').forEach(process);
      }
    }
    document.querySelectorAll('*').forEach(process);
  }

  // ----------------------------------------------------
  // 2. ПРАВЫЙ ALT + КОЛЕСИКО МЫШИ + OSD БЕЙДЖ
  // ----------------------------------------------------
  let isRightAltDown = false;
  let osdTimeout = null;

  window.addEventListener('keydown', (e) => {
    if (e.code === 'AltRight') {
      isRightAltDown = true;
    }
  }, true);

  window.addEventListener('keyup', (e) => {
    if (e.code === 'AltRight') {
      isRightAltDown = false;
    }
  }, true);

  window.addEventListener('blur', () => {
    isRightAltDown = false;
  });

  // Всплывающий OSD бейдж в стиле нашего расширения
  function showOSD(speedText) {
    let osd = document.getElementById('speed-controller-osd');
    if (!osd) {
      osd = document.createElement('div');
      osd.id = 'speed-controller-osd';
      osd.style.cssText = `
        position: fixed !important;
        top: 24px !important;
        right: 24px !important;
        background: rgba(20, 20, 22, 0.88) !important;
        backdrop-filter: blur(20px) !important;
        -webkit-backdrop-filter: blur(20px) !important;
        border: 1px solid rgba(255, 255, 255, 0.22) !important;
        color: #ffffff !important;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Rounded", "Segoe UI", sans-serif !important;
        font-size: 17px !important;
        font-weight: 700 !important;
        letter-spacing: 0.5px !important;
        padding: 6px 18px !important;
        border-radius: 9999px !important;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5) !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
        opacity: 0;
        transform: translateY(-6px) scale(0.95);
      `;
      document.documentElement.appendChild(osd);
    }

    osd.textContent = speedText;
    osd.style.opacity = '1';
    osd.style.transform = 'translateY(0) scale(1)';

    if (osdTimeout) clearTimeout(osdTimeout);
    osdTimeout = setTimeout(() => {
      osd.style.opacity = '0';
      osd.style.transform = 'translateY(-6px) scale(0.95)';
    }, 1100);
  }

  // Перехват колесика мыши с зажатым правым Alt
  window.addEventListener('wheel', (e) => {
    if (isRightAltDown) {
      e.preventDefault();
      e.stopPropagation();

      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      let newSpeed = Math.round((currentSpeed + delta) * 10) / 10;
      if (newSpeed < 1.0) newSpeed = 1.0;
      if (newSpeed > 5.0) newSpeed = 5.0;

      if (Math.abs(newSpeed - currentSpeed) > 0.01) {
        currentSpeed = newSpeed;
        isApplyingOurSpeed = true;
        applySpeedToAll(currentSpeed);
        Promise.resolve().then(() => {
          isApplyingOurSpeed = false;
        });

        let extraInfo = '';
        const mainVid = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (mainVid && !isLiveMedia(mainVid) && isFinite(mainVid.duration) && mainVid.duration > 0) {
          const rem = Math.max(0, (mainVid.duration - mainVid.currentTime) / currentSpeed);
          extraInfo = `  ·  ${formatRemainingDuration(rem)}`;
        }

        showOSD(currentSpeed.toFixed(2) + 'x' + extraInfo);
        setStorage({ speed: currentSpeed });
        updatePageTimeDisplay();
      }
    }
  }, { passive: false, capture: true });

  // ----------------------------------------------------
  // 4. УПРАВЛЕНИЕ ЗВУКОМ (WEB AUDIO API)
  // ----------------------------------------------------
  const mediaAudioPipelines = new WeakMap();

  function getOrCreateAudioPipeline(mediaEl) {
    if (mediaAudioPipelines.has(mediaEl)) {
      return mediaAudioPipelines.get(mediaEl);
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      const ctx = new AudioCtx();

      const source = ctx.createMediaElementSource(mediaEl);
      const gainNode = ctx.createGain();
      const pannerNode = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);

      if (pannerNode) {
        source.connect(gainNode);
        gainNode.connect(pannerNode);
        pannerNode.connect(splitter);
      } else {
        source.connect(gainNode);
        gainNode.connect(splitter);
      }

      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 1, 1);
      merger.connect(ctx.destination);

      const pipeline = {
        ctx,
        source,
        gainNode,
        pannerNode,
        splitter,
        merger,
        mono: false,
        flip: false
      };

      mediaAudioPipelines.set(mediaEl, pipeline);

      const resumeAudio = () => {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
      };

      mediaEl.addEventListener('play', resumeAudio);
      mediaEl.addEventListener('playing', resumeAudio);
      resumeAudio();

      return pipeline;
    } catch (err) {
      return null;
    }
  }

  function applyAudioToElement(mediaEl, settings) {
    const gainVal = Math.max(parseFloat(settings.gain) || 1.0, 1.0);

    if (!mediaAudioPipelines.has(mediaEl) && 
        gainVal === 1.0 && 
        settings.pan === 0.0 && 
        !settings.mono && 
        !settings.flip) {
      return;
    }

    const pipeline = getOrCreateAudioPipeline(mediaEl);
    if (!pipeline) return;

    const { ctx, gainNode, pannerNode, splitter, merger } = pipeline;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    try {
      gainNode.gain.value = gainVal;
    } catch (_) {}

    if (pannerNode) {
      try {
        pannerNode.pan.value = settings.pan;
      } catch (_) {}
    }

    if (pipeline.mono !== settings.mono || pipeline.flip !== settings.flip) {
      try {
        splitter.disconnect();
        merger.disconnect();
        merger.connect(ctx.destination);

        if (settings.mono) {
          splitter.connect(merger, 0, 0);
          splitter.connect(merger, 0, 1);
          splitter.connect(merger, 1, 0);
          splitter.connect(merger, 1, 1);
        } else if (settings.flip) {
          splitter.connect(merger, 0, 1);
          splitter.connect(merger, 1, 0);
        } else {
          splitter.connect(merger, 0, 0);
          splitter.connect(merger, 1, 1);
        }

        pipeline.mono = settings.mono;
        pipeline.flip = settings.flip;
      } catch (e) {}
    }
  }

  function applyAudioSettingsToAll(settings) {
    function process(node) {
      if (!node) return;
      if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
        applyAudioToElement(node, settings);
      }
      if (node.shadowRoot) {
        node.shadowRoot.querySelectorAll('*').forEach(process);
      }
    }
    document.querySelectorAll('*').forEach(process);
  }

  // ----------------------------------------------------
  // 5. ОПРЕДЕЛЕНИЕ РЕКЛАМЫ И ПРЯМЫХ ТРАНСЛЯЦИЙ
  // ----------------------------------------------------
  function isAdActive(video) {
    if (!video) return false;
    const ytPlayer = video.closest('.html5-video-player') || document.querySelector('.html5-video-player, #movie_player');
    if (ytPlayer && (ytPlayer.classList.contains('ad-showing') || ytPlayer.classList.contains('ad-interrupting'))) {
      return true;
    }
    const adOverlay = document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout');
    if (adOverlay && (adOverlay.offsetWidth > 0 || adOverlay.offsetHeight > 0)) {
      return true;
    }
    return false;
  }

  function isLiveMedia(video) {
    if (!video) return false;

    // 1. Стандарт HTML5: бесконечная продолжительность или NaN указывает на стрим
    if (video.duration === Infinity || (!isFinite(video.duration) && video.readyState > 0) || isNaN(video.duration)) {
      return true;
    }

    // Длительность более 24 часов практически гарантированно стрим
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

  // ----------------------------------------------------
  // 6. ПОДСЧЕТ СЭКОНОМЛЕННОГО ВРЕМЕНИ В РЕАЛЬНОМ ВРЕМЕНИ
  // ----------------------------------------------------
  let lastTickTime = Date.now();
  let pendingSavedSeconds = 0;

  setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTickTime) / 1000;
    lastTickTime = now;

    const videos = [];
    function collect(node) {
      if (!node) return;
      if (node.tagName === 'VIDEO') videos.push(node);
      if (node.shadowRoot) node.shadowRoot.querySelectorAll('*').forEach(collect);
    }
    document.querySelectorAll('*').forEach(collect);

    const playingVideo = videos.find(v => !v.paused && !v.ended && v.readyState > 1 && v.playbackRate > 1.0 && !isLiveMedia(v) && !isAdActive(v));
    if (playingVideo && dt > 0 && dt < 5) {
      const saved = dt * (playingVideo.playbackRate - 1.0);
      pendingSavedSeconds += saved;
    }

    if (pendingSavedSeconds >= 0.95) {
      flushSavedTime();
    }
  }, 1000);

  function flushSavedTime() {
    if (pendingSavedSeconds <= 0) return;
    const toAdd = pendingSavedSeconds;
    pendingSavedSeconds = 0;

    getStorage({ totalSecondsSaved: 0 }).then(res => {
      const currentTotal = parseFloat(res.totalSecondsSaved) || 0;
      setStorage({ totalSecondsSaved: currentTotal + toAdd });
    });
  }

  window.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSavedTime();
  });
  window.addEventListener('beforeunload', flushSavedTime);

  // ----------------------------------------------------
  // 6. ИНИЦИАЛИЗАЦИЯ И СЛУШАТЕЛИ STORAGE
  // ----------------------------------------------------
  function initSettings() {
    getStorage({ speed: 1.0, soundSettings: null }).then(res => {
      if (res && res.speed) {
        currentSpeed = parseFloat(res.speed) || 1.0;
        applySpeedToAll(currentSpeed);
      }
      if (res && res.soundSettings) {
        soundSettings = Object.assign({}, soundSettings, res.soundSettings);
        if (soundSettings.gain < 1.0) soundSettings.gain = 1.0;
        applyAudioSettingsToAll(soundSettings);
      }
    });
  }

  initSettings();

  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.speed) {
          const s = parseFloat(changes.speed.newValue) || 1.0;
          if (Math.abs(s - currentSpeed) > 0.01) {
            currentSpeed = s;
            isApplyingOurSpeed = true;
            applySpeedToAll(currentSpeed);
            Promise.resolve().then(() => {
              isApplyingOurSpeed = false;
            });
            updatePageTimeDisplay();
          }
        }
        if (changes.soundSettings) {
          soundSettings = Object.assign({}, soundSettings, changes.soundSettings.newValue);
          if (soundSettings.gain < 1.0) soundSettings.gain = 1.0;
          applyAudioSettingsToAll(soundSettings);
        }
      }
    });
  }

  // Отслеживание перемотки (seeking/seeked) для защиты от сброса скорости плеером
  let lastSeekTime = 0;
  window.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'KeyJ', 'KeyL'].includes(e.code)) {
      lastSeekTime = Date.now();
    }
  }, true);

  ['seeking', 'seeked'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      const v = e.target;
      if (v && v.tagName === 'VIDEO') {
        lastSeekTime = Date.now();
        if (evt === 'seeked') {
          // Сразу после окончания перемотки гарантируем сохранение скорости
          if (!isAdActive(v) && Math.abs(v.playbackRate - currentSpeed) > 0.01) {
            setVideoSpeed(v, currentSpeed);
          }
          setTimeout(() => {
            if (!isAdActive(v) && Math.abs(v.playbackRate - currentSpeed) > 0.01) {
              setVideoSpeed(v, currentSpeed);
            }
          }, 350);
        }
      }
    }, true);
  });

  // Запуск воспроизведения и синхронизация скорости
  ['play', 'playing'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      const v = e.target;
      if (v && v.tagName === 'VIDEO') {
        if (isAdActive(v)) {
          return;
        }
        if (Math.abs(v.playbackRate - currentSpeed) > 0.01) {
          setVideoSpeed(v, currentSpeed);
        }
        applyAudioToElement(v, soundSettings);
      } else if (v && v.tagName === 'AUDIO') {
        applyAudioToElement(v, soundSettings);
      }
    }, true);
  });

  ['loadedmetadata', 'canplay'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      const v = e.target;
      if (v && (v.tagName === 'VIDEO' || v.tagName === 'AUDIO')) {
        if (v.tagName === 'VIDEO') {
          if (isAdActive(v)) return;
          if (Math.abs(v.playbackRate - currentSpeed) > 0.01) {
            setVideoSpeed(v, currentSpeed);
          }
        }
        applyAudioToElement(v, soundSettings);
      }
    }, true);
  });

  // АДАПТАЦИЯ ПОД СКОРОСТЬ ВИДЕО (ДВУСТОРОННЯЯ СИНХРОНИЗАЦИЯ)
  document.addEventListener('ratechange', (e) => {
    if (isApplyingOurSpeed) return;
    const video = e.target;
    if (!video || video.tagName !== 'VIDEO') return;

    // Игнорируем изменения скорости рекламы на YouTube
    if (isAdActive(video)) return;

    // Игнорируем сбросы скорости во время или сразу после перемотки (стрелки влево/вправо, J/L)
    const isSeeking = video.seeking || (Date.now() - lastSeekTime < 700);
    if (isSeeking) {
      if (Math.abs(video.playbackRate - currentSpeed) > 0.01) {
        setVideoSpeed(video, currentSpeed);
      }
      return;
    }

    const newRate = video.playbackRate;
    if (typeof newRate !== 'number' || isNaN(newRate) || !isFinite(newRate) || newRate <= 0) {
      return;
    }

    const roundedRate = Math.round(newRate * 100) / 100;
    const clampedRate = Math.max(1.0, Math.min(5.0, roundedRate));

    if (Math.abs(clampedRate - currentSpeed) > 0.01) {
      currentSpeed = clampedRate;

      // Синхронизируем остальные элементы на странице без зацикливания
      isApplyingOurSpeed = true;
      applySpeedToAll(currentSpeed);
      Promise.resolve().then(() => {
        isApplyingOurSpeed = false;
      });

      // Передаем обновленную скорость в хранилище и попап
      setStorage({ speed: currentSpeed });
      updatePageTimeDisplay();
    }
  }, true);

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'VIDEO') {
            if (!isAdActive(node) && Math.abs(node.playbackRate - currentSpeed) > 0.01) {
              setVideoSpeed(node, currentSpeed);
            }
            applyAudioToElement(node, soundSettings);
          } else if (node.tagName === 'AUDIO') {
            applyAudioToElement(node, soundSettings);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach(v => {
              if (!isAdActive(v) && Math.abs(v.playbackRate - currentSpeed) > 0.01) {
                setVideoSpeed(v, currentSpeed);
              }
              applyAudioToElement(v, soundSettings);
            });
            node.querySelectorAll('audio').forEach(a => {
              applyAudioToElement(a, soundSettings);
            });
          }
        }
      }
    }
  });

  // ----------------------------------------------------
  // 8. ИНДИКАТОР РЕАЛЬНОГО ОСТАВШЕГОСЯ ВРЕМЕНИ (TRUE TIME LEFT)
  // ----------------------------------------------------
  function formatRemainingDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const ss = s.toString().padStart(2, '0');
    if (h > 0) {
      const mm = m.toString().padStart(2, '0');
      return `${h}:${mm}:${ss}`;
    }
    return `${m}:${ss}`;
  }

  function updatePageTimeDisplay() {
    // Для YouTube плеера
    const ytDurationEl = document.querySelector('.ytp-time-duration');
    const ytVideo = document.querySelector('video.html5-main-video') || document.querySelector('video');

    const trueTimeBadge = document.getElementById('speed-yt-true-time');

    // Если это прямая трансляция или реклама, удаляем индикатор времени
    if (!ytVideo || isLiveMedia(ytVideo) || isAdActive(ytVideo)) {
      if (trueTimeBadge) {
        trueTimeBadge.remove();
      }
      return;
    }

    if (ytDurationEl && isFinite(ytVideo.duration) && ytVideo.duration > 0) {
      const currentRate = ytVideo.playbackRate > 0 ? ytVideo.playbackRate : (currentSpeed > 0 ? currentSpeed : 1);
      const remainingSec = Math.max(0, (ytVideo.duration - ytVideo.currentTime) / currentRate);
      let badge = trueTimeBadge;
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'speed-yt-true-time';
        badge.style.cssText = `
          margin-left: 5px;
          opacity: 0.82;
          font-weight: 500;
          font-size: 0.88em;
          color: rgba(255, 255, 255, 0.85);
          letter-spacing: 0.3px;
        `;
        ytDurationEl.parentNode.appendChild(badge);
      }
      badge.textContent = `(⚡ ${formatRemainingDuration(remainingSec)})`;
    }
  }

  setInterval(updatePageTimeDisplay, 1000);

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }
})();
