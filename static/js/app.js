/* Shrutiscakes — APP RUNTIME
 *
 * Loaded ONLY when the site is opened as an installed PWA / TWA.
 * Gives the multi-page Flask app a native feel via:
 *   1. Cross-document view transitions with directional awareness (back vs forward)
 *   2. Edge-swipe-back gesture (left-edge drag → history.back())
 *   3. Press feedback (.pressing class on touchstart for tactile scale)
 *   4. Haptic feedback (navigator.vibrate) on key taps — Android only, iOS no-ops silently
 *   5. Bottom-sheet drag-to-dismiss for modals
 *
 * Does NOT touch web behavior — base.html only injects this script when .is-pwa is set.
 */

(function() {
    'use strict';

    if (!document.documentElement.classList.contains('is-pwa')) return;

    var HAPTIC_MS = 8;
    var EDGE_ZONE_PX = 24;       // touchstart must begin within this far from left edge
    var SWIPE_BACK_THRESHOLD = 60; // px of horizontal travel required to trigger back
    var SHEET_DISMISS_PX = 100;   // px of downward drag required to dismiss a sheet

    function vibrate(ms) {
        if (navigator.vibrate) {
            try { navigator.vibrate(ms || HAPTIC_MS); } catch (e) { /* swallow */ }
        }
    }

    /* ─────────────────────────────────────────────
     * 1. View transition direction
     *    On any back/forward (popstate) navigation, tag <html> with data-nav="back"
     *    so app.css reverses the slide direction. Cleared on the next forward nav.
     * ───────────────────────────────────────────── */
    window.addEventListener('popstate', function() {
        document.documentElement.dataset.nav = 'back';
    });

    // Newer browsers expose pageswap/pagereveal — use them when available for more
    // reliable detection across cross-document transitions.
    if ('onpageswap' in window) {
        window.addEventListener('pageswap', function(e) {
            if (e.viewTransition && e.activation) {
                var type = e.activation.navigationType;
                if (type === 'traverse' || type === 'reload') {
                    document.documentElement.dataset.nav = 'back';
                } else {
                    document.documentElement.dataset.nav = 'forward';
                }
            }
        });
    }

    /* ─────────────────────────────────────────────
     * 2. Edge-swipe-back gesture
     *    Listens for touchstart near x < EDGE_ZONE_PX, tracks horizontal travel,
     *    triggers history.back() if travel exceeds threshold. The browser's
     *    view-transition animation does the actual page slide.
     * ───────────────────────────────────────────── */
    var swipe = { active: false, startX: 0, startY: 0, dx: 0 };

    document.addEventListener('touchstart', function(e) {
        if (e.touches.length !== 1) return;
        var t = e.touches[0];
        if (t.clientX > EDGE_ZONE_PX) return;
        // Don't hijack swipes that start inside a modal/sheet — those have their own gestures.
        if (e.target.closest('.modal.open')) return;
        swipe.active = true;
        swipe.startX = t.clientX;
        swipe.startY = t.clientY;
        swipe.dx = 0;
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
        if (!swipe.active) return;
        var t = e.touches[0];
        swipe.dx = t.clientX - swipe.startX;
        var dy = Math.abs(t.clientY - swipe.startY);
        // Bail if the gesture turns vertical — user is scrolling, not swiping back.
        if (dy > Math.abs(swipe.dx) && dy > 12) {
            swipe.active = false;
            document.body.style.transform = '';
            return;
        }
        if (swipe.dx > 0) {
            // Live drag preview: nudge the page so the gesture feels connected.
            // The actual slide animation happens after history.back() via view-transition.
            document.body.style.transform = 'translateX(' + Math.min(swipe.dx * 0.4, 60) + 'px)';
            document.body.style.transition = 'none';
        }
    }, { passive: true });

    document.addEventListener('touchend', function() {
        if (!swipe.active) return;
        swipe.active = false;
        document.body.style.transition = 'transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1)';
        document.body.style.transform = '';
        if (swipe.dx > SWIPE_BACK_THRESHOLD && history.length > 1) {
            vibrate(12);
            // history.back() triggers popstate → data-nav="back" → CSS slides correctly.
            history.back();
        }
        setTimeout(function() {
            document.body.style.transition = '';
        }, 220);
    }, { passive: true });

    /* ─────────────────────────────────────────────
     * 3. Press feedback (.pressing class)
     *    Adds tactile scale-down on touchstart, removes on touchend.
     *    Delegated so it works on cards/buttons rendered later.
     * ───────────────────────────────────────────── */
    var PRESS_SELECTOR = '.btn, .cake-card, .menu-tile, .app-tab, .cake-image-wrap.clickable';

    document.addEventListener('touchstart', function(e) {
        var el = e.target.closest(PRESS_SELECTOR);
        if (el) el.classList.add('pressing');
    }, { passive: true });

    function clearPressing() {
        document.querySelectorAll('.pressing').forEach(function(el) {
            el.classList.remove('pressing');
        });
    }
    document.addEventListener('touchend', clearPressing, { passive: true });
    document.addEventListener('touchcancel', clearPressing, { passive: true });

    /* ─────────────────────────────────────────────
     * 4. Haptic feedback on key taps
     *    Tab bar switches + primary CTAs get a small buzz on Android.
     * ───────────────────────────────────────────── */
    document.addEventListener('click', function(e) {
        if (e.target.closest('.app-tab, .btn-primary, .btn-wa')) {
            vibrate(HAPTIC_MS);
        }
    });

    /* ─────────────────────────────────────────────
     * 5. Bottom-sheet drag-to-dismiss
     *    Watches for vertical drag on modal content; if user drags down past
     *    SHEET_DISMISS_PX, fire the modal's existing close handler.
     * ───────────────────────────────────────────── */
    var sheet = { active: false, startY: 0, dy: 0, el: null };

    document.addEventListener('touchstart', function(e) {
        var content = e.target.closest('.modal.open .modal-content');
        if (!content) return;
        // Only initiate the drag if the touch is near the top of the sheet
        // (drag handle area) — otherwise the user is just scrolling.
        var rect = content.getBoundingClientRect();
        if (e.touches[0].clientY - rect.top > 80) return;
        sheet.active = true;
        sheet.startY = e.touches[0].clientY;
        sheet.dy = 0;
        sheet.el = content;
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
        if (!sheet.active) return;
        sheet.dy = e.touches[0].clientY - sheet.startY;
        if (sheet.dy > 0) {
            sheet.el.classList.add('dragging');
            sheet.el.style.transform = 'translateY(' + sheet.dy + 'px)';
        }
    }, { passive: true });

    document.addEventListener('touchend', function() {
        if (!sheet.active) return;
        var el = sheet.el;
        var dy = sheet.dy;
        sheet.active = false;
        sheet.el = null;
        if (!el) return;
        el.classList.remove('dragging');
        if (dy > SHEET_DISMISS_PX) {
            // Trigger the modal's own close path so its state stays consistent
            // with the existing close-button + Escape-key handlers.
            var modal = el.closest('.modal');
            el.classList.add('dismissing');
            setTimeout(function() {
                var closeBtn = modal.querySelector('[data-close-modal], [data-close-inquiry]');
                if (closeBtn) closeBtn.click();
                el.classList.remove('dismissing');
                el.style.transform = '';
            }, 200);
        } else {
            // Snap back.
            el.style.transition = 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)';
            el.style.transform = '';
            setTimeout(function() { el.style.transition = ''; }, 240);
        }
    }, { passive: true });

    /* ─────────────────────────────────────────────
     * 6. Collapsing header
     *    Hides the header when scrolling down past a threshold, shows it
     *    again on any meaningful scroll-up. Reclaims vertical space — the
     *    pattern Twitter, Instagram, and most native browsers use.
     * ───────────────────────────────────────────── */
    var lastScrollY = 0;
    var scrollTicking = false;
    var HEADER_THRESHOLD = 80;   // px below which the header always stays visible
    var SCROLL_UP_TOLERANCE = 6; // ignore tiny scroll-ups (finger jitter)

    function onScroll() {
        var y = window.scrollY;
        var html = document.documentElement;
        if (y > lastScrollY && y > HEADER_THRESHOLD) {
            html.classList.add('header-hidden');
        } else if (y < lastScrollY - SCROLL_UP_TOLERANCE || y <= HEADER_THRESHOLD) {
            html.classList.remove('header-hidden');
        }
        lastScrollY = y;
        scrollTicking = false;
    }

    window.addEventListener('scroll', function() {
        if (!scrollTicking) {
            requestAnimationFrame(onScroll);
            scrollTicking = true;
        }
    }, { passive: true });

    /* ─────────────────────────────────────────────
     * 7. Hardware back button → close open modal first
     *    Native expectation: if a sheet/modal is open, pressing back should
     *    close it (not navigate away). We achieve this by pushing a history
     *    entry when a modal opens, then intercepting popstate to close
     *    the modal instead of letting the navigation through.
     *
     *    State machine:
     *      modal opens  → pushState({modalOpen:true})
     *      user closes  → if our state is still on stack, history.back() to clean up
     *      user presses → popstate fires → close modal, skip cleanup
     *                    back
     * ───────────────────────────────────────────── */
    var modalOpenTracked = false;
    var suppressCleanup = false;  // set true when popstate closed the modal

    function handleModalState() {
        var anyOpen = document.querySelector('.modal.open') !== null;
        if (anyOpen && !modalOpenTracked) {
            // Modal just opened — push a history entry we can pop later.
            modalOpenTracked = true;
            history.pushState({ modalOpen: true }, '');
        } else if (!anyOpen && modalOpenTracked) {
            // Modal just closed.
            modalOpenTracked = false;
            if (suppressCleanup) {
                // popstate already consumed our entry — nothing to clean up.
                suppressCleanup = false;
            } else if (history.state && history.state.modalOpen) {
                // User closed via X/backdrop — pop our pushed entry to keep URL clean.
                history.back();
            }
        }
    }

    var modalObserver = new MutationObserver(handleModalState);
    document.querySelectorAll('.modal').forEach(function(modal) {
        modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
    });

    // Intercept popstate BEFORE the existing view-transition direction handler.
    // If a modal is open, close it and short-circuit the navigation.
    window.addEventListener('popstate', function(e) {
        if (modalOpenTracked) {
            suppressCleanup = true;
            document.querySelectorAll('.modal.open').forEach(function(modal) {
                var closeBtn = modal.querySelector('[data-close-modal], [data-close-inquiry]');
                if (closeBtn) closeBtn.click();
            });
            // Stop the back-nav slide animation from playing for a non-navigation pop.
            document.documentElement.removeAttribute('data-nav');
        }
    });

    /* ─────────────────────────────────────────────
     * 8. Keyboard-aware focus
     *    When an input is focused, the on-screen keyboard slides up and can
     *    cover the focused field. Native apps scroll the field into view
     *    above the keyboard. We replicate that by waiting for the keyboard
     *    to open (~300ms) then scrolling the focused element into view.
     * ───────────────────────────────────────────── */
    var FOCUS_INPUT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
    document.addEventListener('focusin', function(e) {
        if (FOCUS_INPUT_TAGS.indexOf(e.target.tagName) === -1) return;
        setTimeout(function() {
            try {
                e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch (err) { /* old browsers */ }
        }, 320);
    });

    /* ─────────────────────────────────────────────
     * 9. Generic autoplay carousel
     *    Used by both the hero banner and the why-us "Our Promise" section.
     *    Builds a row of dot indicators inside a sibling container, ticks
     *    every interval, pauses while the user interacts.
     * ───────────────────────────────────────────── */
    function buildCarousel(track, dotsHost, opts) {
        if (!track || !dotsHost) return;
        var slides = Array.prototype.slice.call(track.children);
        if (slides.length <= 1) return;

        var interval = (opts && opts.interval) || 4000;
        var resumeAfter = (opts && opts.resumeAfter) || 8000;
        var dotClass = (opts && opts.dotClass) || 'app-hero-dot';
        var autoplay = !opts || opts.autoplay !== false;

        dotsHost.innerHTML = slides.map(function(_, i) {
            return '<span class="' + dotClass + (i === 0 ? ' active' : '') + '"></span>';
        }).join('');
        var dotEls = Array.prototype.slice.call(dotsHost.children);

        var current = 0;
        var timer = null;
        var paused = false;
        var resumeTimer = null;

        function goTo(i) {
            var prev = current;
            current = (i + slides.length) % slides.length;
            // When wrapping last→first (or first→last), the translateX would
            // animate backwards across every slide ("blank card flash"). Skip
            // the transition for the jump, then re-enable on the next tick.
            var wrap = Math.abs(current - prev) > 1;
            if (wrap) {
                track.style.transition = 'none';
                track.style.transform = 'translateX(-' + (current * 100) + '%)';
                track.offsetHeight;   // force reflow so the next transition fires
                track.style.transition = 'transform 480ms cubic-bezier(0.22, 0.61, 0.36, 1)';
            } else {
                track.style.transition = 'transform 480ms cubic-bezier(0.22, 0.61, 0.36, 1)';
                track.style.transform = 'translateX(-' + (current * 100) + '%)';
            }
            dotEls.forEach(function(d, idx) { d.classList.toggle('active', idx === current); });
        }

        function tick() { if (!paused) goTo(current + 1); }
        function start() { if (timer) clearInterval(timer); timer = setInterval(tick, interval); }
        function pauseAndResume() {
            paused = true;
            if (resumeTimer) clearTimeout(resumeTimer);
            resumeTimer = setTimeout(function() { paused = false; }, resumeAfter);
        }

        dotsHost.addEventListener('click', function(e) {
            var idx = dotEls.indexOf(e.target);
            if (idx === -1) return;
            goTo(idx);
            if (autoplay) pauseAndResume();
        });
        if (autoplay) {
            track.addEventListener('touchstart', pauseAndResume, { passive: true });
            start();
        }
    }

    /* ─────────────────────────────────────────────
     * Why-us carousel — FADE between absolutely-positioned slides.
     *
     * Why this is its own function (not buildCarousel):
     *  The original buildCarousel used translateX on a flex container.
     *  That fought a base.html IntersectionObserver — when slides 2/3/4 sit
     *  off-screen via transform, the observer never sees them, so .reveal stays
     *  at opacity 0 forever. The fade carousel sidesteps the whole problem:
     *  all 4 slides are stacked at the same position via `position: absolute`,
     *  only the .is-active one has opacity 1 (forced with !important in CSS).
     * ───────────────────────────────────────────── */
    function setupWhyUsCarousel() {
        var grid = document.querySelector('.why-us .why-grid');
        if (!grid) return;
        var slides = Array.prototype.slice.call(grid.children);
        if (slides.length <= 1) return;

        // Belt-and-braces: strip .reveal so the observer's opacity:0 can't bite us.
        slides.forEach(function(s) { s.classList.remove('reveal'); });
        // Initial active slide.
        slides[0].classList.add('is-active');

        // Build dot indicators if not already present.
        var dots = document.querySelector('.why-us-dots');
        if (!dots) {
            dots = document.createElement('div');
            dots.className = 'why-us-dots';
            grid.parentNode.insertBefore(dots, grid.nextSibling);
        }
        dots.innerHTML = slides.map(function(_, i) {
            return '<span class="why-us-dot' + (i === 0 ? ' active' : '') + '"></span>';
        }).join('');
        var dotEls = Array.prototype.slice.call(dots.children);

        var current = 0;
        var AUTOPLAY_MS = 3000;     // was 4500 — quicker rotation
        var RESUME_MS = 6000;
        var timer = null;
        var resumeTimer = null;
        var paused = false;

        function goTo(i) {
            current = (i + slides.length) % slides.length;
            slides.forEach(function(s, idx) { s.classList.toggle('is-active', idx === current); });
            dotEls.forEach(function(d, idx) { d.classList.toggle('active', idx === current); });
        }
        function tick() { if (!paused) goTo(current + 1); }
        function startAutoplay() {
            if (timer) clearInterval(timer);
            timer = setInterval(tick, AUTOPLAY_MS);
        }
        function pauseAndResume() {
            paused = true;
            if (resumeTimer) clearTimeout(resumeTimer);
            resumeTimer = setTimeout(function() { paused = false; }, RESUME_MS);
        }

        dots.addEventListener('click', function(e) {
            var idx = dotEls.indexOf(e.target);
            if (idx === -1) return;
            goTo(idx);
            pauseAndResume();
        });
        grid.addEventListener('touchstart', pauseAndResume, { passive: true });

        startAutoplay();
    }

    /* Boot the homepage carousels. */
    function setupHomeCarousels() {
        buildCarousel(
            document.getElementById('app-hero-track'),
            document.getElementById('app-hero-dots'),
            { interval: 4500, dotClass: 'app-hero-dot' }
        );
        setupWhyUsCarousel();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupHomeCarousels);
    } else {
        setupHomeCarousels();
    }

    /* ─────────────────────────────────────────────
     * 10. Client-side search
     *
     *   HOME page:
     *     - Type → live-filter the visible category tiles (.app-menu-grid-tile)
     *     - Press Enter (or tap the search icon) → navigate to /menu?q=QUERY
     *       so the user actually finds individual products (cakes by name).
     *
     *   MENU / GALLERY pages (search bar hidden per spec):
     *     - If URL has ?q=QUERY, auto-filter .cake-card / .photo-tile to matches.
     *     - Show a "Showing results for 'X' [×]" pill at the top so the user
     *       knows why content is filtered and can clear it.
     *     - "No results" placeholder when nothing matches.
     * ───────────────────────────────────────────── */
    function setupAppSearch() {
        var input = document.getElementById('app-search-input');
        var clear = document.getElementById('app-search-clear');
        if (!input) return;

        // Lazy-loaded product list and the suggestion dropdown DOM node.
        var allProducts = null;
        var dropdown = null;

        function getDropdown() {
            if (dropdown) return dropdown;
            dropdown = document.createElement('div');
            dropdown.className = 'app-search-dropdown';
            dropdown.hidden = true;
            var container = document.querySelector('.app-search');
            if (container) container.appendChild(dropdown);
            return dropdown;
        }

        // Fetch /menu once, parse out every .cake-card's data-attributes into a flat
        // product list. The service-worker pre-caches /menu so subsequent fetches
        // are instant; the first focus pays a one-time HTML round-trip.
        function fetchProducts() {
            if (allProducts !== null) return Promise.resolve(allProducts);
            return fetch('/menu')
                .then(function(r) { return r.text(); })
                .then(function(html) {
                    var doc = new DOMParser().parseFromString(html, 'text/html');
                    var products = [];
                    doc.querySelectorAll('.cake-card').forEach(function(el) {
                        var name = el.dataset.cakeName;
                        if (!name) return;
                        products.push({
                            name: name,
                            image: el.dataset.cakeImage || '',
                            price: el.dataset.cakePrice || '',
                            description: el.dataset.cakeDescription || '',
                            custom: el.dataset.cakeCustom === 'true'
                        });
                    });
                    allProducts = products;
                    return products;
                })
                .catch(function() { allProducts = []; return []; });
        }

        function escapeHtml(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function findMatches(query, products) {
            var q = query.trim().toLowerCase();
            if (!q) return [];
            // Score: name-prefix match > name-contains > description-contains.
            // This gives a sensible "closest match" for Enter-to-go behavior.
            var scored = [];
            products.forEach(function(p) {
                var name = p.name.toLowerCase();
                var desc = p.description.toLowerCase();
                var score = -1;
                if (name.indexOf(q) === 0) score = 100;
                else if (name.indexOf(q) !== -1) score = 50;
                else if (desc.indexOf(q) !== -1) score = 10;
                if (score >= 0) scored.push({ p: p, score: score });
            });
            scored.sort(function(a, b) { return b.score - a.score; });
            return scored.map(function(s) { return s.p; });
        }

        function destinationFor(p) {
            // Navigate to the product detail on the menu page (NOT the order form).
            // ?cake=NAME is a client-side hint — autoOpenCakeFromUrl picks it up
            // on /menu load and auto-opens the existing cake modal for that item.
            // Custom cakes use ?q= so the menu page just filters to that one card
            // (their flow is inquiry-based and doesn't fit the order-form path).
            if (p.custom) return '/menu?q=' + encodeURIComponent(p.name);
            return '/menu?cake=' + encodeURIComponent(p.name);
        }

        function renderSuggestions(query) {
            var dd = getDropdown();
            if (!query.trim()) {
                dd.hidden = true;
                dd.innerHTML = '';
                return;
            }
            fetchProducts().then(function(products) {
                var matches = findMatches(query, products).slice(0, 6);
                if (matches.length === 0) {
                    dd.innerHTML = '<div class="app-search-no-match">No bakes match "<strong>' + escapeHtml(query.trim()) + '</strong>"</div>';
                    dd.hidden = false;
                    return;
                }
                dd.innerHTML = matches.map(function(p) {
                    var priceText = p.custom ? 'Price on request' : ('from ₹' + escapeHtml(p.price));
                    var imgStyle = p.image ? ' style="background-image:url(\'' + p.image.replace(/'/g, '%27') + '\')"' : '';
                    return '<a href="' + destinationFor(p) + '" class="app-search-suggestion">' +
                        '<div class="app-search-suggestion-img"' + imgStyle + '></div>' +
                        '<div class="app-search-suggestion-meta">' +
                        '<span class="app-search-suggestion-name">' + escapeHtml(p.name) + '</span>' +
                        '<span class="app-search-suggestion-price">' + priceText + '</span>' +
                        '</div>' +
                        '</a>';
                }).join('');
                dd.hidden = false;
            });
        }

        // Enter (or magnifier-icon click) → navigate to the CLOSEST product, not /menu.
        function submitToTopMatch() {
            var q = input.value.trim();
            if (!q) return;
            fetchProducts().then(function(products) {
                var matches = findMatches(q, products);
                if (matches.length > 0) {
                    window.location.href = destinationFor(matches[0]);
                } else {
                    // True miss — fall back to the filtered-menu view.
                    window.location.href = '/menu?q=' + encodeURIComponent(q);
                }
            });
        }

        input.addEventListener('focus', fetchProducts);    // preload on first focus
        input.addEventListener('input', function() {
            if (clear) clear.hidden = input.value.length === 0;
            renderSuggestions(input.value);
        });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitToTopMatch();
            } else if (e.key === 'Escape') {
                if (dropdown) dropdown.hidden = true;
            }
        });

        // Close dropdown when interacting outside the search area.
        document.addEventListener('mousedown', function(e) {
            if (e.target.closest('.app-search')) return;
            if (dropdown) dropdown.hidden = true;
        });
        document.addEventListener('touchstart', function(e) {
            if (e.target.closest('.app-search')) return;
            if (dropdown) dropdown.hidden = true;
        }, { passive: true });

        var icon = document.querySelector('.app-search-icon');
        if (icon) {
            icon.style.cursor = 'pointer';
            icon.addEventListener('click', submitToTopMatch);
        }
        if (clear) {
            clear.addEventListener('click', function() {
                input.value = '';
                clear.hidden = true;
                if (dropdown) dropdown.hidden = true;
                input.focus();
            });
        }
    }

    /* Read ?q=QUERY from the URL on /menu and /gallery, filter the products,
       and inject a pill at the top with a clear button. */
    function applyUrlSearchFilter() {
        var params;
        try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
        var q = (params.get('q') || '').trim();
        if (!q) return;
        var ql = q.toLowerCase();

        // Filter both .cake-card (menu) and .photo-tile (gallery).
        // For cake cards: match against name + description + category, so typing
        // "chocolate" finds cakes with chocolate in the description too, not just
        // ones with chocolate in the title.
        var visibleCount = 0;
        var totalCount = 0;
        document.querySelectorAll('.cake-card').forEach(function(el) {
            totalCount++;
            var name = (el.dataset.cakeName || '').toLowerCase();
            var desc = (el.dataset.cakeDescription || '').toLowerCase();
            var catEl = el.querySelector('.cake-cat-tag');
            var cat = catEl ? catEl.textContent.toLowerCase() : '';
            var haystack = name + ' ' + desc + ' ' + cat;
            if (haystack.indexOf(ql) === -1) {
                el.classList.add('search-hidden');
            } else {
                visibleCount++;
            }
        });
        document.querySelectorAll('.photo-tile').forEach(function(el) {
            totalCount++;
            var text = (el.dataset.name || '').toLowerCase();
            if (text.indexOf(ql) === -1) {
                el.classList.add('search-hidden');
            } else {
                visibleCount++;
            }
        });

        if (totalCount === 0) return;

        // Inject the "Showing results for X" pill at the top of the content.
        var pill = document.createElement('div');
        pill.className = 'app-search-result-pill';
        // Escape the user's query before injecting as text content.
        var safe = q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        pill.innerHTML =
            '<span class="app-search-result-text">' +
              (visibleCount > 0
                ? 'Results for "<strong>' + safe + '</strong>" (' + visibleCount + ')'
                : 'No results for "<strong>' + safe + '</strong>"') +
            '</span>' +
            '<button type="button" class="app-search-result-clear" aria-label="Clear search">Clear</button>';

        var firstSection = document.querySelector('main > section, main > div.category-bar');
        if (firstSection) {
            firstSection.parentNode.insertBefore(pill, firstSection);
        } else {
            (document.querySelector('main') || document.body).prepend(pill);
        }

        pill.querySelector('.app-search-result-clear').addEventListener('click', function() {
            window.location.href = window.location.pathname;
        });

        // No-results state: add an empty-state hint.
        if (visibleCount === 0) {
            var hint = document.createElement('div');
            hint.className = 'app-search-empty';
            hint.innerHTML =
                '<p>Nothing matched "<strong>' + safe + '</strong>".</p>' +
                '<p><a href="' + window.location.pathname + '">Browse all</a></p>';
            (document.querySelector('.cake-grid, .photo-grid') ||
             document.querySelector('main')).appendChild(hint);
        }
    }

    /* When the URL has ?cake=NAME (set by a search-suggestion tap), find the
       matching .cake-card and trigger its existing click handler so the product
       modal opens automatically — landing the user on the product detail view. */
    function autoOpenCakeFromUrl() {
        var params;
        try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
        var cakeName = params.get('cake');
        if (!cakeName) return;

        var cards = document.querySelectorAll('.cake-card');
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].dataset.cakeName === cakeName) {
                var clickable = cards[i].querySelector('.cake-image-wrap.clickable') ||
                                cards[i].querySelector('.cake-image.clickable');
                if (clickable) {
                    // Scroll the card into view first, then trigger the modal.
                    cards[i].scrollIntoView({ behavior: 'auto', block: 'center' });
                    clickable.click();
                }
                return;
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            setupAppSearch();
            applyUrlSearchFilter();
            autoOpenCakeFromUrl();
        });
    } else {
        setupAppSearch();
        applyUrlSearchFilter();
        autoOpenCakeFromUrl();
    }
})();
