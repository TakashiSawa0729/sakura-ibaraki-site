/*
 * さくらこども園サイト 共通スクリプト
 * WordPress（Lightning / VK Blocks / ExUnit）の動きを置き換える最小限の処理です。
 *  - スマホ判定（body.device-mobile / device-pc）
 *  - スクロール時のヘッダー（body.header_scrolled）とページトップボタン（body.scrolled）
 *  - スマホメニューの開閉
 *  - スライダー（Swiper）
 *  - アコーディオン・タブ・スクロールアニメーション
 */
(function () {
  'use strict';
  var body = document.body;

  // ---- 端末判定
  var isMobile = window.matchMedia('(pointer:coarse)').matches || /Mobi|Android/i.test(navigator.userAgent);
  body.classList.add(isMobile ? 'device-mobile' : 'device-pc');

  // ---- 透過ヘッダー（ページ上部ではヘッダーを背景の上に重ねる）
  var header = document.querySelector('.site-header--trans--true');
  var pageHeader = document.querySelector('.page-header');
  function layoutHeader() {
    if (!header) return;
    header.classList.add('header-trans-ready');
    var scrolled = body.classList.contains('header_scrolled');
    header.classList.toggle('header-trans-active', !scrolled);
    if (pageHeader && !scrolled) {
      pageHeader.style.paddingTop = header.offsetHeight + 'px';
    }
  }
  function reveal() {
    document.querySelectorAll('.page-header, .page-header-inner, .ltg-slide .ltg-slide-text-set').forEach(function (el) {
      el.style.opacity = '1';
    });
  }

  // ---- スクロール
  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    var was = body.classList.contains('header_scrolled');
    body.classList.toggle('header_scrolled', y > 0);
    body.classList.toggle('scrolled', y > 400);
    if (was !== (y > 0)) layoutHeader();
  }
  layoutHeader();
  reveal();
  window.addEventListener('resize', layoutHeader);
  window.addEventListener('load', layoutHeader);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ページトップ
  document.querySelectorAll('.page_top_btn').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // ページ内リンクをなめらかに
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    var id = a.getAttribute('href');
    if (id.length < 2) return;
    a.addEventListener('click', function (e) {
      var t = document.querySelector(id);
      if (!t) return;
      e.preventDefault();
      t.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // ---- スマホメニュー
  var btn = document.querySelector('.vk-mobile-nav-menu-btn');
  var nav = document.getElementById('vk-mobile-nav') || document.querySelector('.vk-mobile-nav');
  if (btn && nav) {
    btn.addEventListener('click', function () {
      var open = !nav.classList.contains('vk-mobile-nav-open');
      nav.classList.toggle('vk-mobile-nav-open', open);
      btn.classList.toggle('menu-open', open);
    });
    nav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        nav.classList.remove('vk-mobile-nav-open');
        btn.classList.remove('menu-open');
      });
    });
  }
  // サブメニューの開閉ボタン
  document.querySelectorAll('.vk-menu-acc .menu-item-has-children, .global-nav-list .menu-item-has-children').forEach(function (li) {
    var sub = li.querySelector(':scope > .sub-menu');
    if (!sub) return;
    var b = li.querySelector(':scope > .acc-btn');
    if (!b) {
      b = document.createElement('span');
      b.className = 'acc-btn acc-btn-open';
      li.insertBefore(b, sub);
    }
    b.addEventListener('click', function () {
      var open = !sub.classList.contains('acc-child-open');
      sub.classList.toggle('acc-child-open', open);
      sub.classList.toggle('acc-child-close', !open);
      b.classList.toggle('acc-btn-close', open);
      b.classList.toggle('acc-btn-open', !open);
    });
  });

  // ---- スライダー（VK Blocks の data-vkb-slider を Swiper に変換）
  function initSliders() {
    if (typeof Swiper === 'undefined') return;
    document.querySelectorAll('.vk_slider[data-vkb-slider]').forEach(function (el) {
      var o = {};
      try { o = JSON.parse(el.getAttribute('data-vkb-slider')); } catch (e) {}
      var slides = el.querySelectorAll('.swiper-slide').length;
      var perPC = parseFloat(o.slidesPerViewPC) || 1;
      var perTab = parseFloat(o.slidesPerViewTablet) || 1;
      var perSp = parseFloat(o.slidesPerViewMobile) || 1;
      var group = o.slidesPerGroup === 'slides-per-view' ? undefined : 1;
      var cfg = {
        loop: !!o.loop && slides > Math.ceil(perPC) + 1,
        speed: parseInt(o.speed, 10) || 500,
        effect: o.effect === 'fade' ? 'fade' : 'slide',
        centeredSlides: !!o.centeredSlides,
        slidesPerView: perSp,
        slidesPerGroup: group || 1,
        breakpoints: {
          576: { slidesPerView: perTab },
          992: { slidesPerView: perPC }
        },
        navigation: {
          nextEl: el.querySelector('.swiper-button-next'),
          prevEl: el.querySelector('.swiper-button-prev')
        }
      };
      if (o.effect === 'fade') cfg.fadeEffect = { crossFade: true };
      if (o.autoPlay) {
        cfg.autoplay = {
          delay: parseInt(o.autoPlayDelay, 10) || 4000,
          disableOnInteraction: !!o.autoPlayStop,
          reverseDirection: o.direction === 'rtl'
        };
      }
      if (o.pagination && o.pagination !== 'hide') {
        var p = el.querySelector('.swiper-pagination') || el.appendChild(Object.assign(document.createElement('div'), { className: 'swiper-pagination' }));
        cfg.pagination = { el: p, clickable: true, type: o.pagination === 'number' ? 'fraction' : 'bullets' };
      }
      new Swiper(el, cfg);
    });
  }

  // ---- アコーディオン
  document.querySelectorAll('.vk_accordion').forEach(function (acc) {
    var trigger = acc.querySelector('.vk_accordion-trigger');
    var toggle = acc.querySelector('.vk_accordion-toggle');
    var target = acc.querySelector('.vk_accordion-target');
    if (!trigger || !target) return;
    var open = acc.getAttribute('data-initial-state') === 'open';
    function set(o) {
      target.classList.toggle('vk_accordion-target-open', o);
      target.classList.toggle('vk_accordion-target-close', !o);
      if (toggle) {
        toggle.classList.toggle('vk_accordion-toggle-open', o);
        toggle.classList.toggle('vk_accordion-toggle-close', !o);
      }
    }
    set(open);
    trigger.style.cursor = 'pointer';
    trigger.addEventListener('click', function () { open = !open; set(open); });
  });

  // ---- タブ
  document.querySelectorAll('.vk_tab').forEach(function (tab) {
    var labels = tab.querySelectorAll('.vk_tab_labels_label');
    var bodies = tab.querySelectorAll('.vk_tab_bodys_body');
    labels.forEach(function (lab) {
      lab.addEventListener('click', function () {
        var id = lab.getAttribute('aria-controls');
        labels.forEach(function (l) {
          var a = l === lab;
          l.classList.toggle('vk_tab_labels_label-state-active', a);
          l.classList.toggle('vk_tab_labels_label-state-inactive', !a);
          l.setAttribute('aria-selected', a ? 'true' : 'false');
          l.setAttribute('tabindex', a ? '0' : '-1');
        });
        bodies.forEach(function (b) {
          var a = b.id === id;
          b.classList.toggle('vk_tab_bodys_body-state-active', a);
          b.classList.toggle('vk_tab_bodys_body-state-inactive', !a);
        });
      });
    });
  });

  // ---- スクロールアニメーション
  var anims = document.querySelectorAll('.vk_animation');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('vk_animation-active');
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    anims.forEach(function (a) { io.observe(a); });
  } else {
    anims.forEach(function (a) { a.classList.add('vk_animation-active'); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSliders);
  } else {
    initSliders();
  }
})();
