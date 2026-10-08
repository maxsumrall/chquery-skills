// Caption timing matches the checked-in public demo. Keep the coordinator's
// static .example-transcript visible: no evidence depends on watching pixels.
const captions = [
  'Overview: 52 plan operators, grouped into 34 stages in the analysis workspace. Connections show dependencies, not measured work.',
  'Repeated reads: seven separate ReadFromMergeTree operators refer to default.actors. Each plan read selects 4/4 granules; this is not measured runtime work.',
  'Evidence: the table-wide estimate is 235,753 rows, 7 parts and 28 marks. Per-read row counts and runtime are unknown. No speedup is measured.'
];

export function initExamplePreview() {
  const section = document.getElementById('examplePreview');
  const video = document.getElementById('exampleVideo');
  const poster = document.getElementById('examplePoster');
  const playback = document.getElementById('examplePlayback');
  const replay = document.getElementById('exampleReplay');
  const status = document.getElementById('exampleMediaStatus');
  const caption = document.getElementById('exampleCaption');
  if (![section, video, poster, playback, replay, status, caption].every(Boolean)) return;

  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = window.matchMedia('(max-width: 760px)');
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  let userPaused = false;
  let optedIn = false;
  let blocked = false;
  // NETWORK_NO_SOURCE (3) also covers sources exhausted before module init.
  let failed = Boolean(video.error) || video.networkState === 3;
  let inViewport = !('IntersectionObserver' in window);
  let starting = false;
  let destroyed = false;
  let hasFrame = false;
  let variant = '';
  let changingMedia = false;
  let lastTime = 0;
  let generation = 0;
  const listeners = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };

  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  // Automatic playback is policy-controlled here, never an HTML autoplay.
  video.removeAttribute('autoplay');

  function visible() {
    if (document.hidden || !inViewport) return false;
    const { page, comparison, investigations } = document.body.dataset;
    if ((page && page !== 'home') || comparison === 'true' || investigations === 'true') return false;
    for (let node = section; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.inert) return false;
    }
    return section.getClientRects().length > 0;
  }
  const wantsPlayback = () => !destroyed && !changingMedia && !failed && !blocked && !userPaused && (!preference.matches || optedIn);
  const shouldPlay = () => visible() && wantsPlayback();

  function render() {
    const playing = !video.paused && shouldPlay();
    const showFrame = hasFrame && !failed && (!preference.matches || optedIn);
    video.hidden = !showFrame;
    poster.hidden = showFrame;
    playback.textContent = playing || starting ? 'Pause example' : 'Play example';
    playback.disabled = failed;
    replay.disabled = failed;
    caption.textContent = showFrame
      ? captions[video.currentTime < 4 ? 0 : video.currentTime < 9 ? 1 : 2]
      : captions[2];
    const message = failed ? 'Video unavailable. The still image and transcript show the complete example.'
      : blocked ? 'Playback could not start. Play example to try again; the still image and transcript remain available.'
      : userPaused ? 'Example paused. Play to continue or replay from the beginning.'
      : preference.matches && !optedIn ? 'Reduced motion: showing the still image. Play example to opt in.'
      : !visible() ? 'Example paused while out of view.'
      : starting ? 'Loading the silent example. The still image and transcript remain available.'
      : playing ? 'Playing a silent, looping public example. Runtime is unknown.'
      : 'Showing the still image and transcript.';
    // Do not re-announce the same live status on every timeupdate.
    if (status.textContent !== message) status.textContent = message;
  }

  function stop() {
    generation++;
    starting = false;
    video.pause();
  }

  function sync() {
    if (!shouldPlay()) {
      stop();
      render();
      return;
    }
    if (starting || !video.paused) { render(); return; }
    starting = true;
    const ticket = ++generation;
    render();
    const denied = error => {
      if (ticket !== generation) return;
      starting = false;
      if (error.name === 'NotSupportedError' || video.error) failed = true;
      else blocked = true;
      stop();
      render();
    };
    // Catch both a synchronous media failure and a rejected play promise.
    // Call play directly so an explicit button click keeps user activation.
    try {
      Promise.resolve(video.play()).then(() => {
        if (ticket !== generation) return;
        starting = false;
        if (!shouldPlay()) stop();
        render();
      }).catch(denied);
    } catch (error) { denied(error); }
  }

  listen(playback, 'click', () => {
    if (failed) return;
    if (starting || (!video.paused && shouldPlay())) userPaused = true;
    else { userPaused = false; optedIn = true; blocked = false; }
    sync();
  });
  listen(replay, 'click', () => {
    if (failed) return;
    stop();
    video.currentTime = 0;
    hasFrame = false;
    updateMedia();
    userPaused = false;
    optedIn = true;
    blocked = false;
    sync();
  });
  listen(video, 'playing', () => {
    if (!shouldPlay()) stop();
    hasFrame = true;
    starting = false;
    render();
  });
  listen(video, 'pause', render);
  listen(video, 'timeupdate', () => {
    if (video.currentTime < lastTime) {
      hasFrame = false;
      updateMedia();
      // A loop without a variant change already has a decoded frame.
      if (!changingMedia) hasFrame = true;
    }
    lastTime = video.currentTime;
    render();
  });
  listen(video, 'canplay', () => {
    if (!changingMedia) return;
    changingMedia = false;
    sync();
  });
  listen(video, 'error', () => { failed = true; stop(); render(); });
  // Chromium can exhaust child sources without rejecting play() or raising a
  // video-level error. A failed first codec must still allow the second one.
  video.querySelectorAll('source').forEach(source => listen(source, 'error', () => {
    if (video.networkState === 3) { failed = true; stop(); render(); }
  }));
  listen(document, 'visibilitychange', sync);
  listen(preference, 'change', () => {
    // A newly enabled preference always stops motion, including an earlier
    // explicit opt-in. Disabling it never cancels a user's Pause or a denial.
    optedIn = false;
    sync();
  });

  function updateMedia() {
    const theme = document.documentElement.dataset.theme;
    const isDark = theme === 'dark' || (!theme && dark.matches);
    const next = `${narrow.matches ? '-mobile' : ''}${isDark ? '-dark' : ''}`;
    poster.src = `./examples/preview/home-demo-poster${next}.svg`;
    if (next === variant) return;
    // Keep the exact frame and chapter, including a user's Pause. Static hosts
    // need not support Range/seek; apply a new video format at Replay or loop.
    if (hasFrame && video.currentTime > 0) return;
    stop();
    variant = next;
    hasFrame = false;
    changingMedia = true;
    failed = false;
    video.poster = poster.src;
    video.querySelectorAll('source').forEach(source => {
      const extension = source.type === 'video/webm' ? 'webm' : 'mp4';
      source.src = `./examples/preview/home-demo${variant}.${extension}`;
    });
    video.load();
  }
  const updatePresentation = () => { updateMedia(); sync(); };
  listen(narrow, 'change', updatePresentation);
  listen(dark, 'change', updatePresentation);
  const mutations = new MutationObserver(updatePresentation);
  for (let node = section; node; node = node.parentElement) {
    // Attributes only on this visibility chain, never the graph subtree.
    mutations.observe(node, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'style', 'class', 'data-page', 'data-comparison', 'data-investigations', 'data-theme'] });
  }
  let intersection;
  if ('IntersectionObserver' in window) {
    intersection = new window.IntersectionObserver(entries => {
      inViewport = entries.some(entry => entry.isIntersecting);
      sync();
    });
    intersection.observe(section);
  }
  updatePresentation();

  // Useful if the host replaces the homepage; do not leave active observers.
  return () => {
    destroyed = true;
    mutations.disconnect();
    intersection?.disconnect();
    listeners.forEach(remove => remove());
    stop();
    video.hidden = true;
    poster.hidden = false;
  };
}
