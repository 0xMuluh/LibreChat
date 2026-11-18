import { Circle, Dna, Grid3x3, Layers, Microscope, Atom, FlaskConical } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';

/** Fields in the order the filters show them. */
export const FIELD_ORDER = [
  'Microbiome',
  'Single-cell',
  'Spatial',
  'Multi-omics',
  'Bulk RNA-seq',
  'Metabolomics',
  'Proteomics',
];

const FIELD_ICONS: Record<string, LucideIcon> = {
  Microbiome: Microscope,
  'Single-cell': Circle,
  Spatial: Grid3x3,
  'Multi-omics': Layers,
  'Bulk RNA-seq': Dna,
  Metabolomics: FlaskConical,
  Proteomics: Atom,
};

export const fieldIcon = (field: string): LucideIcon => FIELD_ICONS[field] ?? Layers;

export const sortFields = (fields: string[]) =>
  [...fields].sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a);
    const ib = FIELD_ORDER.indexOf(b);
    return (ia < 0 ? FIELD_ORDER.length : ia) - (ib < 0 ? FIELD_ORDER.length : ib);
  });

/** A node of the fields network on the landing page; x and y are fractions of the panel. */
export type FieldNode = {
  id: string;
  /** Title of the node's carousel. */
  label: TranslationKeys;
  /** Name under the node. */
  short: TranslationKeys;
  x: number;
  y: number;
  r: number;
  light: string;
  dark: string;
  /** Catalog fields whose examples the node shows; empty while it has none. */
  fields: string[];
  /** Nodes this one draws an edge to. */
  links: string[];
  /** How many items the node's card lists. */
  items: number;
};

/* Titles, positions, sizes, colours and links follow the Observatory landing reference. */
export const HUB_NODE: FieldNode = {
  id: 'hub',
  items: 4,
  label: 'com_discover_node_hub',
  short: 'com_discover_node_hub',
  x: 0.5,
  y: 0.5,
  r: 22,
  light: '#1c5757',
  dark: '#63ccc0',
  fields: [],
  links: [
    'microbiome',
    'transcriptomics',
    'singlecell',
    'spatial',
    'proteomics',
    'functional',
    'genomes',
    'multiomics',
    'reports',
  ],
};

export const FIELD_NODES: FieldNode[] = [
  {
    id: 'microbiome',
    items: 4,
    label: 'com_discover_node_microbiome',
    short: 'com_discover_node_microbiome_short',
    x: 0.25,
    y: 0.22,
    r: 16,
    light: '#137a55',
    dark: '#34d399',
    fields: ['Microbiome'],
    links: ['functional', 'multiomics', 'genomes', 'reports'],
  },
  {
    id: 'transcriptomics',
    items: 4,
    label: 'com_discover_node_transcriptomics',
    short: 'com_discover_node_transcriptomics',
    x: 0.5,
    y: 0.14,
    r: 15,
    light: '#5b3cc4',
    dark: '#a78bfa',
    fields: ['Bulk RNA-seq'],
    links: ['functional', 'multiomics', 'singlecell', 'reports'],
  },
  {
    id: 'singlecell',
    items: 4,
    label: 'com_discover_node_singlecell',
    short: 'com_discover_node_singlecell',
    x: 0.76,
    y: 0.22,
    r: 16,
    light: '#a66d10',
    dark: '#deb266',
    fields: ['Single-cell'],
    links: ['spatial', 'transcriptomics', 'functional', 'reports'],
  },
  {
    id: 'spatial',
    items: 4,
    label: 'com_discover_node_spatial',
    short: 'com_discover_node_spatial',
    x: 0.86,
    y: 0.48,
    r: 16,
    light: '#b33b50',
    dark: '#e07a8a',
    fields: ['Spatial'],
    links: ['singlecell', 'multiomics', 'reports'],
  },
  {
    id: 'proteomics',
    items: 4,
    label: 'com_discover_node_proteomics',
    short: 'com_discover_node_proteomics_short',
    x: 0.75,
    y: 0.77,
    r: 16,
    light: '#186c96',
    dark: '#7dd3fc',
    fields: ['Proteomics', 'Metabolomics'],
    links: ['functional', 'multiomics', 'reports'],
  },
  {
    id: 'functional',
    items: 4,
    label: 'com_discover_node_functional',
    short: 'com_discover_node_functional_short',
    x: 0.2,
    y: 0.5,
    r: 14,
    light: '#0c6b99',
    dark: '#38bdf8',
    fields: [],
    links: ['microbiome', 'transcriptomics', 'genomes', 'proteomics'],
  },
  {
    id: 'genomes',
    items: 4,
    label: 'com_discover_node_genomes',
    short: 'com_discover_node_genomes_short',
    x: 0.16,
    y: 0.75,
    r: 14,
    light: '#b8500b',
    dark: '#fb923c',
    fields: [],
    links: ['microbiome', 'functional', 'reports'],
  },
  {
    id: 'multiomics',
    items: 4,
    label: 'com_discover_node_multiomics',
    short: 'com_discover_node_multiomics',
    x: 0.38,
    y: 0.84,
    r: 15,
    light: '#aa2b6c',
    dark: '#f472b6',
    fields: ['Multi-omics'],
    links: ['microbiome', 'transcriptomics', 'proteomics', 'reports'],
  },
  {
    id: 'reports',
    items: 4,
    label: 'com_discover_node_reports',
    short: 'com_discover_node_reports_short',
    x: 0.6,
    y: 0.86,
    r: 16,
    light: '#9c630c',
    dark: '#deb266',
    fields: [],
    links: ['microbiome', 'transcriptomics', 'singlecell', 'spatial', 'proteomics', 'multiomics'],
  },
];

/** Translation keys of a node's card: a tagline, then items each with a detail line. */
export const nodeText = (node: FieldNode) => ({
  tagline: `com_discover_node_${node.id}_tagline` as TranslationKeys,
  items: Array.from({ length: node.items }, (_, i) => ({
    title: `com_discover_node_${node.id}_item${i + 1}` as TranslationKeys,
    detail: `com_discover_node_${node.id}_item${i + 1}_detail` as TranslationKeys,
  })),
});
