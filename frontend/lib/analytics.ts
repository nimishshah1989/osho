export const GA_ID = 'G-4K38GJG2WQ';

declare global {
  interface Window {
    gtag: (...args: unknown[]) => void;
    dataLayer: unknown[];
  }
}

function gtag(...args: unknown[]) {
  if (typeof window === 'undefined' || !window.gtag) return;
  window.gtag(...args);
}

// ── Page view (called manually for SPA navigations) ──
export function trackPageView(url: string) {
  gtag('config', GA_ID, { page_path: url });
}

// ── Search submitted ──
export function trackSearch(params: {
  query: string;
  mode: 'phrase' | 'all' | 'near';
  language: string;       // 'en' | 'hi' | 'all'
  proxDist?: number;      // only for near mode
  resultCount: number;
  hitCount: number;
}) {
  gtag('event', 'search', {
    search_term:   params.query,
    search_mode:   params.mode,
    search_lang:   params.language,
    prox_distance: params.proxDist ?? null,
    result_count:  params.resultCount,
    hit_count:     params.hitCount,
  });
}

// ── Zero results ──
export function trackSearchEmpty(query: string, mode: string) {
  gtag('event', 'search_empty', {
    search_term: query,
    search_mode: mode,
  });
}

// ── User clicks a discourse from search results ──
export function trackResultClick(params: {
  eventId: string;
  title: string;
  rank: number;
  query: string;
  mode: string;
}) {
  gtag('event', 'result_click', {
    event_id:    params.eventId,
    title:       params.title,
    result_rank: params.rank,
    search_term: params.query,
    search_mode: params.mode,
  });
}

// ── Full discourse opened ──
export function trackDiscourseOpen(eventId: string, title: string, source: 'search' | 'direct') {
  gtag('event', 'discourse_open', {
    event_id: eventId,
    title,
    source,
  });
}

// ── Search mode changed ──
export function trackModeChange(from: string, to: string) {
  gtag('event', 'mode_change', { from_mode: from, to_mode: to });
}

// ── Proximity distance changed ──
export function trackProxChange(distance: number, via: 'preset' | 'input') {
  gtag('event', 'prox_change', { distance, via });
}

// ── Language filter toggled ──
export function trackLanguageFilter(lang: string) {
  gtag('event', 'language_filter', { language: lang });
}

// ── UI language toggled (EN ↔ HI) ──
export function trackLocaleToggle(locale: string) {
  gtag('event', 'locale_toggle', { locale });
}

// ── Sort order changed ──
export function trackSortChange(sort: string) {
  gtag('event', 'sort_change', { sort });
}

// ── Zen tree: branch (question) clicked ──
export function trackZenBranch(question: string, situation: string) {
  gtag('event', 'zen_branch_click', {
    question,
    situation,
  });
}

// ── Zen tree: leaf (teaching) opened ──
export function trackZenLeaf(title: string, branch: string, situation: string) {
  gtag('event', 'zen_leaf_open', {
    title,
    branch,
    situation,
  });
}

// ── Help page viewed ──
export function trackHelpView() {
  gtag('event', 'help_view', {});
}

// ── Archive page: series clicked ──
export function trackArchiveClick(seriesTitle: string) {
  gtag('event', 'archive_click', { series_title: seriesTitle });
}
