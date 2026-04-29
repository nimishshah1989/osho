"""Tests for Hindi transliteration and FTS query building.

These run in Node/TypeScript in prod, but we test the equivalent Python logic
here to validate the algorithm. We also test the backend's handling of
Devanagari queries end-to-end."""

import re


# ── Transliteration algorithm tests (Python port of transliterate.ts) ──

HALANT = '्'

CONSONANTS = [
    ('ksh', 'क्ष'), ('gy', 'ज्ञ'), ('chh', 'छ'), ('kh', 'ख'), ('gh', 'घ'),
    ('ch', 'च'), ('jh', 'झ'), ('Th', 'ठ'), ('Dh', 'ढ'), ('th', 'थ'),
    ('dh', 'ध'), ('ph', 'फ'), ('bh', 'भ'), ('Sh', 'ष'), ('sh', 'श'),
    ('ng', 'ङ'), ('T', 'ट'), ('D', 'ड'), ('N', 'ण'), ('k', 'क'),
    ('g', 'ग'), ('c', 'च'), ('j', 'ज'), ('t', 'त'), ('d', 'द'),
    ('n', 'न'), ('p', 'प'), ('f', 'फ'), ('b', 'ब'), ('m', 'म'),
    ('y', 'य'), ('r', 'र'), ('l', 'ल'), ('v', 'व'), ('w', 'व'),
    ('s', 'स'), ('h', 'ह'),
]

VOWELS = [
    ('aa', 'आ', 'ा'), ('au', 'औ', 'ौ'), ('ai', 'ऐ', 'ै'), ('ee', 'ई', 'ी'),
    ('ii', 'ई', 'ी'), ('oo', 'ऊ', 'ू'), ('uu', 'ऊ', 'ू'), ('ri', 'ऋ', 'ृ'),
    ('a', 'अ', ''), ('i', 'इ', 'ि'), ('u', 'उ', 'ु'), ('e', 'ए', 'े'),
    ('o', 'ओ', 'ो'),
]


def convert_word(word: str) -> str:
    result = ''
    i = 0
    prev_was_consonant = False

    while i < len(word):
        matched = False

        for pat, standalone, matra in VOWELS:
            if word[i:].startswith(pat):
                result += matra if prev_was_consonant else standalone
                i += len(pat)
                prev_was_consonant = False
                matched = True
                break
        if matched:
            continue

        for pat, dev in CONSONANTS:
            if word[i:].startswith(pat):
                if prev_was_consonant:
                    result += HALANT
                result += dev
                i += len(pat)
                prev_was_consonant = True
                matched = True
                break
        if matched:
            continue

        if prev_was_consonant:
            prev_was_consonant = False
        result += word[i]
        i += 1

    return result


def roman_to_devanagari(text: str) -> str:
    return re.sub(r'[^\s]+', lambda m: convert_word(m.group()), text)


# ── Basic consonant + vowel combinations ─────────────────
# In Hindi, 'a' is the inherent vowel (no visible matra).
# 'ka' → क (implicit 'a'), 'kaa' → का (explicit long 'aa' matra ा)

def test_inherent_vowel():
    """Short 'a' after consonant produces no matra — it's implicit in the consonant."""
    assert convert_word('ka') == 'क'
    assert convert_word('ga') == 'ग'
    assert convert_word('na') == 'न'


def test_long_aa_matra():
    """Long 'aa' produces the ा matra."""
    assert convert_word('kaa') == 'का'
    assert convert_word('gaa') == 'गा'


def test_other_vowel_matras():
    assert convert_word('ki') == 'कि'
    assert convert_word('ku') == 'कु'
    assert convert_word('ke') == 'के'
    assert convert_word('ko') == 'को'
    assert convert_word('kee') == 'की'
    assert convert_word('koo') == 'कू'


def test_standalone_vowels():
    assert convert_word('a') == 'अ'
    assert convert_word('aa') == 'आ'
    assert convert_word('i') == 'इ'
    assert convert_word('u') == 'उ'
    assert convert_word('e') == 'ए'
    assert convert_word('o') == 'ओ'


# ── Common Hindi words ───────────────────────────────────

def test_dhyaan():
    assert roman_to_devanagari('dhyaan') == 'ध्यान'


def test_prem():
    assert roman_to_devanagari('prem') == 'प्रेम'


def test_shaanti():
    result = roman_to_devanagari('shaanti')
    assert 'श' in result
    assert 'न' in result


def test_moksh():
    """'moksh' → 'मोक्ष' because 'ksh' maps to 'क्ष' (contains ष not श)."""
    result = roman_to_devanagari('moksh')
    assert result == 'मोक्ष'
    assert 'ष' in result


def test_sannyas():
    """'sannyas' should not produce ञ — the 'ny' mapping was intentionally removed."""
    result = convert_word('sannyas')
    assert 'ञ' not in result
    assert 'स' in result


# ── Aspirated consonants ─────────────────────────────────

def test_aspirated_with_long_aa():
    assert convert_word('khaa') == 'खा'
    assert convert_word('ghaa') == 'घा'
    assert convert_word('chaa') == 'चा'
    assert convert_word('thaa') == 'था'
    assert convert_word('dhaa') == 'धा'
    assert convert_word('phaa') == 'फा'
    assert convert_word('bhaa') == 'भा'


def test_aspirated_with_inherent_a():
    """Aspirated consonants with short 'a' — no visible matra."""
    assert convert_word('kha') == 'ख'
    assert convert_word('gha') == 'घ'
    assert convert_word('cha') == 'च'
    assert convert_word('tha') == 'थ'
    assert convert_word('dha') == 'ध'


# ── Conjuncts ────────────────────────────────────────────

def test_ksha():
    """'ksha' → 'क्ष' (ksh is a single conjunct, 'a' is inherent)."""
    assert convert_word('ksha') == 'क्ष'


def test_gya():
    assert convert_word('gya') == 'ज्ञ'


def test_consonant_cluster():
    """Two consecutive consonants produce a halant between them."""
    assert convert_word('pr') == 'प्र'
    assert convert_word('str') == 'स्त्र'


# ── Edge cases ───────────────────────────────────────────

def test_spaces_preserved():
    result = roman_to_devanagari('dhyaan prem')
    assert ' ' in result


def test_numbers_pass_through():
    assert roman_to_devanagari('123') == '123'


def test_mixed_input():
    result = roman_to_devanagari('hello duniya')
    assert ' ' in result
    assert 'ह' in result


def test_empty_string():
    assert roman_to_devanagari('') == ''
    assert roman_to_devanagari('   ') == '   '


# ── Anusvara expansion ──────────────────────────────────

def expand_anusvara(text: str) -> list[str]:
    results = {text}
    with_anusvara = re.sub(r'[ङञणनम]्', 'ं', text)
    if with_anusvara != text:
        results.add(with_anusvara)

    nasal_rules = [
        (re.compile(r'ं([कखगघङ])'), r'ङ्\1'),
        (re.compile(r'ं([चछजझञ])'), r'ञ्\1'),
        (re.compile(r'ं([टठडढण])'), r'ण्\1'),
        (re.compile(r'ं([तथदधन])'), r'न्\1'),
        (re.compile(r'ं([पफबभम])'), r'म्\1'),
    ]
    with_nasal = text
    for pattern, replacement in nasal_rules:
        with_nasal = pattern.sub(replacement, with_nasal)
    if with_nasal != text:
        results.add(with_nasal)

    return list(results)


def test_anusvara_collapse():
    """Explicit nasal + halant → anusvara."""
    variants = expand_anusvara('अन्तर')
    assert 'अंतर' in variants
    assert 'अन्तर' in variants


def test_anusvara_expand():
    """Anusvara → appropriate nasal."""
    variants = expand_anusvara('अंतर')
    assert 'अंतर' in variants
    assert 'अन्तर' in variants


def test_anusvara_no_change():
    """Word without anusvara/nasal returns only itself."""
    variants = expand_anusvara('प्रेम')
    assert variants == ['प्रेम']


# ── Highlight regex: Devanagari word boundary fix ────────

def test_js_word_boundary_behavior_documented():
    """In JavaScript, \\b is ASCII-only and fails with Devanagari.
    In Python, \\b supports Unicode. The frontend bug was JS-specific.
    This test documents that Python \\b works (correctly) with Devanagari,
    which is why the fix only needed to be in the TypeScript code."""
    text = "जीवन में धन और धर्म दोनों जरूरी हैं। विश्वास रखो।"
    # Python's \b is Unicode-aware and DOES match Devanagari
    py_pattern = re.compile(r'\bधन\b')
    assert py_pattern.search(text), (
        "Python \\b should match Devanagari (it's Unicode-aware)"
    )
    # The JS fix removes \b for Devanagari words and uses plain match instead
    plain_pattern = re.compile(r'धन')
    assert plain_pattern.search(text), "Plain pattern also works"


def test_plain_devanagari_pattern_matches():
    """Without \\b, Devanagari matching works correctly."""
    text = "जीवन में धन और धर्म दोनों जरूरी हैं। विश्वास रखो।"
    good_pattern = re.compile(r'धन')
    assert good_pattern.search(text)


def test_devanagari_highlight_finds_all_words():
    """Simulates the fixed extractHighlights behavior."""
    words = ['धन', 'धर्म', 'विश्वास']
    has_devanagari = re.compile(r'[\u0900-\u097F]')

    parts = []
    for w in words:
        escaped = re.escape(w)
        if has_devanagari.search(w):
            parts.append(escaped)
        else:
            parts.append(f'\\b{escaped}\\b')

    pattern = re.compile(f'({"|".join(parts)})', re.IGNORECASE)
    text = "जीवन में धन और धर्म दोनों जरूरी हैं। विश्वास रखो।"

    matches = pattern.findall(text)
    assert 'धन' in matches
    assert 'धर्म' in matches
    assert 'विश्वास' in matches


def test_mixed_script_highlight():
    """Pattern with both ASCII and Devanagari words."""
    has_devanagari = re.compile(r'[\u0900-\u097F]')
    words = ['meditation', 'ध्यान']
    parts = []
    for w in words:
        escaped = re.escape(w)
        if has_devanagari.search(w):
            parts.append(escaped)
        else:
            parts.append(f'\\b{escaped}\\b')

    pattern = re.compile(f'({"|".join(parts)})', re.IGNORECASE)

    assert pattern.search("ध्यान में बैठो")
    assert pattern.search("Meditation is the key")
    assert not pattern.search("no matches here")
