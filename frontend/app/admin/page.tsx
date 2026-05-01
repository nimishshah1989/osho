'use client';

import React, { useCallback, useEffect, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language: string | null;
  tags: string[];
}

interface TagRow { tag: string; count: number }

const COMMON_TAGS = [
  'love','meditation','death','god','freedom','awareness','silence','mind','ego',
  'consciousness','bliss','truth','existence','creativity','fear','anger','body',
  'breath','dreams','energy','surrender','devotion','transformation','society',
  'relationship','sex','courage','loneliness','children','education','science',
  'beauty','laughter','art','nature','women','disciple','enlightenment','prayer','religion',
];

const LANGUAGES = ['English', 'Hindi'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function useAdminKey() {
  const [key, setKey] = useState('');
  useEffect(() => {
    setKey(sessionStorage.getItem('admin-key') ?? '');
  }, []);
  return [key, (k: string) => { sessionStorage.setItem('admin-key', k); setKey(k); }] as const;
}

function api(path: string, key: string, opts?: RequestInit) {
  return fetch(`/api/admin/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key, ...(opts?.headers ?? {}) },
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TagPicker({
  value, onChange,
}: { value: string[]; onChange: (t: string[]) => void }) {
  const [custom, setCustom] = useState('');
  const toggle = (t: string) =>
    onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  const addCustom = () => {
    const t = custom.trim().toLowerCase();
    if (t && !value.includes(t)) { onChange([...value, t]); setCustom(''); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {COMMON_TAGS.map((t) => (
          <button key={t} type="button" onClick={() => toggle(t)}
            className={`px-2 py-0.5 rounded text-xs border transition-colors ${
              value.includes(t)
                ? 'bg-amber-600 border-amber-600 text-white'
                : 'border-stone-300 text-stone-500 hover:border-amber-500'
            }`}>{t}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={custom} onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCustom())}
          placeholder="custom tag…"
          className="flex-1 px-2 py-1 text-xs border border-stone-300 rounded focus:outline-none focus:border-amber-500" />
        <button type="button" onClick={addCustom}
          className="px-3 py-1 text-xs bg-stone-100 border border-stone-300 rounded hover:bg-stone-200">+ Add</button>
      </div>
      {value.length > 0 && (
        <p className="text-xs text-stone-500">Selected: {value.join(', ')}</p>
      )}
    </div>
  );
}

function FieldInput({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-stone-600 uppercase tracking-wider">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 text-sm border border-stone-300 rounded focus:outline-none focus:border-amber-500" />
    </label>
  );
}

// ─── Upload Tab ───────────────────────────────────────────────────────────────

function UploadTab({ adminKey }: { adminKey: string }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [location, setLocation] = useState('');
  const [language, setLanguage] = useState('English');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      setStatus({ ok: false, msg: 'Title and content are required.' }); return;
    }
    setLoading(true); setStatus(null);
    try {
      const res = await api('ingest', adminKey, {
        method: 'POST',
        body: JSON.stringify({ title, date, location, language, content, tags }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus({ ok: true, msg: `Ingested! ${data.paragraphs} paragraphs · auto-tags: ${data.tags.join(', ') || 'none'}` });
        setTitle(''); setDate(''); setLocation(''); setContent(''); setTags([]);
      } else {
        setStatus({ ok: false, msg: data.detail ?? 'Ingest failed.' });
      }
    } catch {
      setStatus({ ok: false, msg: 'Network error.' });
    }
    setLoading(false);
  };

  return (
    <form onSubmit={submit} className="space-y-5 max-w-2xl">
      <FieldInput label="Title *" value={title} onChange={setTitle} placeholder="e.g. The Book of Secrets ~ Chapter 1" />
      <div className="grid grid-cols-2 gap-4">
        <FieldInput label="Date" value={date} onChange={setDate} placeholder="YYYY-MM-DD or YYYY" />
        <label className="block space-y-1">
          <span className="text-xs font-medium text-stone-600 uppercase tracking-wider">Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-stone-300 rounded focus:outline-none focus:border-amber-500">
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
      </div>
      <FieldInput label="Location" value={location} onChange={setLocation} placeholder="e.g. Pune, Maharashtra, India" />

      <label className="block space-y-1">
        <span className="text-xs font-medium text-stone-600 uppercase tracking-wider">Tags (optional — will also auto-classify)</span>
        <TagPicker value={tags} onChange={setTags} />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-stone-600 uppercase tracking-wider">Talk content *</span>
        <textarea value={content} onChange={(e) => setContent(e.target.value)}
          rows={14} placeholder="Paste the full text of the talk here…"
          className="w-full px-3 py-2 text-sm border border-stone-300 rounded focus:outline-none focus:border-amber-500 font-mono resize-y" />
        <p className="text-xs text-stone-400">Paragraphs are split on blank lines. Minimum 20 characters per paragraph.</p>
      </label>

      <div className="flex items-center gap-4">
        <button type="submit" disabled={loading}
          className="px-5 py-2 bg-amber-600 text-white text-sm rounded hover:bg-amber-700 disabled:opacity-50 transition-colors">
          {loading ? 'Ingesting…' : 'Ingest Talk'}
        </button>
        {status && (
          <p className={`text-sm ${status.ok ? 'text-green-700' : 'text-red-600'}`}>{status.msg}</p>
        )}
      </div>
    </form>
  );
}

// ─── Edit row inline ──────────────────────────────────────────────────────────

function EditRow({
  event, adminKey, onSaved, onDeleted,
}: { event: EventRow; adminKey: string; onSaved: (e: EventRow) => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(event.title ?? '');
  const [date, setDate] = useState(event.date ?? '');
  const [location, setLocation] = useState(event.location ?? '');
  const [language, setLanguage] = useState(event.language ?? 'English');
  const [tags, setTags] = useState<string[]>(event.tags);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState('');

  const save = async () => {
    setSaving(true); setMsg('');
    await api(`events/${event.id}`, adminKey, {
      method: 'PATCH',
      body: JSON.stringify({ title, date, location, language }),
    });
    await api(`events/${event.id}/tags`, adminKey, {
      method: 'PUT', body: JSON.stringify({ tags }),
    });
    setSaving(false); setMsg('Saved');
    onSaved({ ...event, title, date, location, language, tags });
  };

  const del = async () => {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setDeleting(true);
    await api(`events/${event.id}`, adminKey, { method: 'DELETE' });
    onDeleted();
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 block space-y-1">
          <span className="text-xs text-stone-500">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full px-2 py-1 border border-stone-300 rounded text-sm focus:outline-none focus:border-amber-500" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-stone-500">Date</span>
          <input value={date} onChange={(e) => setDate(e.target.value)}
            className="w-full px-2 py-1 border border-stone-300 rounded text-sm focus:outline-none focus:border-amber-500" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-stone-500">Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}
            className="w-full px-2 py-1 border border-stone-300 rounded text-sm focus:outline-none focus:border-amber-500">
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label className="col-span-2 block space-y-1">
          <span className="text-xs text-stone-500">Location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)}
            className="w-full px-2 py-1 border border-stone-300 rounded text-sm focus:outline-none focus:border-amber-500" />
        </label>
      </div>
      <div>
        <p className="text-xs text-stone-500 mb-1.5">Tags</p>
        <TagPicker value={tags} onChange={setTags} />
      </div>
      <div className="flex items-center gap-3 pt-1">
        <button onClick={save} disabled={saving}
          className="px-4 py-1.5 bg-amber-600 text-white text-xs rounded hover:bg-amber-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        <button onClick={del} disabled={deleting}
          className="px-4 py-1.5 bg-red-600 text-white text-xs rounded hover:bg-red-700 disabled:opacity-50">
          {deleting ? 'Deleting…' : 'Delete Talk'}
        </button>
        {msg && <span className="text-green-700 text-xs">{msg}</span>}
      </div>
    </div>
  );
}

// ─── Browse Tab ───────────────────────────────────────────────────────────────

function BrowseTab({ adminKey }: { adminKey: string }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [langFilter, setLangFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const perPage = 50;

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (q) params.set('q', q);
    if (langFilter) params.set('language', langFilter);
    const res = await api(`events?${params}`, adminKey);
    const data = await res.json();
    setEvents(data.events ?? []);
    setTotal(data.total ?? 0);
    setLoading(false);
  }, [adminKey, page, q, langFilter]);

  useEffect(() => { load(); }, [load]);

  const pages = Math.ceil(total / perPage);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center flex-wrap">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Search title or location…"
          className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-stone-300 rounded focus:outline-none focus:border-amber-500" />
        <select value={langFilter} onChange={(e) => { setLangFilter(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-stone-300 rounded focus:outline-none focus:border-amber-500">
          <option value="">All Languages</option>
          {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <span className="text-sm text-stone-500">{total.toLocaleString()} talks</span>
      </div>

      {loading ? (
        <p className="text-sm text-stone-400 py-4">Loading…</p>
      ) : (
        <div className="space-y-1">
          {events.map((ev) => (
            <div key={ev.id}>
              <button
                type="button"
                onClick={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                className="w-full text-left px-3 py-2.5 rounded border border-stone-200 hover:border-amber-300 hover:bg-amber-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-stone-800 truncate">{ev.title ?? '—'}</p>
                    <p className="text-xs text-stone-400 mt-0.5">
                      {[ev.date?.slice(0,10), ev.location, ev.language].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1 justify-end max-w-[200px]">
                    {ev.tags.slice(0, 4).map((t) => (
                      <span key={t} className="text-[10px] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">{t}</span>
                    ))}
                    {ev.tags.length > 4 && (
                      <span className="text-[10px] text-stone-400">+{ev.tags.length - 4}</span>
                    )}
                  </div>
                </div>
              </button>
              {expandedId === ev.id && (
                <EditRow
                  event={ev} adminKey={adminKey}
                  onSaved={(updated) => setEvents((prev) => prev.map((e) => e.id === updated.id ? updated : e))}
                  onDeleted={() => { setEvents((prev) => prev.filter((e) => e.id !== ev.id)); setExpandedId(null); }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center gap-3 pt-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
            className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50 disabled:opacity-40">← Prev</button>
          <span className="text-sm text-stone-500">Page {page} of {pages}</span>
          <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}
            className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50 disabled:opacity-40">Next →</button>
        </div>
      )}
    </div>
  );
}

// ─── Tags Tab ─────────────────────────────────────────────────────────────────

function TagsTab({ adminKey }: { adminKey: string }) {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tagEvents, setTagEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api('all-tags', adminKey).then((r) => r.json()).then((d) => setTags(d.tags ?? []));
  }, [adminKey]);

  const selectTag = async (tag: string) => {
    if (selected === tag) { setSelected(null); setTagEvents([]); return; }
    setSelected(tag); setLoading(true);
    const res = await api(`events?per_page=200&q=${encodeURIComponent(tag)}`, adminKey);
    const data = await res.json();
    // Filter to only events that actually have this tag
    setTagEvents((data.events ?? []).filter((e: EventRow) => e.tags.includes(tag)));
    setLoading(false);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-500">{tags.length} tags across all talks. Click a tag to see which talks have it.</p>
      <div className="flex flex-wrap gap-2">
        {tags.map(({ tag, count }) => (
          <button key={tag} onClick={() => selectTag(tag)}
            className={`px-3 py-1 rounded-full text-xs border transition-colors ${
              selected === tag
                ? 'bg-amber-600 border-amber-600 text-white'
                : 'border-stone-300 text-stone-600 hover:border-amber-500'
            }`}>
            {tag} <span className="opacity-70">{count.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-stone-700">
            Talks tagged <strong>"{selected}"</strong>
            {!loading && ` — ${tagEvents.length.toLocaleString()}`}
          </p>
          {loading ? (
            <p className="text-sm text-stone-400">Loading…</p>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {tagEvents.map((ev) => (
                <div key={ev.id} className="px-3 py-2 border border-stone-200 rounded text-sm">
                  <p className="font-medium text-stone-800">{ev.title}</p>
                  <p className="text-xs text-stone-400">
                    {[ev.date?.slice(0,10), ev.location, ev.language].filter(Boolean).join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Login screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }: { onLogin: (k: string) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const attempt = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await api('all-tags', input);
      if (res.ok) { onLogin(input); }
      else { setError('Wrong password.'); }
    } catch {
      setError('Could not reach server.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50">
      <form onSubmit={attempt} className="bg-white shadow rounded-lg p-8 space-y-5 w-80">
        <div>
          <h1 className="text-xl font-semibold text-stone-800">Osho Admin</h1>
          <p className="text-sm text-stone-500 mt-1">Enter the admin password to continue.</p>
        </div>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Password"
          className="w-full px-3 py-2 border border-stone-300 rounded focus:outline-none focus:border-amber-500"
          autoFocus
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={loading}
          className="w-full py-2 bg-amber-600 text-white text-sm rounded hover:bg-amber-700 disabled:opacity-50 transition-colors">
          {loading ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

type Tab = 'upload' | 'browse' | 'tags';

export default function AdminPage() {
  const [adminKey, setAdminKey] = useAdminKey();
  const [tab, setTab] = useState<Tab>('upload');

  if (!adminKey) return <LoginScreen onLogin={setAdminKey} />;

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between">
        <h1 className="text-base font-semibold text-stone-800">Osho Admin</h1>
        <button
          onClick={() => { sessionStorage.removeItem('admin-key'); setAdminKey(''); }}
          className="text-xs text-stone-400 hover:text-stone-700 transition-colors"
        >
          Logout
        </button>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Tabs */}
        <div className="flex gap-1 border-b border-stone-200 pb-3">
          {(['upload', 'browse', 'tags'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm rounded transition-colors capitalize ${
                tab === t
                  ? 'bg-amber-600 text-white'
                  : 'text-stone-500 hover:text-stone-800'
              }`}>{t === 'upload' ? 'Upload New Talk' : t === 'browse' ? 'Browse & Edit' : 'Tags'}</button>
          ))}
        </div>

        {tab === 'upload' && <UploadTab adminKey={adminKey} />}
        {tab === 'browse' && <BrowseTab adminKey={adminKey} />}
        {tab === 'tags'   && <TagsTab   adminKey={adminKey} />}
      </div>
    </div>
  );
}
