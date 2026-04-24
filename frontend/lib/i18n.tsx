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
  'brand.name': 'OSHO',

  'nav.search': 'Search',
  'nav.archive': 'Archive',
  'nav.constellation': 'Constellation',
  'nav.lang.en': 'EN',
  'nav.lang.hi': 'हिं',
  'nav.theme.dark': 'Dark',
  'nav.theme.light': 'Light',

  'search.title': 'Search',
  'search.placeholder.phrase': 'e.g.  falling in love you remain a child',
  'search.placeholder.near': 'e.g.  misery attachment love',
  'search.placeholder.all': 'e.g.  silence awareness · title: vigyan · zen OR tantra',
  'search.placeholder.roman': 'e.g.  dhyaan prem shaanti moksh',
  'search.submit': 'Search',
  'search.match': 'Match',
  'search.mode.phrase': 'Exact phrase',
  'search.mode.all': 'All words',
  'search.mode.near': 'Within N words',
  'search.prox.label': 'N =',
  'search.prox.suffix': 'words',
  'search.sort': 'Sort',
  'search.sort.rank': 'Rank',
  'search.sort.title': 'Title',
  'search.results.one': '{n} discourse matched',
  'search.results.many': '{n} discourses matched',
  'search.empty.pristine':
    'Search for a word or phrase to see every discourse where Osho spoke it.',
  'search.empty.none': 'No discourses match this query.',
  'search.searching': 'searching…',
  'search.col.discourse': 'Discourse',
  'search.col.rankShort': 'Rank',
  'search.col.az': 'A→Z',
  'search.detail.emptyWithResults':
    'Select a discourse on the left to read the matched passages.',
  'search.detail.emptyPristine':
    "Matched passages — in Osho's own words — will appear here.",
  'search.detail.full': 'Full discourse',
  'search.detail.back': 'Back',
  'search.detail.topMatches': 'Top matches',
  'search.detail.para': '¶',
  'search.detail.loadingFull': 'loading full discourse…',
  'search.detail.showAll': 'Show entire discourse with matches highlighted ({n} ¶)',
  'search.translit.toggle': 'Type in Roman (phonetic)',
  'search.translit.preview': 'Hindi preview',

  'archive.title': 'Archive',
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

  'constellation.title': 'Constellation',
  'constellation.lead':
    'Every talk placed at the intersection of time, place, and theme. Click a cluster to read the talks inside.',
  'constellation.loading': 'Unfolding the Constellation...',
  'constellation.error': 'Constellation unavailable',
  'constellation.legend': 'Dot size ∝ number of talks · Theme toggles above hide/show.',
  'constellation.close': 'Close',
  'constellation.talks.one': '{n} talk',
  'constellation.talks.many': '{n} talks',

  'read.back': 'Back to Archive',
  'read.discourse': 'Discourse',
  'read.paragraphs.one': '{n} paragraph',
  'read.paragraphs.many': '{n} paragraphs',
  'read.loading': 'Unfurling the discourse...',
  'read.error': 'Discourse unavailable',
  'read.empty': 'This discourse has no paragraphs indexed yet.',
  'read.searchInstead': 'Search for this instead',
};

const HI: Dict = {
  'brand.name': 'ओशो',

  'nav.search': 'खोज',
  'nav.archive': 'संग्रह',
  'nav.constellation': 'नक्षत्र',
  'nav.lang.en': 'EN',
  'nav.lang.hi': 'हिं',
  'nav.theme.dark': 'रात',
  'nav.theme.light': 'दिन',

  'search.title': 'खोज',
  'search.placeholder.phrase': 'जैसे:  प्रेम में पड़कर तुम बच्चे रह जाते हो',
  'search.placeholder.near': 'जैसे:  दुख मोह प्रेम',
  'search.placeholder.all': 'जैसे:  मौन होश · title: ध्यान · ज़ेन OR तंत्र',
  'search.placeholder.roman': 'जैसे:  dhyaan prem shaanti moksh',
  'search.submit': 'खोजो',
  'search.match': 'खोज का तरीका',
  'search.mode.phrase': 'पूरा वाक्य',
  'search.mode.all': 'सभी शब्द',
  'search.mode.near': 'N शब्दों के बीच',
  'search.prox.label': 'N =',
  'search.prox.suffix': 'शब्द',
  'search.sort': 'क्रम',
  'search.sort.rank': 'मिलान से',
  'search.sort.title': 'शीर्षक से',
  'search.results.one': '{n} प्रवचन मिला',
  'search.results.many': '{n} प्रवचन मिले',
  'search.empty.pristine':
    'कोई शब्द या वाक्य खोजो — जहाँ भी ओशो ने उसे कहा हो, सारे प्रवचन यहीं दिखेंगे।',
  'search.empty.none': 'इस खोज से कोई प्रवचन नहीं मिला।',
  'search.searching': 'ढूंढ रहे हैं…',
  'search.col.discourse': 'प्रवचन',
  'search.col.rankShort': 'क्रम',
  'search.col.az': 'अ→ह',
  'search.detail.emptyWithResults':
    'बाईं तरफ़ से कोई प्रवचन चुनो — मिले हुए अंश यहाँ खुल जाएंगे।',
  'search.detail.emptyPristine':
    'मिले हुए अंश — ओशो के अपने शब्दों में — यहाँ दिखेंगे।',
  'search.detail.full': 'पूरा प्रवचन',
  'search.detail.back': 'वापस',
  'search.detail.topMatches': 'सबसे अच्छे मिले अंश',
  'search.detail.para': '¶',
  'search.detail.loadingFull': 'पूरा प्रवचन खुल रहा है…',
  'search.detail.showAll': 'पूरा प्रवचन देखो — हर मिलान हाईलाइट ({n} ¶)',
  'search.translit.toggle': 'रोमन में लिखो (उच्चारण से)',
  'search.translit.preview': 'हिंदी में',

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
  'read.searchInstead': 'इसके बदले खोज में देखो',
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
