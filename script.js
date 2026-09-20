/* Rivet House — minimal interaction layer */
(function () {
  'use strict';

  /* ---- Preloader: fade out on load ---- */
  window.addEventListener('load', function () {
    var pre = document.getElementById('preloader');
    if (!pre) return;
    setTimeout(function () { pre.classList.add('is-hidden'); }, 350);
  });

  /* ---- Broken images fall back to themed .ph placeholder ---- */
  document.querySelectorAll('img').forEach(function (img) {
    img.addEventListener('error', function () { img.style.display = 'none'; });
  });

  /* ---- Announcement bar dismiss (remembered per browser) ---- */
  var announceClose = document.getElementById('announceClose');
  try {
    if (localStorage.getItem('rh-announce-dismissed') === '1') {
      document.body.classList.add('announce-dismissed');
    }
  } catch (e) {}
  if (announceClose) {
    announceClose.addEventListener('click', function () {
      document.body.classList.add('announce-dismissed');
      try { localStorage.setItem('rh-announce-dismissed', '1'); } catch (e) {}
    });
  }

  /* ---- Navigation overlay ---- */
  var menuToggle = document.getElementById('menuToggle');
  var navClose = document.getElementById('navClose');
  var navOverlay = document.getElementById('navOverlay');
  function openNav() {
    navOverlay.classList.add('is-open');
    document.body.classList.add('nav-open');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'true');
  }
  function closeNav() {
    navOverlay.classList.remove('is-open');
    document.body.classList.remove('nav-open');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
  }
  if (menuToggle) menuToggle.addEventListener('click', openNav);
  if (navClose) navClose.addEventListener('click', closeNav);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });

  /* ---- Arch carousel ---- */
  var slider = document.getElementById('slider');
  if (slider) {
    var slides = slider.querySelectorAll('.slider__slide');
    var dotsWrap = document.getElementById('sliderDots');
    var current = 0;
    var timer;

    slides.forEach(function (_, i) {
      var b = document.createElement('button');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', 'Go to slide ' + (i + 1));
      if (i === 0) b.classList.add('is-active');
      b.addEventListener('click', function () { go(i); reset(); });
      dotsWrap.appendChild(b);
    });
    var dots = dotsWrap.querySelectorAll('button');

    function go(i) {
      slides[current].classList.remove('is-active');
      dots[current].classList.remove('is-active');
      current = (i + slides.length) % slides.length;
      slides[current].classList.add('is-active');
      dots[current].classList.add('is-active');
    }
    function next() { go(current + 1); }
    function reset() { clearInterval(timer); timer = setInterval(next, 5000); }
    reset();
  }

  /* ---- Elevated Escape crossfade carousel ---- */
  var escape = document.getElementById('escapeSlides');
  if (escape) {
    var eslides = escape.querySelectorAll('.escape-slide');
    var edots = document.getElementById('escapeDots');
    var ec = 0, etimer;
    eslides.forEach(function (_, i) {
      var b = document.createElement('button');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', 'Go to escape slide ' + (i + 1));
      if (i === 0) b.classList.add('is-active');
      b.addEventListener('click', function () { ego(i); ereset(); });
      edots.appendChild(b);
    });
    var edotEls = edots.querySelectorAll('button');
    function ego(i) {
      eslides[ec].classList.remove('is-active');
      edotEls[ec].classList.remove('is-active');
      ec = (i + eslides.length) % eslides.length;
      eslides[ec].classList.add('is-active');
      edotEls[ec].classList.add('is-active');
    }
    function ereset() { clearInterval(etimer); etimer = setInterval(function () { ego(ec + 1); }, 6000); }
    ereset();
  }

  /* ---- Scroll fade-up reveals ---- */
  var faders = document.querySelectorAll('.animate-fade');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
    faders.forEach(function (el) { io.observe(el); });
  } else {
    faders.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ---- Lazy videos: load + play only when in view (performance) ---- */
  var lazyVideos = document.querySelectorAll('video[data-src]');
  if (lazyVideos.length && 'IntersectionObserver' in window) {
    /* Load a video's source (once) and try to play it. Never pauses on exit,
       so once a reel starts it keeps looping — no reel is left frozen. */
    function loadAndPlay(v) {
      if (!v.dataset.loaded) {
        var s = document.createElement('source');
        s.src = v.getAttribute('data-src'); s.type = 'video/mp4';
        v.appendChild(s); v.load(); v.dataset.loaded = '1';
        var ld = v.parentNode.querySelector('.reel-load'); if (ld) ld.remove();
      }
      v.muted = true;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    }
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) loadAndPlay(entry.target);
      });
    }, { rootMargin: '600px 0px', threshold: 0.01 });
    lazyVideos.forEach(function (v) { vio.observe(v); });

    /* Fallback: some browsers block silent autoplay until a user gesture.
       On the first scroll / tap / move, load AND play EVERY reel (including the
       ones parked off-screen in the horizontal wall), then keep them running. */
    var kicked = false;
    function kickVideos() {
      if (kicked) return; kicked = true;
      lazyVideos.forEach(loadAndPlay);
      window.removeEventListener('scroll', kickVideos);
      window.removeEventListener('touchstart', kickVideos);
      window.removeEventListener('pointerdown', kickVideos);
      window.removeEventListener('mousemove', kickVideos);
    }
    window.addEventListener('scroll', kickVideos, { passive: true, once: true });
    window.addEventListener('touchstart', kickVideos, { passive: true, once: true });
    window.addEventListener('pointerdown', kickVideos, { passive: true, once: true });
    window.addEventListener('mousemove', kickVideos, { passive: true, once: true });
  } else {
    lazyVideos.forEach(function (v) {
      var s = document.createElement('source'); s.src = v.getAttribute('data-src'); s.type = 'video/mp4';
      v.appendChild(s); v.load();
    });
  }

  /* ---- Hero video: ensure it plays (muted autoplay) ---- */
  var heroVid = document.querySelector('.hero__video');
  if (heroVid) { var hp = heroVid.play(); if (hp && hp.catch) hp.catch(function(){}); }

  /* ---- Lightbox (gallery) ---- */
  var lb = document.getElementById('lightbox');
  if (lb) {
    var lbBody = lb.querySelector('.lightbox__body');
    var lbClose = lb.querySelector('.lightbox__close');
    document.querySelectorAll('[data-lightbox]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var type = el.getAttribute('data-type') || 'image';
        var src = el.getAttribute('data-lightbox');
        lbBody.innerHTML = '';
        if (type === 'video') {
          var v = document.createElement('video');
          v.src = src; v.controls = true; v.autoplay = true; v.loop = true; v.playsInline = true;
          lbBody.appendChild(v);
        } else {
          var img = document.createElement('img'); img.src = src; img.alt = ''; lbBody.appendChild(img);
        }
        lb.classList.add('is-open');
      });
    });
    function closeLb() { lb.classList.remove('is-open'); lbBody.innerHTML = ''; }
    if (lbClose) lbClose.addEventListener('click', closeLb);
    lb.addEventListener('click', function (e) { if (e.target === lb) closeLb(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLb(); });
  }

  /* ---- FAQ accordion ---- */
  document.querySelectorAll('.faq__item').forEach(function (item) {
    var q = item.querySelector('.faq__q');
    var a = item.querySelector('.faq__a');
    if (!q || !a) return;
    q.addEventListener('click', function () {
      var open = item.classList.contains('is-open');
      // close siblings
      document.querySelectorAll('.faq__item.is-open').forEach(function (o) {
        if (o !== item) { o.classList.remove('is-open'); var oa = o.querySelector('.faq__a'); if (oa) oa.style.maxHeight = null; var oq = o.querySelector('.faq__q'); if (oq) oq.setAttribute('aria-expanded', 'false'); }
      });
      if (open) {
        item.classList.remove('is-open'); a.style.maxHeight = null; q.setAttribute('aria-expanded', 'false');
      } else {
        item.classList.add('is-open'); a.style.maxHeight = a.scrollHeight + 'px'; q.setAttribute('aria-expanded', 'true');
      }
    });
  });

  /* ---- Booking + newsletter: no backend in this study build ---- */
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"], .cta');
      if (btn) {
        var original = btn.textContent;
        btn.textContent = 'Coming soon';
        setTimeout(function () { btn.textContent = original; }, 1600);
      }
    });
  });
})();
