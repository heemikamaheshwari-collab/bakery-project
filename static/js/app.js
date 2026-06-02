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
})();
