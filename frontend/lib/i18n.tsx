'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

export type Locale = 'en' | 'hi';

type Dict = Record<string, string>;

const STORAGE_KEY = 'osho:locale';

const EN: Dict = {
  'brand.tagline': 'SPEAKS..',
  'nav.archive': 'Archive',
  'nav.constellation': 'Constellation',
  'nav.ask': 'Ask',
  'nav.lang.en': 'EN',
  'nav.lang.hi': 'हिं',

  'ask.title': 'Ask — Keyword Search',
  'ask.placeholder.phrase': 'e.g.  falling in love you remain a child',
  'ask.placeholder.near': 'e.g.  misery attachment love',
  'ask.placeholder.all': 'e.g.  silence awareness · title: vigyan · zen OR tantra',
  'ask.submit': 'Search',
  'ask.match': 'Match',
  'ask.mode.phrase': 'Exact phrase',
  'ask.mode.all': 'All words',
  'ask.mode.near': 'Within N words',
  'ask.prox.label': 'N =',
  'ask.prox.suffix': 'words',
  'ask.sort': 'Sort',
  'ask.sort.rank': 'Rank',
  'ask.sort.title': 'Title',
  'ask.results.one': '{n} discourse matched',
  'ask.results.many': '{n} discourses matched',
  'ask.empty.pristine':
    'Search for a word or phrase to see every discourse where Osho spoke it.',
  'ask.empty.none': 'No discourses match this query.',
  'ask.searching': 'searching…',
  'ask.col.discourse': 'Discourse',
  'ask.col.rankShort': 'Rank',
  'ask.col.az': 'A→Z',
  'ask.detail.emptyWithResults':
    'Select a discourse on the left to read the matched passages.',
  'ask.detail.emptyPristine':
    "Matched passages — in Osho's own words — will appear here.",
  'ask.detail.full': 'Full discourse',
  'ask.detail.back': 'Back',
  'ask.detail.topMatches': 'Top matches',
  'ask.detail.para': '¶',
  'ask.detail.loadingFull': 'loading full discourse…',
  'ask.detail.showAll': 'Show entire discourse with matches highlighted ({n} ¶)',

  'archive.title': 'The Archive',
  'archive.lead':
    'Every indexed discourse, grouped by the lens of your choice. Click any talk to read it in full.',
  'archive.lens.time': 'By Year',
  'archive.lens.era': 'By Era',
  'archive.lens.geography': 'By Place',
  'archive.lens.theme': 'By Theme',
  'archive.loading': 'Unfolding the Archive...',
  'archive.error': 'Archive unavailable',
  'archive.empty': 'The archive appears empty.',
  'archive.talks.one': '{n} talk',
  'archive.talks.many': '{n} talks',

  'constellation.title': 'The Constellation',
  'constellation.lead':
    'Every talk placed at the intersection of time, place, and theme. Click a cluster to read the talks inside.',
  'constellation.loading': 'Unfolding the Constellation...',
  'constellation.error': 'Constellation unavailable',
  'constellation.legend': 'Dot size ∝ number of talks · Theme toggles above hide/show.',
  'constellation.close': 'Close',
  'constellation.talks.one': '{n} talk',
  'constellation.talks.many': '{n} talks',

  'read.back': 'Back to the Archive',
  'read.discourse': 'Discourse',
  'read.paragraphs.one': '{n} paragraph',
  'read.paragraphs.many': '{n} paragraphs',
  'read.loading': 'Unfurling the discourse...',
  'read.error': 'Discourse unavailable',
  'read.empty': 'This discourse has no paragraphs indexed yet.',
  'read.askInstead': 'Ask Osho about this instead',
};

// Colloquial, everyday Hindi — avoids Sanskritized / formal register.
const HI: Dict = {
  'brand.tagline': 'बोल रहे हैं..',
  'nav.archive': 'संग्रह',
  'nav.constellation': 'नक्षत्र',
  'nav.ask': 'पूछो',
  'nav.lang.en': 'EN',
  'nav.lang.hi': 'हिं',

  'ask.title': 'पूछो — शब्द से खोज',
  'ask.placeholder.phrase': 'जैसे:  प्रेम में पड़कर तुम बच्चे रह जाते हो',
  'ask.placeholder.near': 'जैसे:  दुख मोह प्रेम',
  'ask.placeholder.all': 'जैसे:  मौन होश · title: ध्यान · ज़ेन OR तंत्र',
  'ask.submit': 'खोजो',
  'ask.match': 'खोज का तरीका',
  'ask.mode.phrase': 'पूरा वाक्य',
  'ask.mode.all': 'सभी शब्द',
  'ask.mode.near': 'N शब्दों के बीच',
  'ask.prox.label': 'N =',
  'ask.prox.suffix': 'शब्द',
  'ask.sort': 'क्रम',
  'ask.sort.rank': 'मिलान से',
  'ask.sort.title': 'शीर्षक से',
  'ask.results.one': '{n} प्रवचन मिला',
  'ask.results.many': '{n} प्रवचन मिले',
  'ask.empty.pristine':
    'कोई शब्द या वाक्य खोजो — जहाँ भी ओशो ने उसे कहा हो, सारे प्रवचन यहीं दिखेंगे।',
  'ask.empty.none': 'इस खोज से कोई प्रवचन नहीं मिला।',
  'ask.searching': 'ढूंढ रहे हैं…',
  'ask.col.discourse': 'प्रवचन',
  'ask.col.rankShort': 'क्रम',
  'ask.col.az': 'अ→ह',
  'ask.detail.emptyWithResults':
    'बाईं तरफ़ से कोई प्रवचन चुनो — मिले हुए अंश यहाँ खुल जाएंगे।',
  'ask.detail.emptyPristine':
    'मिले हुए अंश — ओशो के अपने शब्दों में — यहाँ दिखेंगे।',
  'ask.detail.full': 'पूरा प्रवचन',
  'ask.detail.back': 'वापस',
  'ask.detail.topMatches': 'सबसे अच्छे मिले अंश',
  'ask.detail.para': '¶',
  'ask.detail.loadingFull': 'पूरा प्रवचन खुल रहा है…',
  'ask.detail.showAll': 'पूरा प्रवचन देखो — हर मिलान हाईलाइट ({n} ¶)',

  'archive.title': 'संग्रह',
  'archive.lead':
    'ओशो के सारे प्रवचन — अपनी पसंद के हिसाब से सजाए हुए। किसी भी प्रवचन पर क्लिक करो और पूरा पढ़ो।',
  'archive.lens.time': 'साल से',
  'archive.lens.era': 'युग से',
  'archive.lens.geography': 'जगह से',
  'archive.lens.theme': 'विषय से',
  'archive.loading': 'संग्रह खुल रहा है...',
  'archive.error': 'संग्रह उपलब्ध नहीं',
  'archive.empty': 'संग्रह अभी खाली दिख रहा है।',
  'archive.talks.one': '{n} प्रवचन',
  'archive.talks.many': '{n} प्रवचन',

  'constellation.title': 'नक्षत्र',
  'constellation.lead':
    'हर प्रवचन — समय, जगह और विषय के चौराहे पर। किसी भी समूह पर क्लिक करो और उसमें के प्रवचन पढ़ो।',
  'constellation.loading': 'नक्षत्र खुल रहा है...',
  'constellation.error': 'नक्षत्र उपलब्ध नहीं',
  'constellation.legend':
    'बिंदु का आकार = प्रवचनों की संख्या · ऊपर के बटन से विषय दिखाओ/छिपाओ।',
  'constellation.close': 'बंद करो',
  'constellation.talks.one': '{n} प्रवचन',
  'constellation.talks.many': '{n} प्रवचन',

  'read.back': 'वापस संग्रह में',
  'read.discourse': 'प्रवचन',
  'read.paragraphs.one': '{n} अंश',
  'read.paragraphs.many': '{n} अंश',
  'read.loading': 'प्रवचन खुल रहा है...',
  'read.error': 'प्रवचन उपलब्ध नहीं',
  'read.empty': 'इस प्रवचन के अंश अभी तैयार नहीं हैं।',
  'read.askInstead': 'इसके बदले खोज में देखो',
};

const DICTS: Record<Locale, Dict> = { en: EN, hi: HI };

interface Ctx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<Ctx>({
  locale: 'en',
  setLocale: () => {},
  t: (k) => k,
});

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'hi' || stored === 'en') setLocaleState(stored);
    } catch {
      /* localStorage blocked */
    }
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* noop */
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const raw = DICTS[locale][key] ?? EN[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
    },
    [locale],
  );

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): Ctx {
  return useContext(LocaleContext);
}
