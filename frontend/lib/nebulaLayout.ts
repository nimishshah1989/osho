import type { Lens } from '../components/Nebula/LensSwitcher';

export interface NebulaNode {
  id: string;
  title: string;
  galaxy: string;
  color: string;
  pos: [number, number, number];
  date: string;
}

export interface ClusterDef {
  name: string;
  color: string;
  centroid: [number, number, number];
  size: number;
  memberIndices: number[];
}

export interface LayoutResult {
  clusters: ClusterDef[];
  positions: Float32Array;
  colors: Float32Array;
  pointToCluster: Uint16Array;
}

const THEME_COLORS: Record<string, string> = {
  Zen: '#10b981',
  Tantra: '#ef4444',
  Sufism: '#8b5cf6',
  Meditation: '#f59e0b',
  'Love & Freedom': '#ec4899',
  Philosophy: '#3b82f6',
  Misc: '#94a3b8',
};

const ERA_COLORS: Record<string, string> = {
  Bombay: '#60a5fa',
  'Poona I': '#d4af37',
  Rajneeshpuram: '#ef4444',
  'Poona II': '#10b981',
  Undated: '#94a3b8',
};

const DECADE_COLORS: Record<string, string> = {
  '1960s': '#3b82f6',
  '1970s': '#d4af37',
  '1980s': '#ef4444',
  '1990s': '#10b981',
  '2000s': '#8b5cf6',
  Undated: '#94a3b8',
};

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

function jitter(id: string, seed: number): number {
  const h = Math.abs(hash(id + ':' + seed));
  return ((h % 1000) / 1000 - 0.5) * 2;
}

function eraFor(date: string): string {
  const yr = parseInt((date || '').slice(0, 4), 10);
  if (!Number.isFinite(yr)) return 'Undated';
  if (yr < 1970) return 'Bombay';
  if (yr < 1981) return 'Poona I';
  if (yr < 1986) return 'Rajneeshpuram';
  return 'Poona II';
}

function decadeFor(date: string): string {
  const yr = parseInt((date || '').slice(0, 4), 10);
  if (!Number.isFinite(yr)) return 'Undated';
  const decade = Math.floor(yr / 10) * 10;
  return `${decade}s`;
}

// Simple non-cryptographic RGB parser
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h, 16);
  return [
    ((bigint >> 16) & 0xff) / 255,
    ((bigint >> 8) & 0xff) / 255,
    (bigint & 0xff) / 255,
  ];
}

interface ClusterSpec {
  name: string;
  color: string;
  centroid: [number, number, number];
  radius: number;
}

function layoutCentroids(
  lens: Lens,
  groupKeys: string[],
): ClusterSpec[] {
  if (lens === 'timeline') {
    const order = ['Bombay', 'Poona I', 'Rajneeshpuram', 'Poona II', 'Undated'];
    const present = order.filter((e) => groupKeys.includes(e));
    const spacing = 180;
    return present.map((name, i) => ({
      name,
      color: ERA_COLORS[name] ?? '#94a3b8',
      centroid: [(i - (present.length - 1) / 2) * spacing, 0, 0],
      radius: 55,
    }));
  }
  if (lens === 'geography') {
    // Vertical stacked bands (keyed by galaxy for this dataset)
    return groupKeys.map((name, i) => ({
      name,
      color: THEME_COLORS[name] ?? '#94a3b8',
      centroid: [0, (i - (groupKeys.length - 1) / 2) * 80, 0],
      radius: 70,
    }));
  }
  if (lens === 'concepts') {
    const order = ['1960s', '1970s', '1980s', '1990s', '2000s', 'Undated'];
    const present = order.filter((d) => groupKeys.includes(d));
    // 2x3 grid on xy plane
    return present.map((name, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      return {
        name,
        color: DECADE_COLORS[name] ?? '#94a3b8',
        centroid: [
          (col - 1) * 200,
          (row - 0.5) * 160,
          0,
        ],
        radius: 70,
      };
    });
  }
  // themes: ring layout on xz plane
  const keys = groupKeys;
  const radius = 260;
  return keys.map((name, i) => {
    const angle = (i / keys.length) * Math.PI * 2;
    return {
      name,
      color: THEME_COLORS[name] ?? '#94a3b8',
      centroid: [Math.cos(angle) * radius, Math.sin(i * 1.3) * 30, Math.sin(angle) * radius],
      radius: 60,
    };
  });
}

export function buildLayout(data: NebulaNode[], lens: Lens): LayoutResult {
  // Step 1: classify each node into a cluster key
  const keyOf: string[] = new Array(data.length);
  data.forEach((n, i) => {
    if (lens === 'timeline') keyOf[i] = eraFor(n.date);
    else if (lens === 'concepts') keyOf[i] = decadeFor(n.date);
    else keyOf[i] = n.galaxy || 'Misc';
  });

  // Step 2: collect unique keys in a stable order (by population desc)
  const counts = new Map<string, number>();
  for (const k of keyOf) counts.set(k, (counts.get(k) ?? 0) + 1);
  const groupKeys = Array.from(counts.keys()).sort((a, b) => (counts.get(b)! - counts.get(a)!));

  // Step 3: choose centroid positions per lens
  const specs = layoutCentroids(lens, groupKeys);
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const clusterIndex = new Map(specs.map((s, i) => [s.name, i]));

  // Step 4: place points near their cluster centroid, with deterministic jitter
  const positions = new Float32Array(data.length * 3);
  const colors = new Float32Array(data.length * 3);
  const pointToCluster = new Uint16Array(data.length);

  const memberIndices: number[][] = specs.map(() => []);

  data.forEach((n, i) => {
    const key = keyOf[i];
    const spec = specByName.get(key);
    const cidx = clusterIndex.get(key);
    if (!spec || cidx === undefined) {
      positions[i * 3] = n.pos[0] * 0.3;
      positions[i * 3 + 1] = n.pos[1] * 0.3;
      positions[i * 3 + 2] = n.pos[2] * 0.3;
      colors[i * 3] = 0.5;
      colors[i * 3 + 1] = 0.5;
      colors[i * 3 + 2] = 0.5;
      pointToCluster[i] = 0xffff;
      return;
    }

    // Sphere distribution around centroid
    const radius = spec.radius * (0.3 + Math.abs(jitter(n.id, 1)));
    const theta = (hash(n.id) % 1000 / 1000) * Math.PI * 2;
    const phi = Math.acos(jitter(n.id, 2));

    positions[i * 3]     = spec.centroid[0] + radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = spec.centroid[1] + radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = spec.centroid[2] + radius * Math.cos(phi);

    const [r, g, b] = hexToRgb(spec.color);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
    pointToCluster[i] = cidx;
    memberIndices[cidx].push(i);
  });

  const clusters: ClusterDef[] = specs.map((s, i) => ({
    name: s.name,
    color: s.color,
    centroid: s.centroid,
    size: memberIndices[i].length,
    memberIndices: memberIndices[i],
  }));

  return { clusters, positions, colors, pointToCluster };
}
